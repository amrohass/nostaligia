-- An upload whose bytes never arrived is failed after its window, and its day's slot returned (0065).
--
-- ── What this file has to discriminate ───────────────────────
--
--   1. WHICH rows. The two sets in 1 and 2 are exact over this file's fixtures, and the
--      fixtures sit on both sides of every edge: 60 vs 70 minutes for a member (the window
--      is 65), 3 vs 7 hours for a moderator (6h05), attempts 0 vs 1, pending vs approved.
--      A window that forgot the transfer, that ignored the role, or that reaped a row a
--      worker had given back each moves one named row into the wrong set.
--   2. the slot, and ONLY the slot. Count comes back by exactly one per reaped row; bytes
--      do not come back at all (the header of 0065 says why that is the ceiling, not a
--      shortfall). 4 and 5 read sums per user, and 7 pins the DAY with a fixture from 30 hours ago —
--      a slot goes back to the day it was charged on, not the day the reaper ran.
--   3. that it happens once. 8 runs it again; a reaper that released on every pass would
--      hand a member a fresh slot every fifteen minutes.
--   4. what the member meets afterwards: their late complete-upload is refused as
--      terminal (10), not revived.
--
-- Assertions are scoped to fixtures. Against the deployed database the function also
-- reaps real orphans inside this rolled-back transaction, so nothing here counts them.

begin;
create extension if not exists pgtap;

/* One fixture is APPROVED with no media, to prove it is left alone. 0063's media rule is a
   deferred check at a commit this file never reaches (as in 33_comments_publish). */
set constraints public.posts_approved_has_media deferred;

-- 2 which rows · 1 the reason · 4 the slot · 1 once · 1 the trail · 1 afterwards
-- · 1 who may run it · 1 the schedule
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000043a1', 'ex-member@t.local'),
  ('00000000-0000-0000-0000-0000000043a2', 'ex-mod@t.local'),
  ('00000000-0000-0000-0000-0000000043a3', 'ex-empty@t.local'),
  ('00000000-0000-0000-0000-0000000043a4', 'ex-yesterday@t.local');

update public.email_confirmations set confirmed_at = now() where confirmed_at is null;

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000043a2', 'moderator',
        '00000000-0000-0000-0000-0000000043a2');

-- Inserted before any JWT is set: posts_stamp_authorship returns early, so created_at and
-- author_label stand as written. That is the only way to put a row an hour in the past.
insert into public.posts (id, kind, title_en, body_en, status, created_by, author_label,
                          ingest_object_key, ingest_state, ingest_attempts, created_at) values
  ('00000000-0000-0000-0000-0000000043f1', 'media', 'abandoned', 'never sent', 'pending',
   '00000000-0000-0000-0000-0000000043a1', 'member',
   '00000000-0000-0000-0000-0000000043a1/old', 'awaiting_bytes', 0, now() - interval '70 minutes'),
  ('00000000-0000-0000-0000-0000000043f2', 'media', 'still uploading', 'slow line', 'pending',
   '00000000-0000-0000-0000-0000000043a1', 'member',
   '00000000-0000-0000-0000-0000000043a1/fresh', 'awaiting_bytes', 0, now() - interval '60 minutes'),
  ('00000000-0000-0000-0000-0000000043f3', 'media', 'given back by a worker', 'bytes are there', 'pending',
   '00000000-0000-0000-0000-0000000043a1', 'member',
   '00000000-0000-0000-0000-0000000043a1/released', 'awaiting_bytes', 1, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000043f4', 'media', 'a 4 GB master', 'long transfer', 'pending',
   '00000000-0000-0000-0000-0000000043a2', 'moderator',
   '00000000-0000-0000-0000-0000000043a2/mid', 'awaiting_bytes', 0, now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000043f5', 'media', 'a master that never came', 'gave up', 'pending',
   '00000000-0000-0000-0000-0000000043a2', 'moderator',
   '00000000-0000-0000-0000-0000000043a2/old', 'awaiting_bytes', 0, now() - interval '7 hours'),
  ('00000000-0000-0000-0000-0000000043f6', 'media', 'nothing left to return', 'quota at zero', 'pending',
   '00000000-0000-0000-0000-0000000043a3', 'member',
   '00000000-0000-0000-0000-0000000043a3/old', 'awaiting_bytes', 0, now() - interval '2 hours'),
  -- Charged on a day that is certainly not today, for assertion 7's "which day".
  ('00000000-0000-0000-0000-0000000043f8', 'media', 'from yesterday', 'a different day', 'pending',
   '00000000-0000-0000-0000-0000000043a4', 'member',
   '00000000-0000-0000-0000-0000000043a4/old', 'awaiting_bytes', 0, now() - interval '30 hours');

insert into public.posts (id, kind, title_en, body_en, status, created_by, author_label,
                          ingest_object_key, ingest_state, ingest_attempts, created_at,
                          license, provenance, consent, approved_by, approved_at, content_hash)
values ('00000000-0000-0000-0000-0000000043f7', 'media', 'approved with no bytes', 'an anomaly',
        'approved', '00000000-0000-0000-0000-0000000043a1', 'member',
        '00000000-0000-0000-0000-0000000043a1/approved', 'awaiting_bytes', 0,
        now() - interval '3 hours',
        'CC-BY-SA-4.0', 'family album', jsonb_build_object('granted', true, 'may_withdraw', true),
        '00000000-0000-0000-0000-0000000043a2', now(),
        '15df9d67f8e90a98014647411681314ce17bf434981db443bf36cae14532a677');

-- A quota row for every day any fixture was charged on — one day, or two across midnight.
-- The member and moderator start at 5 slots / 1000 bytes a day; the third member at zero.
insert into public.upload_quota (user_id, day, count, bytes)
select distinct p.created_by, (p.created_at at time zone 'UTC')::date,
       case when p.created_by = '00000000-0000-0000-0000-0000000043a3' then 0 else 5 end,
       case when p.created_by = '00000000-0000-0000-0000-0000000043a3' then 0 else 1000 end
  from public.posts p
 where p.id::text like '00000000-0000-0000-0000-0000000043f%'
on conflict (user_id, day) do nothing;

-- ...and a row for TODAY beside the 30-hours-ago one, so a slot returned to the wrong day
-- has somewhere to land and be seen.
insert into public.upload_quota (user_id, day, count, bytes)
values ('00000000-0000-0000-0000-0000000043a4', (now() at time zone 'UTC')::date, 5, 1000)
on conflict (user_id, day) do nothing;

create temp table quota_before as
  select user_id, sum(count)::integer as n, sum(bytes)::bigint as b, count(*)::integer as days
    from public.upload_quota
   where user_id::text like '00000000-0000-0000-0000-0000000043a%'
   group by user_id;

create function pg_temp.quota_of(p uuid) returns table (n integer, b bigint)
language sql stable as $fn$
  select sum(count)::integer, sum(bytes)::bigint from public.upload_quota where user_id = p;
$fn$;

do $$ begin perform public.expire_unstarted_uploads(); end $$;

-- ═══ 1-2 · Exactly which rows ════════════════════════════════

select set_eq(
  $q$ select id::text from public.posts
       where id::text like '00000000-0000-0000-0000-0000000043f%' and ingest_state = 'failed' $q$,
  array['00000000-0000-0000-0000-0000000043f1',    -- member, 70 min: past 5 + 60
        '00000000-0000-0000-0000-0000000043f5',    -- moderator, 7 h: past 5 min + 6 h
        '00000000-0000-0000-0000-0000000043f6',    -- member, 2 h, whose quota is already 0
        '00000000-0000-0000-0000-0000000043f8'],   -- member, 30 h
  'the reaper fails exactly the never-started uploads past their window');

select set_eq(
  $q$ select id::text from public.posts
       where id::text like '00000000-0000-0000-0000-0000000043f%' and ingest_state = 'awaiting_bytes' $q$,
  array['00000000-0000-0000-0000-0000000043f2',    -- member, 60 min: a slow upload may still land
        '00000000-0000-0000-0000-0000000043f3',    -- attempts 1: a worker gave it back, bytes exist
        '00000000-0000-0000-0000-0000000043f4',    -- moderator, 3 h: a 4 GB master's window is longer
        '00000000-0000-0000-0000-0000000043f7'],   -- approved: not this function's to judge
  'and leaves alone a member''s slow upload, a worker-released row, a moderator''s long transfer and an approved row');

select results_eq(
  $q$ select ingest_error, status::text from public.posts
       where id = '00000000-0000-0000-0000-0000000043f1' $q$,
  $q$ values ('upload_expired', 'pending') $q$,
  'the reaped row names why — upload_expired, which /me renders — and its status, a human axis, is untouched');

-- ═══ 4-7 · The slot comes back, the bytes do not ═════════════

select results_eq(
  $q$ select n, b from pg_temp.quota_of('00000000-0000-0000-0000-0000000043a1') $q$,
  $q$ select n - 1, b from quota_before where user_id = '00000000-0000-0000-0000-0000000043a1' $q$,
  'the member gets back exactly ONE slot — one row reaped of four — and none of the bytes');

select results_eq(
  $q$ select n, b from pg_temp.quota_of('00000000-0000-0000-0000-0000000043a2') $q$,
  $q$ select n - 1, b from quota_before where user_id = '00000000-0000-0000-0000-0000000043a2' $q$,
  'the moderator likewise: one slot for the one reaped master, bytes still charged');

select results_eq(
  $q$ select n, b from pg_temp.quota_of('00000000-0000-0000-0000-0000000043a3') $q$,
  $q$ values (0, 0::bigint) $q$,
  'a day already at zero stays at zero — never negative, and the constraint never raises');

-- The day the slot was TAKEN from, not the day the reaper happened to run. Without the
-- 30-hour fixture this is only observable within a few hours of UTC midnight.
select results_eq(
  $q$ select day = (now() at time zone 'UTC')::date, count from public.upload_quota
       where user_id = '00000000-0000-0000-0000-0000000043a4' order by day $q$,
  $q$ values (false, 4), (true, 5) $q$,
  'the slot goes back to the day it was charged on — yesterday''s row gives one back, today''s is untouched');

-- ═══ 8 · Once ════════════════════════════════════════════════

do $$ begin perform public.expire_unstarted_uploads(); end $$;

select results_eq(
  $q$ select n, b from pg_temp.quota_of('00000000-0000-0000-0000-0000000043a1') $q$,
  $q$ select n - 1, b from quota_before where user_id = '00000000-0000-0000-0000-0000000043a1' $q$,
  'a second pass returns nothing more — a reaped row is terminal, so its slot is returned once');

-- ═══ 9 · On the record ═══════════════════════════════════════

select is(
  (select count(*) from public.audit_log
    where target_id = '00000000-0000-0000-0000-0000000043f1'
      and action = 'ingest.failed' and actor is null),
  1::bigint,
  'audit_log records the machine failing it — ingest.failed, no human actor');

-- ═══ 10 · What the member meets afterwards ═══════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000043a1","role":"authenticated"}';

select is(
  public.begin_ingest('00000000-0000-0000-0000-0000000043a1/old') ->> 'reason',
  'terminal_state',
  'a complete-upload arriving after the reaper is refused as terminal, not revived');

-- ═══ 11 · Who may run it ═════════════════════════════════════

select throws_ok($q$ select public.expire_unstarted_uploads() $q$, '42501', null,
  'a member cannot run the reaper — it hands back quota');

reset role;

-- ═══ 12 · It runs on its own ═════════════════════════════════

select results_eq(
  $q$ select schedule, command from cron.job where jobname = 'rma-expire-uploads' $q$,
  $q$ values ('*/15 * * * *'::text, 'select public.expire_unstarted_uploads()'::text) $q$,
  'pg_cron runs it every fifteen minutes');

select * from finish();
rollback;
