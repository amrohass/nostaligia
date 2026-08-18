-- release_ingest (migration 0031).
--
-- This function exists to fix a stranded-state defect, and in fixing it opens a loop that
-- costs Cloud Run money. So the assertions come in two halves: the boundary (whose ingest
-- may a caller hand back) and the bound (how many times, before the answer is no).
--
-- The negative space matters as much as the feature. A worker that could release its own
-- job could ask to be handed work forever, which is the same billing vector from the other
-- end — so what media_worker CANNOT reach is asserted here rather than assumed from 0026.

begin;
create extension if not exists pgtap;

-- 6 privileges · 3 boundary · 4 the release · 4 terminal · 3 the ceiling
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'release-one@t.local'),
  ('00000000-0000-0000-0000-0000000000d2', 'release-two@t.local');

insert into public.posts (id, kind, title_en, body_en, created_by,
                          ingest_object_key, ingest_state, ingest_attempts,
                          processing_started_at)
values
  ('00000000-0000-0000-0000-0000000aa001', 'media', 'mine', 'my upload',
   '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000d1/mine', 'processing', 1, now()),
  ('00000000-0000-0000-0000-0000000aa002', 'media', 'theirs', 'their upload',
   '00000000-0000-0000-0000-0000000000d2',
   '00000000-0000-0000-0000-0000000000d2/theirs', 'processing', 1, now()),
  ('00000000-0000-0000-0000-0000000aa003', 'media', 'done', 'already ingested',
   '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000d1/done', 'ready', 1, now()),
  ('00000000-0000-0000-0000-0000000aa004', 'media', 'refused', 'sniffer refused it',
   '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000d1/refused', 'failed', 1, now()),
  ('00000000-0000-0000-0000-0000000aa005', 'media', 'looping', 'ceiling fixture',
   '00000000-0000-0000-0000-0000000000d1',
   '00000000-0000-0000-0000-0000000000d1/looping', 'awaiting_bytes', 0, null);

create function pg_temp.state_of(p_key text) returns text
language sql stable security definer set search_path = '' as $fn$
  select p.ingest_state::text from public.posts p where p.ingest_object_key = p_key;
$fn$;

create function pg_temp.attempts_of(p_key text) returns integer
language sql stable security definer set search_path = '' as $fn$
  select p.ingest_attempts::integer from public.posts p where p.ingest_object_key = p_key;
$fn$;

create function pg_temp.started_of(p_key text) returns timestamptz
language sql stable security definer set search_path = '' as $fn$
  select p.processing_started_at from public.posts p where p.ingest_object_key = p_key;
$fn$;

-- ═══ 1–6 · Privileges ════════════════════════════════════════

select ok(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'release_ingest'),
  'release_ingest is SECURITY DEFINER — ingest_state stays un-writable directly');

select ok(
  not has_function_privilege('anon', 'public.release_ingest(text)', 'execute'),
  'anon cannot release anything');

select ok(
  has_function_privilege('authenticated', 'public.release_ingest(text)', 'execute'),
  'a signed-in member can release their own');

-- The worker's whole reach is complete_ingest and fail_ingest (0026). If it could release,
-- it could hand its own job back and be given another, forever — the billing loop this
-- migration bounds, entered from the worker side where no quota applies at all.
select ok(
  not has_function_privilege('media_worker', 'public.release_ingest(text)', 'execute'),
  'the worker cannot hand its own job back and ask for another');

select ok(
  not has_function_privilege('media_worker', 'public.begin_ingest(text)', 'execute'),
  'nor start one — ingest is reported by the worker, never driven by it');

select ok(
  not has_function_privilege(
    'media_worker',
    'public.claim_upload_slot(bigint,text,public.post_kind,jsonb)', 'execute'),
  'and it cannot create a draft post or spend anybody''s quota');

-- ═══ 7–9 · The ownership boundary ════════════════════════════

set local role authenticated;
set local request.jwt.claims to '';

select is(
  public.release_ingest('x/y') ->> 'reason', 'unauthenticated',
  'no subject claim, no release');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}';

-- The one that matters (§5). d1 must not be able to interfere with d2's in-flight upload.
select is(
  public.release_ingest('00000000-0000-0000-0000-0000000000d2/theirs') ->> 'reason',
  'object_key_not_owned',
  'a member cannot release somebody else''s ingest');

reset role;

select is(
  pg_temp.state_of('00000000-0000-0000-0000-0000000000d2/theirs'), 'processing',
  '...and the refused attempt left their row in flight, untouched');

-- ═══ 10–13 · The release ═════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}';

select is(
  (public.release_ingest('00000000-0000-0000-0000-0000000000d1/mine') ->> 'idempotent')::boolean,
  false,
  'the owner releases a job no worker took');

reset role;

select is(
  pg_temp.state_of('00000000-0000-0000-0000-0000000000d1/mine'), 'awaiting_bytes',
  '...putting it back where complete-upload can retry it');

select is(
  pg_temp.started_of('00000000-0000-0000-0000-0000000000d1/mine'), null,
  '...with the stamp cleared, because nothing is processing');

-- The bound. A release that gave the attempt back would make the ceiling unreachable and
-- turn this function into the unbounded loop it exists to bound.
select is(
  pg_temp.attempts_of('00000000-0000-0000-0000-0000000000d1/mine'), 1,
  '...and the attempt still spent');

-- ═══ 14–17 · Terminal states and replay ══════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}';

-- A 'ready' row may already be approved and published. Releasing it would invite a second
-- worker to overwrite media that is live.
select is(
  public.release_ingest('00000000-0000-0000-0000-0000000000d1/done') ->> 'reason',
  'terminal_state',
  'a finished ingest cannot be released');

select is(
  public.release_ingest('00000000-0000-0000-0000-0000000000d1/refused') ->> 'reason',
  'terminal_state',
  'nor a refused one — this is not a way to revive a rejected upload');

select is(
  (public.release_ingest('00000000-0000-0000-0000-0000000000d1/mine') ->> 'idempotent')::boolean,
  true,
  'releasing an already-released row is harmless');

select is(
  public.release_ingest('00000000-0000-0000-0000-0000000000d1/no-such-upload') ->> 'reason',
  'unknown_object',
  'a well-formed key with nothing behind it is refused');

-- ═══ 18–20 · The ceiling ═════════════════════════════════════
--
-- The loop this exists to stop, run for real: release, begin, release, begin. Each begin
-- spends an attempt and each release gives none back, so the fourth begin has to refuse.

select public.begin_ingest('00000000-0000-0000-0000-0000000000d1/looping');   -- 1
select public.release_ingest('00000000-0000-0000-0000-0000000000d1/looping');
select public.begin_ingest('00000000-0000-0000-0000-0000000000d1/looping');   -- 2
select public.release_ingest('00000000-0000-0000-0000-0000000000d1/looping');
select public.begin_ingest('00000000-0000-0000-0000-0000000000d1/looping');   -- 3
select public.release_ingest('00000000-0000-0000-0000-0000000000d1/looping');

select is(
  public.begin_ingest('00000000-0000-0000-0000-0000000000d1/looping') ->> 'reason',
  'too_many_attempts',
  'the fourth hand-off is refused — a member cannot spawn workers indefinitely');

reset role;

-- Refused, not failed. Three transient network errors are not a hostile file, and the
-- bytes are still sitting in quarantine intact.
select is(
  pg_temp.state_of('00000000-0000-0000-0000-0000000000d1/looping'), 'awaiting_bytes',
  '...leaving the row for a moderator or the M6 reaper rather than failing it');

select is(
  pg_temp.attempts_of('00000000-0000-0000-0000-0000000000d1/looping'), 3,
  '...and the refusal itself spent nothing');

select * from finish();
rollback;
