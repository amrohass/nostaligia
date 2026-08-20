-- 0046 · The list that takes a permalink away
--
-- §9: "The publish step emits item/{id}/index.html with full OG/Twitter tags and the content
-- in HTML." Those pages are the one thing a release writes outside `/v/{ts}/`, because a URL
-- somebody pasted into a group chat two years ago cannot require resolving a pointer before
-- it resolves at all.
--
-- Everything versioned is replaced wholesale on each release, so nothing versioned can go
-- stale. An unversioned page can, and one way it goes stale is dangerous: a post that was
-- approved, published, and then WITHDRAWN vanishes from every shard while its item page
-- keeps serving the full text, the photograph and the byline from the root of the bucket.
-- No amount of correctness in the shard builder touches that file.
--
-- Takedown does not have this problem — §8's path deletes the page itself, in the same
-- request as the bytes, and never waits for a publish. This is for the quieter exits:
-- withdrawn by the author, rejected after approval, edited past its approval hash, or an
-- ingest that regressed.
--
-- ── Why it is bounded by the audit log ───────────────────────
--
-- The obvious version returns every post that is not publishable. It is correct and it is a
-- cost-amplification vector: every draft anybody has ever started is in it, the set only
-- grows, and the publisher would issue one DELETE per member draft on every release forever.
-- §6 spends four layers on exactly this class of unbounded operation.
--
-- So the set is narrowed to posts that could actually HAVE a page — ones that reached
-- 'approved' at least once. audit_log is the only place that fact survives: `approved_at` and
-- `content_hash` are both cleared by 0012's edit-after-approval trigger, which is precisely
-- the case this has to catch, and §3 makes audit rows permanent so the evidence cannot be
-- rotated away. audit_log_target_idx on (target_type, target_id, created_at desc) is what
-- makes the lookup a probe rather than a scan.
--
-- ── Not a shard source ───────────────────────────────────────
--
-- 20_publish_cron assertion 27 derives "every table the publisher reads" from the functions
-- that build SHARD CONTENT, and this one is deliberately not among them: it drives
-- deletions, and nothing it returns is ever written anywhere. The dispatch is covered
-- regardless — every transition that lands a post in this list is an UPDATE on `posts` where
-- old.status was 'approved', which 0037's trigger already fires on.

set search_path = public, extensions;

create or replace function public.unpublishable_post_ids()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(p.id order by p.id), '[]'::jsonb)
  from public.posts p
  where not (p.status = 'approved' and p.takedown = false and p.ingest_state = 'ready')
    and exists (
      select 1
      from public.audit_log a
      where a.target_type = 'post'
        and a.target_id = p.id
        and a.after ->> 'status' = 'approved'
    );
$$;

comment on function public.unpublishable_post_ids() is
  'Posts that must not keep a prerendered item page — approved once, publishable no longer (CLAUDE.md §9).';

-- Same posture as every other publisher-side accessor: service_role, and no browser role.
-- This one additionally reads audit_log, which 0015 leaves readable to `authenticated` but
-- which nothing should be aggregating over from a browser.
revoke execute on function public.unpublishable_post_ids() from public, anon, authenticated;
grant  execute on function public.unpublishable_post_ids() to service_role;
