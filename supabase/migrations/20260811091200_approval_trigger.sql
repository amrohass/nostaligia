-- 0012 · Approval, content hash, and the audit trail
--
-- §5: "Edit-after-approval trigger: any UPDATE to content columns resets status to
-- 'pending' and clears approved_by/approved_at. Record content_hash at approval; the
-- publisher refuses rows whose hash ≠ approved hash."
-- §2 write path: "approval → trigger records approver + content hash + audit row."
--
-- The whole point is that a moderator approves CONTENT, not a row id. If the content
-- can change afterwards without re-approval, the approval means nothing — and since
-- the publisher reads approved rows, an edit-after-approval is a route to publishing
-- unreviewed material. That is the hole this closes.

set search_path = public, extensions;

-- ── What "content" means, in exactly one place ───────────────
--
-- Every other rule here is expressed in terms of this hash, so there is a single
-- definition of what a moderator approved and only one thing to keep in step.
--
-- Notes on canonicalisation, because a hash that is not stable is worse than none:
--   · timestamptz is rendered at UTC. `::text` alone would render in the session's
--     TimeZone, so the same row would hash differently for two different clients.
--   · geography is rendered as WKT rather than compared with `=`, whose semantics
--     for spatial types have changed across PostGIS versions.
--   · jsonb::text is already canonical — jsonb normalises key order and whitespace
--     on storage, so equal values always render identically.
--   · media_assets are folded in, ordered, so swapping the image behind an approved
--     post changes the hash and the publisher refuses it (M2). Media changes do NOT
--     reset status to pending: backfilling a 480p rendition months later should not
--     un-approve an item, but it must not go out silently either.
--
-- SECURITY DEFINER so the hash always covers the true set of media rows rather than
-- the subset RLS happens to show the caller. A hash computed over a filtered view
-- would disagree with the publisher's and fail every row.
create or replace function public.post_content_hash(p public.posts)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    sha256(convert_to(
      concat_ws(
        E'\x1f',
        p.kind::text,
        coalesce(p.title_ar, ''), coalesce(p.title_en, ''),
        coalesce(p.body_ar, ''),  coalesce(p.body_en, ''),
        coalesce(p.date_earliest::text, ''),
        coalesce(p.date_latest::text, ''),
        coalesce(p.date_precision::text, ''),
        coalesce(extensions.st_astext(p.location), ''),
        p.location_precision::text,
        coalesce(extensions.st_astext(p.location_public), ''),
        coalesce(p.location_source::text, ''),
        coalesce(p.place_id::text, ''),
        coalesce((p.event_starts_at at time zone 'UTC')::text, ''),
        coalesce((p.event_ends_at   at time zone 'UTC')::text, ''),
        coalesce(p.venue_ar, ''), coalesce(p.venue_en, ''),
        p.details::text,
        coalesce(p.license, ''), coalesce(p.provenance, ''),
        p.consent::text,
        p.author_label::text,
        coalesce((
          select string_agg(
                   concat_ws(E'\x1e',
                     m.role::text,
                     coalesce(m.rendition::text, ''),
                     m.bucket::text,
                     m.storage_path),
                   E'\x1d' order by m.role, m.rendition, m.storage_path)
          from public.media_assets m
          where m.post_id = p.id
        ), '')
      ),
      'UTF8'
    )),
    'hex'
  );
$$;

comment on function public.post_content_hash(public.posts) is
  'The single definition of "content" (CLAUDE.md §5). The publisher refuses rows whose hash has moved.';

-- The before/after state §4 requires on every privileged action. Raw `location` IS
-- included: audit_log is admin-only and never reaches a shard or an export, and a
-- coordinate change is precisely the kind of edit that needs to be auditable.
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
    'created_by',         p.created_by
  );
$$;

-- Only the triggers (which run as owner) and the publisher need these.
revoke execute on function public.post_content_hash(public.posts) from public;
revoke execute on function public.post_audit_snapshot(public.posts) from public;
grant  execute on function public.post_content_hash(public.posts) to service_role;
grant  execute on function public.post_audit_snapshot(public.posts) to service_role;

-- ── The approval state machine ───────────────────────────────
--
-- Three transitions, in this order:
--
--   1. Content changed while approved      → back to 'pending', approval erased.
--   2. Entering 'approved'                 → stamp approver, time, content hash.
--   3. Leaving 'approved' for anything else → approval erased.
--
-- A consequence worth stating plainly: a moderator CANNOT edit and re-approve in one
-- UPDATE. Rule 1 fires first and forces 'pending', so re-approval is a second,
-- separate act. That is intended — whoever approves must have seen the final text.
--
-- Note this trigger does not decide WHO may approve. That is RLS's job (item 4);
-- this only guarantees that whatever approval happens is recorded truthfully.
create or replace function public.posts_enforce_approval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_content_changed boolean;
begin
  v_content_changed :=
    public.post_content_hash(new) is distinct from public.post_content_hash(old);

  -- 1 — §5, the rule this file exists for.
  if v_content_changed and old.status = 'approved' then
    new.status      := 'pending';
    new.approved_by := null;
    new.approved_at := null;
    new.content_hash := null;
  end if;

  -- 2 — approval is a record, not a flag.
  if new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_by  := coalesce(auth.uid(), new.approved_by);
    new.approved_at  := now();
    new.content_hash := public.post_content_hash(new);
  end if;

  -- 3 — rejected, withdrawn or pending carries no approval record.
  if new.status <> 'approved' and old.status = 'approved' then
    new.approved_by  := null;
    new.approved_at  := null;
    new.content_hash := null;
  end if;

  return new;
end;
$$;

comment on function public.posts_enforce_approval() is
  'CLAUDE.md §5 — an edit to approved content returns it to the queue.';

create trigger posts_enforce_approval
  before update on public.posts
  for each row execute function public.posts_enforce_approval();

-- ── The audit trail ──────────────────────────────────────────
--
-- §4: "Every moderator and admin action writes to moderation_actions AND audit_log
-- with actor, target, timestamp, and before/after state. No privileged action may
-- bypass this."
--
-- Attached to the table, not called from application code, which is what "may not
-- bypass" has to mean — an Edge Function that forgot to log, or a service-role
-- script, still writes an audit row. SECURITY DEFINER so the insert into audit_log
-- succeeds for a caller who has no rights to that table at all (nobody does).
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
    elsif old.takedown is distinct from new.takedown then
      v_action := case when new.takedown then 'post.takedown' else 'post.restore' end;
    else
      v_action := 'post.edit';
    end if;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (auth.uid(), v_action, 'post', new.id, v_before, public.post_audit_snapshot(new));

  -- The subset that is a moderation DECISION rather than an ordinary edit. §4 wants
  -- these in both places: audit_log is the permanent record, moderation_actions is
  -- the team-readable one the dashboard shows.
  v_privileged := v_action in (
    'post.status.approved', 'post.status.rejected', 'post.status.withdrawn',
    'post.takedown', 'post.restore'
  );

  if v_privileged then
    insert into public.moderation_actions (actor, action, target_type, target_id)
    values (auth.uid(), v_action, 'post', new.id);
  end if;

  return null;
end;
$$;

comment on function public.posts_write_audit() is
  'CLAUDE.md §4 — no privileged action bypasses the audit trail, because it is a trigger.';

create trigger posts_write_audit
  after insert or update on public.posts
  for each row execute function public.posts_write_audit();
