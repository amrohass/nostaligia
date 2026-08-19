-- 0032 · Rights are captured at upload, or the upload does not happen
--
-- §7: "Provenance and consent captured at upload, including the right to withdraw and a
-- per-item license. Ask 'where did this come from' — a contributor granting a license they
-- do not hold is how heritage archives acquire liability."
--
-- 0027 read all three fields out of the draft and stored whatever arrived, including
-- nothing. The share sheet sent nothing, so every member upload landed with license null
-- and provenance null — and posts_approved_has_rights then refused to let ANY of them be
-- approved. The contribution lifecycle ran end to end and stopped one step short of
-- public, permanently, for every member.
--
-- Two ways out of that. Relax the constraint, or collect the fields. §7 is unambiguous
-- about which, so: collect them, and refuse the upload without them — before the quota is
-- charged, so a member who omits a licence has not spent one of their twenty.
--
-- ── Why the refusal lives here and not in the sheet ──────────
--
-- §5. The share sheet marks the fields `required`, which is a courtesy that saves a
-- round-trip and stops nothing: the form is one removeAttribute away from submitting
-- without them, and claim_upload_slot is granted to `authenticated` and directly callable
-- through PostgREST regardless. If the rule is going to bind, it binds here.
--
-- ── Why the licence is an allowlist, and only on this path ───
--
-- Free-text licence is not a licence. "Free to use" is not a term anyone can act on in
-- five years, and M5's export owes Dublin Core a dc:rights value that means something.
-- Three options, because a dropdown of near-identical Creative Commons variants asks a
-- contributor to make a distinction they have no way to make.
--
-- The allowlist constrains THIS path only — a member upload — and deliberately not the
-- column. The bulk importer (M5) will carry ~300 items whose rights are whatever they
-- historically are: "©, used by permission of the family", a museum deposit agreement, an
-- unresolved orphan work. A CHECK on posts.license would make those unimportable, and the
-- archive would be the poorer for a constraint that only ever needed to govern a dropdown.
--
-- ── Why consent is stamped rather than accepted ──────────────
--
-- The client asserts `granted`. It does not get to say WHEN. A client-supplied timestamp
-- on a record whose whole purpose is to evidence that someone agreed to something at a
-- particular moment is worth nothing; now() here is worth something. may_withdraw is set
-- unconditionally because §7 grants the right to withdraw — it is not the contributor's to
-- decline, and recording it as a variable would imply otherwise.
--
-- Keys are exactly those 0022's posts_consent_keys allowlist admits.

set search_path = public, extensions;

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
  -- The vocabulary a member may choose from. See the header for why it is not a CHECK.
  c_licenses constant text[] := array['CC-BY-SA-4.0', 'CC0-1.0', 'rights-reserved'];

  v_uid        uuid := (select auth.uid());
  v_quota      jsonb;
  v_post_id    uuid;
  v_title_ar   text := nullif(btrim(coalesce(p_draft ->> 'title_ar', '')), '');
  v_title_en   text := nullif(btrim(coalesce(p_draft ->> 'title_en', '')), '');
  v_body_ar    text := nullif(btrim(coalesce(p_draft ->> 'body_ar',  '')), '');
  v_body_en    text := nullif(btrim(coalesce(p_draft ->> 'body_en',  '')), '');
  v_license    text := nullif(btrim(coalesce(p_draft ->> 'license', '')), '');
  v_provenance text := nullif(btrim(coalesce(p_draft ->> 'provenance', '')), '');
  v_granted    boolean;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_object_key');
  end if;

  -- The key must sit under the caller's own id. request-upload builds it that way, but
  -- this function is granted to `authenticated` and is therefore directly callable: a
  -- member who could name someone else's key would attach their draft to a stranger's
  -- upload, and complete_ingest would later hand them the derivatives.
  if p_object_key not like (v_uid::text || '/%') then
    return jsonb_build_object('allowed', false, 'reason', 'object_key_not_owned');
  end if;

  -- §9 makes the description required archival metadata, and posts_has_a_title wants a
  -- title. Both are checked here so the caller gets a named refusal rather than a raw
  -- constraint violation — and, more importantly, before the quota is charged.
  if v_title_ar is null and v_title_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'title_required');
  end if;
  if v_body_ar is null and v_body_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'description_required');
  end if;

  -- §7's three, in the order the sheet asks them. Each gets its own reason because "your
  -- upload was refused" is not something a contributor can act on, and the one thing worse
  -- than asking someone for a licence is asking them for it twice.
  if v_license is null then
    return jsonb_build_object('allowed', false, 'reason', 'license_required');
  end if;
  if not (v_license = any (c_licenses)) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_license',
                              'licenses', to_jsonb(c_licenses));
  end if;
  if v_provenance is null then
    return jsonb_build_object('allowed', false, 'reason', 'provenance_required');
  end if;

  -- Anything that is not the boolean true is a refusal, including the string "true", a
  -- missing key, and a malformed consent object. A cast is deliberately avoided: the draft
  -- is attacker-controlled, and `'nonsense'::boolean` raises rather than returning false —
  -- which here would mean a 500 where a named refusal belongs.
  v_granted := (p_draft -> 'consent' -> 'granted') = 'true'::jsonb;
  if v_granted is not true then
    return jsonb_build_object('allowed', false, 'reason', 'consent_required');
  end if;

  -- Pre-checked rather than left to the unique index, for the same reason: a constraint
  -- violation here would abort after the charge.
  if exists (select 1 from public.posts p where p.ingest_object_key = p_object_key) then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_object_key');
  end if;

  -- The charge. Refusals are passed through untouched so the caller sees the same
  -- reasons and the same limit fields it would from claim_upload_quota directly.
  v_quota := public.claim_upload_quota(p_bytes);
  if (v_quota ->> 'allowed')::boolean is not true then
    return v_quota;
  end if;

  -- No EXCEPTION block. See 0027's header: catching here would strand the charge above.
  insert into public.posts (
    kind, title_ar, title_en, body_ar, body_en,
    license, provenance, consent,
    created_by, ingest_object_key, ingest_state
  )
  values (
    p_kind, v_title_ar, v_title_en, v_body_ar, v_body_en,
    v_license, v_provenance,
    jsonb_build_object(
      'granted', true,
      -- Stamped, not accepted. See the header.
      'granted_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'may_withdraw', true
    ),
    v_uid, p_object_key, 'awaiting_bytes'
  )
  returning id into v_post_id;

  return v_quota || jsonb_build_object('post_id', v_post_id, 'object_key', p_object_key);
end;
$$;

comment on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb) is
  'Charges the daily quota and creates the draft post in one transaction, with §7 rights capture as a precondition (CLAUDE.md §2, §6, §7).';

-- Unchanged from 0027, restated because CREATE OR REPLACE does not carry them and a future
-- reader should not have to diff two files to learn who may call this.
revoke execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  from public, anon;
grant execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  to authenticated, service_role;
