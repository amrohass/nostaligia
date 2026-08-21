-- The decade a contributor chose (0047).
--
-- The share sheet has asked "which decade?" since the prototype. claim_upload_slot read four
-- keys out of the draft and never a date, so the answer went into the request and nowhere
-- else: every member upload arrived with date_earliest null and the generated `decade`
-- column null, and the decade slider, the decade shards and the moderation queue all read a
-- column nothing was filling.
--
-- §3: "Dates are EDTF-lite — heritage photos are 'sometime in the 60s'. Never force a single
-- date." So the decade expands into a RANGE, and the assertions below are mostly about the
-- ways that could be got wrong quietly:
--
--   · a single date would produce the right slider value and simultaneously assert the
--     photograph was taken on 1 January, which is the forced single date §3 forbids
--   · a bad value clamped to something plausible files the item under a decade nobody chose
--   · a refusal AFTER the quota charge costs a member an upload for a typo

begin;
create extension if not exists pgtap;

-- 4 the expansion · 3 refusals · 2 absent is valid · 1 the charge
select plan(10);

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-00000000de01', 'decade@t.local');

/* Created BEFORE the role switch, so they are owned by the superuser this suite runs as.
   pg_temp.claimed reads public.posts, and 0015 grants `authenticated` no table-level SELECT
   on it — a helper created after `set role` would be owned by `authenticated` and SECURITY
   DEFINER would buy it nothing. */
create function pg_temp.draft(p_extra jsonb default '{}'::jsonb) returns jsonb
language sql immutable as $fn$
  select jsonb_build_object(
    'title_en', 'a title',
    'body_en', 'a description',
    'license', 'CC-BY-SA-4.0',
    'provenance', 'family album',
    -- 0032's rights capture refuses an upload without an affirmed consent, and it refuses
    -- it BEFORE the decade is looked at. Without this every assertion below would read
    -- consent_required and the file would prove nothing about dates.
    'consent', jsonb_build_object('granted', true)
  ) || p_extra;
$fn$;

create function pg_temp.claim(p_key text, p_extra jsonb default '{}'::jsonb) returns jsonb
language sql as $fn$
  select public.claim_upload_slot(
    1024,
    '00000000-0000-0000-0000-00000000de01/' || p_key,
    'media'::public.post_kind,
    pg_temp.draft(p_extra));
$fn$;

/* The row a claim produced, by object key. */
create function pg_temp.claimed(p_key text) returns public.posts
language sql stable security definer as $fn$
  select p.* from public.posts p
   where p.ingest_object_key = '00000000-0000-0000-0000-00000000de01/' || p_key;
$fn$;

/* Uploads charged today, summed across rows rather than read from one — the day key is
   claim_upload_quota's business and an assertion that reproduced its expression would be
   asserting a copy of it. */
create function pg_temp.charged() returns integer
language sql stable security definer as $fn$
  select coalesce(sum(q.count), 0)::integer
    from public.upload_quota q
   where q.user_id = '00000000-0000-0000-0000-00000000de01';
$fn$;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000de01","role":"authenticated"}';

-- ═══ 1–4 · The expansion ═════════════════════════════════════

select is(
  (pg_temp.claim('a', '{"decade":"1960"}') ->> 'allowed')::boolean,
  true,
  'a valid decade is accepted');

select is(
  (pg_temp.claimed('a')).decade,
  1960::smallint,
  'the generated decade column is filled — the slider has something to filter on');

-- §3's whole point. A single date would give the same `decade` and would additionally
-- assert a day nobody knows.
select is(
  (pg_temp.claimed('a')).date_earliest::text || '..' || (pg_temp.claimed('a')).date_latest::text,
  '1960-01-01..1969-12-31',
  'it expands into an EDTF-lite RANGE, not a forced single date');

select is(
  (pg_temp.claimed('a')).date_precision::text,
  'decade',
  '...and says how precisely the range is known');

-- ═══ 5–7 · Refusals ══════════════════════════════════════════

-- Refused rather than clamped. Silently rewriting 1955 to 1950, or 3000 to the current
-- decade, files the item under a decade the contributor did not choose — and nothing
-- anywhere would report it.
select is(
  pg_temp.claim('b', '{"decade":"1955"}') ->> 'reason',
  'invalid_decade',
  'a decade that is not a multiple of ten is refused, not rounded');

select is(
  pg_temp.claim('c', '{"decade":"1820"}') ->> 'reason',
  'invalid_decade',
  'a decade before photography reached these albums is refused');

-- The draft is a jsonb blob a browser composed, so a bare cast would raise inside a
-- SECURITY DEFINER function and reach the member as a 500 with a Postgres error in it.
select is(
  pg_temp.claim('d', '{"decade":"banana"}') ->> 'reason',
  'invalid_decade',
  'a non-numeric decade is a named refusal, not a 500');

-- ═══ 8–9 · Absent is still valid ═════════════════════════════

-- §3 does not require a date. The archive has items whose decade genuinely is not known,
-- and refusing an upload over it would be inventing a requirement.
select is(
  (pg_temp.claim('e') ->> 'allowed')::boolean,
  true,
  'a draft with no decade is accepted, exactly as before 0047');

select ok(
  (pg_temp.claimed('e')).date_earliest is null
    and (pg_temp.claimed('e')).date_precision is null,
  '...and stores neither a date nor a precision — posts_date_precision_needs_a_date');

-- ═══ 10 · Where the refusal happens ══════════════════════════

-- The ordering rule this function is built around: every refusal comes BEFORE
-- claim_upload_quota, so a typo in a decade costs a member nothing. Measured against the
-- quota row rather than against the return value, because the return value would look
-- right either way.
--
-- Five claims above; two of them were accepted.
select is(
  pg_temp.charged(),
  2,
  'the three refused decades were never charged — only the two accepted claims were');

reset role;
select * from finish();
rollback;
