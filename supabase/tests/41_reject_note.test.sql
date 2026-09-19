-- A rejection carries a note, and its author can read the note and the day — nothing else (0064).
--
-- ── What this file has to discriminate ───────────────────────
--
--   1. the note is required ON THE SERVER. A dashboard that asks for one proves nothing
--      (§5), so the refusal that matters is 8: a moderator's plain UPDATE, the PATCH
--      admin.js used to send, refused with no note. 9 is its control — the same UPDATE
--      with the GUC set lives — so 8 is the note discriminating, not the row being shut.
--   2. the author sees their own note. 11 and 12 are the pair: the author gets it, another
--      member asking the same function gets nothing.
--   3. the author sees NOTHING ELSE. 13 reads the function's result type off the catalogue,
--      because "the author cannot see the moderator" is a property of the columns, and no
--      row-count assertion can observe a column that should not be there. 14 pins that the
--      table itself stayed moderator-only — an owner policy added beside it would pass 11.
--   4. a TAKEDOWN note on the same post is not a rejection note (15). Both are
--      moderation_actions rows with a note; only the action separates them.

begin;
create extension if not exists pgtap;

-- 7 the RPC · 2 the server-side rule · 7 the author's read · 1 the grant
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000041a1', 'rn-author@t.local'),
  ('00000000-0000-0000-0000-0000000041a2', 'rn-stranger@t.local'),
  ('00000000-0000-0000-0000-0000000041a3', 'rn-mod@t.local');

-- 0060 gates every contribution on a confirmed address, and a fixture account created here
-- is an ordinary confirmed member. The UNCONFIRMED case has one file of its own
-- (37_email_confirmation).
update public.email_confirmations set confirmed_at = now() where confirmed_at is null;

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000041a3', 'moderator',
        '00000000-0000-0000-0000-0000000041a3');

-- Pending posts need a title and a body (posts_has_a_title, posts_has_a_description) and
-- nothing else; no approval constraint applies to them. Inserted before any JWT is set, so
-- posts_stamp_authorship leaves created_by as written.
insert into public.posts (id, kind, title_en, body_en, status, created_by) values
  ('00000000-0000-0000-0000-0000000041f1', 'media', 'to be rejected', 'a blurry scan',
   'pending', '00000000-0000-0000-0000-0000000041a1'),
  ('00000000-0000-0000-0000-0000000041f2', 'media', 'patched directly', 'the old door',
   'pending', '00000000-0000-0000-0000-0000000041a1'),
  ('00000000-0000-0000-0000-0000000041f3', 'media', 'rejected before 0064', 'no note then',
   'pending', '00000000-0000-0000-0000-0000000041a1');

-- A rejection from a session with no uid: the service role, a maintainer at psql. Exempt by
-- design (the header of 0064 says why), and this is also the shape of every rejection made
-- before 0064 — a moderation_actions row whose note is NULL. Assertion 16 reads it back.
update public.posts set status = 'rejected' where id = '00000000-0000-0000-0000-0000000041f3';

-- Readers that run as the owner, so an assertion about a row is not an assertion about
-- 0015's column grants (pgTAP authoring trap 1).
create function pg_temp.status_of(p uuid) returns text
language sql stable security definer as $fn$
  select status::text from public.posts where id = p;
$fn$;

create function pg_temp.rejections_of(p uuid) returns bigint
language sql stable security definer as $fn$
  select count(*) from public.moderation_actions
   where target_id = p and action = 'post.status.rejected';
$fn$;

-- ═══ 1-7 · reject_post ═══════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a1","role":"authenticated"}';

select is(
  public.reject_post('00000000-0000-0000-0000-0000000041f1', 'rejecting my own') ->> 'reason',
  'forbidden',
  'a member may not reject — not even their own post, which posts_update would also refuse');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a3","role":"authenticated"}';

select is(
  public.reject_post('00000000-0000-0000-0000-0000000041f1', E'  \t ') ->> 'reason',
  'note_required',
  'a moderator may not reject with a blank note — whitespace is not a reason');

select is(
  public.reject_post('00000000-0000-0000-0000-0000000041f1', repeat('x', 4001)) ->> 'reason',
  'note_too_long',
  'the table''s own 4000-character ceiling, answered by name');

select is(
  public.reject_post('00000000-0000-0000-0000-0000000041ff', 'no such post') ->> 'reason',
  'unknown_post',
  'a post that does not exist is named as such');

-- The refusals above must not have moved the row. Read in its own statement: the reader is
-- STABLE and would not see a write made by the statement it is part of (trap 2).
select is(pg_temp.status_of('00000000-0000-0000-0000-0000000041f1'), 'pending',
  'CONTROL: none of the four refusals touched the post');

-- The note carries a U+202E RIGHT-TO-LEFT OVERRIDE. It crosses from a moderator to a
-- contributor, so §6 applies and the stored note must not contain it.
do $$ begin
  perform public.reject_post('00000000-0000-0000-0000-0000000041f1',
                             E'  The scan is too blurry‮ — please upload a sharper one.  ');
end $$;

-- LOAD-BEARING. reject_post sets the note with set_config(..., true), which lasts until the
-- end of the TRANSACTION — and this whole file is one transaction, where in production each
-- PostgREST request is its own. Left set, it would satisfy the trigger in assertion 8, and
-- 8 would pass against a database with no rule at all.
do $$ begin perform set_config('rma.moderation_note', '', true); end $$;

reset role;

select results_eq(
  $q$ select status::text, (select note from public.moderation_actions
                              where target_id = p.id and action = 'post.status.rejected'),
             (select actor from public.moderation_actions
                              where target_id = p.id and action = 'post.status.rejected')
        from public.posts p where p.id = '00000000-0000-0000-0000-0000000041f1' $q$,
  $q$ values ('rejected',
              'The scan is too blurry — please upload a sharper one.',
              '00000000-0000-0000-0000-0000000041a3'::uuid) $q$,
  'a moderator rejects with a note: the post is rejected and the ledger holds the note, trimmed and bidi-clean, under the moderator');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a3","role":"authenticated"}';

select is(
  public.reject_post('00000000-0000-0000-0000-0000000041f1', 'and again') ->> 'reason',
  'already_rejected',
  'rejecting a rejected post is refused by name — it is not a transition, and the note would land nowhere');

-- ═══ 8-9 · The rule is the server's, not the dashboard's ════
--
-- The PATCH admin.js sent before 0064, from a moderator's own session. posts_update admits
-- it and 0015 grants the column, so the ONLY thing that can refuse it is the trigger.

select throws_ok(
  $q$ update public.posts set status = 'rejected'
       where id = '00000000-0000-0000-0000-0000000041f2' $q$,
  '23514', null,
  'a moderator''s plain status PATCH to rejected, with no note, is refused by the database');

-- The same statement once the GUC holds a note — which is all reject_post does. Cleared
-- afterwards, for the reason given after the DO block above.
do $$ begin perform set_config('rma.moderation_note', 'Out of scope for this archive.', true); end $$;
select lives_ok(
  $q$ update public.posts set status = 'rejected'
       where id = '00000000-0000-0000-0000-0000000041f2' $q$,
  'CONTROL: the identical UPDATE with a note set lives — 8 is the note discriminating, not the row being shut');
do $$ begin perform set_config('rma.moderation_note', '', true); end $$;

-- ═══ 10-16 · The author reads the reason, and only that ═════

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a1","role":"authenticated"}';

select is(
  (select count(*) from public.my_rejections()), 3::bigint,
  'the author gets one row per rejected post of theirs — the RPC''s, the direct one, and the pre-0064 one');

select results_eq(
  $q$ select note, rejected_on from public.my_rejections()
       where post_id = '00000000-0000-0000-0000-0000000041f1' $q$,
  $q$ values ('The scan is too blurry — please upload a sharper one.'::text,
              (now() at time zone 'UTC')::date) $q$,
  'and for the one rejected with a note, they get that note and the DAY it happened');

set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a2","role":"authenticated"}';

select is_empty(
  $q$ select * from public.my_rejections() $q$,
  'another member asking the same function gets nothing — scoped by the token, not by an argument');

-- The columns, from the catalogue. "The author never learns which moderator" cannot be
-- observed by counting rows; it is a fact about the shape, so the shape is what is read.
select is(
  pg_get_function_result('public.my_rejections()'::regprocedure),
  'TABLE(post_id uuid, note text, rejected_on date)',
  'three columns and no more: no actor, no action, no timestamp finer than a day');

-- 0064 added no policy. If one had been added so the author could read their row, 11 would
-- pass AND the author could `select=actor` through PostgREST — which is exactly why it was
-- not. The table stays moderator-only.
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a1","role":"authenticated"}';

select is(
  (select count(*) from public.moderation_actions
    where target_id = '00000000-0000-0000-0000-0000000041f1'), 0::bigint,
  'the author still cannot read moderation_actions directly, even the row about their own post');

reset role;

-- A takedown note on the SAME post, written after the rejection. It is a moderation_actions
-- row with a note and a later timestamp — an unfiltered "latest note for this post" returns
-- it. It is written for the ledger, not for the person whose photograph was removed.
insert into public.moderation_actions (actor, action, target_type, target_id, note, created_at)
values ('00000000-0000-0000-0000-0000000041a3', 'post.takedown', 'post',
        '00000000-0000-0000-0000-0000000041f1', 'INTERNAL: legal complaint #12', now() + interval '1 minute');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000041a1","role":"authenticated"}';

select is(
  (select note from public.my_rejections() where post_id = '00000000-0000-0000-0000-0000000041f1'),
  'The scan is too blurry — please upload a sharper one.',
  'a later takedown note on the same post is NOT returned — only the rejection reaches the author');

select is(
  (select note from public.my_rejections() where post_id = '00000000-0000-0000-0000-0000000041f3'),
  null::text,
  'a rejection with no note (the pre-0064 shape) comes back with its day and a NULL note, not omitted');

-- ═══ 17 · anon reaches neither ═══════════════════════════════

reset role;
set local role anon;
select throws_ok($q$ select * from public.my_rejections() $q$, '42501', null,
  'anon cannot execute my_rejections');
reset role;

select * from finish();
rollback;
