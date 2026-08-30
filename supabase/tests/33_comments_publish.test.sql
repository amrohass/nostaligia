-- A comment is published when it is written (0054) — §1's one review exception.
--
-- The migration moves a single literal in three places, and the reason this file exists is
-- that moving it in TWO of them produces a comment box that refuses every comment rather
-- than a system that still moderates. The default, 0014's authorship trigger and 0019's
-- policy all named 'pending'; the trigger is the one that decides, and a test written only
-- against the policy would have gone green on a database where nobody could comment at all.
--
-- So assertion 1 is the whole point and it is deliberately the plainest one here: write a
-- comment the way the front end writes it, and read back what landed.
--
-- ── What must NOT have moved ─────────────────────────────────
--
-- The exception is for prior review and for nothing else, so the assertions below pin the
-- boundaries that stayed where they were. Each is paired: a "cannot" beside a "can", because
-- a refusal is also what a broken grant looks like and an unpaired "cannot" would keep
-- passing against a table nobody can write to at all.
--
--   · you may comment on an approved post          — and NOT on a pending one
--   · a moderator may still hide a comment         — and an author may NOT edit their own
--   · a published comment moves the CONTENT revision, which is what makes it reachable:
--     its body travels in item/{id}.json (§2's 21 Aug amendment), so a comment that
--     published without moving that number would be live in the database and in no shard.

begin;
create extension if not exists pgtap;

-- 3 what lands · 2 where you may write · 2 the signal · 3 who may change it
select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000c0a1', 'cm-author@t.local'),
  ('00000000-0000-0000-0000-00000000c0a2', 'cm-member@t.local'),
  ('00000000-0000-0000-0000-00000000c0a3', 'cm-mod@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000c0a3', 'moderator',
        '00000000-0000-0000-0000-00000000c0a3');

-- One approved post to comment on and one pending post to be refused on. The approved row
-- satisfies both of 0006's approval constraints — posts_approved_has_rights and
-- posts_approved_is_attributable — and content_hash is 64 lowercase hex rather than a label.
-- Settable directly only because this INSERT runs before any JWT is set.
insert into public.posts (id, kind, title_en, body_en, status, created_by,
                          license, provenance, consent,
                          approved_by, approved_at, content_hash)
values ('00000000-0000-0000-0000-00000000cf01', 'media', 'an approved photograph', 'of a street',
        'approved', '00000000-0000-0000-0000-00000000c0a1',
        'CC-BY-SA-4.0', 'family album',
        jsonb_build_object('granted', true, 'may_withdraw', true),
        '00000000-0000-0000-0000-00000000c0a3', now(),
        '15df9d67f8e90a98014647411681314ce17bf434981db443bf36cae14532a677');

-- body_en is not decoration: posts_has_a_description requires one side of it, exactly as
-- posts_has_a_title requires one side of the title. §9's "required description field on
-- upload (frame it as archival metadata)" written as a CHECK.
insert into public.posts (id, kind, title_en, body_en, status, created_by)
values ('00000000-0000-0000-0000-00000000cf02', 'media', 'still in the queue',
        'not yet reviewed', 'pending', '00000000-0000-0000-0000-00000000c0a1');

-- SECURITY DEFINER readers: `authenticated` holds a column subset on comments (0015), so a
-- test that read status through the member's own role would fail on the grant rather than on
-- the behaviour -- and a permission error is indistinguishable from the refusal some of
-- these assertions are looking for.
create function pg_temp.comment_status(p_body text) returns text
language sql stable security definer as $fn$
  select c.status::text from public.comments c where c.body = p_body;
$fn$;

create function pg_temp.comment_author(p_body text) returns uuid
language sql stable security definer as $fn$
  select c.created_by from public.comments c where c.body = p_body;
$fn$;

create function pg_temp.content_rev() returns bigint
language sql stable security definer as $fn$
  select content_revision from public.publish_revision where id;
$fn$;

-- ═══ 1-3 · What a member's comment lands as ══════════════════
--
-- Written exactly as engage.js writes it: (post_id, body, lang) and nothing else, because
-- 0015's INSERT grant is those three columns. `status` is not offered and could not be
-- honoured if it were.

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c0a2","role":"authenticated"}';

insert into public.comments (post_id, body, lang)
values ('00000000-0000-0000-0000-00000000cf01', 'a remark that should be live at once', 'en');

reset role;

select is(
  pg_temp.comment_status('a remark that should be live at once'),
  'published',
  'a member''s comment lands published — §1''s exception, and the trigger is what does it');

select is(
  pg_temp.comment_author('a remark that should be live at once'),
  '00000000-0000-0000-0000-00000000c0a2'::uuid,
  'the author is still stamped by trigger, not chosen by the client');

-- The default matters on its own: 0014's trigger returns early when auth.uid() is null, so
-- an importer or a service_role insert never reaches the line that stamps the status. Before
-- 0054 that path produced a 'pending' row nothing could ever publish.
select is(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'comments' and column_name = 'status'),
  '''published''::comment_status',
  'and the column default agrees, for the path where no end user is present');

-- ═══ 4-5 · Where a member may write ══════════════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c0a2","role":"authenticated"}';

-- The paired "cannot". Unchanged from 0019 and it must stay unchanged: publishing on insert
-- would otherwise let a member attach public text to an item no moderator has approved.
select throws_ok(
  $q$ insert into public.comments (post_id, body, lang)
      values ('00000000-0000-0000-0000-00000000cf02', 'on an unapproved item', 'en') $q$,
  '42501', null,
  'a comment on a PENDING post is still refused');

select lives_ok(
  $q$ insert into public.comments (post_id, body, lang)
      values ('00000000-0000-0000-0000-00000000cf01', 'a second remark', 'en') $q$,
  '...while the same member writing on the approved one succeeds');

reset role;

-- ═══ 6-7 · The signal that makes it reachable ════════════════
--
-- Measured as a delta in a temporary table: the inserts above already moved the number, and
-- an absolute value would encode this file's order rather than the rule.

create temporary table cm_rev (rev_before bigint);
insert into cm_rev select pg_temp.content_rev();

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c0a2","role":"authenticated"}';
insert into public.comments (post_id, body, lang)
values ('00000000-0000-0000-0000-00000000cf01', 'a third remark', 'en');
reset role;

select cmp_ok(
  pg_temp.content_rev(), '>', (select rev_before from cm_rev),
  'a published comment moves the CONTENT revision — its body travels in the item shard');

update cm_rev set rev_before = pg_temp.content_rev();

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c0a3","role":"authenticated"}';
update public.comments set status = 'removed' where body = 'a third remark';
reset role;

select cmp_ok(
  pg_temp.content_rev(), '>', (select rev_before from cm_rev),
  '...and removing one moves it too, so the shard loses it');

-- ═══ 8-10 · Who may change one afterwards ════════════════════
--
-- Moderation is reactive now, which makes these three the whole of it.

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c0a3","role":"authenticated"}';

update public.comments set status = 'hidden'
 where body = 'a remark that should be live at once';

reset role;

select is(
  pg_temp.comment_status('a remark that should be live at once'),
  'hidden',
  'a moderator can still hide a comment — §4 is untouched');

-- The paired "cannot", and the one that matters most: a member who could edit a live comment
-- could write something ordinary and rewrite it afterwards, which would empty reactive
-- moderation exactly as prior review was emptied by having no queue screen.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000c0a2","role":"authenticated"}';

update public.comments set body = 'quietly rewritten' where body = 'a second remark';

select is(
  (select count(*)::int from public.comments where body = 'quietly rewritten'),
  0,
  'an author cannot edit their own comment once it is live');

-- An RLS-refused UPDATE removes zero rows and raises nothing, so the assertion above would
-- read the same against a table the member cannot see at all. This is its control.
select is(
  (select count(*)::int from public.comments where body = 'a second remark'),
  1,
  '...and the row is still there and still readable by its author, so that was RLS');

reset role;

select * from finish();
rollback;
