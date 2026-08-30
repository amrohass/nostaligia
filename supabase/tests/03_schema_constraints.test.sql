-- Schema integrity — the constraints, from BOTH directions.
--
-- This file exists because of the `decade` finding: a generated column applied
-- cleanly through twelve migrations, two full resets and 43 green assertions without
-- ever being EVALUATED, because no fixture had ever set date_earliest. A constraint
-- that never rejects anything is decoration; a generated expression that never
-- computes anything is worse, because it looks tested.
--
-- The coverage inventory found twelve such columns on posts. Every one is exercised
-- here, and every CHECK is asserted to reject as well as accept.

begin;
create extension if not exists pgtap;

-- 6 decade · 3 EDTF · 4 event · 3 title/body · 4 place+source · 6 media · 3 releases
select plan(29);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e001', 'schema@test.local');
insert into public.profiles (id, handle) values
  ('00000000-0000-0000-0000-00000000e001', 'schema_user');
insert into public.places (id, name_ar, name_en, location) values
  ('00000000-0000-0000-0000-0000000000d1', 'ميدان المنارة', 'Al-Manara Square',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography);

-- ── decade: the 5-9 range that discriminates the two plausible expressions ──
-- (EXTRACT(...)::int / 10) * 10   -> 1967 becomes 1960   (correct)
-- (EXTRACT(...) / 10)::int * 10   -> 1967 becomes 1970   (wrong, and equally immutable)
insert into public.posts (id, kind, title_ar, body_ar, created_by, location_precision,
                          date_earliest, date_precision)
values
  ('00000000-0000-0000-0000-000000000d01','media','عقد','و','00000000-0000-0000-0000-00000000e001','hidden', date '1967-03-01','year'),
  ('00000000-0000-0000-0000-000000000d02','media','عقد','و','00000000-0000-0000-0000-00000000e001','hidden', date '1965-06-15','year'),
  ('00000000-0000-0000-0000-000000000d03','media','عقد','و','00000000-0000-0000-0000-00000000e001','hidden', date '1969-12-31','year'),
  ('00000000-0000-0000-0000-000000000d04','media','عقد','و','00000000-0000-0000-0000-00000000e001','hidden', date '1900-01-01','year'),
  ('00000000-0000-0000-0000-000000000d05','media','عقد','و','00000000-0000-0000-0000-00000000e001','hidden', date '2029-07-04','year'),
  ('00000000-0000-0000-0000-000000000d06','media','بلا تاريخ','و','00000000-0000-0000-0000-00000000e001','hidden', null, null);

select is((select decade from public.posts where id='00000000-0000-0000-0000-000000000d01'), 1960::smallint,
          'decade: 1967 -> 1960 (the assertion that separates the two expressions)');
select is((select decade from public.posts where id='00000000-0000-0000-0000-000000000d02'), 1960::smallint,
          'decade: 1965 -> 1960');
select is((select decade from public.posts where id='00000000-0000-0000-0000-000000000d03'), 1960::smallint,
          'decade: 1969 -> 1960');
select is((select decade from public.posts where id='00000000-0000-0000-0000-000000000d04'), 1900::smallint,
          'decade: 1900 -> 1900 (lower edge)');
select is((select decade from public.posts where id='00000000-0000-0000-0000-000000000d05'), 2020::smallint,
          'decade: 2029 -> 2020 (upper edge)');
select is((select decade from public.posts where id='00000000-0000-0000-0000-000000000d06'), null,
          'decade: NULL date_earliest yields NULL, not 0');

-- ── EDTF date constraints ────────────────────────────────────
select lives_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,
        date_earliest,date_latest,date_precision)
      values ('media','مدى','و','00000000-0000-0000-0000-00000000e001','hidden',
              date '1960-01-01', date '1969-12-31','decade') $q$,
  'a decade-precision RANGE is accepted — heritage dates are not single days');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,
        date_earliest,date_latest)
      values ('media','مقلوب','و','00000000-0000-0000-0000-00000000e001','hidden',
              date '1969-12-31', date '1960-01-01') $q$,
  '23514', null, 'date_latest before date_earliest is refused');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,date_precision)
      values ('media','بلا تاريخ','و','00000000-0000-0000-0000-00000000e001','hidden','year') $q$,
  '23514', null, 'a date_precision with no date is refused');

-- ── The event cluster — kind='event' had NEVER been inserted ──
select lives_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,
        event_starts_at,event_ends_at,venue_ar)
      values ('event','معرض','و','00000000-0000-0000-0000-00000000e001','hidden',
              timestamptz '2026-04-01 16:00+03', timestamptz '2026-04-01 20:00+03','بلدية رام الله') $q$,
  'a well-formed event is accepted');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision)
      values ('event','بلا موعد','و','00000000-0000-0000-0000-00000000e001','hidden') $q$,
  '23514', null, 'an event with no start time is refused');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,event_starts_at)
      values ('media','صورة بموعد','و','00000000-0000-0000-0000-00000000e001','hidden',
              timestamptz '2026-04-01 16:00+03') $q$,
  '23514', null, 'event columns on a non-event row are refused');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,
        event_starts_at,event_ends_at)
      values ('event','ينتهي قبل أن يبدأ','و','00000000-0000-0000-0000-00000000e001','hidden',
              timestamptz '2026-04-01 20:00+03', timestamptz '2026-04-01 16:00+03') $q$,
  '23514', null, 'an event ending before it starts is refused');

-- ── The English branch of the title/body OR constraints ──────
-- Every fixture so far satisfied these via the Arabic side only, so the second
-- half of both OR expressions had never been the reason a row was accepted.
select lives_ok(
  $q$ insert into public.posts (kind,title_en,body_en,created_by,location_precision)
      values ('media','English only','A description','00000000-0000-0000-0000-00000000e001','hidden') $q$,
  'an English-only post satisfies the title and body constraints');

select throws_ok(
  $q$ insert into public.posts (kind,body_ar,created_by,location_precision)
      values ('media','و','00000000-0000-0000-0000-00000000e001','hidden') $q$,
  '23514', null, 'a post with no title in either language is refused');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,created_by,location_precision)
      values ('media','بلا وصف','00000000-0000-0000-0000-00000000e001','hidden') $q$,
  '23514', null, 'a post with no description in either language is refused (§9)');

-- ── place_id and location_source ─────────────────────────────
select lives_ok(
  $q$ insert into public.posts (id,kind,title_ar,body_ar,created_by,location_precision,
        place_id,location_source)
      values ('00000000-0000-0000-0000-000000000d10','media','بمكان','و',
              '00000000-0000-0000-0000-00000000e001','hidden',
              '00000000-0000-0000-0000-0000000000d1','admin') $q$,
  'place_id and location_source accept valid values');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,place_id)
      values ('media','مكان وهمي','و','00000000-0000-0000-0000-00000000e001','hidden',
              '00000000-0000-0000-0000-0000000000ff') $q$,
  '23503', null, 'place_id rejects a non-existent place (FK)');

delete from public.places where id = '00000000-0000-0000-0000-0000000000d1';
select is((select place_id from public.posts where id='00000000-0000-0000-0000-000000000d10'), null,
          'deleting a place sets place_id NULL rather than deleting the memory');

select throws_ok(
  $q$ insert into public.posts (kind,title_ar,body_ar,created_by,location_precision,location_source)
      values ('media','مصدر','و','00000000-0000-0000-0000-00000000e001','hidden','satellite') $q$,
  '22P02', null, 'location_source rejects a value outside the enum');

-- ── media_assets: the ladder invariants ──────────────────────
insert into public.posts (id,kind,title_ar,body_ar,created_by,location_precision)
values ('00000000-0000-0000-0000-000000000d20','media','بوسائط','و',
        '00000000-0000-0000-0000-00000000e001','hidden');

select lives_ok(
  $q$ insert into public.media_assets (post_id,role,storage_path,bucket,mime)
      values ('00000000-0000-0000-0000-000000000d20','master','originals/a.mp4','originals','video/mp4') $q$,
  'a master in originals/ is accepted');

select throws_ok(
  $q$ insert into public.media_assets (post_id,role,storage_path,bucket,mime)
      values ('00000000-0000-0000-0000-000000000d20','master','public/b.mp4','public','video/mp4') $q$,
  '23514', null,
  'a master in the public bucket is refused (§6 — preservation and delivery never conflated)');

select throws_ok(
  $q$ insert into public.media_assets (post_id,role,storage_path,bucket,mime)
      values ('00000000-0000-0000-0000-000000000d20','master','originals/c.mp4','originals','video/mp4') $q$,
  '23505', null, 'a second master on one post is refused');

select throws_ok(
  $q$ insert into public.media_assets (post_id,role,rendition,storage_path,bucket,mime)
      values ('00000000-0000-0000-0000-000000000d20','thumb','1080p','public/d.jpg','public','image/jpeg') $q$,
  '23514', null, 'a rendition label on a non-rendition row is refused');

select throws_ok(
  $q$ insert into public.media_assets (post_id,role,storage_path,bucket,mime)
      values ('00000000-0000-0000-0000-000000000d20','rendition','public/e.mp4','public','video/mp4') $q$,
  '23514', null, 'a rendition with no rung is refused');

select throws_ok(
  $q$ insert into public.media_assets (post_id,role,storage_path,bucket,mime)
      values ('00000000-0000-0000-0000-000000000d20','thumb','public/f.svg','public','image/svg+xml') $q$,
  '23514', null, 'SVG is refused at the column (§6)');

-- ── releases: exactly one active ─────────────────────────────
-- The fixture below has to be the ONLY active release, and on a database that has ever
-- published, it is not — the insert hits releases_only_one_active and takes the whole file
-- down before this section's first assertion. That is why this file could not be run
-- against the deployed database. On a fresh one this updates nothing, and either way the
-- transaction rolls back.
update public.releases set active = false;
insert into public.releases (path, active) values ('/v/2026-08-11T09:00:00Z/', true);
select throws_ok(
  $q$ insert into public.releases (path, active) values ('/v/2026-08-11T09:05:00Z/', true) $q$,
  '23505', null, 'two simultaneously-active releases are unrepresentable (§2)');

select lives_ok(
  $q$ insert into public.releases (path, active) values ('/v/2026-08-11T09:05:00Z/', false) $q$,
  'an inactive release alongside the active one is fine');

select throws_ok(
  $q$ insert into public.releases (path, active) values ('not-a-release-path', false) $q$,
  '23514', null, 'a malformed release path is refused');

select * from finish();
rollback;
