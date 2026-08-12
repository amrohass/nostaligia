-- begin_ingest (migration 0028).
--
-- This is the one function in the ingest path that a member calls directly and that
-- moves state, so the two things worth pinning are: it only ever moves their OWN upload,
-- and it only ever moves it once.

begin;
create extension if not exists pgtap;

-- 3 privileges · 6 refusals · 4 transition
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'begin-one@t.local'),
  ('00000000-0000-0000-0000-0000000000b2', 'begin-two@t.local');

insert into public.posts (id, kind, title_en, body_en, created_by,
                          ingest_object_key, ingest_state)
values
  ('00000000-0000-0000-0000-00000000dd01', 'media', 'mine', 'my upload',
   '00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000b1/mine', 'awaiting_bytes'),
  ('00000000-0000-0000-0000-00000000dd02', 'media', 'theirs', 'their upload',
   '00000000-0000-0000-0000-0000000000b2',
   '00000000-0000-0000-0000-0000000000b2/theirs', 'awaiting_bytes'),
  ('00000000-0000-0000-0000-00000000dd03', 'media', 'done', 'already ingested',
   '00000000-0000-0000-0000-0000000000b1',
   '00000000-0000-0000-0000-0000000000b1/done', 'ready');

create function pg_temp.state_of(p_key text) returns text
language sql stable security definer set search_path = '' as $fn$
  select p.ingest_state::text from public.posts p where p.ingest_object_key = p_key;
$fn$;

-- ═══ 1–3 · Privileges ════════════════════════════════════════

select ok(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'begin_ingest'),
  'begin_ingest is SECURITY DEFINER — ingest_state is not member-writable directly');

select ok(
  not has_function_privilege('anon', 'public.begin_ingest(text)', 'execute'),
  'anon cannot start an ingest');

select ok(
  has_function_privilege('authenticated', 'public.begin_ingest(text)', 'execute'),
  'a signed-in member can start their own');

-- ═══ 4–8 · Refusals ══════════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to '';

select is(
  public.begin_ingest('x/y') ->> 'reason', 'unauthenticated',
  'no subject claim, no ingest');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';

select is(
  public.begin_ingest('') ->> 'reason', 'invalid_object_key',
  'an empty key is refused');

-- The one that matters: b1 must not be able to drive b2's upload through the pipeline.
select is(
  public.begin_ingest('00000000-0000-0000-0000-0000000000b2/theirs') ->> 'reason',
  'object_key_not_owned',
  'a member cannot start somebody else''s ingest');

select is(
  public.begin_ingest('00000000-0000-0000-0000-0000000000b1/no-such-upload') ->> 'reason',
  'unknown_object',
  'a well-formed key with no draft behind it is refused');

select is(
  public.begin_ingest('00000000-0000-0000-0000-0000000000b1/done') ->> 'reason',
  'terminal_state',
  'a finished ingest cannot be restarted');

-- b2's row must be untouched by b1's attempt above.
reset role;
select is(
  pg_temp.state_of('00000000-0000-0000-0000-0000000000b2/theirs'), 'awaiting_bytes',
  '...and the refused attempt left the other member''s row alone');

-- ═══ 9–12 · The transition ═══════════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}';

select is(
  (public.begin_ingest('00000000-0000-0000-0000-0000000000b1/mine') ->> 'already_processing')::boolean,
  false,
  'the first call hands the upload to a worker');

-- The reason the HEAD in the original plan was replaced by a state transition: a member
-- calling this in a loop must not spawn a worker invocation each time.
select is(
  (public.begin_ingest('00000000-0000-0000-0000-0000000000b1/mine') ->> 'already_processing')::boolean,
  true,
  'the second call is harmless and tells the caller not to invoke again');

select is(
  (public.begin_ingest('00000000-0000-0000-0000-0000000000b1/mine') ->> 'ok')::boolean,
  true,
  '...and a retry is still ok rather than an error the client must special-case');

reset role;

select is(
  pg_temp.state_of('00000000-0000-0000-0000-0000000000b1/mine'), 'processing',
  '...with the row sitting in processing exactly once');

select * from finish();
rollback;
