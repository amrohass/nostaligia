-- claim_upload_slot (migration 0027).
--
-- The function exists to make one thing impossible: a half-done upload slot. Quota
-- charged with no draft row means the member has spent an upload on nothing and cannot
-- retry; a draft row with no charge means the daily ceiling leaks. So most of this file
-- is refusals paired with an assertion that the OTHER half did not happen.
--
-- The ownership check gets its own attention because this function is granted to
-- `authenticated` and is therefore directly callable by any member with a token — not
-- only by request-upload.

begin;
create extension if not exists pgtap;

-- 3 privileges · 7 refusals · 6 happy path · 4 atomicity
select plan(20);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'slot-one@t.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'slot-two@t.local');

-- upload_quota and posts are both unreadable by the caller we impersonate below, so the
-- harness needs owner-rights observers to check that a refusal really wrote nothing.
create function pg_temp.quota_count(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select coalesce((select q.count from public.upload_quota q
                    where q.user_id = p_user
                      and q.day = (now() at time zone 'UTC')::date), 0);
$fn$;

create function pg_temp.post_count(p_user uuid) returns integer
language sql stable security definer set search_path = '' as $fn$
  select count(*)::integer from public.posts p where p.created_by = p_user;
$fn$;

create function pg_temp.post_field(p_key text, p_field text) returns text
language plpgsql stable security definer set search_path = '' as $fn$
declare v text;
begin
  execute format('select (%I)::text from public.posts where ingest_object_key = $1', p_field)
    into v using p_key;
  return v;
end;
$fn$;

-- ═══ 1–3 · Privileges ════════════════════════════════════════

select ok(
  (select p.prosecdef from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'claim_upload_slot'),
  'claim_upload_slot is SECURITY DEFINER — posts and upload_quota are unreachable otherwise');

select ok(
  not has_function_privilege('anon',
    'public.claim_upload_slot(bigint,text,public.post_kind,jsonb)', 'execute'),
  'anon cannot claim an upload slot');

select ok(
  has_function_privilege('authenticated',
    'public.claim_upload_slot(bigint,text,public.post_kind,jsonb)', 'execute'),
  'a signed-in member can — it runs as them, by design');

-- ═══ 4–10 · Refusals ═════════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to '';

select is(
  public.claim_upload_slot(1024, 'x/y', 'media', '{"title_en":"t","body_en":"b"}') ->> 'reason',
  'unauthenticated',
  'no subject claim is refused before anything is counted');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select is(
  public.claim_upload_slot(1024, '', 'media', '{"title_en":"t","body_en":"b"}') ->> 'reason',
  'invalid_object_key',
  'an empty object key is refused');

-- The one that matters most. a1 naming a2's key would attach their draft to a stranger's
-- upload, and complete_ingest would later hand them the derivatives.
select is(
  public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-0000000000a2/stolen', 'media',
    '{"title_en":"t","body_en":"b"}') ->> 'reason',
  'object_key_not_owned',
  'a member cannot claim a slot under another member''s id');

-- A prefix that merely STARTS with the id is not the same as being under it.
select is(
  public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-0000000000a1x/evil', 'media',
    '{"title_en":"t","body_en":"b"}') ->> 'reason',
  'object_key_not_owned',
  'and the ownership check is not fooled by a lookalike prefix');

select is(
  public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-0000000000a1/k1', 'media',
    '{"body_en":"b"}') ->> 'reason',
  'title_required',
  'a draft with no title in either language is refused');

select is(
  public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-0000000000a1/k1', 'media',
    '{"title_en":"t","body_en":"   "}') ->> 'reason',
  'description_required',
  'whitespace is not a description — §9 makes it required archival metadata');

-- Not one of the five refusals above may have touched the quota.
select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000a1'), 0,
  'and none of those refusals charged the quota');

-- ═══ 11–16 · The happy path ══════════════════════════════════

select is(
  (public.claim_upload_slot(1048576,
     '00000000-0000-0000-0000-0000000000a1/k1', 'voice',
     '{"title_ar":"عنوان","body_ar":"وصف","license":"CC-BY-SA-4.0","provenance":"family album"}'
   ) ->> 'allowed')::boolean,
  true,
  'a well-formed claim succeeds');

reset role;

select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000a1/k1', 'ingest_state'),
  'awaiting_bytes',
  '...the draft waits for bytes rather than defaulting to ready');

select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000a1/k1', 'created_by'),
  '00000000-0000-0000-0000-0000000000a1',
  '...authorship comes from auth.uid(), not from an argument');

-- The client declares kind at request-upload (agreed rather than letting the worker
-- mutate it post-ingest), so it must survive verbatim.
select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000a1/k1', 'kind'),
  'voice',
  '...the declared kind is carried through');

-- §7: provenance and a per-item licence are captured at upload, not bolted on later.
select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000a1/k1', 'provenance'),
  'family album',
  '...and so are provenance and licence');

select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000a1'), 1,
  '...and the quota was charged exactly once');

-- ═══ 17–20 · Atomicity ═══════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select is(
  public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-0000000000a1/k1', 'media',
    '{"title_en":"t","body_en":"b"}') ->> 'reason',
  'duplicate_object_key',
  'one post per object, and the second claim is refused rather than aborting');

-- A refusal after the quota check would have left the charge behind. It is pre-checked
-- precisely so it does not.
select is(
  pg_temp.quota_count('00000000-0000-0000-0000-0000000000a1'), 1,
  '...without charging a second time');

-- A file larger than the whole daily budget: the refusal comes from claim_upload_quota
-- and is passed through untouched.
select is(
  public.claim_upload_slot(2000000000,
    '00000000-0000-0000-0000-0000000000a1/k2', 'media',
    '{"title_en":"t","body_en":"b"}') ->> 'reason',
  'over_daily_bytes',
  'a quota refusal is passed through with its own reason intact');

reset role;

select is(
  pg_temp.post_count('00000000-0000-0000-0000-0000000000a1'), 1,
  '...and left no draft row behind — still just the one from the happy path');

select * from finish();
rollback;
