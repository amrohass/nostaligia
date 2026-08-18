-- 0031 · Giving back a job no worker ever took
--
-- The defect this closes, precisely: complete-upload calls begin_ingest, which moves the
-- row to 'processing', and THEN invokes the worker. If that invocation fails — the worker
-- is unreachable, rejects the job, or is not configured at all — the function correctly
-- returns 502, but the row stays in 'processing'. Every retry after that reaches
-- begin_ingest, gets already_processing, and complete-upload answers
--
--     200 { ok: true, status: "processing" }
--
-- for a job that no worker has ever seen. The upload never completes and never fails, and
-- the client is told everything is fine. A 502 that strands state is recoverable; a 200
-- that strands state is not, because nothing retries.
--
-- ── Why this needs a ceiling, and 0030 provides it ───────────
--
-- release_ingest is granted to `authenticated`, so — exactly as claim_upload_slot's header
-- notes about itself — it is directly callable through PostgREST by anyone with a token.
-- A member can therefore loop: release, call complete-upload, release, call complete-upload.
-- Each cycle spawns a worker invocation, and a worker invocation is a Cloud Run instance
-- decoding a file. That is unbounded compute off a single quota slot, which is the exact
-- shape of the billing incident §6 was written after.
--
-- ingest_attempts is what makes the loop finite. begin_ingest refuses past
-- MAX_INGEST_ATTEMPTS, release does not decrement, so an object is worth at most three
-- worker invocations however many times it is released. The daily quota already bounds how
-- many objects exist. The two ceilings compose.
--
-- ── What it deliberately cannot do ───────────────────────────
--
-- Only 'processing' moves, and only ever back to 'awaiting_bytes'. It cannot touch a
-- terminal state, so it is not a way to revive a rejected upload; it cannot reach status,
-- approved_by, approved_at, content_hash or takedown, so it is not a way into moderation;
-- and it is NOT granted to media_worker, so the worker cannot hand its own job back and
-- ask for another one.
--
-- ── What it does not fix ─────────────────────────────────────
--
-- A worker that ACCEPTED the job and then died still leaves the row in 'processing' with
-- nothing to release it, because the invocation succeeded. That is 0028's stuck-job gap
-- and it is still open; this narrows it to worker-side death rather than closing it. The
-- reaper is M6, where processing_started_at is waiting for it.

set search_path = public, extensions;

-- ── begin_ingest gains the ceiling ───────────────────────────
--
-- Replaces the function as it stood after 0030. Same warning as there and in 0026: this
-- must be edited forward from the newest version, never rebased onto an older one.
--
-- Three, not a configuration knob. A retry loop that needs more than three attempts is not
-- retrying, it is failing, and a member watching an upload fail three times is information
-- the log should carry rather than something to absorb silently.
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

  if v_post.ingest_state = 'processing' then
    return jsonb_build_object('ok', true, 'post_id', v_post.id, 'already_processing', true,
                              'attempts', v_post.ingest_attempts);
  end if;

  -- Checked after the state tests, so a row that is already processing is still answered
  -- already_processing rather than being told it is out of attempts. The ceiling exists to
  -- stop NEW invocations, not to make an in-flight job unreportable.
  --
  -- The row is left in 'awaiting_bytes' rather than being failed. Failing it here would
  -- make three transient network errors indistinguishable from a hostile file, and would
  -- put a permanent refusal on an upload whose bytes are sitting in quarantine intact. A
  -- moderator or the M6 reaper can decide; this function will not.
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
                            'attempts', v_post.ingest_attempts + 1);
end;
$$;

comment on function public.begin_ingest(text) is
  'The uploader reports their bytes are in quarantine. Moves awaiting_bytes -> processing, at most three times.';

revoke execute on function public.begin_ingest(text) from public, anon;
grant  execute on function public.begin_ingest(text) to authenticated, service_role;

-- ── release_ingest ───────────────────────────────────────────
--
-- The ownership checks are begin_ingest's, twice over and for the same reason: the key
-- must sit under auth.uid(), and the row itself must agree. A member who could release
-- somebody else's ingest could hand a stranger's in-flight upload back to the queue.
create or replace function public.release_ingest(p_object_key text)
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

  -- A finished ingest is finished. Releasing a 'ready' row would put an item whose media
  -- already exists — and may already be approved and published — back in the queue for a
  -- second worker to overwrite.
  if v_post.ingest_state = 'ready' or v_post.ingest_state = 'failed' then
    return jsonb_build_object('ok', false, 'reason', 'terminal_state',
                              'state', v_post.ingest_state);
  end if;

  -- Already released, by a retry of this same call or by an earlier failure. Idempotent
  -- rather than an error, for the reason begin_ingest gives: a client whose response was
  -- dropped has done nothing wrong.
  if v_post.ingest_state = 'awaiting_bytes' then
    return jsonb_build_object('ok', true, 'post_id', v_post.id, 'idempotent', true,
                              'attempts', v_post.ingest_attempts);
  end if;

  -- ingest_attempts is deliberately NOT decremented. Decrementing it would make the
  -- ceiling above unreachable and turn this function into the unbounded loop it exists to
  -- bound. processing_started_at is cleared because nothing is processing.
  update public.posts
     set ingest_state          = 'awaiting_bytes',
         processing_started_at = null
   where id = v_post.id;

  return jsonb_build_object('ok', true, 'post_id', v_post.id, 'idempotent', false,
                            'attempts', v_post.ingest_attempts);
end;
$$;

comment on function public.release_ingest(text) is
  'Hands back a job no worker took, so the uploader can retry. Bounded by posts.ingest_attempts.';

-- authenticated only, and never media_worker: the worker must not be able to release its
-- own job and be handed another. anon reaches nothing.
revoke execute on function public.release_ingest(text) from public, anon;
grant  execute on function public.release_ingest(text) to authenticated, service_role;
