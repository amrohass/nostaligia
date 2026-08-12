-- 0028 · The client says "the bytes are up"
--
-- The plan for complete-upload was: check the key belongs to the caller, HEAD the object
-- in R2, invoke the worker. The HEAD is replaced by this function, and the reasoning is
-- worth writing down because it looks like a shortcut and is not.
--
-- What the HEAD was for was avoiding a worker invocation for an object that is not there.
-- It does that badly. It cannot be a security control, because the object can vanish
-- between the HEAD and the worker's fetch, so the worker has to handle absence anyway --
-- meaning the HEAD buys nothing it does not already have to do. And it needs a second
-- SigV4 signing path in the Edge Function for a check that is advisory at best.
--
-- The real thing worth preventing is a member calling complete-upload in a loop and
-- spawning a worker invocation each time. A state transition prevents that and the HEAD
-- does not: the second call sees 'processing' and returns without invoking anything. It
-- also gives the worker a truthful state to report against, and it costs one round trip
-- the Edge Function was already making.
--
-- ── The stuck-job problem, stated rather than solved ─────────
--
-- If the worker dies mid-job the post sits in 'processing' and this function will keep
-- answering already_processing, so the upload never completes and never fails. That needs
-- a reaper -- something that returns sufficiently old 'processing' rows to
-- 'awaiting_bytes' or fails them outright. It belongs with the monitoring work in M6
-- (publish age, function errors) rather than being half-built here, and it is a real gap
-- until then, not a theoretical one.

set search_path = public, extensions;

create or replace function public.begin_ingest(p_object_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_post public.posts;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_object_key');
  end if;

  -- Same ownership rule as claim_upload_slot, and for the same reason: this is granted to
  -- `authenticated` and is therefore directly callable. Without it a member could drive
  -- another member's upload through the pipeline.
  if p_object_key not like (v_uid::text || '/%') then
    return jsonb_build_object('ok', false, 'reason', 'object_key_not_owned');
  end if;

  select * into v_post
    from public.posts
   where ingest_object_key = p_object_key
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_object');
  end if;

  -- Belt and braces. The LIKE above already establishes ownership, but that is a string
  -- comparison against a key format; this is the row itself saying who owns it.
  if v_post.created_by is distinct from v_uid then
    return jsonb_build_object('ok', false, 'reason', 'object_key_not_owned');
  end if;

  if v_post.ingest_state = 'ready' or v_post.ingest_state = 'failed' then
    return jsonb_build_object('ok', false, 'reason', 'terminal_state',
                              'state', v_post.ingest_state);
  end if;

  -- Already handed to a worker. Returning ok keeps the client's retry harmless, and
  -- already_processing tells complete-upload not to invoke a second time.
  if v_post.ingest_state = 'processing' then
    return jsonb_build_object('ok', true, 'post_id', v_post.id, 'already_processing', true);
  end if;

  update public.posts
     set ingest_state = 'processing'
   where id = v_post.id;

  return jsonb_build_object('ok', true, 'post_id', v_post.id, 'already_processing', false);
end;
$$;

comment on function public.begin_ingest(text) is
  'The uploader reports their bytes are in quarantine. Moves awaiting_bytes -> processing, once.';

revoke execute on function public.begin_ingest(text) from public, anon;
grant  execute on function public.begin_ingest(text) to authenticated, service_role;
