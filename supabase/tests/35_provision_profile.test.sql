-- 0057 · a profile exists the moment an account does.
--
-- The failure this file exists to catch is the one that shipped for three milestones and
-- was found by looking at row counts rather than by any test: an account with no profile.
-- Nothing asserted it, because nothing asserted a relationship BETWEEN the two tables —
-- every profile test built its own fixture profiles by hand, which is exactly the shape
-- that hides a missing trigger.
--
-- So the first assertion here is the one that matters most, and it is deliberately about
-- the whole database rather than about a fixture.

begin;
create extension if not exists pgtap;

-- 1 invariant · 4 shape · 3 generated handle · 2 idempotence · 2 privilege
select plan(12);

-- ═══ The invariant ═══════════════════════════════════════════
-- Every account has a profile. Not "the one I just made" — every one, including whatever
-- the deployed database happens to be carrying when this is run against it.
select is(
  (select count(*)::int from auth.users u
    where not exists (select 1 from public.profiles p where p.id = u.id)),
  0,
  'every account in this database has a profile (§7 — no account without a public identity)');

-- ═══ A new account gets one, by trigger ══════════════════════
insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000e5001', 'provision-one@t.local');

select is(
  (select count(*)::int from public.profiles where id = '00000000-0000-0000-0000-0000000e5001'),
  1,
  'inserting an account creates its profile, with no help from any client');

select ok(
  (select handle from public.profiles where id = '00000000-0000-0000-0000-0000000e5001')
    like 'member\_%',
  '...carrying a placeholder handle');

-- avatar_path NULL is not an oversight: 0004 says the generated avatar is derived from the
-- id at render time rather than stored, and public.js renders it from the handle. Asserted
-- so that "mandatory avatar" is never satisfied by writing a path to a file nobody made.
select is(
  (select avatar_path from public.profiles where id = '00000000-0000-0000-0000-0000000e5001'),
  null,
  '...and NO avatar_path — null IS the generated avatar (§7)');

select is(
  (select visibility from public.profiles where id = '00000000-0000-0000-0000-0000000e5001'),
  '{"bio":"public","comments":"public","personalInfo":"public","contributions":"public"}'::jsonb,
  '...and the default visibility, not something the trigger invented');

-- ═══ The handle is legal, private and unique ═════════════════
select ok(
  public.is_allowed_handle(
    (select handle from public.profiles where id = '00000000-0000-0000-0000-0000000e5001')),
  'the generated handle passes is_allowed_handle — by construction, not by luck');

select ok(
  (select handle = public.normalized_handle(handle)
     from public.profiles where id = '00000000-0000-0000-0000-0000000e5001'),
  '...is already normalized, so the handle in the database is the handle in the URL');

-- §7: emails are never published, and a handle IS published. This is the assertion that
-- stops someone "improving" the placeholder into something friendlier later.
select ok(
  (select handle not like '%provision-one%' and handle not like '%t.local%'
     and handle not like '%' || replace('00000000-0000-0000-0000-0000000e5001', '-', '') || '%'
     from public.profiles where id = '00000000-0000-0000-0000-0000000e5001'),
  '...and carries nothing of the email or the account id (§7)');

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000e5002', 'provision-two@t.local');

select isnt(
  (select handle from public.profiles where id = '00000000-0000-0000-0000-0000000e5001'),
  (select handle from public.profiles where id = '00000000-0000-0000-0000-0000000e5002'),
  'two accounts get two different handles');

-- ═══ Idempotence ═════════════════════════════════════════════
-- The backfill runs the same function over existing rows, so calling it twice must not
-- rename anybody. A profile whose handle changed under it would break every published
-- profile/{handle}.json and every /u/{handle} link already shared.
select is(
  public.ensure_profile('00000000-0000-0000-0000-0000000e5001'),
  false,
  'ensure_profile on an account that already has one reports it did nothing');

select is(
  (select count(distinct handle)::int from public.profiles
    where id in ('00000000-0000-0000-0000-0000000e5001','00000000-0000-0000-0000-0000000e5002')),
  2,
  '...and did not rename it — a changed handle would break every link already shared');

-- ═══ Not reachable from a browser ════════════════════════════
select ok(
  not has_function_privilege('anon', 'public.ensure_profile(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.ensure_profile(uuid)', 'execute'),
  'ensure_profile is not executable by anon or authenticated — it is a trigger body, not an API');

select * from finish();
rollback;
