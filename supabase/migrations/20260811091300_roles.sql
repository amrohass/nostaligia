-- 0013 · Roles
--
-- §4: "Role lives in a JWT claim set by a SECURITY DEFINER function or an
-- access-token hook — NEVER in a user-writable column. profiles.role_cache is
-- display-only and must never be trusted for authorization."
--
-- This file builds BOTH halves, because they answer different questions:
--
--   public.user_roles          the source of truth. Service-role only: no grant, no
--                              policy, unreachable from any browser session.
--   public.authz_role()        what RLS POLICIES read. SECURITY DEFINER over the
--                              table, so a demotion bites on the very next
--                              statement.
--   custom_access_token_hook   what EDGE FUNCTIONS and the admin UI read, as a JWT
--                              claim. §6 requires request-upload to take role-aware
--                              caps "from the JWT role claim".
--
-- Why policies read the table rather than the claim: a JWT is a snapshot. Revoke
-- someone's moderator role and their existing token still says 'moderator' until it
-- refreshes — up to an hour of continued approval rights over an archive whose whole
-- premise is that nothing is published unreviewed. The table costs one indexed
-- lookup per policy evaluation and has no such window. The claim is still published
-- because Edge Functions run before any RLS evaluation and need something to read,
-- and because the admin UI needs to know which affordances to render — but §5 is
-- clear that the admin UI is UX only, never a guard.

-- ── The source of truth ──────────────────────────────────────
--
-- One role per user. The absence of a row means 'member', so signup does not have to
-- write here at all — which means the ordinary path never touches the most
-- security-sensitive table in the schema.
create table public.user_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        public.app_role not null default 'member',
  granted_by  uuid references auth.users (id) on delete set null,
  granted_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger user_roles_touch_updated_at
  before update on public.user_roles
  for each row execute function public.touch_updated_at();

comment on table public.user_roles is
  'Authorization source of truth. No browser grant, no policy — service role only (CLAUDE.md §4).';

-- Not readable and not writable from a browser, at all, by anyone. A moderator who
-- can read this table learns who else is a moderator; a member who can write it
-- becomes one.
revoke all on public.user_roles from anon, authenticated;

alter table public.user_roles enable row level security;

-- ── What policies read ───────────────────────────────────────
--
-- Returns NULL for an unauthenticated caller — deliberately NOT 'member', because a
-- signed-out visitor is not a member and a policy that confuses the two grants
-- engagement rights to the world.
--
-- (select auth.uid()) rather than auth.uid() is the standard Supabase RLS form: the
-- scalar subquery is evaluated once as an InitPlan instead of once per row.
create or replace function public.authz_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null then null
    else coalesce(
      (select r.role from public.user_roles r where r.user_id = (select auth.uid())),
      'member'::public.app_role
    )
  end;
$$;

comment on function public.authz_role() is
  'The authorization role of the current caller. NULL when signed out. Read by RLS policies.';

-- coalesce(..., false) is not decoration. authz_role() is NULL when signed out, and
-- `null in ('moderator','admin')` is NULL, not false. A bare NULL is harmless inside
-- a USING clause (which treats it as false) but becomes a hole the moment anything
-- writes `not public.is_moderator()` — NOT NULL is NULL is false, so the negation
-- would silently fail open for exactly the caller it was meant to catch.
create or replace function public.is_moderator()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.authz_role() in ('moderator', 'admin'), false);
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(public.authz_role() = 'admin', false);
$$;

comment on function public.is_moderator() is
  'CLAUDE.md §4 — moderator or admin. Every capability a moderator has, an admin also has.';

-- ── What the JWT carries ─────────────────────────────────────
--
-- Supabase calls this on every token issue and refresh with
--   { "user_id": "...", "claims": { ... }, "authentication_method": "..." }
-- and uses whatever `claims` we hand back.
--
-- The claim goes under app_metadata, which the client cannot influence — user_metadata
-- IS user-writable and putting a role there would be exactly the "user-writable
-- column" §4 forbids, wearing a different hat.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role   public.app_role;
  v_claims jsonb;
begin
  select r.role into v_role
  from public.user_roles r
  where r.user_id = (event ->> 'user_id')::uuid;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);

  v_claims := jsonb_set(
    v_claims,
    '{app_metadata}',
    coalesce(v_claims -> 'app_metadata', '{}'::jsonb)
      || jsonb_build_object('user_role', coalesce(v_role::text, 'member'))
  );

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  'Publishes app_metadata.user_role into the JWT for Edge Functions (CLAUDE.md §6). Not read by RLS.';

-- Only Supabase Auth may call the hook. Nobody else has any business doing so.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from anon, authenticated, public;

-- ── role_cache: the display mirror ───────────────────────────
--
-- §4 calls this display-only. It is kept honest three ways: the column grants in
-- 0004 make it unwritable from any browser session, this trigger is the only thing
-- that ever sets it, and a CI assertion in item 5 fails the build if any RLS policy
-- expression so much as mentions the column name.
create or replace function public.user_roles_sync_role_cache()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.profiles set role_cache = 'member' where id = old.user_id;
  else
    update public.profiles set role_cache = new.role where id = new.user_id;
  end if;
  return null;
end;
$$;

create trigger user_roles_sync_role_cache
  after insert or update or delete on public.user_roles
  for each row execute function public.user_roles_sync_role_cache();

-- ── Role changes are audited by the same mechanism as posts ──
--
-- A grant or revoke of moderator is the single most security-relevant write in this
-- system: it is the one that decides who may publish to an archive whose premise is
-- that nothing is published unreviewed. It leaves a row here, on the table, for the
-- same reason post approvals do — so the record does not depend on which code path
-- happened to make the change. An Edge Function, a psql session, a migration and a
-- future admin screen all produce identical evidence.
--
-- moderation_actions targets 'profile': the subject of a role change is a person,
-- and target_id is their user id.
create or replace function public.user_role_snapshot(r public.user_roles)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id',    r.user_id,
    'role',       r.role,
    'granted_by', r.granted_by,
    'granted_at', r.granted_at
  );
$$;

create or replace function public.user_roles_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_action  text;
  v_before  jsonb;
  v_after   jsonb;
  v_note    text;
begin
  if tg_op = 'INSERT' then
    v_user_id := new.user_id;
    v_action  := 'role.grant';
    v_before  := null;
    v_after   := public.user_role_snapshot(new);
    v_note    := new.role::text;

  elsif tg_op = 'DELETE' then
    v_user_id := old.user_id;
    v_action  := 'role.revoke';
    v_before  := public.user_role_snapshot(old);
    v_after   := null;
    v_note    := old.role::text || ' -> member';

  else
    v_user_id := new.user_id;
    v_before  := public.user_role_snapshot(old);
    v_after   := public.user_role_snapshot(new);
    -- Every write to this table is audited, not only the ones that move the role.
    -- Re-affirming a role is itself a decision worth a row.
    if old.role is distinct from new.role then
      v_action := 'role.change';
      v_note   := old.role::text || ' -> ' || new.role::text;
    else
      v_action := 'role.reaffirm';
      v_note   := new.role::text;
    end if;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (auth.uid(), v_action, 'user_role', v_user_id, v_before, v_after);

  insert into public.moderation_actions (actor, action, target_type, target_id, note)
  values (auth.uid(), v_action, 'profile', v_user_id, v_note);

  return null;
end;
$$;

comment on function public.user_roles_write_audit() is
  'CLAUDE.md §4 — a grant or revoke of moderator leaves a row whatever wrote it.';

create trigger user_roles_write_audit
  after insert or update or delete on public.user_roles
  for each row execute function public.user_roles_write_audit();
