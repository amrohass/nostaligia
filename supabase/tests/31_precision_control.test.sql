-- M5 item 1 — the contributor may loosen their location's precision, never tighten it.
--
-- 0049 decided precision from the coordinate's SOURCE and gave the contributor no say;
-- §7's amendment says M5 owns the control. 0052 adds it in one direction only.
--
-- Two things here are worth more than the rest:
--
--   · **the refusal is on the RPC and the boundary is on the TABLE.** 0049's own header
--     says a member "can write the same columns through PostgREST directly", so a control
--     that lived only in claim_upload_slot would be decoration an attacker steps around.
--     Assertions 10–12 go at the table with a direct UPDATE, which is the path that
--     actually matters.
--   · **assertion 10 is a CONTROL and is not optional.** A test that only asserted "the
--     member's UPDATE to 'exact' fails" would pass just as well against a database that
--     refused the column outright, or refused the row, or had no such member — it would
--     be green for three wrong reasons. So first prove the member CAN write
--     location_precision, by loosening it; only then does 11's refusal mean the trigger.

begin;
create extension if not exists pgtap;

-- 3 gazetteer · 5 pin · 1 no-coordinate · 3 the trigger itself
select plan(12);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000d0c1', 'prec-member@t.local'),
  ('00000000-0000-0000-0000-00000000d0c2', 'prec-mod@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000d0c2', 'moderator',
        '00000000-0000-0000-0000-00000000d0c2');

insert into public.places (id, name_ar, name_en, location, unconfirmed)
values ('00000000-0000-0000-0000-00000000be01', 'المنارة', 'Al-Manara Square',
        extensions.st_setsrid(extensions.st_makepoint(35.2042, 31.8996), 4326)::extensions.geography,
        false);

-- Same shape as 29's: 0032's rights capture refuses before the location is looked at, so
-- without these keys every assertion below would read consent_required and prove nothing.
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
    '00000000-0000-0000-0000-00000000d0c1/' || p_key,
    'media'::public.post_kind,
    pg_temp.draft(p_extra));
$fn$;

create function pg_temp.claimed(p_key text) returns public.posts
language sql stable security definer as $fn$
  select p.* from public.posts p
   where p.ingest_object_key = '00000000-0000-0000-0000-00000000d0c1/' || p_key;
$fn$;

create function pg_temp.charged() returns integer
language sql stable security definer as $fn$
  select coalesce(sum(q.count), 0)::integer
    from public.upload_quota q
   where q.user_id = '00000000-0000-0000-0000-00000000d0c1';
$fn$;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000d0c1","role":"authenticated"}';

-- ═══ 1–3 · A gazetteer place justifies 'exact' ═══════════════
-- Its point is already public in places.json, so the contributor may keep it — or bury it.

select is(
  (pg_temp.claimed('a')).location_precision::text,
  'exact',
  'asking for the precision the source justifies is accepted'
) from (select pg_temp.claim('a', '{"place_id":"00000000-0000-0000-0000-00000000be01",
                                    "location_precision":"exact"}')) _;

select is(
  (pg_temp.claimed('b')).location_precision::text,
  'area',
  'a contributor may publish a gazetteer place VAGUELY'
) from (select pg_temp.claim('b', '{"place_id":"00000000-0000-0000-0000-00000000be01",
                                    "location_precision":"area"}')) _;

-- 'hidden' is the strongest form of the control and the one §7 cares about most: the item
-- is still in the archive, and it is nowhere on the map.
select is(
  (pg_temp.claimed('c')).location_precision::text
    || ' ' || coalesce((pg_temp.claimed('c')).location_public::text, 'null'),
  'hidden null',
  '...or ask for it to carry no coordinate at all, and then none is published'
) from (select pg_temp.claim('c', '{"place_id":"00000000-0000-0000-0000-00000000be01",
                                    "location_precision":"hidden"}')) _;

-- ═══ 4–8 · A dropped pin justifies only 'street' ═════════════

select is(
  (pg_temp.claimed('d')).location_precision::text,
  'street',
  'a pin at the precision its source justifies is accepted'
) from (select pg_temp.claim('d', '{"lat":"31.9","lon":"35.2","location_precision":"street"}')) _;

select is(
  (pg_temp.claimed('e')).location_precision::text,
  'area',
  'a pin may be published vaguer still'
) from (select pg_temp.claim('e', '{"lat":"31.9","lon":"35.2","location_precision":"area"}')) _;

-- THE assertion. A pin is a coordinate nobody curated and most plausibly a home (§7).
-- Relabelling it 'exact' would make "fuzzing is default-on" an opt-out.
select is(
  pg_temp.claim('f', '{"lat":"31.9","lon":"35.2","location_precision":"exact"}') ->> 'reason',
  'precision_too_precise',
  'a pin CANNOT be sharpened to exact — the source does not justify it'
);

select is(
  pg_temp.claim('g', '{"lat":"31.9","lon":"35.2","location_precision":"rooftop"}') ->> 'reason',
  'invalid_precision',
  'an unknown precision is a named refusal, not a 500 from a failed enum cast'
);

-- Both refusals above must land before claim_upload_quota, exactly as 0049's do: five
-- claims were accepted, two refused, so the charge must still read five.
select is(
  pg_temp.charged(),
  5,
  'the two refusals were never charged');

-- ═══ 9 · No coordinate justifies nothing ═════════════════════

select is(
  pg_temp.claim('h', '{"location_precision":"area"}') ->> 'reason',
  'precision_too_precise',
  'with no coordinate at all, even `area` is sharper than the source justifies');

-- ═══ 10–12 · The boundary is the TABLE, not the RPC ══════════
--
-- 0049: "0015 already grants `authenticated` UPDATE on location, location_precision,
-- location_source and place_id, so the same member can write the same columns through
-- PostgREST directly." That sentence is why the next three exist.

-- CONTROL, and the whole file leans on it. Post 'd' is a pin stored at 'street'. The member
-- loosens it to 'area' by writing the column DIRECTLY. If this fails, assertion 11 proves
-- nothing whatever — it would be green against a missing grant, a missing row or a policy
-- that never admitted this member.
select lives_ok(
  $$ update public.posts set location_precision = 'area'
      where ingest_object_key = '00000000-0000-0000-0000-00000000d0c1/d' $$,
  'CONTROL: the member really can write location_precision directly — so 11 can only fail on the trigger');

select throws_ok(
  $$ update public.posts set location_precision = 'exact'
      where ingest_object_key = '00000000-0000-0000-0000-00000000d0c1/d' $$,
  '23514',
  null,
  'the member cannot sharpen it past what the pin justifies, even bypassing the RPC');

-- §7's amendment ends "and a moderator can change either", and 0049's set_post_location is
-- the tool it means: a moderator correcting a wrong pin to the landmark it photographs is
-- the case this must not block.
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000d0c2","role":"authenticated"}';

select lives_ok(
  $$ update public.posts set location_precision = 'exact'
      where ingest_object_key = '00000000-0000-0000-0000-00000000d0c1/d' $$,
  'a moderator is exempt — §7 leaves the correction to them');

reset role;
select * from finish();
rollback;
