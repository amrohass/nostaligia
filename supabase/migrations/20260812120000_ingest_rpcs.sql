-- 0026 · The media worker's entire reach into the database
--
-- The worker decodes attacker-supplied bytes. It is the least trustworthy process in the
-- system, so §5's rule applies to it more than to anything else: authorization lives in
-- policies and functions, never in the caller being well-behaved.
--
-- It therefore gets no service-role key. It gets a Postgres role with NO table grants at
-- all and execute on exactly two functions. A fully compromised worker can mark an
-- ingest complete or failed for object keys it already knows, with asset paths of its
-- choosing. It cannot read posts, cannot approve anything, cannot reach another table.
-- That boundary is enforced by grants rather than by worker code being careful, which is
-- the whole difference between this and handing it service_role.
--
-- What these functions deliberately never touch: status, approved_by, approved_at,
-- content_hash, takedown. Ingest is a machine fact; moderation is a human judgement.

set search_path = public, extensions;

-- Roles are cluster-level, not database-level, so `supabase db reset` drops the database
-- and leaves this behind. Guarded, or the second reset fails.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'media_worker') then
    create role media_worker nologin;
  end if;
end
$$;

grant usage on schema public to media_worker;
-- PostgREST switches into the role named in the JWT's `role` claim, which it can only do
-- if authenticator is a member of it.
grant media_worker to authenticator;

-- ── The audit trail learns what ingest is ────────────────────
--
-- §4: "no privileged action may bypass" the audit trail, which is why it is a trigger on
-- the table and not a call the RPC makes. So the RPCs below write no audit rows
-- themselves — they update posts, and the existing trigger records it. What the trigger
-- lacked was a name for this: an ingest update fell through to 'post.edit', which is
-- both untrue and useless when reading the log.
--
-- actor stays NULL. The worker is not a person, and audit_log.actor is a uuid referencing
-- auth.users. Minting a sentinel user for it would put a non-human in the real user
-- table, where it would surface in admin user lists and could be granted a role. NULL
-- actor plus an ingest-specific action is unambiguous, and keeps `actor` meaning "a human
-- did this" everywhere it appears.
create or replace function public.post_audit_snapshot(p public.posts)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'kind',               p.kind,
    'status',             p.status,
    'takedown',           p.takedown,
    'title_ar',           p.title_ar,
    'title_en',           p.title_en,
    'body_ar',            p.body_ar,
    'body_en',            p.body_en,
    'date_earliest',      p.date_earliest,
    'date_latest',        p.date_latest,
    'date_precision',     p.date_precision,
    'location',           extensions.st_astext(p.location),
    'location_precision', p.location_precision,
    'location_public',    extensions.st_astext(p.location_public),
    'location_source',    p.location_source,
    'place_id',           p.place_id,
    'event_starts_at',    p.event_starts_at,
    'event_ends_at',      p.event_ends_at,
    'venue_ar',           p.venue_ar,
    'venue_en',           p.venue_en,
    'details',            p.details,
    'license',            p.license,
    'provenance',         p.provenance,
    'consent',            p.consent,
    'author_label',       p.author_label,
    'content_hash',       p.content_hash,
    'approved_by',        p.approved_by,
    'approved_at',        p.approved_at,
    'created_by',         p.created_by,
    -- Added in 0026. Present in the audit snapshot but deliberately NOT in
    -- post_content_hash — an ingest update must never reset an approved post (§5).
    -- 09_ingest_state pins that distinction.
    'ingest_state',       p.ingest_state,
    'ingest_error',       p.ingest_error
  );
$$;

grant execute on function public.post_audit_snapshot(public.posts) to service_role;

-- Replaces the function as it stood after 0014, NOT after 0012. The first draft of this
-- migration rebased on 0012 and silently dropped 0014's self-approval tracking -- caught
-- by 07_triggers test 8, which is why that assertion exists. CREATE OR REPLACE has no
-- idea what it is overwriting; the only defence is starting from the latest version and
-- a suite that notices.
create or replace function public.posts_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action     text;
  v_before     jsonb;
  v_privileged boolean;
begin
  if tg_op = 'INSERT' then
    v_action := 'post.create';
    v_before := null;
  else
    v_before := public.post_audit_snapshot(old);
    if old.status is distinct from new.status then
      v_action := 'post.status.' || new.status::text;
      -- From 0014, and preserved verbatim. §4 permits a moderator to publish their own
      -- content; a separation-of-duties gap you cannot close, you make queryable.
      if new.status = 'approved'
         and new.approved_by is not null
         and new.approved_by is not distinct from new.created_by then
        v_action := v_action || '.self';
      end if;
    elsif old.takedown is distinct from new.takedown then
      v_action := case when new.takedown then 'post.takedown' else 'post.restore' end;
    elsif old.ingest_state is distinct from new.ingest_state then
      -- Named for the outcome rather than the state, because that is what a human
      -- reading the log wants: 'ingest.complete', not 'ingest.ready'.
      v_action := case new.ingest_state
                    when 'ready'  then 'ingest.complete'
                    when 'failed' then 'ingest.failed'
                    else 'ingest.' || new.ingest_state::text
                  end;
    else
      v_action := 'post.edit';
    end if;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (auth.uid(), v_action, 'post', new.id, v_before, public.post_audit_snapshot(new));

  -- Ingest is not a moderation decision and does not belong in the team-readable log.
  -- approved.self is here because 0014 put it here; dropping it would silently stop
  -- self-approvals reaching moderation_actions.
  v_privileged := v_action in (
    'post.status.approved', 'post.status.approved.self',
    'post.status.rejected', 'post.status.withdrawn',
    'post.takedown', 'post.restore'
  );

  if v_privileged then
    insert into public.moderation_actions (actor, action, target_type, target_id)
    values (auth.uid(), v_action, 'post', new.id);
  end if;

  return null;
end;
$$;

-- ── complete_ingest ──────────────────────────────────────────
--
-- Called once per object by the worker. Everything about it is designed around the
-- assumption that it will eventually be called twice, out of order, or by something
-- hostile.
--
-- `for update` serialises two workers racing the same object; 'ready' is terminal so a
-- replay returns the first result instead of attaching a second set of derivatives; and
-- 'failed' is terminal in the other direction, so a compromised worker cannot flip a
-- rejected upload to ready by calling again.
--
-- p_content_hash is deliberately absent. posts.content_hash is the APPROVAL hash, written
-- by the trigger when a moderator approves and read by the M2 publisher to refuse rows
-- whose content moved. It is not a checksum of the uploaded bytes and the worker has no
-- business setting it.
create or replace function public.complete_ingest(
  p_object_key   text,
  p_sniffed_mime text,
  p_assets       jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post      public.posts;
  v_total     integer;
  v_masters   integer;
  v_bad_master integer;
  v_bad_deriv integer;
begin
  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_object_key');
  end if;

  select * into v_post
    from public.posts
   where ingest_object_key = p_object_key
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_object');
  end if;

  if v_post.ingest_state = 'ready' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'post_id', v_post.id);
  end if;

  if v_post.ingest_state = 'failed' then
    return jsonb_build_object('ok', false, 'reason', 'terminal_state', 'state', 'failed');
  end if;

  if jsonb_typeof(p_assets) is distinct from 'array' or jsonb_array_length(p_assets) = 0 then
    return jsonb_build_object('ok', false, 'reason', 'no_assets');
  end if;

  -- Shape and §6's bucket rule, checked before anything is written. An enum value the
  -- caller invented raises rather than casting, so the whole read is guarded.
  begin
    select
      count(*),
      count(*) filter (where a.role = 'master'),
      count(*) filter (where a.role = 'master' and a.bucket <> 'originals'),
      count(*) filter (where a.role <> 'master' and a.bucket <> 'public')
      into v_total, v_masters, v_bad_master, v_bad_deriv
      from jsonb_to_recordset(p_assets) as a(
        role         public.media_role,
        rendition    public.media_rendition,
        storage_path text,
        bucket       public.media_bucket,
        mime         text,
        bytes        bigint,
        width        integer,
        height       integer,
        duration_s   numeric,
        bitrate_kbps integer,
        sort_order   integer
      );
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'malformed_assets');
  end;

  if v_masters <> 1 then
    return jsonb_build_object('ok', false, 'reason', 'expected_exactly_one_master',
                              'masters', v_masters);
  end if;

  -- §6: the master is the archival copy and lives in originals/, which is never
  -- CDN-fronted. Everything served to a browser is a derivative in public/. A worker that
  -- writes a master row pointing at public/ has published the untouched original,
  -- EXIF and all.
  if v_bad_master > 0 then
    return jsonb_build_object('ok', false, 'reason', 'master_must_be_in_originals');
  end if;
  if v_bad_deriv > 0 then
    return jsonb_build_object('ok', false, 'reason', 'derivative_must_be_in_public');
  end if;

  begin
    insert into public.media_assets (
      post_id, role, rendition, storage_path, bucket, mime,
      bytes, width, height, duration_s, bitrate_kbps, sort_order
    )
    select v_post.id, a.role, a.rendition, a.storage_path, a.bucket, a.mime,
           a.bytes, a.width, a.height, a.duration_s, a.bitrate_kbps,
           coalesce(a.sort_order, 0)
      from jsonb_to_recordset(p_assets) as a(
        role         public.media_role,
        rendition    public.media_rendition,
        storage_path text,
        bucket       public.media_bucket,
        mime         text,
        bytes        bigint,
        width        integer,
        height       integer,
        duration_s   numeric,
        bitrate_kbps integer,
        sort_order   integer
      );
  exception when others then
    -- The table's own constraints are the last word on asset shape; a violation here is
    -- a worker bug, and the transaction unwinds with the post still un-ready.
    return jsonb_build_object('ok', false, 'reason', 'asset_rejected', 'detail', sqlerrm);
  end;

  -- The only columns touched. status, approved_by, approved_at, content_hash and
  -- takedown are not in this list and must never be.
  update public.posts
     set ingest_state = 'ready',
         ingest_error = null
   where id = v_post.id;

  return jsonb_build_object(
    'ok', true, 'post_id', v_post.id, 'assets', v_total, 'sniffed_mime', p_sniffed_mime
  );
end;
$$;

comment on function public.complete_ingest(text, text, jsonb) is
  'The media worker records finished derivatives. Cannot touch moderation state (CLAUDE.md §5).';

-- ── fail_ingest ──────────────────────────────────────────────
--
-- The sniffer refused it, or the decode did not survive. The reason is shown to the
-- uploader and never to the public, so it may name the format but must not echo bytes.
create or replace function public.fail_ingest(
  p_object_key text,
  p_reason     text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post public.posts;
begin
  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing_object_key');
  end if;

  select * into v_post
    from public.posts
   where ingest_object_key = p_object_key
     for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_object');
  end if;

  -- A finished ingest cannot be un-finished. Otherwise a compromised worker could void
  -- media behind an item that has already been approved and published.
  if v_post.ingest_state = 'ready' then
    return jsonb_build_object('ok', false, 'reason', 'terminal_state', 'state', 'ready');
  end if;

  if v_post.ingest_state = 'failed' then
    return jsonb_build_object('ok', true, 'idempotent', true, 'post_id', v_post.id);
  end if;

  update public.posts
     set ingest_state = 'failed',
         ingest_error = left(coalesce(p_reason, 'unspecified'), 500)
   where id = v_post.id;

  return jsonb_build_object('ok', true, 'post_id', v_post.id);
end;
$$;

comment on function public.fail_ingest(text, text) is
  'The media worker records a refused or undecodable upload (CLAUDE.md §6).';

-- ── Who may call them ────────────────────────────────────────
--
-- Not authenticated. A member who could call complete_ingest would mark their own upload
-- ready with asset paths they chose, putting unprocessed bytes in front of a moderator
-- and, after approval, in front of the public.
revoke execute on function public.complete_ingest(text, text, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_ingest(text, text)            from public, anon, authenticated;

grant execute on function public.complete_ingest(text, text, jsonb) to media_worker, service_role;
grant execute on function public.fail_ingest(text, text)            to media_worker, service_role;
