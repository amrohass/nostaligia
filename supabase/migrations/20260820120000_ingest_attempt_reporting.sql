-- 0040 · begin_ingest reports the ceiling, not just the count
--
-- Part of the release-only retry path (§12, approved 20 Aug 2026). Deliberately NOT the
-- reaper: public.reap_stale_ingests and its c_ingest_lease are held until the deployed-
-- worker probe returns a real 20-minute figure, because that lease is derived from
-- JOB_DEADLINE_MS and publishing a client-facing expiry twice is worse than publishing it
-- late. Nothing here depends on that number.
--
-- ── The defect ───────────────────────────────────────────────
--
-- complete-upload answers 202 with `status: "processing"` and nothing else. That is an
-- open-ended promise: a client has no way to know whether it is the first attempt or the
-- last, and no basis on which to ever stop waiting. The uploader whose worker died sees
-- the same answer forever as the uploader whose transcode is running normally.
--
-- Attempts are already tracked and already bounded — 0031 increments ingest_attempts and
-- refuses past three. But the CEILING is reported on exactly one branch, the refusal:
--
--     too_many_attempts  ->  { attempts, max_attempts }
--     already_processing ->  { attempts }
--     the normal claim   ->  { attempts }
--
-- So a client is told the limit only once it has already hit it, which is the moment the
-- information stops being useful. "Attempt 2" means nothing without "of 3".
--
-- ── What this does ───────────────────────────────────────────
--
-- max_attempts on every branch that returns attempts. That is the whole migration. The
-- constant stays where it is, declared once inside begin_ingest — it is not duplicated
-- anywhere, so there is nothing here to keep in step.
--
-- Body is 0031's, unchanged except for the three return objects.

set search_path = public, extensions;

create or replace function public.begin_ingest(p_object_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := (select auth.uid());
  v_post     public.posts;
  c_max_attempts constant smallint := 3;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  end if;

  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_object_key');
  end if;

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

  if v_post.created_by is distinct from v_uid then
    return jsonb_build_object('ok', false, 'reason', 'object_key_not_owned');
  end if;

  if v_post.ingest_state = 'ready' or v_post.ingest_state = 'failed' then
    return jsonb_build_object('ok', false, 'reason', 'terminal_state',
                              'state', v_post.ingest_state);
  end if;

  -- Carries the ceiling now. A client polling an in-flight job learns "2 of 3" rather than
  -- "2", which is the difference between knowing how much rope is left and not.
  if v_post.ingest_state = 'processing' then
    return jsonb_build_object('ok', true, 'post_id', v_post.id, 'already_processing', true,
                              'attempts', v_post.ingest_attempts,
                              'max_attempts', c_max_attempts);
  end if;

  -- Checked after the state tests, so a row that is already processing is still answered
  -- already_processing rather than being told it is out of attempts. The ceiling exists to
  -- stop NEW invocations, not to make an in-flight job unreportable.
  --
  -- The row is left in 'awaiting_bytes' rather than being failed. Failing it here would
  -- make three transient network errors indistinguishable from a hostile file, and would
  -- put a permanent refusal on an upload whose bytes are sitting in quarantine intact. A
  -- moderator or the reaper can decide; this function will not.
  if v_post.ingest_attempts >= c_max_attempts then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts',
                              'attempts', v_post.ingest_attempts,
                              'max_attempts', c_max_attempts);
  end if;

  update public.posts
     set ingest_state          = 'processing',
         ingest_attempts       = v_post.ingest_attempts + 1,
         processing_started_at = now()
   where id = v_post.id;

  return jsonb_build_object('ok', true, 'post_id', v_post.id, 'already_processing', false,
                            'attempts', v_post.ingest_attempts + 1,
                            'max_attempts', c_max_attempts);
end;
$$;

comment on function public.begin_ingest(text) is
  'Claims the awaiting_bytes -> processing transition. Reports attempt N of max on every branch.';

-- Restated because CREATE OR REPLACE does not carry grants forward when the function is
-- recreated in a later migration, and because a definer function silently left executable
-- by PUBLIC is what 22_rpc_ownership.test.sql exists to catch.
revoke execute on function public.begin_ingest(text) from public, anon;
grant  execute on function public.begin_ingest(text) to authenticated, service_role;
