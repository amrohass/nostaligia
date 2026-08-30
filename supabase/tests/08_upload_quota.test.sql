-- The daily upload quota (§6, cost ceiling layer three).
--
-- The failure this file exists to catch is a quota that reports "denied" while still
-- writing the counter, or reports "allowed" while writing nothing. Either way the
-- ceiling stops being a ceiling, and neither shows up in a test that only asserts the
-- return value. So every denial assertion here has a paired assertion that the
-- counter did NOT move, and every allow has one that it did.
--
-- The timezone pair at the end is the one that looks like paranoia and is not: the
-- day boundary IS the reset, current_date is evaluated in the caller's TimeZone, and
-- a session that can `SET TimeZone` can otherwise roll itself a fresh allowance.

begin;
create extension if not exists pgtap;

-- 4 structure · 2 limits · 3 guards · 7 bytes · 2 counts · 5 role · 2 timezone
select plan(25);

-- ── Fixtures ─────────────────────────────────────────────────
-- A separate user per scenario. Sharing one would make each assertion depend on the
-- order of the ones before it, and a quota test whose fixtures interfere is a quota
-- test that passes for the wrong reason.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'q-bytes@t.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'q-mod@t.local'),
  ('00000000-0000-0000-0000-0000000000c3', 'q-count@t.local'),
  ('00000000-0000-0000-0000-0000000000c4', 'q-tz-east@t.local'),
  ('00000000-0000-0000-0000-0000000000c5', 'q-tz-west@t.local');

insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000c2', 'moderator');

-- ═══ Structure ═══════════════════════════════════════════════
select is(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_upload_quota'),
  true,
  'claim_upload_quota is SECURITY DEFINER — upload_quota is unreachable otherwise');

select ok(
  not has_function_privilege('anon', 'public.claim_upload_quota(bigint)', 'execute'),
  'anon cannot execute claim_upload_quota');

select ok(
  has_function_privilege('authenticated', 'public.claim_upload_quota(bigint)', 'execute'),
  'authenticated can execute claim_upload_quota — it runs as the caller, by design');

-- The structural half of the timezone pin. The behavioural half is at the end; this
-- one fails the moment someone deletes the SET clause, whatever time the suite runs.
select ok(
  (select p.proconfig from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_upload_quota')
  @> array['TimeZone=UTC'],
  'claim_upload_quota pins TimeZone=UTC — the day boundary is the quota reset');

-- ═══ The limits themselves ═══════════════════════════════════
select is(
  (select row(max_count, max_bytes)::text from public.upload_daily_limits('member')),
  row(20, 1073741824::bigint)::text,
  'member daily ceiling is 20 uploads / 1 GiB');

select is(
  (select row(max_count, max_bytes)::text from public.upload_daily_limits('moderator')),
  row(200, 42949672960::bigint)::text,
  'moderator daily ceiling is 200 uploads / 40 GiB');

-- ═══ Guards ══════════════════════════════════════════════════
-- anon does not get a polite JSON refusal, because anon cannot execute the function
-- at all. Asserting the throw rather than a return value is the point: if someone
-- ever grants execute to anon "so it can return a nicer error", this fails.
set local role anon;
set local request.jwt.claims to '';
select throws_ok(
  $$ select public.claim_upload_quota(1024) $$,
  '42501', 'permission denied for function claim_upload_quota',
  'anon cannot reach the quota function at all — execute is revoked');
reset role;

-- The in-function guard is still load-bearing. `authenticated` is a database role,
-- and a request carrying it with no usable sub claim reaches the body with
-- auth.uid() NULL. That caller is what this branch is for.
set local role authenticated;
set local request.jwt.claims to '';
select is(
  public.claim_upload_quota(1024) ->> 'reason', 'unauthenticated',
  'authenticated with no subject claim is refused before anything is counted');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';
select is(
  public.claim_upload_quota(0) ->> 'reason', 'invalid_bytes',
  'a zero-byte declaration is refused rather than counted as a free upload');
reset role;

-- ═══ Bytes: the ceiling holds, and refusals cost nothing ═════
--
-- The assertions below need to SEE the counter while impersonating a caller who is
-- rightly forbidden from reading it. This observer runs with owner rights purely so
-- the harness can look. That `authenticated` cannot read upload_quota directly is
-- asserted in 05_matrix, where it belongs — it is not what this file is testing.
create function pg_temp.quota_count(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select q.count from public.upload_quota q
   where q.user_id = p_user and q.day = (now() at time zone 'UTC')::date;
$fn$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';

select is(
  (public.claim_upload_quota(1024) ->> 'allowed')::boolean, true,
  'a member''s first upload of the day is admitted');

select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000c1'), 1,
  '...and the counter moved to 1');

-- Larger than the ENTIRE daily budget. This is the case the ON CONFLICT guard cannot
-- catch on its own, because on the first upload of a day there is no conflict to
-- guard — hence the explicit check before the insert.
select is(
  public.claim_upload_quota(2000000000) ->> 'reason', 'over_daily_bytes',
  'a single file larger than the whole daily budget is refused');

select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000c1'), 1,
  '...and that refusal wrote nothing — the counter is still 1');

select is(
  (public.claim_upload_quota(600000000) ->> 'allowed')::boolean, true,
  'a 600 MB upload fits inside the remaining budget');

select is(
  public.claim_upload_quota(600000000) ->> 'reason', 'quota_exceeded',
  'a second 600 MB upload would cross 1 GiB and is refused');

select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000c1'), 2,
  '...and THAT refusal wrote nothing either — still 2, not 3');
reset role;

-- ═══ Count: twenty is twenty ═════════════════════════════════
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}';

-- Twenty admitted calls, each one byte, so the byte ceiling is nowhere near and the
-- only thing under test is the count.
select public.claim_upload_quota(1) from generate_series(1, 20);

select is(
  public.claim_upload_quota(1) ->> 'reason', 'quota_exceeded',
  'the twenty-first upload of the day is refused on count');

select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000c3'), 20,
  '...and the count stayed at 20');
reset role;

-- ═══ Role comes from the table, and raises the ceiling ═══════
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}';

select is(
  public.claim_upload_quota(4294967296) ->> 'role', 'moderator',
  'the role in the receipt is resolved from user_roles, not from any claim');

select is(
  (select (public.claim_upload_quota(4294967296) ->> 'allowed')::boolean), true,
  'a 4 GB master is inside a moderator''s daily budget — §6''s cap, not a member''s');
reset role;

-- ═══ …and a claim that DISAGREES with the table loses ════════
--
-- The assertion above says "not from any claim", and until 31 Aug 2026 it could not have
-- caught that: its token carries no role claim at all, so a function that preferred the
-- claim would have passed it for want of anything to prefer. §5's rule is specifically
-- about a token the attacker controls the contents of — "authorization lives in RLS
-- policies and Edge Functions, nowhere else" — so the case worth pinning is a MEMBER whose
-- token says otherwise, loudly, in both of the claim names the access-token hook could
-- plausibly use.
--
-- Verified live against the deployed database the same day, as the real harness member.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated","user_role":"admin","app_role":"admin"}';

-- CONTROL, and this file would be lying without it: if the claims never reached the
-- session the two assertions below would pass because there was no forgery to ignore,
-- which is the same shape as the bug they replace.
select is(
  current_setting('request.jwt.claims', true)::jsonb ->> 'user_role', 'admin',
  'CONTROL: the forged admin claim really is on the session the function runs in');

select is(
  public.claim_upload_quota(4294967296) ->> 'role', 'member',
  'a member whose token CLAIMS admin is still a member to the quota');

select is(
  public.claim_upload_quota(4294967296) ->> 'reason', 'over_daily_bytes',
  '...so the 4 GB a moderator was just granted is refused for them');
reset role;

-- ═══ The day is UTC, whatever the session says ═══════════════
--
-- Two sessions on opposite sides of the date line. At any instant at least one of
-- them disagrees with UTC about what day it is, so if the SET clause is ever removed
-- one of these two assertions fails — whenever CI happens to run.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c4","role":"authenticated"}';
set local timezone = 'Pacific/Kiritimati';   -- UTC+14
select is(
  (public.claim_upload_quota(1) ->> 'day')::date,
  (now() at time zone 'UTC')::date,
  'at UTC+14 the quota day is still the UTC day');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c5","role":"authenticated"}';
set local timezone = 'Pacific/Midway';       -- UTC-11
select is(
  (public.claim_upload_quota(1) ->> 'day')::date,
  (now() at time zone 'UTC')::date,
  'at UTC-11 the quota day is still the UTC day');
reset role;

select * from finish();
rollback;
