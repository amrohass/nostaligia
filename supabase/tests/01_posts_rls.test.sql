-- The posts denial matrix: every cell of the SELECT table in 0018, plus the write
-- denials, run as anon / member / moderator.
--
-- Role switching is written inline rather than wrapped in a helper, because SET LOCAL
-- inside a function does not reliably survive the function's return — a helper that
-- silently stopped switching roles would make every denial below pass for the wrong
-- reason. Verbose and unambiguous beats tidy here.

begin;
create extension if not exists pgtap;

select plan(17);

-- ── Fixtures, as the owner (RLS does not apply) ──────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a001', 'member@test.local'),
  ('00000000-0000-0000-0000-00000000a002', 'moderator@test.local'),
  ('00000000-0000-0000-0000-00000000a003', 'other@test.local');

insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-00000000a002', 'moderator');

insert into public.profiles (id, handle) values
  ('00000000-0000-0000-0000-00000000a001', 'member_one'),
  ('00000000-0000-0000-0000-00000000a002', 'mod_one'),
  ('00000000-0000-0000-0000-00000000a003', 'other_one');

-- The BEFORE INSERT stamp trigger returns early when auth.uid() is null, so these
-- land exactly as written — which is what lets us build an approved row directly.
insert into public.posts
  (id, kind, title_ar, body_ar, status, created_by,
   location, location_precision, location_public,
   license, provenance, approved_by, approved_at, content_hash)
values
  ('00000000-0000-0000-0000-0000000000f1'::uuid, 'media', 'منشور معتمد', 'وصف',
   'approved', '00000000-0000-0000-0000-00000000a001',
   extensions.st_setsrid(extensions.st_makepoint(35.2034, 31.9038), 4326)::extensions.geography,
   'area',
   extensions.st_setsrid(extensions.st_makepoint(35.20, 31.90), 4326)::extensions.geography,
   'CC BY-SA 4.0', 'family album',
   '00000000-0000-0000-0000-00000000a002', now(),
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),

  ('00000000-0000-0000-0000-0000000000f2'::uuid, 'media', 'قيد المراجعة لي', 'وصف',
   'pending', '00000000-0000-0000-0000-00000000a001', null, 'hidden', null,
   null, null, null, null, null),

  ('00000000-0000-0000-0000-0000000000f3'::uuid, 'media', 'قيد المراجعة لغيري', 'وصف',
   'pending', '00000000-0000-0000-0000-00000000a003', null, 'hidden', null,
   null, null, null, null, null),

  ('00000000-0000-0000-0000-0000000000f4'::uuid, 'media', 'مسحوب لغيري', 'وصف',
   'withdrawn', '00000000-0000-0000-0000-00000000a003', null, 'hidden', null,
   null, null, null, null, null);

-- ═══ anon ════════════════════════════════════════════════════
-- SET LOCAL rather than select set_config(): set_config is a function call and emits
-- a result row into the TAP stream. Harness parsers treat unrecognised lines as
-- "unknown" rather than failing, but a test suite whose output needs a tolerant
-- parser is one bad day from being misread. SET is a utility command and prints
-- nothing.
set local role anon;
set local request.jwt.claims to '';

-- §2: public visitors cause zero database reads. anon holds no grant at all, so
-- this is refused by privilege before RLS is ever consulted.
select throws_ok(
  $q$ select id from public.posts $q$,
  '42501',
  null,
  'anon cannot read posts at all — no grant, not merely no rows'
);

select throws_ok(
  $q$ select id from public.profiles $q$,
  '42501',
  null,
  'anon cannot read profiles directly'
);

reset role;

-- ═══ member ══════════════════════════════════════════════════
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000a001","role":"authenticated"}';

select is(
  (select count(*) from public.posts where id = '00000000-0000-0000-0000-0000000000f1'),
  1::bigint,
  'member sees an approved post'
);

select is(
  (select count(*) from public.posts where id = '00000000-0000-0000-0000-0000000000f2'),
  1::bigint,
  'member sees THEIR OWN pending post'
);

select is(
  (select count(*) from public.posts where id = '00000000-0000-0000-0000-0000000000f3'),
  0::bigint,
  'member cannot see another member''s pending post (CLAUDE.md §5)'
);

select is(
  (select count(*) from public.posts where id = '00000000-0000-0000-0000-0000000000f4'),
  0::bigint,
  'member cannot see another member''s withdrawn post'
);

-- Column privileges: §7's aggregate, refused one column at a time.
select throws_ok(
  $q$ select location from public.posts $q$,
  '42501', null,
  'member cannot read raw posts.location even on an approved row (§7)'
);

select throws_ok(
  $q$ select created_by from public.posts $q$,
  '42501', null,
  'member cannot read posts.created_by — the author→post mapping (§7)'
);

select throws_ok(
  $q$ select created_at from public.posts $q$,
  '42501', null,
  'member cannot read exact posts.created_at — day precision only (§7)'
);

-- …but the day-precision column is there, which is the point.
select lives_ok(
  $q$ select created_on from public.posts $q$,
  'member CAN read posts.created_on, the day-precision timestamp'
);

-- Writes.
select throws_ok(
  $q$ update public.posts set status = 'approved'
      where id = '00000000-0000-0000-0000-0000000000f2' $q$,
  '42501', null,
  'member cannot approve their own pending post'
);

select throws_ok(
  $q$ update public.posts set takedown = true
      where id = '00000000-0000-0000-0000-0000000000f2' $q$,
  '42501', null,
  'member cannot take down their own post — takedown is a moderator verb (§4)'
);

select lives_ok(
  $q$ update public.posts set status = 'withdrawn'
      where id = '00000000-0000-0000-0000-0000000000f2' $q$,
  'member CAN withdraw their own post (§7 right to withdraw)'
);

-- The author's own full row, including everything the column grants withheld.
select is(
  (select count(*) from public.posts_full()
   where location is not null and id = '00000000-0000-0000-0000-0000000000f1'),
  1::bigint,
  'posts_full() returns the author their own raw location'
);

select is(
  (select count(*) from public.posts_full()
   where id = '00000000-0000-0000-0000-0000000000f3'),
  0::bigint,
  'posts_full() does not leak another member''s pending post to a member'
);

reset role;

-- ═══ moderator ═══════════════════════════════════════════════
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000a002","role":"authenticated"}';

-- The blanket read on pending: deliberate, because approve/reject is
-- unimplementable without it.
select is(
  (select count(*) from public.posts
   where id in ('00000000-0000-0000-0000-0000000000f3',
                '00000000-0000-0000-0000-0000000000f4')),
  2::bigint,
  'moderator sees others'' pending AND withdrawn posts (deliberate — see 0018)'
);

select lives_ok(
  $q$ update public.posts
      set status = 'approved', license = 'CC BY-SA 4.0', provenance = 'donor'
      where id = '00000000-0000-0000-0000-0000000000f3' $q$,
  'moderator CAN approve another member''s pending post'
);

reset role;

select * from finish();
rollback;
