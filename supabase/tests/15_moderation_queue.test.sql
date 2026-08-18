-- The moderation queue, as the dashboard actually asks for it (M1 piece 5).
--
-- 01_posts_rls already pins who may SEE and who may APPROVE. What it does not cover is the
-- predicate the queue screen is built on — `status = 'pending' and ingest_state = 'ready'`
-- — which 0025 introduced and nothing has asserted since.
--
-- That predicate is the difference between a moderator reviewing an item and a moderator
-- staring at a row whose media is still being transcoded. It is also the one place where
-- the two orthogonal axes 0025 kept separate have to be read together, so it is worth
-- pinning that neither half is doing the other's job.
--
-- ── And the decision the maintainer took on pending media ────
--
-- Derivatives land in the CDN-fronted `public/` bucket at ingest, before approval. The
-- accepted posture is that the bytes sit behind an unguessable v4 UUID, nothing links to
-- them until approval, and §8's takedown path already deletes them on request — so what
-- has to hold is that the UUID stays undiscoverable through the API. Tests 9 and 10 are
-- that: a member cannot read the id, the object key, or the asset paths of a pending post
-- that is not theirs.

begin;
create extension if not exists pgtap;

-- 6 the predicate · 3 approval and its rights precondition · 2 the paths stay private
select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'queue-author@t.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'queue-mod@t.local'),
  ('00000000-0000-0000-0000-0000000000e3', 'queue-nosy@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000e2', 'moderator',
        '00000000-0000-0000-0000-0000000000e2');

-- license and provenance are set on every fixture that will ever be approved, because
-- posts_approved_has_rights (§7: "nothing goes public without recorded provenance and a
-- license") refuses the UPDATE otherwise. cc05 deliberately omits them — that is test 9.
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          ingest_object_key, ingest_state, status,
                          approved_by, approved_at, content_hash)
values
  -- The only row that belongs in a queue.
  ('00000000-0000-0000-0000-00000000cc01', 'media', 'ready and pending', 'reviewable',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000e1/ready', 'ready', 'pending', null, null, null),
  -- Media still in the worker. Pending, but there is nothing to look at.
  ('00000000-0000-0000-0000-00000000cc02', 'media', 'still processing', 'not reviewable yet',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000e1/processing', 'processing', 'pending', null, null, null),
  -- Refused by the sniffer. Also pending, also nothing to look at.
  ('00000000-0000-0000-0000-00000000cc03', 'media', 'failed ingest', 'refused',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000e1/failed', 'failed', 'pending', null, null, null),
  -- Ready, but a decision was already made. Attribution is written out by hand here
  -- because posts_approved_is_attributable requires it and the trigger that normally
  -- supplies it fires BEFORE UPDATE, not before insert — so a row born approved has to
  -- carry its own.
  ('00000000-0000-0000-0000-00000000cc04', 'media', 'already approved', 'done',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000e1/approved', 'ready', 'approved', '00000000-0000-0000-0000-0000000000e2', now(), repeat('a', 64)),
  -- Reviewable, but with no recorded rights. Exactly what a member upload looks like
  -- today: claim_upload_slot accepts both fields and the share sheet does not collect
  -- them until M5.
  ('00000000-0000-0000-0000-00000000cc05', 'media', 'no rights recorded', 'reviewable',
   null, null, '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000e1/norights', 'ready', 'pending', null, null, null);

insert into public.media_assets (post_id, role, storage_path, bucket, mime)
values ('00000000-0000-0000-0000-00000000cc01', 'master',
        '00000000-0000-0000-0000-0000000000e1/ready', 'originals', 'image/jpeg'),
       ('00000000-0000-0000-0000-00000000cc01', 'thumb',
        '00000000-0000-0000-0000-00000000cc01/thumb.webp', 'public', 'image/webp'),
       -- On cc05, which stays pending for the whole file. Test 11 has to ask about a post
       -- that is STILL pending: the first draft asked about cc01, which test 7 approves,
       -- so it was asserting that approved media is hidden — which it is not, and should
       -- not be. The distinction is the entire point of the assertion.
       ('00000000-0000-0000-0000-00000000cc05', 'thumb',
        '00000000-0000-0000-0000-00000000cc05/thumb.webp', 'public', 'image/webp');

create function pg_temp.queue_ids() returns setof uuid
language sql stable as $fn$
  select p.id from public.posts p
   where p.status = 'pending' and p.ingest_state = 'ready'
   order by p.created_on, p.id;
$fn$;

create function pg_temp.status_of(p_id uuid) returns text
language sql stable security definer set search_path = '' as $fn$
  select p.status::text from public.posts p where p.id = p_id;
$fn$;

create function pg_temp.approver_of(p_id uuid) returns uuid
language sql stable security definer set search_path = '' as $fn$
  select p.approved_by from public.posts p where p.id = p_id;
$fn$;

-- ═══ 1–6 · The predicate ═════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000e2","role":"authenticated"}';

select is(
  (select count(*)::integer from pg_temp.queue_ids()), 2,
  'a moderator''s queue holds exactly the reviewable items');

select is(
  (select q from pg_temp.queue_ids() q limit 1),
  '00000000-0000-0000-0000-00000000cc01'::uuid,
  '...oldest first, and ready+pending');

-- The reason 0025 narrowed posts_moderation_queue_idx. An item mid-transcode reaches a
-- moderator as a row with nothing behind it.
select ok(
  '00000000-0000-0000-0000-00000000cc02'::uuid not in (select * from pg_temp.queue_ids()),
  'an item still processing is not queued — there would be nothing to look at');

select ok(
  '00000000-0000-0000-0000-00000000cc03'::uuid not in (select * from pg_temp.queue_ids()),
  'nor one whose ingest failed');

select ok(
  '00000000-0000-0000-0000-00000000cc04'::uuid not in (select * from pg_temp.queue_ids()),
  'nor one already decided');

-- The two axes stay orthogonal: ingest_state must not be doing status's job. If a ready
-- ingest implied a pending decision, the approved row above would be back in the queue.
select is(
  (select count(p.id)::integer from public.posts p
    where p.ingest_state = 'ready' and p.status = 'approved'), 1,
  'ready and approved coexist — ingest_state is not a moderation state (0025)');

-- ═══ 7–9 · Approving, and what it requires first ═════════════
--
-- The dashboard sends `status` and nothing else. These assert that is sufficient AND that
-- it is all that is needed: approved_by is written by the trigger, from auth.uid().

select lives_ok($$
  update public.posts set status = 'approved'
   where id = '00000000-0000-0000-0000-00000000cc01'
$$, 'a moderator approves by setting status alone');

-- §7's floor, and a real constraint on the dashboard: a post with no recorded licence or
-- provenance CANNOT be approved, by anyone, ever. The share sheet does not collect either
-- field until M5, so this is the state most member uploads are in today — which is why the
-- publish button has to refuse it in the UI with a reason, rather than sending an UPDATE
-- that comes back as a raw constraint violation.
select throws_ok($$
  update public.posts set status = 'approved'
   where id = '00000000-0000-0000-0000-00000000cc05'
$$, '23514', null,
  'a post with no licence or provenance cannot be approved (§7)');

reset role;

select is(
  pg_temp.approver_of('00000000-0000-0000-0000-00000000cc01'),
  '00000000-0000-0000-0000-0000000000e2'::uuid,
  '...and the trigger records WHO, from auth.uid() rather than from the request');

-- ═══ 10–11 · The pending object paths stay private ═══════════
--
-- The accepted posture on pending media (see the header) rests entirely on the UUID being
-- undiscoverable. These are that assumption, asserted.

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000e3","role":"authenticated"}';

select is(
  (select count(p.id)::integer from public.posts p
    where p.id = '00000000-0000-0000-0000-00000000cc02'), 0,
  'an unrelated member cannot see a pending post at all — so cannot learn its id');

select is(
  (select count(m.id)::integer from public.media_assets m
    where m.post_id = '00000000-0000-0000-0000-00000000cc05'), 0,
  '...nor the storage paths of its derivatives, which is what keeps the CDN URL unguessable');

select * from finish();
rollback;
