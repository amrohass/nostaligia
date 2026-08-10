-- STAGE 0, STEP 4 — prove the test harness before trusting a single result from it.
--
-- Deliberately NOT in supabase/tests/, because it contains an intentional failure and
-- would poison `supabase test db` forever. Run it by hand, once, and read the output:
--
--   npx supabase start
--   npx supabase db reset
--   psql "$(npx supabase status -o env | grep DB_URL | cut -d= -f2-)" -f supabase/harness_probe.sql
--
-- or paste it into Studio's SQL editor at http://127.0.0.1:54323.
--
-- WHAT IT IS FOR
--
-- pgTAP keeps its plan state in a temp table created by the session user. Every RLS
-- test in this suite calls `set local role authenticated` before asserting. If the
-- temp-schema privilege check bites after that role switch, EVERY assertion fails at
-- once with a permissions error — and a suite that fails for infrastructural reasons
-- looks exactly like a suite that caught a real bug, until you read the messages.
--
-- Worse is the inverse: if `set local role` silently did not take effect, every
-- denial test would pass while running as a superuser, and the suite would be
-- reporting that the database is secure because it never actually tested it.
-- Probe 3 is the one that rules that out.
--
-- EXPECTED OUTPUT — exactly this, in this order:
--
--   1..4
--   ok 1 - pgTAP works as the session user
--   ok 2 - pgTAP still works after SET LOCAL ROLE authenticated
--   ok 3 - the role switch actually took effect
--   not ok 4 - DELIBERATE FAILURE: this line must be present
--
-- Three ways to read a bad run:
--   · an ERROR at probe 2  → temp-schema collision. The suite is not usable as
--                            written; every RLS test needs a different role-switch
--                            mechanism.
--   · probe 3 fails        → SET LOCAL ROLE is not taking. Every denial test in the
--                            suite is meaningless. This is the dangerous one.
--   · probe 4 shows `ok`   → the harness cannot detect failure at all. Nothing this
--                            suite ever reports means anything.

begin;
create extension if not exists pgtap;

select plan(4);

-- 1 · Baseline: does pgTAP function at all, as the owner?
select ok(true, 'pgTAP works as the session user');

-- 2 · The temp-table question.
set local role authenticated;
select ok(true, 'pgTAP still works after SET LOCAL ROLE authenticated');

-- 3 · The silent-no-op question. If this reports the session superuser instead of
--     `authenticated`, every denial assertion in this suite is worthless.
select is(current_user::text, 'authenticated', 'the role switch actually took effect');

reset role;

-- 4 · Can the harness detect a failure? A suite that cannot fail is not a suite.
select ok(false, 'DELIBERATE FAILURE: this line must be present');

select * from finish();
rollback;
