-- 0051 · Withdrawal — the account is anonymized, the archive is not
--
-- §7 gives a contributor "the right to withdraw". §3 says audit rows are "permanent —
-- never deleted, never rotated". Those two sentences are in direct tension, and until now
-- the tension was not resolved but merely undiscovered: `DELETE /auth/v1/admin/users/{id}`
-- answers
--
--     500 {"code":"23001","message":"audit_log is append-only: UPDATE refused
--          (CLAUDE.md §3 — audit rows are permanent)"}
--
-- because `audit_log.actor` is ON DELETE SET NULL and the append-only trigger refuses the
-- UPDATE that cascade attempts. That is the system working exactly as designed. It also
-- means a contributor who has ever acted cannot be hard-deleted, so "we will delete your
-- account" was a promise this schema could not keep.
--
-- ── The resolution: anonymize in place ───────────────────────
--
-- Nothing is deleted that carries the archive. The IDENTITY is destroyed and the
-- CONTRIBUTIONS remain:
--
--   profiles      handle → a tombstone, display_name / avatar_path / bio → NULL,
--                 visibility → fully private, deleted_at stamped.
--   auth.users    identifying fields cleared by the `delete-account` Edge Function over
--                 the GoTrue admin API. The ROW stays: audit_log, posts.created_by and
--                 comments.created_by all reference it, and §3 forbids the cascade.
--   posts,        untouched. `created_by` is an opaque UUID and is not granted to any
--   comments      browser role (0015); the byline everybody actually sees is the handle,
--                 and the handle is now a tombstone. Deleting the material would be
--                 deleting the archive, which is not what withdrawal means here.
--   audit_log,    untouched, and never touched. Not one statement below writes to either
--   moderation_   except by INSERT. The permanence rule is not weakened to make erasure
--   actions       tidier; the erasure is shaped around it.
--
-- ── What the permanent record is allowed to remember ─────────
--
-- Decided 29 Aug 2026: the audit row records the account id, the timestamp, the tombstone
-- handle it now carries, and COUNTS of what was removed. It does NOT record the old
-- handle, display name or bio. §3 makes that row immortal, so anything identifying written
-- into it survives the erasure it is supposed to record — which would make the deletion
-- public-facing only, and this archive's contributors are not in a position to accept a
-- half-erasure they were not told about.
--
-- The cost is stated rather than hidden: if a deletion is later disputed, the log proves
-- WHEN and BY WHOM and HOW MUCH, and cannot prove WHO. That was the deliberate trade.
--
-- ── The old handle is released ───────────────────────────────
--
-- Decided 29 Aug 2026. Once scrubbed, the handle a withdrawing member gave up becomes
-- available again like any other. The impersonation risk is real and was weighed: someone
-- may later register it, and older immutable releases under /v/{ts}/ still carry the old
-- byline. It was accepted because reserving it would mean keeping the handle in a table
-- forever, which is the same half-erasure the paragraph above refuses.
--
-- What is NOT released is the tombstone shape itself — see the guard below.

set search_path = public, extensions;

-- ── The column ───────────────────────────────────────────────
--
-- Deliberately NOT added to any grant. 0015's model is that a column is denied until
-- someone names it, so a browser cannot read this directly; it reaches the front end as a
-- boolean through profile_view() below. `auth_scrubbed_at` is separate from `deleted_at`
-- because the two halves cannot share a transaction (see request_account_deletion) and a
-- single column could not tell "scrubbed" from "database done, GoTrue still holding the
-- email".
alter table public.profiles
  add column deleted_at       timestamptz,
  add column auth_scrubbed_at timestamptz;

comment on column public.profiles.deleted_at is
  'CLAUDE.md §7 right to withdraw. Set by request_account_deletion(); the row is anonymized, never deleted (§3).';
comment on column public.profiles.auth_scrubbed_at is
  'When the GoTrue half completed. NULL after a successful scrub means the Edge Function half is still owed.';

-- ── The tombstone shape is not registrable ───────────────────
--
-- `deleted_user_<12–17 hex>` passes is_allowed_handle() and normalized_handle() unchanged
-- (verified against the live schema before this was written), which is what makes it
-- usable as a tombstone — and also what would let anybody register one. Since the old
-- handle is released for reuse, this guard is the only thing standing between a withdrawn
-- contributor and somebody wearing their marker.
--
-- A transaction-local GUC carries the exemption, the same idiom 0036 uses for
-- rma.moderation_note and for the same reason: a trigger takes no arguments, and
-- set_config(..., true) cannot leak onto the next statement of a pooled connection.
-- It is compared against the row's own id, so the exemption grants exactly one row.
create or replace function public.reject_tombstone_handle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.handle ~ '^deleted_user_[0-9a-f]{12,17}$'
     and coalesce(nullif(current_setting('rma.account_deletion', true), ''), '')
         is distinct from new.id::text then
    raise exception 'handle "%" is reserved', new.handle
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.reject_tombstone_handle() is
  'A withdrawn account''s marker is not a handle anybody may claim (CLAUDE.md §7).';

-- AFTER profiles_bidi_strip in name order, so the value tested is the cleaned one — the
-- same ordering argument 0045 makes about profiles_reject_reserved_handle.
create trigger profiles_reject_tombstone_handle
  before insert or update of handle on public.profiles
  for each row execute function public.reject_tombstone_handle();

-- ── profile_view(), now able to say "this account is gone" ───
--
-- DROP then CREATE rather than CREATE OR REPLACE: adding a column to a `returns table`
-- changes the return type, which REPLACE refuses. The grants go with the drop and are
-- restated below.
--
-- Everything else is 0016's body verbatim. `is_deleted` is a boolean and never the
-- timestamp: a public read path that hands out WHEN somebody withdrew is a dated event
-- attached to an identity, which is the correlation §7 spends its length on.
drop function if exists public.profile_view(text);

create function public.profile_view(p_handle text)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  avatar_path   text,
  role_cache    public.app_role,
  bio           text,
  visibility    jsonb,
  member_since  integer,
  is_own        boolean,
  is_deleted    boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.handle,
    p.display_name,
    p.avatar_path,
    p.role_cache,
    case
      when p.id = (select auth.uid()) then p.bio
      when public.is_moderator()      then p.bio
      when p.visibility ->> 'bio' = 'public' then p.bio
      else null
    end as bio,
    case
      when p.id = (select auth.uid()) or public.is_moderator() then p.visibility
      else null
    end as visibility,
    extract(year from p.created_at)::integer as member_since,
    coalesce(p.id = (select auth.uid()), false) as is_own,
    p.deleted_at is not null as is_deleted
  from public.profiles p
  where public.normalized_handle(p.handle) = public.normalized_handle(p_handle);
$$;

comment on function public.profile_view(text) is
  'CLAUDE.md §7 — handle and avatar always public, everything else per visibility.';

revoke execute on function public.profile_view(text) from public;
grant  execute on function public.profile_view(text) to anon, authenticated, service_role;

-- ── The publish signal, corrected while we are here ──────────
--
-- 0033's WHEN clause names handle, display_name and avatar_path, and its comment cites
-- "shards.ts author()" — which was the whole of a profile's presence in a release when it
-- was written. 0044 changed that: profile/{handle}.json now carries `bio`, `member_since`
-- and both visibility flags, so since M3 a bio or visibility edit has moved shard bytes
-- and signalled nothing, and the change went live whenever some unrelated content change
-- happened to publish.
--
-- The scrub below trips the old clause anyway (all three named columns change), so this is
-- not load-bearing for withdrawal — which is precisely why it is worth fixing now rather
-- than depending on by accident.
drop trigger if exists profiles_bump_publish_revision_update on public.profiles;

create trigger profiles_bump_publish_revision_update
  after update on public.profiles
  for each row when (old.handle       is distinct from new.handle
                  or old.display_name is distinct from new.display_name
                  or old.avatar_path  is distinct from new.avatar_path
                  or old.bio          is distinct from new.bio
                  or old.visibility   is distinct from new.visibility)
  execute function public.bump_publish_revision('content');

-- ── The RPC ──────────────────────────────────────────────────

/*
 * Anonymize an account, atomically, and hand back what the caller still has to do.
 *
 * SECURITY DEFINER with the authorization written into the body, following
 * request_takedown: the caller gets a NAMED refusal, and the check reads the database's
 * opinion of who they are rather than anything they said.
 *
 * Self OR admin. Moderator is deliberately excluded — §4's capability table gives "Manage
 * users / roles" to admin alone, and erasing somebody's identity is that row of the table,
 * not the content row above it.
 *
 * Returns `user_id` and the OLD `avatar_path`. Both are capabilities the Edge Function
 * needs and neither is otherwise recoverable after this transaction commits: the avatar
 * object in R2 has no other pointer once the column is NULL, and returning the id is what
 * lets the function scrub exactly the auth user this function approved and no other.
 */
create or replace function public.request_account_deletion(
  p_user_id uuid default null,
  p_note    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor    uuid := (select auth.uid());
  v_target   uuid := coalesce(p_user_id, (select auth.uid()));
  v_profile  public.profiles%rowtype;
  v_handle   text;
  v_avatar   text;
  v_by_admin boolean;
  n_likes    integer := 0;
  n_saves    integer := 0;
  n_quota    integer := 0;
  n_reports  integer := 0;
  n_roles    integer := 0;
begin
  if v_actor is null or v_target is null then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  v_by_admin := v_target is distinct from v_actor;

  if v_by_admin and not public.is_admin() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select * into v_profile from public.profiles where id = v_target;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_profile');
  end if;

  -- Idempotent, for the same reason request_takedown is: the second half of this runs over
  -- HTTP and can fail on its own, and retrying the whole call IS the recovery path. A
  -- refusal here would strand the GoTrue half permanently.
  if v_profile.deleted_at is not null then
    return jsonb_build_object(
      'ok', true, 'reason', 'already_deleted',
      'user_id', v_target, 'handle', v_profile.handle,
      'avatar_path', null,
      'auth_scrubbed', v_profile.auth_scrubbed_at is not null);
  end if;

  v_avatar := v_profile.avatar_path;

  -- ── Why a HASH and not a slice of the id ───────────────────
  --
  -- The obvious tombstone is `deleted_user_<first 12 hex of the uuid>`. It is wrong twice.
  --
  -- The first is mechanical: a uuid is not guaranteed random in its PREFIX. v7 puts a
  -- millisecond timestamp there, and every fixture and importer id in this repository is a
  -- hand-written pattern with a distinguishing SUFFIX — so two accounts collide on the
  -- unique handle index in the middle of somebody's erasure, which is the worst possible
  -- moment for an error that reads as a bug.
  --
  -- The second is the one that matters. `profile/<handle>.json` is a PUBLIC, CDN-cached,
  -- year-immutable file, so its name is published to everyone forever. §7 names the user
  -- id as the join key and the de-anonymisation vector, and 0044 deliberately omits it
  -- from the profile shard for that reason — putting 48 bits of it into the filename would
  -- quietly undo that. sha256 costs nothing here and the uuid keeps its 122 bits of
  -- preimage resistance, so the tombstone identifies the account to us and to nobody else.
  --
  -- 12 hex is 48 bits: at ten thousand withdrawn accounts the birthday probability is
  -- ~2e-7. The loop is there anyway, because "negligible" is not "impossible" and the
  -- alternative is a unique-violation raised at that same worst possible moment.
  declare
    v_hash text := encode(sha256(v_target::text::bytea), 'hex');
    v_len  integer := 12;
  begin
    loop
      v_handle := 'deleted_user_' || substr(v_hash, 1, v_len);
      exit when not exists (
        select 1 from public.profiles
         where public.normalized_handle(handle) = v_handle and id <> v_target);
      -- 17 keeps the handle at 30 characters, which is is_allowed_handle()'s ceiling.
      if v_len >= 17 then
        raise exception 'could not derive a free tombstone handle for %', v_target
          using errcode = 'unique_violation';
      end if;
      v_len := v_len + 1;
    end loop;
  end;

  -- The exemption for the tombstone guard, scoped to this transaction and this row.
  perform set_config('rma.account_deletion', v_target::text, true);

  update public.profiles
     set handle       = v_handle,
         display_name = null,
         avatar_path  = null,
         bio          = null,
         visibility   = '{"bio":"private","personalInfo":"private","contributions":"private","comments":"private"}'::jsonb,
         deleted_at   = now()
   where id = v_target;

  -- A withdrawn account does not keep a privilege. This DELETE is itself audited by
  -- 0013's user_roles_write_audit, so the demotion has its own permanent row.
  delete from public.user_roles where user_id = v_target;
  get diagnostics n_roles = row_count;

  -- Engagement, per the 29 Aug decision. `saves` and `upload_quota` are invisible outside
  -- the account and their removal changes no published byte. `likes` DOES change baked
  -- counts on other people's items — accepted, because a surviving user_id→post mapping is
  -- exactly the contribution history §7 names as the de-anonymization vector, and it
  -- outlives the identity scrub by pointing at the same UUID audit_log keeps forever.
  delete from public.likes where user_id = v_target;
  get diagnostics n_likes = row_count;

  delete from public.saves where user_id = v_target;
  get diagnostics n_saves = row_count;

  delete from public.upload_quota where user_id = v_target;
  get diagnostics n_quota = row_count;

  -- The report survives, unlinked: a moderator's open queue must not lose items because
  -- the reporter withdrew, and the report's text is about somebody else's content.
  update public.reports set reported_by = null where reported_by = v_target;
  get diagnostics n_reports = row_count;

  -- §3's permanent row. `before` carries the id and the fact that the account was live;
  -- it deliberately carries no name, handle or bio. See the header.
  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (
    v_actor,
    case when v_by_admin then 'account.delete.admin' else 'account.delete' end,
    'profile',
    v_target,
    jsonb_build_object('id', v_target, 'deleted_at', null),
    jsonb_build_object(
      'id', v_target,
      'handle', v_handle,
      'deleted_at', now(),
      'removed', jsonb_build_object(
        'likes', n_likes, 'saves', n_saves, 'upload_quota_days', n_quota,
        'reports_unlinked', n_reports, 'roles', n_roles)));

  -- The team-readable ledger records a DECISION somebody made about somebody else. A
  -- member erasing themselves is not that, which is the same line 0036 draws between
  -- post.takedown and a member's own withdrawal.
  if v_by_admin then
    insert into public.moderation_actions (actor, action, target_type, target_id, note)
    values (v_actor, 'account.delete.admin', 'profile', v_target,
            nullif(btrim(coalesce(p_note, '')), ''));
  end if;

  return jsonb_build_object(
    'ok', true, 'reason', 'deleted',
    'user_id', v_target, 'handle', v_handle,
    'avatar_path', v_avatar,
    'auth_scrubbed', false);
end;
$$;

comment on function public.request_account_deletion(uuid, text) is
  'CLAUDE.md §7 right to withdraw, reconciled with §3''s permanent audit. Self or admin.';

revoke execute on function public.request_account_deletion(uuid, text) from public, anon;
grant  execute on function public.request_account_deletion(uuid, text) to authenticated, service_role;

-- ── The second half's receipt ────────────────────────────────
--
-- service_role only: it is called by the `delete-account` Edge Function after the GoTrue
-- admin API has answered, and nothing a browser holds should be able to claim the auth
-- half is done when it is not. Stamping it is what makes an unfinished deletion findable
-- — `deleted_at is not null and auth_scrubbed_at is null` is the retry list.
create or replace function public.mark_account_auth_scrubbed(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  select * into v_profile from public.profiles where id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_profile');
  end if;

  -- Refused rather than tolerated: stamping the auth half on an account that was never
  -- anonymized would put a row on nobody's retry list while the profile still carries a
  -- name. The ordering is the safety property, so it is checked rather than assumed.
  if v_profile.deleted_at is null then
    return jsonb_build_object('ok', false, 'reason', 'not_deleted');
  end if;

  if v_profile.auth_scrubbed_at is not null then
    return jsonb_build_object('ok', true, 'reason', 'already_scrubbed', 'user_id', p_user_id);
  end if;

  update public.profiles set auth_scrubbed_at = now() where id = p_user_id;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (null, 'account.auth_scrubbed', 'profile', p_user_id,
          jsonb_build_object('id', p_user_id, 'auth_scrubbed_at', null),
          jsonb_build_object('id', p_user_id, 'auth_scrubbed_at', now()));

  return jsonb_build_object('ok', true, 'reason', 'scrubbed', 'user_id', p_user_id);
end;
$$;

comment on function public.mark_account_auth_scrubbed(uuid) is
  'Receipt for the GoTrue half. deleted_at set with auth_scrubbed_at NULL is the retry list.';

revoke execute on function public.mark_account_auth_scrubbed(uuid) from public, anon, authenticated;
grant  execute on function public.mark_account_auth_scrubbed(uuid) to service_role;
