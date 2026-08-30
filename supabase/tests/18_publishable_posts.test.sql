-- publishable_posts and redacted_post_ids (migration 0035).
--
-- This function decides what the world sees. Not "what a signed-in member sees, subject to
-- a policy that will catch a mistake" — what is written into an immutable file, cached for
-- a year, and served to everyone including people who will never visit the site again.
--
-- So the assertions here are mostly about what it does NOT return. shards.test.ts covers
-- the same ground from the other end, scanning emitted bytes for sentinels; this covers the
-- query. Two independent layers on purpose: this one is a query somebody will edit to add a
-- field, and that one is a gate that fails when they do.

begin;
create extension if not exists pgtap;

-- 3 privileges · 6 the predicate · 5 §7 and §5 · 3 redactions
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000fa01', 'pub-author@t.local'),
  ('00000000-0000-0000-0000-00000000fa02', 'pub-mod@t.local');

insert into public.profiles (id, handle, display_name)
values ('00000000-0000-0000-0000-00000000fa01', 'pub_author', 'صاحب الصورة');

insert into public.places (id, name_ar, name_en, location)
values ('00000000-0000-0000-0000-00000000fb01', 'المنارة', 'Al-Manara',
        st_setsrid(st_makepoint(35.2042, 31.8996), 4326)::geography);

-- Six rows: one publishable, and five that must not be.
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          place_id, location, location_precision, status, takedown,
                          ingest_state, approved_by, approved_at, content_hash)
values
  -- The only one that should come back.
  ('00000000-0000-0000-0000-0000000000d1', 'media', 'published', 'visible',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000fa01',
   '00000000-0000-0000-0000-00000000fb01',
   st_setsrid(st_makepoint(35.20429, 31.89961), 4326)::geography, 'street',
   'approved', false, 'ready',
   '00000000-0000-0000-0000-00000000fa02', now(), repeat('a', 64)),
  -- Awaiting a decision.
  ('00000000-0000-0000-0000-0000000000d2', 'media', 'pending', 'not yet',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000fa01', null,
   null, 'hidden', 'pending', false, 'ready', null, null, null),
  -- §8: taken down. The bytes are already gone; this stops the next release re-listing it.
  ('00000000-0000-0000-0000-0000000000d3', 'media', 'taken down', 'gone',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000fa01', null,
   null, 'hidden', 'approved', true, 'ready',
   '00000000-0000-0000-0000-00000000fa02', now(), repeat('a', 64)),
  -- Approved, but the transcode never finished: a card with a broken image.
  ('00000000-0000-0000-0000-0000000000d4', 'media', 'still processing', 'no derivatives',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000fa01', null,
   null, 'hidden', 'approved', false, 'processing',
   '00000000-0000-0000-0000-00000000fa02', now(), repeat('a', 64)),
  ('00000000-0000-0000-0000-0000000000d5', 'media', 'rejected', 'no',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000fa01', null,
   null, 'hidden', 'rejected', false, 'ready', null, null, null),
  -- Location hidden. It IS publishable; the coordinate is not.
  ('00000000-0000-0000-0000-0000000000d6', 'media', 'hidden place', 'no coordinate',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000fa01', null,
   st_setsrid(st_makepoint(35.5, 31.5), 4326)::geography, 'hidden',
   'approved', false, 'ready',
   '00000000-0000-0000-0000-00000000fa02', now(), repeat('a', 64));

insert into public.media_assets (post_id, role, storage_path, bucket, mime)
values ('00000000-0000-0000-0000-0000000000d1', 'thumb',
        '00000000-0000-0000-0000-0000000000d1/thumb.webp', 'public', 'image/webp'),
       ('00000000-0000-0000-0000-0000000000d1', 'master',
        '00000000-0000-0000-0000-00000000fa01/original', 'originals', 'image/jpeg');

-- Scoped to this file's own fixtures. publishable_posts() returns the WHOLE archive, so
-- unscoped the count assertion below read "the deployed archive holds exactly two
-- publishable posts" rather than "of these six fixtures, exactly these two qualify" — true
-- on an empty database and false on any real one. Every assertion in this file is about
-- which of ITS rows the predicate admits, so the filter belongs here, once.
create function pg_temp.ids() returns setof text
language sql stable as $fn$
  select item ->> 'id' from jsonb_array_elements(public.publishable_posts()) item
   where item ->> 'id' like '00000000-0000-0000-0000-%';
$fn$;

create function pg_temp.one(p_id text) returns jsonb
language sql stable as $fn$
  select item from jsonb_array_elements(public.publishable_posts()) item
   where item ->> 'id' = p_id;
$fn$;

-- ═══ 1–3 · Privileges ════════════════════════════════════════
--
-- §2's read path is "zero database reads for public visitors". An RPC that returns the
-- whole archive in one call is the most attractive possible way to violate that by
-- accident, so it is not reachable from a browser at any privilege level.

select ok(
  not has_function_privilege('anon', 'public.publishable_posts()', 'execute'),
  'anon cannot call publishable_posts');

select ok(
  not has_function_privilege('authenticated', 'public.publishable_posts()', 'execute'),
  '...nor can a signed-in member — §2 keeps the whole archive out of one round trip');

select ok(
  has_function_privilege('service_role', 'public.publishable_posts()', 'execute'),
  'the publisher can');

-- ═══ 4–9 · The predicate ═════════════════════════════════════

select is(
  (select count(*)::integer from pg_temp.ids()), 2,
  'exactly the two approved, ready, not-taken-down rows are publishable');

select ok(
  '00000000-0000-0000-0000-0000000000d2' not in (select * from pg_temp.ids()),
  'a pending post is not published');

select ok(
  '00000000-0000-0000-0000-0000000000d3' not in (select * from pg_temp.ids()),
  'nor a taken-down one — §8, so the next release does not re-list bytes that are gone');

select ok(
  '00000000-0000-0000-0000-0000000000d4' not in (select * from pg_temp.ids()),
  'nor one whose transcode never finished — there are no derivatives to show');

select ok(
  '00000000-0000-0000-0000-0000000000d5' not in (select * from pg_temp.ids()),
  'nor a rejected one');

select is(
  pg_temp.one('00000000-0000-0000-0000-0000000000d1') ->> 'author_handle',
  'pub_author',
  'the author comes back as a handle');

-- ═══ 10–14 · §7 and §5 ═══════════════════════════════════════
--
-- The heart of the file. Every one of these is a field that exists on the row and must not
-- exist in the output.

select ok(
  not (pg_temp.one('00000000-0000-0000-0000-0000000000d1') ? 'location'),
  '§7: the raw location is not in the payload at all, under any key');

select ok(
  not (pg_temp.one('00000000-0000-0000-0000-0000000000d1') ? 'created_by'),
  '§7: nor the author''s user id, which would join their whole history together');

select ok(
  not (pg_temp.one('00000000-0000-0000-0000-0000000000d1') ? 'created_at'),
  '§7: nor an exact timestamp — public timestamps are day precision');

select ok(
  not (pg_temp.one('00000000-0000-0000-0000-0000000000d1') ? 'ingest_object_key'),
  '§7: nor the object key, which begins with the uploader''s uuid');

-- The fuzzed point IS published, and for a 'hidden' post 0021 derives it as null — so the
-- coordinate is absent twice over, once by the trigger and once by shards.ts refusing to
-- emit it. Belt and braces on the one field §7 is most explicit about.
select is(
  pg_temp.one('00000000-0000-0000-0000-0000000000d6') -> 'location_public',
  'null'::jsonb,
  '...and a hidden post carries no coordinate even in location_public');

-- ═══ 15–17 · §5 and the redaction list ═══════════════════════
--
-- content_hash was set to 64 a's by hand above, which is not the hash of the row. The
-- function REPORTS the mismatch instead of hiding the row: a post that silently vanished
-- would look exactly like one that was never approved, and content altered after approval
-- is the case somebody needs to be told about.
select is(
  (pg_temp.one('00000000-0000-0000-0000-0000000000d1') -> 'hash_matches')::text,
  'false',
  '§5: a row whose hash does not match its approval is reported, not filtered away');

select is(
  (select count(*)::integer
     from jsonb_array_elements_text(public.redacted_post_ids())), 1,
  'the redaction list holds the taken-down post');

select is(
  (select value from jsonb_array_elements_text(public.redacted_post_ids())),
  '00000000-0000-0000-0000-0000000000d3',
  '...and it is the right one');

select * from finish();
rollback;
