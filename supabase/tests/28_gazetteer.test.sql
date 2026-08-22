-- The gazetteer (0048), and the §4 trail behind it.
--
-- 0005 created `places` in M0 and 0017 settled who may write it ("the grants exist now so M4
-- has somewhere to land"). Nothing had ever read or written a row until M4, so this file is
-- the first thing that says whether any of it works.
--
-- What is worth asserting, in the order it can go wrong quietly:
--
--   · a search that matches nothing a contributor would type. Arabic is where this fails:
--     the definite article ال fuses to the noun, so a token-based matcher never finds
--     المنارة from منارة, and a substring one does. The assertions below are in Arabic for
--     that reason rather than for decoration.
--   · an ORDER BY that lands after the LIMIT, which produces a neatly ordered list of the
--     wrong eight places and looks entirely correct.
--   · a member writing the gazetteer. save_place is SECURITY INVOKER precisely so 0017's
--     policies decide, and the failure mode of getting that wrong is silent: the function
--     would simply work for everybody.
--   · §4's "no privileged action may bypass this". The trail is a trigger, so the test is
--     whether the rows appear for a write nobody asked to log.

begin;
create extension if not exists pgtap;

-- 5 search · 3 resolution from a pin · 4 writing one · 3 who may · 3 the trail
select plan(18);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000ba01', 'gaz-mod@t.local'),
  ('00000000-0000-0000-0000-00000000ba02', 'gaz-member@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000ba01', 'moderator',
        '00000000-0000-0000-0000-00000000ba01');

-- Three real places and one that nobody has located. Coordinates are Ramallah's, so the
-- distances below are metres a person could walk rather than arbitrary numbers.
insert into public.places (id, name_ar, name_en, aliases, location, unconfirmed)
values
  ('00000000-0000-0000-0000-00000000bb01', 'المنارة', 'Al-Manara Square',
   array['دوار المنارة', 'Manara'],
   extensions.st_setsrid(extensions.st_makepoint(35.2042, 31.8996), 4326)::extensions.geography,
   false),
  ('00000000-0000-0000-0000-00000000bb02', 'البلدة القديمة', 'Old Town',
   '{}',
   extensions.st_setsrid(extensions.st_makepoint(35.2010, 31.9020), 4326)::extensions.geography,
   false),
  ('00000000-0000-0000-0000-00000000bb03', 'رام الله التحتا', 'Lower Ramallah',
   '{}',
   extensions.st_setsrid(extensions.st_makepoint(35.2500, 31.9300), 4326)::extensions.geography,
   false),
  ('00000000-0000-0000-0000-00000000bb04', 'بيت الحكاية', null,
   '{}', null, true);

/* Names out of a search result, in order, as one comma-joined string. Comparing the ORDER
   matters as much as the membership — see the header on LIMIT before ORDER BY. */
create function pg_temp.names(p_result jsonb) returns text
language sql immutable as $fn$
  select coalesce(string_agg(hit ->> 'name_ar', ',' order by ord), '')
    from jsonb_array_elements(p_result) with ordinality as t(hit, ord);
$fn$;

/* Audit rows for a gazetteer action, counted through a definer function.
 *
 * 0020's audit_log_select requires is_admin(), and the actor below is a MODERATOR — which
 * is the role the gazetteer belongs to. Reading the table directly would return zero rows
 * and the assertion would fail while describing the trail as missing, when what is missing
 * is the reader's privilege. Created before the role switch, so it is owned by the
 * superuser this suite runs as; the same shape 29_upload_location uses to read `location`.
 *
 * moderation_actions is NOT read this way: 0020 lets a moderator read it, that is what the
 * dashboard does, and asserting it directly is therefore worth something. */
create function pg_temp.audit_count(p_action text, p_actor uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select count(*)::integer
    from public.audit_log a
   where a.target_type = 'place'
     and a.action = p_action
     and (p_actor is null or a.actor = p_actor);
$fn$;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000ba02","role":"authenticated"}';

-- ═══ 1–5 · Autocomplete ══════════════════════════════════════

-- The case a token-based matcher fails and this one must not: the definite article is part
-- of the stored word, so the query is a substring of the name rather than a word in it.
select is(
  pg_temp.names(public.places_search('منارة')),
  'المنارة',
  'searching for منارة finds المنارة — the definite article does not hide it');

select is(
  pg_temp.names(public.places_search('Manara')),
  'المنارة',
  'the English name matches too, case-insensitively');

-- Why `aliases` exists: 0048 does not normalise Arabic orthography, and the moderator's
-- answer to a variant spelling is to add it here.
select is(
  pg_temp.names(public.places_search('دوار')),
  'المنارة',
  'an alias matches, which is the whole mitigation for orthographic variants');

-- A confirmed place and an unconfirmed one both match; the one nobody has located sorts
-- LAST. It is offered, because a name with no coordinate is still the right label.
--
-- Asserted as "four results, this one at the end" rather than as the whole ordered list:
-- with no pin there is nothing to sort by but the name, and the collation that decides how
-- two Arabic names compare is a property of the database's locale rather than of this
-- function. Pinning it here would make the suite fail on a correctly-behaving server with a
-- different lc_collate, which is a test asserting the wrong thing loudly.
select is(
  jsonb_array_length(public.places_search('ا'))::text || ':' ||
    (public.places_search('ا') -> -1 ->> 'name_ar'),
  '4:بيت الحكاية',
  'every match is offered, and the unlocated one is last');

-- With a pin the order IS this function's business: distance, ascending. The pin sits on
-- the Old Town, so the nearest two are the Old Town and Al-Manara ~400 m away — Lower
-- Ramallah is 5 km off and must not appear. That is what makes this the assertion a LIMIT
-- applied before the ORDER BY fails: it would return an arbitrary two of the three.
select is(
  pg_temp.names(public.places_search('ا', 31.9021, 35.2011, 2)),
  'البلدة القديمة,المنارة',
  'with a pin, the limit takes the NEAREST matches rather than any two');

-- ═══ 6–8 · Resolution from a dropped pin ═════════════════════

-- ~58 m north-east of Al-Manara: somebody who meant the square and tapped slightly off.
-- The radii below are 150 m and 20 m against that 58, rather than values that sit near it —
-- a test whose margin is smaller than the difference between a planar estimate and a
-- geodesic one is a test that fails on a PostGIS upgrade.
select is(
  pg_temp.names(public.places_near(31.9000, 35.2046, 150)),
  'المنارة',
  'a pin near a landmark resolves to it');

select ok(
  ((public.places_near(31.9000, 35.2046, 150) -> 0 ->> 'distance_m')::numeric) between 20 and 150,
  '...with a distance in METRES, which is what ST_DWithin on geography means');

-- Radius is a real bound, not a suggestion: inside 20 m the same pin finds nothing, and the
-- unconfirmed place with no coordinate can never appear here at all.
select is(
  public.places_near(31.9000, 35.2046, 20),
  '[]'::jsonb,
  'a tight radius finds nothing rather than the nearest thing anywhere');

-- ═══ 9–11 · A member may not write it ════════════════════════

-- §5, and the reason save_place is SECURITY INVOKER: if it were DEFINER this would succeed
-- and nothing would look different.
select throws_ok(
  $$ select public.save_place(null, 'مكان جديد', 'New place', '{}', 31.9, 35.2, false) $$,
  '42501',
  null,
  'a member calling save_place is refused by the policy, not by the function');

select is(
  (select count(*)::integer from public.places),
  4,
  '...and nothing was inserted');

-- Reading it is fine and deliberately so: 0017 grants every signed-in user SELECT, and the
-- share sheet's autocomplete needs it. `anon` gets neither, which 16_function_grants pins.
select ok(
  jsonb_array_length(public.places_search('منارة')) = 1,
  'a member CAN read the gazetteer — autocomplete is not a privileged act');

-- ═══ 12–15 · Writing one, as a moderator ═════════════════════

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000ba01","role":"authenticated"}';

select is(
  public.save_place(null, 'مسجد جمال عبد الناصر', 'Jamal Abdel Nasser Mosque',
                    array['الجامع الكبير'], 31.9035, 35.2050, false) ->> 'saved',
  'true',
  'a moderator creates a place');

-- 0005's places_confirmed_has_location, reported as a reason a moderator can act on rather
-- than as a constraint name.
select is(
  public.save_place(null, 'مكان بلا موقع', null, '{}', null, null, false) ->> 'reason',
  'confirmed_needs_location',
  'a confirmed place with no point is refused by name');

-- ...and the same row with the flag set is legitimate. That is what `unconfirmed` is for:
-- a place somebody named that nobody has located yet.
select is(
  public.save_place(null, 'مكان بلا موقع', null, '{}', null, null, true) ->> 'saved',
  'true',
  'the same entry marked unconfirmed is accepted');

-- §2: "Geohash is a derived publish-time shard key ONLY." Nothing here writes it, so it
-- cannot drift from the coordinates it claims to describe.
select ok(
  (select bool_and(geohash is null) from public.places),
  'no row carries a stored geohash — the publisher derives every cell from the point');

-- ═══ 16–18 · §4's trail, by trigger ══════════════════════════

-- "Every moderator and admin action writes to moderation_actions AND audit_log ... No
-- privileged action may bypass this." Nothing above asked to be logged.
--
-- Counted by ACTOR rather than in total: the four fixtures at the top of this file are
-- ordinary inserts by the suite's superuser and the trigger logged those too, with a null
-- actor. Counting everything would make the number a fact about the fixtures.
select is(
  pg_temp.audit_count('place.create', '00000000-0000-0000-0000-00000000ba01'),
  2,
  'both of the moderator''s creations left an audit row, unasked');

select is(
  (select count(*)::integer from public.moderation_actions
    where target_type = 'place' and actor = '00000000-0000-0000-0000-00000000ba01'),
  2,
  '...and a moderation_actions row beside each, which is why the enum gained ''place''');

-- Confirming a place is the decision worth querying for on its own: it is the moment a name
-- somebody typed becomes a coordinate the map draws.
--
-- The write is its own statement rather than an operand beside the assertion. Postgres does
-- not promise which side of `||` it evaluates first, so a combined form could count the
-- audit rows before the write that produces one.
do $$
declare v_id uuid;
begin
  select id into v_id from public.places where name_ar = 'مكان بلا موقع' and unconfirmed;
  perform public.save_place(v_id, 'مكان بلا موقع', null, '{}', 31.9001, 35.2001, false);
end $$;

select is(
  pg_temp.audit_count('place.confirm', null),
  1,
  'confirming one is recorded as place.confirm, not as an ordinary edit');

reset role;
select * from finish();
rollback;
