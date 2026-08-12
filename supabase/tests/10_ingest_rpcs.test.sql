-- The media worker's reach into the database (migration 0026).
--
-- The worker decodes attacker-supplied bytes, so the question this file answers is not
-- "does complete_ingest work" but "what can a compromised worker do". The answer has to
-- be: mark ingests complete or failed for keys it already knows, and nothing else. Every
-- assertion below is either a boundary on that, or a check that the boundary did not cost
-- us the actual feature.

begin;
create extension if not exists pgtap;

-- 8 privileges · 12 complete_ingest · 3 moderation safety · 5 fail_ingest
select plan(28);

-- ═══ Fixtures ════════════════════════════════════════════════

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'ingest-rpc@t.local');

insert into public.posts (id, kind, title_en, body_en, license, provenance,
                          created_by, ingest_object_key, ingest_state)
values
  ('00000000-0000-0000-0000-00000000ee01', 'media', 'happy', 'happy path fixture',
   'CC-BY-SA-4.0', 'fixture', '00000000-0000-0000-0000-0000000000f1', 'u1/happy', 'awaiting_bytes'),
  ('00000000-0000-0000-0000-00000000ee02', 'media', 'to fail', 'failure fixture',
   'CC-BY-SA-4.0', 'fixture', '00000000-0000-0000-0000-0000000000f1', 'u1/fails', 'processing'),
  ('00000000-0000-0000-0000-00000000ee03', 'media', 'validation', 'validation fixture',
   'CC-BY-SA-4.0', 'fixture', '00000000-0000-0000-0000-0000000000f1', 'u1/valid', 'awaiting_bytes');

-- The well-formed asset set is written out at each call site rather than held in a temp
-- view. The first attempt used a view and it failed with "permission denied for view
-- good_assets" — which is the boundary under test doing its job, since media_worker holds
-- no read grant on anything. Granting the test fixture to it would have quietly widened
-- the very thing these assertions exist to pin.
--
-- For the same reason the assertions cannot look at the tables while impersonating the
-- worker. These observers run with owner rights purely so the harness can see. That
-- media_worker cannot read these tables directly is asserted below, where it belongs.

create function pg_temp.asset_count(p_post uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select count(*)::integer from public.media_assets m where m.post_id = p_post;
$fn$;

create function pg_temp.post_ingest_state(p_post uuid) returns text
language sql stable security definer set search_path = '' as $fn$
  select p.ingest_state::text from public.posts p where p.id = p_post;
$fn$;

-- ═══ 1–8 · Privileges ════════════════════════════════════════

select has_role('media_worker', 'the media_worker role exists');

-- The boundary. No table grants at all: a compromised worker cannot read the archive.
select ok(
  not has_table_privilege('media_worker', 'public.posts', 'SELECT'),
  'media_worker cannot read posts');

select ok(
  not has_table_privilege('media_worker', 'public.media_assets', 'SELECT'),
  'media_worker cannot read media_assets either — only the functions touch them');

select ok(
  has_function_privilege('media_worker', 'public.complete_ingest(text,text,jsonb)', 'execute'),
  'media_worker can execute complete_ingest');

select ok(
  has_function_privilege('media_worker', 'public.fail_ingest(text,text)', 'execute'),
  'media_worker can execute fail_ingest');

-- A member who could call these would mark their own upload ready with asset paths they
-- chose — unprocessed bytes in front of a moderator, and then in front of the public.
select ok(
  not has_function_privilege('authenticated', 'public.complete_ingest(text,text,jsonb)', 'execute'),
  'a member cannot complete their own ingest');

select ok(
  not has_function_privilege('authenticated', 'public.fail_ingest(text,text)', 'execute'),
  'nor fail somebody else''s');

select ok(
  not has_function_privilege('anon', 'public.complete_ingest(text,text,jsonb)', 'execute'),
  'and anon reaches neither');

-- ═══ 9–20 · complete_ingest ══════════════════════════════════
--
-- Run as the owner, not as media_worker, and that is sound rather than convenient: both
-- functions are SECURITY DEFINER and read nothing about their caller — no auth.uid(), no
-- role check, the object key arrives as an argument. Behaviour is therefore identical
-- whoever calls them, and WHO may call them is asserted above by grant, which is where
-- that belongs.
--
-- The first draft did impersonate the worker here and failed with "function
-- is(text, unknown, unknown) does not exist": pgtap lives in a schema media_worker has no
-- USAGE on, so the assertion helpers themselves disappeared. The fix was not to grant the
-- worker access to the extensions schema — that would widen production privileges to suit
-- a test, and the narrowness is the entire point of the role.

select is(
  public.complete_ingest('u1/does-not-exist', 'image/jpeg', '[{"role":"master","storage_path":"u1/happy/master.jpg","bucket":"originals","mime":"image/jpeg","bytes":204800,"width":4000,"height":3000,"sort_order":0},{"role":"thumb","storage_path":"u1/happy/thumb.webp","bucket":"public","mime":"image/webp","bytes":8192,"width":400,"height":300,"sort_order":1}]'::jsonb) ->> 'reason',
  'unknown_object',
  'an object with no post is refused rather than creating one');

select is(
  public.complete_ingest('', 'image/jpeg', '[{"role":"master","storage_path":"u1/happy/master.jpg","bucket":"originals","mime":"image/jpeg","bytes":204800,"width":4000,"height":3000,"sort_order":0},{"role":"thumb","storage_path":"u1/happy/thumb.webp","bucket":"public","mime":"image/webp","bytes":8192,"width":400,"height":300,"sort_order":1}]'::jsonb) ->> 'reason',
  'missing_object_key',
  'an empty key is refused before any lookup');

select is(
  public.complete_ingest('u1/valid', 'image/jpeg', '[]'::jsonb) ->> 'reason',
  'no_assets',
  'a completion with no derivatives is not a completion');

select is(
  public.complete_ingest('u1/valid', 'image/jpeg', '[
    {"role":"master","storage_path":"a","bucket":"originals","mime":"image/jpeg"},
    {"role":"master","storage_path":"b","bucket":"originals","mime":"image/jpeg"}
  ]'::jsonb) ->> 'reason',
  'expected_exactly_one_master',
  'two masters means the worker lost track of which file this is');

-- §6: the master is the archival copy, lives in originals/, and is never CDN-fronted. A
-- master row pointing at public/ has published the untouched original, EXIF and all.
select is(
  public.complete_ingest('u1/valid', 'image/jpeg', '[
    {"role":"master","storage_path":"a","bucket":"public","mime":"image/jpeg"}
  ]'::jsonb) ->> 'reason',
  'master_must_be_in_originals',
  'a master in the public bucket is refused');

select is(
  public.complete_ingest('u1/valid', 'image/jpeg', '[
    {"role":"master","storage_path":"a","bucket":"originals","mime":"image/jpeg"},
    {"role":"thumb","storage_path":"b","bucket":"originals","mime":"image/webp"}
  ]'::jsonb) ->> 'reason',
  'derivative_must_be_in_public',
  'a derivative hidden in originals/ is refused — it would never reach the CDN');

-- None of the six refusals above may have written anything.
select is(
  pg_temp.asset_count('00000000-0000-0000-0000-00000000ee03'),
  0,
  'and not one of those refusals created an asset row');

select is(
  (public.complete_ingest('u1/happy', 'image/jpeg', '[{"role":"master","storage_path":"u1/happy/master.jpg","bucket":"originals","mime":"image/jpeg","bytes":204800,"width":4000,"height":3000,"sort_order":0},{"role":"thumb","storage_path":"u1/happy/thumb.webp","bucket":"public","mime":"image/webp","bytes":8192,"width":400,"height":300,"sort_order":1}]'::jsonb) ->> 'ok')::boolean,
  true,
  'a well-formed completion succeeds');

select is(
  pg_temp.asset_count('00000000-0000-0000-0000-00000000ee01'),
  2,
  '...writing both asset rows');

select is(
  pg_temp.post_ingest_state('00000000-0000-0000-0000-00000000ee01'),
  'ready',
  '...and moving the post to ready');

-- Replay. Two workers, or one worker retrying a request whose response was lost.
select is(
  (public.complete_ingest('u1/happy', 'image/jpeg', '[{"role":"master","storage_path":"u1/happy/master.jpg","bucket":"originals","mime":"image/jpeg","bytes":204800,"width":4000,"height":3000,"sort_order":0},{"role":"thumb","storage_path":"u1/happy/thumb.webp","bucket":"public","mime":"image/webp","bytes":8192,"width":400,"height":300,"sort_order":1}]'::jsonb) ->> 'idempotent')::boolean,
  true,
  'a replay is idempotent rather than a second set of derivatives');

select is(
  pg_temp.asset_count('00000000-0000-0000-0000-00000000ee01'),
  2,
  '...and really did not duplicate the assets');

-- ═══ 21–23 · Moderation state is untouched ═══════════════════

select is(
  (select p.status::text from public.posts p
    where p.id = '00000000-0000-0000-0000-00000000ee01'),
  'pending',
  'completing an ingest does not approve anything');

select is(
  (select a.action from public.audit_log a
    where a.target_id = '00000000-0000-0000-0000-00000000ee01'
      and a.action like 'ingest.%'
    order by a.created_at desc limit 1),
  'ingest.complete',
  'the audit row names the ingest, not a generic post.edit');

-- actor is NULL and that is the design: the worker is not a person, and audit_log.actor
-- references auth.users. A sentinel user would surface in admin user lists and could be
-- granted a role. NULL actor plus an ingest-specific action keeps `actor` meaning
-- "a human did this" everywhere it appears.
select is(
  (select count(*)::integer from public.moderation_actions
    where target_id = '00000000-0000-0000-0000-00000000ee01'),
  0,
  'and ingest never reaches the team-readable moderation log');

-- ═══ 24–28 · fail_ingest ═════════════════════════════════════

select is(
  public.fail_ingest('u1/nope', 'whatever') ->> 'reason',
  'unknown_object',
  'failing an object with no post is refused');

select is(
  (public.fail_ingest('u1/fails', 'sniffed image/svg+xml, refused by §6') ->> 'ok')::boolean,
  true,
  'a refused upload can be marked failed');

-- A finished ingest cannot be un-finished, or a compromised worker could void the media
-- behind an item that has already been approved and published.
select is(
  public.fail_ingest('u1/happy', 'trying to void a completed ingest') ->> 'reason',
  'terminal_state',
  'ready is terminal — fail_ingest cannot walk it back');

select is(
  public.complete_ingest('u1/fails', 'image/jpeg', '[{"role":"master","storage_path":"u1/happy/master.jpg","bucket":"originals","mime":"image/jpeg","bytes":204800,"width":4000,"height":3000,"sort_order":0},{"role":"thumb","storage_path":"u1/happy/thumb.webp","bucket":"public","mime":"image/webp","bytes":8192,"width":400,"height":300,"sort_order":1}]'::jsonb) ->> 'reason',
  'terminal_state',
  'and failed is terminal in the other direction');

select is(
  (select a.action from public.audit_log a
    where a.target_id = '00000000-0000-0000-0000-00000000ee02'
      and a.action like 'ingest.%'
    order by a.created_at desc limit 1),
  'ingest.failed',
  'the failure is named in the audit trail too');

select * from finish();
rollback;
