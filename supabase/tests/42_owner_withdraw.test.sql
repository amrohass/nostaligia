-- An author withdraws their own pending or rejected submission, by status alone.
--
-- No migration adds this. 0018's posts_update already admits the author (USING created_by =
-- auth.uid()) and already accepts 'withdrawn' as what their row may become (WITH CHECK
-- status in ('pending','withdrawn')), and 0015 grants `authenticated` UPDATE(status). /me
-- gained a button for it on 18 Sep 2026; this file is the database half of that button,
-- pinned so a later rewrite of posts_update cannot remove it without a red line.
--
-- ── What this file has to discriminate ───────────────────────
--
--   1. the write the client sends — `{status:'withdrawn'}` and nothing else — lands, from
--      pending (1) and from rejected (6);
--   2. §5's edit-after-approval trigger does not fight it. Asserted, not argued: status is
--      not an input to post_content_hash (3), so posts_enforce_approval sees no content
--      change and its rules 1–3 are all inert for a row that was never approved (2, 4);
--   3. it is soft. The row stays and the trail is written (5) — §3's audit rows are
--      permanent, and a withdrawal is one more of them;
--   4. it is the AUTHOR's. Another member's identical write matches nothing (7), beside the
--      same member withdrawing their own post as its control (8);
--   5. it costs no release (11). A post that was never public moves no publish revision.
--
-- ── And the rest of 0018, kept by decision ───────────────────
--
-- The same policy lets an author move a rejected or withdrawn post back to 'pending', and
-- withdraw an APPROVED one. Both were put to Amro on 18 Sep 2026 — his brief had assumed
-- neither route existed — and on 19 Sep he kept both. So they are pinned here (9, 10, 12)
-- rather than left to be "fixed": a pending return re-enters the moderation queue, where
-- a moderator decides again, and an approved withdrawal is §7's right to withdraw without
-- waiting on a moderator. Closing either would need a trigger, not a policy — WITH CHECK
-- sees only the new row.

begin;
create extension if not exists pgtap;

-- 2 from pending · 1 the hash · 1 no approval record · 1 the trail · 1 from rejected
-- · 2 whose · 2 back to pending · 1 the cost · 1 an approved one
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000042a1', 'wd-author@t.local'),
  ('00000000-0000-0000-0000-0000000042a2', 'wd-stranger@t.local');

update public.email_confirmations set confirmed_at = now() where confirmed_at is null;

-- Inserted before any JWT is set, so posts_stamp_authorship leaves created_by and status as
-- written — the only way to seed a REJECTED row without a moderator in this file.
insert into public.posts (id, kind, title_en, body_en, status, created_by) values
  ('00000000-0000-0000-0000-0000000042f1', 'media', 'still in review', 'a doorway',
   'pending',  '00000000-0000-0000-0000-0000000042a1'),
  ('00000000-0000-0000-0000-0000000042f2', 'media', 'turned down', 'a hillside',
   'rejected', '00000000-0000-0000-0000-0000000042a1'),
  ('00000000-0000-0000-0000-0000000042f3', 'media', 'the stranger''s own', 'a well',
   'pending',  '00000000-0000-0000-0000-0000000042a2'),
  ('00000000-0000-0000-0000-0000000042f5', 'media', 'turned down, sent again', 'a terrace',
   'rejected', '00000000-0000-0000-0000-0000000042a1');

-- The author's APPROVED post, which exists for assertion 7 and nothing else: it is the one
-- row of the author's that a STRANGER can see. Aimed at a pending row, 7 passed with
-- posts_update's USING opened to `true` — posts_select hides a stranger's pending row
-- before the UPDATE policy is ever consulted, so the test was proving the wrong policy.
-- Found by mutation, 18 Sep 2026.
--
-- It satisfies both approval constraints (pgTAP authoring trap 3). The media 0063 requires
-- is a deferred check at a commit this file never reaches, as in 33_comments_publish.
set constraints public.posts_approved_has_media deferred;
insert into public.posts (id, kind, title_en, body_en, status, created_by,
                          license, provenance, consent,
                          approved_by, approved_at, content_hash)
values ('00000000-0000-0000-0000-0000000042f4', 'media', 'the author''s published one',
        'a courtyard', 'approved', '00000000-0000-0000-0000-0000000042a1',
        'CC-BY-SA-4.0', 'family album',
        jsonb_build_object('granted', true, 'may_withdraw', true),
        '00000000-0000-0000-0000-0000000042a1', now(),
        '15df9d67f8e90a98014647411681314ce17bf434981db443bf36cae14532a677');

-- Owner-rights readers (pgTAP authoring trap 1), and a snapshot of what must not move.
create function pg_temp.row_of(p uuid)
returns table (status text, content_hash text, approved_by uuid, approved_at timestamptz,
               title_en text, body_en text)
language sql stable security definer as $fn$
  select status::text, content_hash, approved_by, approved_at, title_en, body_en
    from public.posts where id = p;
$fn$;

create function pg_temp.hash_now(p uuid) returns text
language sql stable security definer as $fn$
  select public.post_content_hash(x) from public.posts x where x.id = p;
$fn$;

create temp table before_withdraw as
  select pg_temp.hash_now('00000000-0000-0000-0000-0000000042f1') as hash,
         (select content_revision from public.publish_revision where id) as revision;

-- ═══ 1-5 · From pending, the write /me sends ═════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000042a1","role":"authenticated"}';

-- The PATCH, as SQL: one column, filtered by id. RETURNING is what PostgREST's
-- return=representation reads, so an RLS refusal here is 0 rows rather than an error — and
-- is_empty on the refusal case below depends on exactly that.
select results_eq(
  $q$ update public.posts set status = 'withdrawn'
       where id = '00000000-0000-0000-0000-0000000042f1'
      returning id, status::text $q$,
  $q$ values ('00000000-0000-0000-0000-0000000042f1'::uuid, 'withdrawn') $q$,
  'the author withdraws their own pending post with a status-only update');

reset role;

select results_eq(
  $q$ select status, title_en, body_en from pg_temp.row_of('00000000-0000-0000-0000-0000000042f1') $q$,
  $q$ values ('withdrawn', 'still in review', 'a doorway') $q$,
  'it STAYS withdrawn — the edit-after-approval trigger did not send it back to pending — and nothing else moved');

-- The reason 2 holds, checked rather than read off the function body: status is not in the
-- content hash, so to posts_enforce_approval a status-only write is not a content change.
select is(
  pg_temp.hash_now('00000000-0000-0000-0000-0000000042f1'),
  (select hash from before_withdraw),
  'post_content_hash is identical before and after — status is not content, so §5''s rule 1 cannot fire');

select results_eq(
  $q$ select content_hash, approved_by, approved_at
        from pg_temp.row_of('00000000-0000-0000-0000-0000000042f1') $q$,
  $q$ values (null::text, null::uuid, null::timestamptz) $q$,
  'and no approval record was invented or stamped by rule 2 or 3 — the row was never approved and still is not');

-- Soft, and on the record. audit_log for the full before/after; moderation_actions because
-- posts_write_audit lists post.status.withdrawn among the decisions the team reads.
select results_eq(
  $q$ select (select count(*) from public.posts
                where id = '00000000-0000-0000-0000-0000000042f1'),
             (select count(*) from public.audit_log
                where target_id = '00000000-0000-0000-0000-0000000042f1'
                  and action = 'post.status.withdrawn'
                  and actor = '00000000-0000-0000-0000-0000000042a1'),
             (select count(*) from public.moderation_actions
                where target_id = '00000000-0000-0000-0000-0000000042f1'
                  and action = 'post.status.withdrawn'
                  and actor = '00000000-0000-0000-0000-0000000042a1') $q$,
  $q$ values (1::bigint, 1::bigint, 1::bigint) $q$,
  'the row stays, and audit_log and moderation_actions each record the author withdrawing it');

-- ═══ 6 · From rejected ═══════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000042a1","role":"authenticated"}';

select results_eq(
  $q$ update public.posts set status = 'withdrawn'
       where id = '00000000-0000-0000-0000-0000000042f2'
      returning status::text $q$,
  $q$ values ('withdrawn') $q$,
  'the author withdraws their own REJECTED post the same way');

-- ═══ 7-8 · Only the author ═══════════════════════════════════

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000042a2","role":"authenticated"}';

-- The author's approved post, which the stranger CAN read. So 0 rows here is posts_update's
-- USING excluding it: were USING open, the row would reach WITH CHECK, fail created_by
-- there, and RAISE — which is_empty reports as a failure, not a pass.
select is_empty(
  $q$ update public.posts set status = 'withdrawn'
       where id = '00000000-0000-0000-0000-0000000042f4'
      returning id $q$,
  'another member''s identical write to a post of the author''s that they can SEE matches nothing — USING is created_by');

select results_eq(
  $q$ update public.posts set status = 'withdrawn'
       where id = '00000000-0000-0000-0000-0000000042f3'
      returning status::text $q$,
  $q$ values ('withdrawn') $q$,
  'CONTROL: the same member CAN withdraw their own — 7 is ownership refusing, not the column or the verb');

-- ═══ 9-10 · Back to pending (kept, 19 Sep 2026) ══════════════
--
-- The same status-only write, in the other direction. Both rows re-enter the moderation
-- queue as ordinary submissions; neither can reach 'approved' this way — posts_update's
-- WITH CHECK admits only pending and withdrawn for an author.
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000042a1","role":"authenticated"}';

select results_eq(
  $q$ update public.posts set status = 'pending'
       where id = '00000000-0000-0000-0000-0000000042f5'
      returning status::text $q$,
  $q$ values ('pending') $q$,
  'the author moves their REJECTED post back to pending');

select results_eq(
  $q$ update public.posts set status = 'pending'
       where id = '00000000-0000-0000-0000-0000000042f1'
      returning status::text $q$,
  $q$ values ('pending') $q$,
  'and their WITHDRAWN post back to pending — withdrawal is reversible by its author');

reset role;

-- ═══ 11 · It costs no release ════════════════════════════════
--
-- posts_bump_publish_revision_update fires only WHEN old or new status is 'approved'. Five
-- status moves of never-public posts later, the content revision has not moved, so nothing
-- was dispatched and no archive was rebuilt for something that was never in it.
select is(
  (select content_revision from public.publish_revision where id),
  (select revision from before_withdraw),
  'withdrawing unpublished posts, and returning them, moves no publish revision');

-- ═══ 12 · An approved post (kept, 19 Sep 2026) ═══════════════
--
-- Last, because it is the one write in this file that DOES move the revision: the post
-- leaves the archive at the next publish. posts_enforce_approval's rule 3 clears the
-- approval record on the way out, so a re-submission is reviewed from scratch.
--
-- The write is the author's; the read is the owner's, because approved_by is not in 0015's
-- grant to `authenticated` and a RETURNING of it would be refused for that reason alone. A
-- write that RLS refused matches 0 rows silently — and then the row still reads 'approved'.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000042a1","role":"authenticated"}';
do $$ begin
  update public.posts set status = 'withdrawn' where id = '00000000-0000-0000-0000-0000000042f4';
end $$;
reset role;

select results_eq(
  $q$ select status, approved_by is null, content_hash is null
        from pg_temp.row_of('00000000-0000-0000-0000-0000000042f4') $q$,
  $q$ values ('withdrawn', true, true) $q$,
  'the author withdraws their own APPROVED post, and its approval record is cleared');

select * from finish();
rollback;
