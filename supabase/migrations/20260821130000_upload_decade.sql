-- 0047 · The decade a contributor chose stops being discarded
--
-- The share sheet has asked "which decade?" since the prototype, with a select that defaults
-- to the 1960s. claim_upload_slot reads four keys out of the draft — title_ar/en, body_ar/en
-- — plus licence, provenance and consent, and has never read a date. So the answer went into
-- the request and nowhere else, and every member upload arrived with date_earliest null,
-- date_precision null and the generated `decade` column null.
--
-- That is not cosmetic for this archive. §3 makes the date model the point: "heritage photos
-- are 'sometime in the 60s'. Never force a single date." The decade slider (§1, §9), the
-- decade shards, and the moderation queue's decade field all read a column nothing was
-- filling — and the person who actually knows the answer is the contributor, at the moment
-- they are looking at the photograph. Asking them and throwing it away leaves a moderator
-- guessing from a scan.
--
-- Found while wiring the front end to the shards in M3, which is the milestone that made the
-- decade visible in three places at once and therefore the milestone in which its absence
-- stopped looking like an empty column and started looking like a lost answer.
--
-- ── Why a decade rather than a date ──────────────────────────
--
-- The client sends `decade`, an integer, and this expands it into §3's EDTF-lite range:
--
--     1960  ->  date_earliest 1960-01-01, date_latest 1969-12-31, precision 'decade'
--
-- Not date_earliest alone. posts.decade is GENERATED from date_earliest, so a single date
-- would produce the right slider value and simultaneously assert that the photograph was
-- taken on the first of January — which is the forced single date §3 forbids in as many
-- words. The range says what is actually known.
--
-- A finer date is deliberately not accepted here. The sheet has no control for one, and an
-- API that took date_earliest/date_latest/date_precision as free parameters would let a
-- client assert 'day' precision on something nobody has dated to a day. Moderators edit
-- posts through the queue and can narrow it there; that path already exists and is reviewed.
--
-- ── Absent is still valid ────────────────────────────────────
--
-- A draft with no decade inserts nulls, exactly as before. posts_date_precision_needs_a_date
-- allows both columns null, the archive has items whose decade genuinely is not known, and
-- refusing an upload over it would be inventing a requirement §3 does not make.

set search_path = public, extensions;

/*
 * Replaced, not edited: 0029 is this function's only definition.
 *
 * The body below is 0029's with a validated decade added. Everything before the INSERT is
 * untouched — the ownership check, both required-field refusals, the duplicate-key
 * pre-check and the quota charge are in the same order, because that order is what keeps a
 * refusal from happening after the charge.
 */
create or replace function public.claim_upload_slot(
  p_bytes      bigint,
  p_object_key text,
  p_kind       public.post_kind,
  p_draft      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_quota    jsonb;
  v_post_id  uuid;
  v_title_ar text := nullif(btrim(coalesce(p_draft ->> 'title_ar', '')), '');
  v_title_en text := nullif(btrim(coalesce(p_draft ->> 'title_en', '')), '');
  v_body_ar  text := nullif(btrim(coalesce(p_draft ->> 'body_ar',  '')), '');
  v_body_en  text := nullif(btrim(coalesce(p_draft ->> 'body_en',  '')), '');

  -- Parsed defensively rather than cast. The draft is a jsonb blob a browser composed, so
  -- `(p_draft ->> 'decade')::int` on the string "banana" raises inside a SECURITY DEFINER
  -- function and reaches the member as a 500 with a Postgres error in it. A regex first
  -- means a malformed value is simply absent, which is the same outcome as not sending one.
  v_decade_raw text := nullif(btrim(coalesce(p_draft ->> 'decade', '')), '');
  v_decade     int  := case when v_decade_raw ~ '^[0-9]{4}$' then v_decade_raw::int end;

  v_earliest date;
  v_latest   date;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_object_key');
  end if;

  if p_object_key not like (v_uid::text || '/%') then
    return jsonb_build_object('allowed', false, 'reason', 'object_key_not_owned');
  end if;

  if v_title_ar is null and v_title_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'title_required');
  end if;
  if v_body_ar is null and v_body_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'description_required');
  end if;

  if exists (select 1 from public.posts p where p.ingest_object_key = p_object_key) then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_object_key');
  end if;

  -- Bounded, and REFUSED rather than clamped when it is out of range. 1900 is well before
  -- photography reached these albums and the upper bound is the current decade; a value
  -- outside that is a client that is confused or hostile, and silently rewriting it to
  -- something plausible would file the item under a decade nobody chose.
  --
  -- Checked before the quota charge, with every other refusal, so a bad decade costs a
  -- member nothing.
  if v_decade_raw is not null then
    if v_decade is null
       or v_decade % 10 <> 0
       or v_decade < 1900
       or v_decade > ((extract(year from now())::int / 10) * 10) then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_decade');
    end if;
    v_earliest := make_date(v_decade, 1, 1);
    v_latest   := make_date(v_decade + 9, 12, 31);
  end if;

  v_quota := public.claim_upload_quota(p_bytes);
  if (v_quota ->> 'allowed')::boolean is not true then
    return v_quota;
  end if;

  insert into public.posts (
    kind, title_ar, title_en, body_ar, body_en,
    date_earliest, date_latest, date_precision,
    license, provenance, consent,
    created_by, ingest_object_key, ingest_state
  )
  values (
    p_kind, v_title_ar, v_title_en, v_body_ar, v_body_en,
    v_earliest, v_latest,
    -- Null when there is no date, because posts_date_precision_needs_a_date says a
    -- precision without a date is not a thing.
    case when v_earliest is null then null else 'decade'::public.date_precision end,
    nullif(btrim(coalesce(p_draft ->> 'license', '')), ''),
    nullif(btrim(coalesce(p_draft ->> 'provenance', '')), ''),
    coalesce(p_draft -> 'consent', '{}'::jsonb),
    v_uid, p_object_key, 'awaiting_bytes'
  )
  returning id into v_post_id;

  return v_quota || jsonb_build_object('post_id', v_post_id, 'object_key', p_object_key);
end;
$$;

comment on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb) is
  'One transaction: charge the quota and create the draft post (CLAUDE.md §6). Expands a decade into §3''s EDTF-lite range.';

-- Restated in full. CREATE OR REPLACE keeps the existing grants, but 22_rpc_ownership exists
-- because assuming that is how a function ends up executable by PUBLIC.
revoke execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  from public, anon;
grant execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  to authenticated, service_role;
