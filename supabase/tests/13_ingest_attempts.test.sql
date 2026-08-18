-- ingest_attempts, processing_started_at, and the audio rung (migrations 0029, 0030).
--
-- Two things are under test and they are related by one argument. The ceiling that 0031
-- installs is only worth anything if a member cannot reset the counter it reads, so the
-- privilege assertions below are not bookkeeping — they are the ceiling. And the audio
-- rendition value only earns its place if it solved the problem WITHOUT relaxing the
-- constraint that keeps video renditions honest, so that constraint is asserted still
-- standing.

begin;
create extension if not exists pgtap;

-- 3 audio rung · 5 columns · 4 privileges · 5 counting
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'attempts-one@t.local');

insert into public.posts (id, kind, title_en, body_en, created_by,
                          ingest_object_key, ingest_state)
values
  ('00000000-0000-0000-0000-00000000ff01', 'voice', 'a voice note', 'archival description',
   '00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000c1/voice', 'awaiting_bytes'),
  ('00000000-0000-0000-0000-00000000ff02', 'media', 'counting', 'attempt counting fixture',
   '00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000c1/counting', 'awaiting_bytes');

create function pg_temp.attempts_of(p_key text) returns integer
language sql stable security definer set search_path = '' as $fn$
  select p.ingest_attempts::integer from public.posts p where p.ingest_object_key = p_key;
$fn$;

create function pg_temp.started_of(p_key text) returns timestamptz
language sql stable security definer set search_path = '' as $fn$
  select p.processing_started_at from public.posts p where p.ingest_object_key = p_key;
$fn$;

-- ═══ 1–3 · The audio rung ════════════════════════════════════

select ok(
  'audio' = any (enum_range(null::public.media_rendition)::text[]),
  'media_rendition can express an audio delivery variant');

-- The whole reason 0029 exists: §6 requires normalized audio in public/, and before this
-- there was no row shape that could hold it.
select lives_ok($$
  insert into public.media_assets (post_id, role, rendition, storage_path, bucket, mime,
                                   bytes, duration_s, bitrate_kbps)
  values ('00000000-0000-0000-0000-00000000ff01', 'rendition', 'audio',
          'c1/voice/audio.opus', 'public', 'audio/ogg', 40960, 62.5, 48)
$$, 'a normalized audio derivative can be written to public/');

-- And the constraint that made 0029 necessary is still doing its job. If the audio problem
-- had been "solved" by allowing role='rendition' with a null rung, every video rendition
-- would silently become unlabelled and M6's player would have nothing to select on.
select throws_ok($$
  insert into public.media_assets (post_id, role, rendition, storage_path, bucket, mime)
  values ('00000000-0000-0000-0000-00000000ff01', 'rendition', null,
          'c1/voice/nameless', 'public', 'audio/ogg')
$$, '23514', null,
  '...and a rendition with no rung is still refused — the constraint was not relaxed');

-- ═══ 4–8 · The columns ═══════════════════════════════════════

select has_column('public', 'posts', 'ingest_attempts', 'posts records how many workers have had it');
select has_column('public', 'posts', 'processing_started_at', 'and when the current one took it');

select col_not_null('public', 'posts', 'ingest_attempts',
  'ingest_attempts is never null — a null ceiling is no ceiling');

select throws_ok($$
  insert into public.posts (kind, title_en, body_en, created_by, ingest_attempts)
  values ('media', 'negative', 'negative attempts', '00000000-0000-0000-0000-0000000000c1', -1)
$$, '23514', null,
  'a negative attempt count is refused');

select is(
  pg_temp.started_of('00000000-0000-0000-0000-0000000000c1/counting'), null,
  'processing_started_at is null until a worker actually takes it');

-- ═══ 9–12 · Privileges — this IS the ceiling ═════════════════
--
-- 0015 revoked everything on posts and grants back column by column, so these hold by
-- construction. They are asserted anyway because the failure is silent: a later migration
-- that grants a column range would leave 0031's ceiling in place, tested, and worthless.

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_attempts', 'UPDATE'),
  'a member cannot reset their own attempt counter');

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'processing_started_at', 'UPDATE'),
  'nor backdate when a worker took their upload');

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_attempts', 'SELECT'),
  'and does not read it either — the refusal reason carries that information');

select ok(
  not has_column_privilege('anon', 'public.posts', 'ingest_attempts', 'UPDATE'),
  'anon reaches neither column');

-- ═══ 13–17 · begin_ingest counts ═════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';

select is(
  (public.begin_ingest('00000000-0000-0000-0000-0000000000c1/counting') ->> 'attempts')::integer,
  1,
  'the first hand-off is attempt 1');

reset role;

select is(
  pg_temp.attempts_of('00000000-0000-0000-0000-0000000000c1/counting'), 1,
  '...and the row agrees');

select isnt(
  pg_temp.started_of('00000000-0000-0000-0000-0000000000c1/counting'), null,
  '...with the moment it was taken recorded');

-- A client polling complete-upload in a loop must not inflate the counter, or three real
-- attempts would be spent by a retry that invoked nothing.
--
-- The stamp is backdated first, by hand. Inside a single transaction now() is frozen, so
-- comparing before and after would pass whether or not the second call rewrote it — the
-- assertion would look green and test nothing. An impossible old value is the only way to
-- tell "left alone" from "rewritten to the same instant".
update public.posts
   set processing_started_at = '2020-01-01T00:00:00Z'
 where ingest_object_key = '00000000-0000-0000-0000-0000000000c1/counting';

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000c1","role":"authenticated"}';

select is(
  (public.begin_ingest('00000000-0000-0000-0000-0000000000c1/counting') ->> 'attempts')::integer,
  1,
  'a second call reports the same attempt rather than spending another');

reset role;

select is(
  pg_temp.started_of('00000000-0000-0000-0000-0000000000c1/counting'),
  '2020-01-01T00:00:00Z'::timestamptz,
  '...and leaves the stamp alone, so a stuck job cannot look perpetually fresh');

select * from finish();
rollback;
