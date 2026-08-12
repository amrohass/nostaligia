-- 0027 · One transaction for "may they upload, and what is this going to be"
--
-- complete_ingest resolves a post by ingest_object_key. Nothing set that column, so the
-- worker had nothing to talk to. This is the other half: the draft row is created at the
-- moment the URL is signed, by the UPLOADER, under their own JWT.
--
-- ── Why one function and not two calls ───────────────────────
--
-- request-upload could charge the quota and then insert the row. Two statements, two
-- ways to end up half-done: quota charged with no row (the member has spent an upload on
-- nothing and cannot retry) or a row with no quota (the ceiling leaks). Both are
-- recoverable only by hand.
--
-- Inside one function they are one transaction. Note the deliberate absence of an
-- EXCEPTION block around the insert: a caught exception would roll back only its own
-- subtransaction, leaving the quota charge from before it intact — exactly the half-done
-- state this exists to prevent. Predictable failures are pre-checked and returned as
-- refusals BEFORE the charge; anything unforeseen propagates and takes the charge with it.
--
-- ── Why the uploader inserts, and not the worker ─────────────
--
-- §2 says the posts row is inserted "under RLS". The worker is not the author and holds
-- no path to posts at all (0026). Authorship belongs to the person, and created_by is
-- taken from auth.uid() here rather than from an argument, so it cannot be spoofed even
-- by a bug in the Edge Function.
--
-- claim_upload_quota is called rather than reimplemented — its ON CONFLICT guard is the
-- thing that makes the ceiling unraceable, and a second copy of that logic is a second
-- thing to get wrong. Its 22 tests continue to cover it directly.

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
  v_uid      uuid := (select auth.uid());
  v_quota    jsonb;
  v_post_id  uuid;
  v_title_ar text := nullif(btrim(coalesce(p_draft ->> 'title_ar', '')), '');
  v_title_en text := nullif(btrim(coalesce(p_draft ->> 'title_en', '')), '');
  v_body_ar  text := nullif(btrim(coalesce(p_draft ->> 'body_ar',  '')), '');
  v_body_en  text := nullif(btrim(coalesce(p_draft ->> 'body_en',  '')), '');
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

  -- No EXCEPTION block. See the header: catching here would strand the charge above.
  insert into public.posts (
    kind, title_ar, title_en, body_ar, body_en,
    license, provenance, consent,
    created_by, ingest_object_key, ingest_state
  )
  values (
    p_kind, v_title_ar, v_title_en, v_body_ar, v_body_en,
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
  'Charges the daily quota and creates the draft post in one transaction (CLAUDE.md §2, §6).';

-- authenticated, because it runs as the caller: auth.uid() is both the quota subject and
-- the author. The worst a member can do by calling it directly is spend their own
-- allowance creating empty drafts under their own id.
revoke execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  from public, anon;
grant execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  to authenticated, service_role;
