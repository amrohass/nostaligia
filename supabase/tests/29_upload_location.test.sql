-- Where a contribution happened (0049), and what publishing it means.
--
-- posts.location has existed since 0006 with a fuzzing trigger, a publisher and a geo shard
-- behind it, and until M4 nothing ever wrote it — so this file is the first thing that says
-- whether that whole pipeline produces anything.
--
-- The assertions are mostly about §7 rather than about plumbing, because the plumbing fails
-- loudly and §7 fails silently:
--
--   · a gazetteer place publishes the curated point unfuzzed, and a PIN publishes snapped
--     to roughly a block. Getting that backwards would publish a contributor's home to the
--     metre and would look completely normal on the map.
--   · location_public is DERIVED (0021). A path that wrote it directly would bypass the
--     fuzzing entirely, which is the exact failure 0021 was written to end.
--   · a coordinate the client sent beside a place id must be ignored, or naming Al-Manara
--     and filing the item elsewhere is a two-line request.
--   · every refusal has to come BEFORE the quota charge, or a typo costs a member an upload.

begin;
create extension if not exists pgtap;

-- 4 the gazetteer path · 4 the pin path · 4 refusals · 2 the charge · 3 the moderator's fix
select plan(17);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000a0c1', 'loc-member@t.local'),
  ('00000000-0000-0000-0000-00000000a0c2', 'loc-mod@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000a0c2', 'moderator',
        '00000000-0000-0000-0000-00000000a0c2');

insert into public.places (id, name_ar, name_en, location, unconfirmed)
values
  ('00000000-0000-0000-0000-00000000bc01', 'المنارة', 'Al-Manara Square',
   extensions.st_setsrid(extensions.st_makepoint(35.2042, 31.8996), 4326)::extensions.geography,
   false),
  -- A name with no coordinate: legitimate, and the case where a place id must NOT produce a
  -- point out of nowhere.
  ('00000000-0000-0000-0000-00000000bc02', 'بيت الحكاية', null, null, true);

/* Same shape as 27_upload_decade's, and for the same reason: 0032's rights capture refuses
   an upload before the location is looked at, so without these keys every assertion below
   would read consent_required and prove nothing about coordinates. */
create function pg_temp.draft(p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable as $fn$
  select jsonb_build_object(
    'title_en', 'a title',
    'body_en', 'a description',
    'license', 'CC-BY-SA-4.0',
    'provenance', 'family album',
    'consent', jsonb_build_object('granted', true)
  ) || p_extra;
$fn$;

create function pg_temp.claim(p_key text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql as $fn$
  select public.claim_upload_slot(
    1024,
    '00000000-0000-0000-0000-00000000a0c1/' || p_key,
    'media'::public.post_kind,
    pg_temp.draft(p_extra));
$fn$;

create function pg_temp.claimed(p_key text) returns public.posts
language sql stable security definer as $fn$
  select p.* from public.posts p
   where p.ingest_object_key = '00000000-0000-0000-0000-00000000a0c1/' || p_key;
$fn$;

/* The published point, to six decimals, as "lat,lon" — or null. Read through a definer
   function because 0015 grants no browser role SELECT on `location`, which is the point. */
create function pg_temp.published(p_key text) returns text
language sql stable security definer as $fn$
  select case when p.location_public is null then null
              else round(extensions.st_y(p.location_public::extensions.geometry)::numeric, 6)::text
                   || ',' ||
                   round(extensions.st_x(p.location_public::extensions.geometry)::numeric, 6)::text
         end
    from public.posts p
   where p.ingest_object_key = '00000000-0000-0000-0000-00000000a0c1/' || p_key;
$fn$;

create function pg_temp.charged() returns integer
language sql stable security definer as $fn$
  select coalesce(sum(q.count), 0)::integer
    from public.upload_quota q
   where q.user_id = '00000000-0000-0000-0000-00000000a0c1';
$fn$;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000a0c1","role":"authenticated"}';

-- ═══ 1–4 · A place out of the gazetteer ══════════════════════

select is(
  (pg_temp.claim('a', '{"place_id":"00000000-0000-0000-0000-00000000bc01"}') ->> 'allowed')::boolean,
  true,
  'a gazetteer place is accepted');

-- §7's "exact" is CHOSEN here, and 0049's header argues why: the coordinate is the
-- gazetteer's own, 0050 publishes it in places.json, and snapping it would move the item
-- off the landmark it is a photograph of while protecting nobody.
select is(
  (pg_temp.claimed('a')).location_precision::text,
  'exact',
  'a curated point publishes unfuzzed, because it is already published');

select is(
  pg_temp.published('a'),
  '31.899600,35.204200',
  '...and the published point is the landmark itself, to the digit');

-- The coordinate came from the ROW. A client that sent both must not be able to name one
-- place and file the item at another — the queue would show the landmark's name against it.
-- The claim is its own statement. Postgres does not promise which operand of `||` it
-- evaluates first, so a combined form could read the published point before the claim that
-- produces it — and would then pass or fail on the planner's mood.
do $$ begin
  perform pg_temp.claim('b', '{"place_id":"00000000-0000-0000-0000-00000000bc01",
                               "lat":"32.5","lon":"36.5"}');
end $$;

select is(
  pg_temp.published('b'),
  '31.899600,35.204200',
  'a coordinate sent beside a place id is ignored, not merged');

-- ═══ 5–8 · A pin the contributor placed ══════════════════════

select is(
  (pg_temp.claim('c', '{"lat":"31.902345","lon":"35.201678"}') ->> 'allowed')::boolean,
  true,
  'a dropped pin is accepted');

select is(
  (pg_temp.claimed('c')).location_precision::text,
  'street',
  'a pin nobody curated starts at block level (§7 — fuzzing is default-on)');

-- 0021 snaps to a 0.001° grid, which at this latitude is ~111 m by ~94 m. The assertion is
-- on the PUBLISHED column rather than on the raw one, because the raw one is not the thing
-- §7 protects anybody from.
select is(
  pg_temp.published('c'),
  '31.902000,35.202000',
  '...and the published point is snapped to the grid, not the point that was sent');

-- The other half of that sentence: the archive still holds the precise coordinate, for the
-- moderator and the record. Fuzzing is a publishing rule, not a data-loss rule.
select ok(
  extensions.st_y((pg_temp.claimed('c')).location::extensions.geometry) between 31.90234 and 31.90235,
  'the exact point is still in `location`, which is what location_public exists to protect');

-- ═══ 9–12 · Refusals ═════════════════════════════════════════

-- The draft is a jsonb blob a browser composed. A bare cast on any of these raises inside a
-- SECURITY DEFINER function and reaches the member as a 500 with a Postgres error in it.
select is(
  pg_temp.claim('d', '{"place_id":"not-a-uuid"}') ->> 'reason',
  'invalid_place',
  'a malformed place id is a named refusal, not a 500');

select is(
  pg_temp.claim('e', '{"place_id":"00000000-0000-0000-0000-0000000000ff"}') ->> 'reason',
  'unknown_place',
  'a place id nothing matches is refused rather than silently dropped');

select is(
  pg_temp.claim('f', '{"lat":"north","lon":"35.2"}') ->> 'reason',
  'invalid_coordinates',
  'a non-numeric coordinate is a named refusal');

select is(
  pg_temp.claim('g', '{"lat":"91.0","lon":"35.2"}') ->> 'reason',
  'invalid_coordinates',
  'a latitude off the planet is refused, not clamped');

-- ═══ 13–14 · An unlocated place, and the charge ══════════════

-- An unconfirmed gazetteer entry has no point. The item is filed under the NAME and carries
-- no coordinate, which is exactly what 'hidden' means and is not a refusal.
do $$ begin
  perform pg_temp.claim('h', '{"place_id":"00000000-0000-0000-0000-00000000bc02"}');
end $$;

select is(
  (pg_temp.claimed('h')).place_id::text
    || ' ' || (pg_temp.claimed('h')).location_precision::text
    || ' ' || coalesce(pg_temp.published('h'), 'null'),
  '00000000-0000-0000-0000-00000000bc02 hidden null',
  'a place with no coordinate files the item under the name and publishes no point');

-- Every refusal comes before claim_upload_quota, so a bad coordinate costs a member nothing.
-- Eight claims above; four were refused.
select is(
  pg_temp.charged(),
  4,
  'the four refusals were never charged');

-- ═══ 15–17 · A moderator corrects it (R1) ════════════════════

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000a0c2","role":"authenticated"}';

select is(
  public.set_post_location((pg_temp.claimed('c')).id,
                           '00000000-0000-0000-0000-00000000bc01', null, null, null) ->> 'saved',
  'true',
  'a moderator re-attaches a pinned item to a gazetteer place');

select is(
  pg_temp.published('c'),
  '31.899600,35.204200',
  '...and the published point moves with it');

-- The branch that had no other route: clearing a pin that should never have been placed.
-- 'hidden' publishes nothing, which is the whole of §7's default.
do $$ begin
  perform public.set_post_location((pg_temp.claimed('c')).id, null, null, null, null);
end $$;

select is(
  (pg_temp.claimed('c')).location_precision::text
    || ' ' || coalesce(pg_temp.published('c'), 'null'),
  'hidden null',
  'clearing the location takes the item off the map entirely');

reset role;
select * from finish();
rollback;
