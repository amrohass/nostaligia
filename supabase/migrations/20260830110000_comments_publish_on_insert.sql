-- 0054 · A comment is published when it is written
--
-- A PRODUCT DECISION, taken 30 Aug 2026, and it overrides CLAUDE.md §1's "everything
-- user-submitted is reviewed before it is public" **for comments only**. §1 and §3 carry the
-- exception in the same commit as this file, because a rule with an undocumented carve-out
-- is worse than either rule alone.
--
-- Posts are unchanged and are not what this is about. A photograph carries provenance, a
-- licence, a location and a claim about the past, and §7 is explicit that the archive
-- acquires liability when it publishes one it has not looked at. A remark under it does not
-- carry any of that.
--
-- ── What was actually happening ──────────────────────────────
--
-- Not "comments waited for review". Comments were never seen again.
--
-- 0019 pinned an insert to status='pending' and gave a moderator the UPDATE that lifts it.
-- No screen was ever built that calls it: `admin.js` has a queue, an archive register,
-- events, places, members, reports and copy, and no comments panel. The one comment this
-- database holds has been pending since it was written, and nothing in the deployed system
-- could ever have changed that.
--
-- So the choice was not between review and no review. It was between a comment box that
-- silently discards and one that works, plus §4's reactive controls that already exist.
--
-- ── What is deliberately NOT relaxed ─────────────────────────
--
--   · sign-in is still required            — 0019's `auth.uid() is not null`, unchanged
--   · you may still only comment on an approved, non-taken-down post   — unchanged
--   · created_by is still stamped by trigger and is not in the grant   — 0014, unchanged
--   · bidi stripping still runs before the row lands  — 0045's comments_strip_bidi, and it
--     is now the ONLY thing between a hostile string and a shard, which is why it is a
--     BEFORE trigger on the table rather than anything a client does
--   · a moderator can still hide or remove any comment (status='hidden'/'removed'), and
--     `reports` still takes a member's flag                            — §4, unchanged
--
-- Moderation becomes reactive rather than prior. That is the whole of the change.
--
-- ── The publish cadence follows by itself ────────────────────
--
-- 0044 already routes a comment by its status: a `published` one bumps the CONTENT revision
-- (its body travels in item/{id}.json — §2's 21 Aug amendment), a non-published one bumps
-- only the counter. Nothing here touches those triggers; changing the default is what makes
-- the content branch the one that fires, and 0042 dispatches a publish from it.
--
-- The cost that implies was weighed rather than missed. Every release still rewrites every
-- shard (§2's 19 Aug amendment), so a comment now costs an archive rebuild — where §6's
-- one-hour floor bounds likes, it does not bound content. Two things keep that from being a
-- storm: the single-writer lease answers a concurrent dispatch `held` in one statement
-- without building anything, and 0042's follow-up collects whatever landed while the lease
-- was held. N comments in one window therefore cost roughly one release and one follow-up,
-- not N releases. If that stops being true, the answer is §2's deferred incremental diff,
-- not a throttle that would make a comment appear an hour after it was written.

set search_path = public, extensions;

-- ── Three places say 'pending', and all three have to move ───
--
-- Found by testing the insert rather than by reading the policy, which is the only way it
-- WOULD be found: changing the default and the policy alone leaves the column grant and the
-- trigger disagreeing, and the symptom is not "comments are still moderated" but
--
--     42501: new row violates row-level security policy for table "comments"
--
-- — a comment box that refuses every comment. The three are the default below, 0014's
-- authorship trigger, and 0019's policy, and the trigger is the one that actually decides.

-- 1 · the default, which applies to an insert with no end user (an importer, service_role):
-- 0014's trigger returns early when auth.uid() is null, so this is that path's only answer.
alter table public.comments alter column status set default 'published';

comment on column public.comments.status is
  'published on insert (0054 — §1''s review exception for comments). hidden/removed are moderator actions.';

-- 2 · the trigger, which is what a signed-in member's insert actually gets.
--
-- `status` is not in 0015's INSERT grant, so a client cannot name the column — but the
-- stamp stays explicit rather than being left to the default, and that is deliberate. It is
-- the property that makes the grant a second lock rather than the only one: if `status` were ever
-- added to the grant, a member still could not insert a comment as 'hidden' or
-- pre-'removed'. Same shape as 0014's, one literal different.
create or replace function public.comments_stamp_authorship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  new.created_by := (select auth.uid());
  new.status     := 'published';   -- 0054: reactive moderation, not prior
  return new;
end;
$fn$;

comment on function public.comments_stamp_authorship() is
  'Stamps the author and publishes on insert. §1''s comment exception (0054); the trigger is what decides, not the default.';

-- 3 · the policy ────────────────────────────────────────────
--
-- Restated whole rather than patched, because a reader deciding whether a member can
-- self-publish needs the entire clause in front of them. Everything except the status
-- literal is 0019's, unchanged.
drop policy if exists comments_insert on public.comments;

create policy comments_insert on public.comments
  for insert to authenticated
  with check (
        (select auth.uid()) is not null
    and created_by = (select auth.uid())
    and status = 'published'
    and exists (
      select 1 from public.posts p
      where p.id = comments.post_id
        and p.status = 'approved'
        and not p.takedown
    )
  );

-- ── The author's own UPDATE, which is now unreachable ────────
--
-- 0019 let an author fix their own comment "while it is still in the queue". There is no
-- queue any more, so that branch can never match its own USING clause — and that is the
-- outcome to keep rather than to repair. A member who could edit a live comment could post
-- something ordinary and rewrite it afterwards, which would empty reactive moderation of
-- meaning in exactly the way prior review was emptied by having no screen.
--
-- Rewritten to say so, rather than left as a clause whose next reader has to work out that
-- it is dead. Moderators are unaffected.
drop policy if exists comments_update on public.comments;

create policy comments_update on public.comments
  for update to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

comment on policy comments_update on public.comments is
  'Moderator only. An author cannot edit a comment that is already live (0054).';

-- ── The one row that was already stranded ────────────────────
--
-- Written by a member through the real client, held `pending` by a workflow with no second
-- half. Publishing it is the same decision as the one above applied to the past; leaving it
-- would mean the change fixes every comment except the one that proved the problem.
--
-- Not a blanket UPDATE of every non-published row: `hidden` and `removed` are decisions
-- somebody took, and this must not undo them.
update public.comments set status = 'published' where status = 'pending';
