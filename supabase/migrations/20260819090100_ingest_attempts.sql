-- 0030 · How many times this upload has been handed to a worker, and when
--
-- Two columns, and one of them does nothing yet. That is deliberate and worth stating
-- plainly rather than dressing up:
--
--   ingest_attempts        read and enforced from 0031, which is what bounds the retry
--                          loop that the rollback in complete-upload opens.
--   processing_started_at  WRITTEN here, READ BY NOTHING until the M6 reaper. 0028's
--                          header names the stuck-job problem and defers it; a reaper
--                          needs to know how long a row has been in 'processing', and
--                          that fact has to start being recorded before it is needed or
--                          the reaper's first run sees a column of nulls.
--
-- ── Neither column is member-writable ────────────────────────
--
-- 0015 revoked everything on posts and grants back column by column, so a new column is
-- unreachable by anon and authenticated until something grants it. Nothing here does, and
-- that is the load-bearing part: a member who could write ingest_attempts could reset
-- their own counter to zero and walk straight through the ceiling 0031 installs. The
-- ceiling would still be there, still be tested, and still be worthless.
--
-- They are not granted SELECT either. The uploader learns they are out of retries from
-- begin_ingest's named refusal, which is the same information without widening the
-- column privileges that 0015 spent a migration narrowing.

set search_path = public, extensions;

alter table public.posts
  add column ingest_attempts       smallint    not null default 0
               constraint posts_ingest_attempts_non_negative
               check (ingest_attempts >= 0),
  add column processing_started_at timestamptz;

comment on column public.posts.ingest_attempts is
  'How many times this object has been handed to a media worker. Bounds the retry loop (CLAUDE.md §6).';
comment on column public.posts.processing_started_at is
  'When the current worker took it. Written from 0030, read by the M6 reaper.';

-- ── begin_ingest learns to count ─────────────────────────────
--
-- Replaces the function as it stood after 0028, not after any earlier version. 0026's
-- header records why that sentence is here: CREATE OR REPLACE has no idea what it is
-- overwriting, and a rebase onto the wrong ancestor silently drops whatever the newer
-- version added. Everything below the two new SET clauses is 0028 verbatim.
--
-- The stamp goes on the transition, not on the call. A second call answers
-- already_processing without touching either column — otherwise a client polling in a
-- loop would keep pushing processing_started_at forward and a stuck job would look
-- perpetually fresh to the reaper that is supposed to catch it.
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
    return jsonb_build_object('ok', true, 'post_id', v_post.id, 'already_processing', true,
                              'attempts', v_post.ingest_attempts);
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
  'The uploader reports their bytes are in quarantine. Moves awaiting_bytes -> processing, counting attempts.';

-- Restated rather than assumed. 0028 set these, and a CREATE OR REPLACE preserves them —
-- but the cost of writing them again is nothing and the cost of being wrong is that the
-- one function a member calls to move ingest state is reachable by anon.
revoke execute on function public.begin_ingest(text) from public, anon;
grant  execute on function public.begin_ingest(text) to authenticated, service_role;
