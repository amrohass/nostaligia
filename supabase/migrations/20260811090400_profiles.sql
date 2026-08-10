-- 0004 · profiles
--
-- §3: handle is user-chosen and NOT a legal name. §7: handle and avatar are always
-- public; bio, personal info, contributions and comments are gated by `visibility`.
-- Email appears nowhere — it lives only in auth.users, which no browser session can
-- read. §7: "Emails are never published. Not in profiles, not in snapshots, not in
-- exports." The way to guarantee that is to not have the column.
--
-- There is deliberately NO trigger creating a profile on signup. §7 makes the handle
-- mandatory and user-chosen; auto-generating one would either leak the email local
-- part or invent a name for someone. Profile creation is an explicit onboarding step
-- (M1) under the INSERT policy in item 4.

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,

  -- Arabic or Latin, single-script, stored in normalized form. See
  -- public.normalized_handle() and public.is_allowed_handle() in 0002 for what is
  -- folded and why. Uniqueness is on the normalized form (index below), and the
  -- stored value must already BE that form, so the handle in the database is exactly
  -- the handle in the URL.
  --
  -- (A CHECK calling a user-defined function is not re-validated if the function is
  -- later replaced. Changing either function therefore needs a follow-up migration
  -- that revalidates this constraint — the pgTAP tests in item 5 pin both.)
  handle        text not null
                  constraint profiles_handle_allowed
                  check (public.is_allowed_handle(handle))
                  constraint profiles_handle_is_normalized
                  check (handle = public.normalized_handle(handle)),

  display_name  text
                  constraint profiles_display_name_length
                  check (display_name is null or char_length(btrim(display_name)) between 1 and 80),

  -- Mandatory at the application layer, defaulting to a generated avatar (§7). Not
  -- NOT NULL here because the generated default is derived from the id at render
  -- time rather than stored.
  avatar_path   text,

  bio           text
                  constraint profiles_bio_length
                  check (bio is null or char_length(bio) <= 2000),

  visibility    jsonb not null
                  default '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'::jsonb
                  constraint profiles_visibility_shape
                  check (public.is_valid_visibility(visibility)),

  -- DISPLAY ONLY (§4). Never read by an RLS policy — a CI assertion in item 5 walks
  -- pg_policies and fails the build if any policy expression so much as mentions this
  -- column. Maintained by trigger from public.user_roles (item 3), and made
  -- structurally unwritable from the browser by the column grants below.
  role_cache    public.app_role not null default 'member',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Uniqueness on the folded form, so محمد and مـحـمـ__د cannot both exist.
create unique index profiles_handle_normalized_key
  on public.profiles (public.normalized_handle(handle));

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

comment on table public.profiles is
  'Public identity. No email column by design (CLAUDE.md §7).';
comment on column public.profiles.role_cache is
  'DISPLAY ONLY. Authorization reads public.user_roles via public.authz_role(). Never trust this.';

-- ── Privileges ───────────────────────────────────────────────
-- Supabase grants ALL on new public tables to anon/authenticated by default, so we
-- start from zero and grant back deliberately.
--
-- Column-level grants matter here in a way RLS cannot replicate: `moderator` and
-- `admin` are not database roles — every signed-in user is `authenticated` — so a
-- column grant applies to all of them equally. That is exactly right for role_cache,
-- which NO browser session may ever write, whatever its role. Role changes go
-- through public.user_roles, which is service-role only.
--
-- (A column-level REVOKE cannot subtract from a table-level GRANT, which is why this
-- revokes the whole privilege first and then grants the specific columns.)
revoke all on public.profiles from anon, authenticated;

grant select on public.profiles to anon, authenticated;
grant insert (id, handle, display_name, avatar_path, bio, visibility) on public.profiles to authenticated;
grant update (handle, display_name, avatar_path, bio, visibility) on public.profiles to authenticated;
-- No DELETE: account removal is a request flow with an audit trail (M5), not a
-- client-issued DELETE.

-- ── RLS ──────────────────────────────────────────────────────
-- Enabled at creation so there is never a window in which the table is readable
-- without a policy. Policies arrive in item 4; until then this is deny-all for
-- anon and authenticated.
--
-- FORCE is deliberately NOT set anywhere in this schema. FORCE applies RLS to the
-- table OWNER, which would break the two things that must be able to bypass it:
-- the SECURITY DEFINER authorization function reading user_roles, and the
-- SECURITY DEFINER audit triggers writing audit_log. service_role carries BYPASSRLS
-- regardless, so FORCE buys nothing against the actual threat model — the browser —
-- while reliably breaking the trusted paths.
alter table public.profiles enable row level security;

-- ── Reserved handles ─────────────────────────────────────────
--
-- Two separate problems, one list:
--
--   1. ROUTE COLLISION. M3 replaces hash routing with real paths, so a profile lives
--      at /u/<handle> — but the site also has /archive, /map, /events, /page/... and
--      the publisher writes /v/<ts>/, /feed/, /geo/, /decade/, /item/, /manifest.json
--      and /redactions.json. A handle equal to any of those is a live routing bug
--      waiting for M3. Reserving them now costs nothing; discovering it later means
--      renaming someone's identity.
--   2. IMPERSONATION. "admin", "الإدارة", "official", "فريق_الأرشيف" — a handle is
--      shown beside contributed material, and §7 is explicit that attribution is what
--      the handle is FOR. Someone posting as "الأرشيف" is claiming the archive said it.
--
-- A table rather than a constant, so the list grows without a migration. It is
-- checked by trigger, not by CHECK, because a CHECK constraint may not read a table.
create table public.reserved_handles (
  handle      text primary key,
  reason      text not null,
  created_at  timestamptz not null default now()
);

insert into public.reserved_handles (handle, reason) values
  -- public routes, present and planned
  ('archive', 'route'), ('map', 'route'), ('events', 'route'), ('event', 'route'),
  ('page', 'route'), ('pages', 'route'), ('me', 'route'), ('u', 'route'),
  ('m', 'route'), ('item', 'route'), ('items', 'route'), ('v', 'route'),
  ('feed', 'route'), ('geo', 'route'), ('decade', 'route'), ('decades', 'route'),
  ('manifest', 'route'), ('redactions', 'route'), ('search', 'route'),
  ('about', 'route'), ('contact', 'route'), ('support', 'route'), ('donate', 'route'),
  ('help', 'route'), ('terms', 'route'), ('privacy', 'route'), ('legal', 'route'),
  ('press', 'route'),
  ('الأرشيف', 'route'), ('الخريطة', 'route'), ('الفعاليات', 'route'),
  ('عن', 'route'), ('تواصل', 'route'), ('تبرع', 'route'), ('المساعدة', 'route'),
  ('الدعم', 'route'), ('بحث', 'route'),

  -- infrastructure and asset paths
  ('assets', 'infrastructure'), ('static', 'infrastructure'), ('public', 'infrastructure'),
  ('cdn', 'infrastructure'), ('api', 'infrastructure'), ('auth', 'infrastructure'),
  ('www', 'infrastructure'), ('mail', 'infrastructure'), ('ftp', 'infrastructure'),
  ('root', 'infrastructure'), ('storage', 'infrastructure'), ('originals', 'infrastructure'),
  ('quarantine', 'infrastructure'),

  -- account lifecycle words that must never be a real person
  ('login', 'reserved'), ('logout', 'reserved'), ('signin', 'reserved'),
  ('signup', 'reserved'), ('register', 'reserved'), ('settings', 'reserved'),
  ('profile', 'reserved'), ('account', 'reserved'),
  ('null', 'reserved'), ('undefined', 'reserved'), ('none', 'reserved'),
  ('anonymous', 'reserved'), ('deleted', 'reserved'), ('removed', 'reserved'),
  ('مجهول', 'reserved'), ('محذوف', 'reserved'),

  -- impersonation: authority, staff and the archive itself
  ('admin', 'impersonation'), ('administrator', 'impersonation'), ('moderator', 'impersonation'),
  ('mod', 'impersonation'), ('team', 'impersonation'), ('staff', 'impersonation'),
  ('official', 'impersonation'), ('security', 'impersonation'), ('abuse', 'impersonation'),
  ('report', 'impersonation'), ('system', 'impersonation'),
  ('ramallah', 'impersonation'), ('ramallahmemory', 'impersonation'),
  ('memory', 'impersonation'), ('atlas', 'impersonation'), ('municipality', 'impersonation'),
  ('الإدارة', 'impersonation'), ('المدير', 'impersonation'), ('مدير', 'impersonation'),
  ('مشرف', 'impersonation'), ('الفريق', 'impersonation'), ('رسمي', 'impersonation'),
  ('رام_الله', 'impersonation'), ('ذاكرة_رام_الله', 'impersonation'),
  ('البلدية', 'impersonation'), ('بلدية_رام_الله', 'impersonation');

-- SECURITY DEFINER because a member has no read access to the list — the error
-- message is the only channel through which the list is observable, which is
-- deliberate: there is no reason to hand out an enumerable inventory of the words
-- worth impersonating.
create or replace function public.reject_reserved_handle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1
    from public.reserved_handles r
    where public.normalized_handle(r.handle) = public.normalized_handle(new.handle)
  ) then
    raise exception 'handle "%" is reserved', new.handle
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger profiles_reject_reserved_handle
  before insert or update of handle on public.profiles
  for each row execute function public.reject_reserved_handle();

comment on table public.reserved_handles is
  'Route collisions and impersonation targets. Compared in normalized form.';

-- Not readable from the browser: see the note on the function above.
revoke all on public.reserved_handles from anon, authenticated;

alter table public.reserved_handles enable row level security;
