-- 0010 · reports, moderation_actions, audit_log, releases, upload_quota
--
-- §4: "Every moderator and admin action writes to moderation_actions AND audit_log
-- with actor, target, timestamp, and before/after state. No privileged action may
-- bypass this."
--
-- Three of these five tables are never reachable from a browser at all — not
-- readable, not writable, no policy, no grant. They are locked twice over: the
-- privileges are revoked AND RLS is enabled with no policy. Either alone would do;
-- both means a mistake in item 4 cannot open them by accident.

-- ── reports ──────────────────────────────────────────────────
create table public.reports (
  id           uuid primary key default gen_random_uuid(),

  target_type  public.report_target not null,
  target_id    uuid not null,

  reason       text not null
                 constraint reports_reason_length
                 check (char_length(btrim(reason)) between 1 and 2000),

  -- Nullable only for account erasure; the INSERT policy pins it to auth.uid().
  reported_by  uuid references auth.users (id) on delete set null,

  status       public.report_status not null default 'open',

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create trigger reports_touch_updated_at
  before update on public.reports
  for each row execute function public.touch_updated_at();

revoke all on public.reports from anon, authenticated;
grant select on public.reports to authenticated;
grant insert, update on public.reports to authenticated;

alter table public.reports enable row level security;

-- ── moderation_actions ───────────────────────────────────────
-- Readable by the team (the existing dashboard already promises this: "the decision
-- is written to the admin log, visible to the team only"). Written only by the
-- SECURITY DEFINER paths that perform the actions — never by a client INSERT, or a
-- moderator could fabricate a record of someone else's decision.
create table public.moderation_actions (
  id           uuid primary key default gen_random_uuid(),

  actor        uuid references auth.users (id) on delete set null,

  -- Free text rather than an enum: CLAUDE.md does not enumerate the action
  -- vocabulary, and inventing one now would mean migrating it in M1.
  action       text not null
                 constraint moderation_actions_action_length
                 check (char_length(btrim(action)) between 1 and 64),

  target_type  public.moderation_target not null,
  target_id    uuid not null,

  note         text
                 constraint moderation_actions_note_length
                 check (note is null or char_length(note) <= 4000),

  created_at   timestamptz not null default now()
);

revoke all on public.moderation_actions from anon, authenticated;
grant select on public.moderation_actions to authenticated;

alter table public.moderation_actions enable row level security;

-- ── audit_log ────────────────────────────────────────────────
-- §3: "Audit rows are permanent — never deleted, never rotated. They are part of the
-- archival record and required for grant reporting. (User asked for 30-day
-- retention; permanent is the floor, not a cap.)"
--
-- Permanence is enforced by trigger, not by policy, because a policy only binds the
-- roles it names. The triggers below refuse UPDATE, DELETE and TRUNCATE from every
-- role including service_role and the table owner. The only way past them is a
-- superuser explicitly disabling the trigger, which is itself a logged act.
create table public.audit_log (
  id           uuid primary key default gen_random_uuid(),

  actor        uuid references auth.users (id) on delete set null,

  action       text not null
                 constraint audit_log_action_length
                 check (char_length(btrim(action)) between 1 and 64),

  -- text, not an enum: audit covers every table, including ones not yet created.
  target_type  text not null
                 constraint audit_log_target_type_length
                 check (char_length(btrim(target_type)) between 1 and 64),

  target_id    uuid,

  before       jsonb constraint audit_log_before_is_object
                 check (before is null or jsonb_typeof(before) = 'object'),
  after        jsonb constraint audit_log_after_is_object
                 check (after is null or jsonb_typeof(after) = 'object'),

  created_at   timestamptz not null default now()
);

create or replace function public.audit_log_is_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'audit_log is append-only: % refused (CLAUDE.md §3 — audit rows are permanent)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

-- TRUNCATE cannot be combined with other events in one CREATE TRIGGER, hence two.
create trigger audit_log_no_update_or_delete
  before update or delete on public.audit_log
  for each statement execute function public.audit_log_is_append_only();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function public.audit_log_is_append_only();

comment on table public.audit_log is
  'Append-only and permanent (CLAUDE.md §3). UPDATE/DELETE/TRUNCATE refused by trigger for every role.';

-- Not reachable from a browser at all. §4 does not grant moderators audit access;
-- the admin-only read policy arrives in item 4, on top of this grant.
revoke all on public.audit_log from anon, authenticated;
grant select on public.audit_log to authenticated;

alter table public.audit_log enable row level security;

-- ── releases ─────────────────────────────────────────────────
-- §2: the publisher rebuilds shards into /v/{ISO-ts}/ and atomically flips the
-- manifest pointer. Exactly one release is active at a time — the partial unique
-- index makes a two-active state unrepresentable, which is the database half of
-- what the single-writer advisory lock guarantees on the publisher side.
create table public.releases (
  id          uuid primary key default gen_random_uuid(),
  -- The hyphen sits last inside the bracket so it is unambiguously a literal. `\-`
  -- would depend on whether PostgreSQL's ARE treats backslash as an escape inside a
  -- bracket expression, which is exactly the kind of detail that differs between
  -- regex flavours and would silently widen the pattern.
  path        text not null unique
                constraint releases_path_shape
                check (path ~ '^/v/[0-9TZ:.-]+/$'),
  created_at  timestamptz not null default now(),
  active      boolean not null default false
);

create unique index releases_only_one_active
  on public.releases ((active))
  where active;

comment on index public.releases_only_one_active is
  'Two simultaneously-active releases are unrepresentable (CLAUDE.md §2).';

-- Publisher-only. No browser session reads or writes this.
revoke all on public.releases from anon, authenticated;

alter table public.releases enable row level security;

-- ── upload_quota ─────────────────────────────────────────────
-- §6, cost ceiling layer three: "per-user daily quotas enforced in the database".
-- Written by the request-upload Edge Function (M1) under the service role. A member
-- must not be able to read — let alone reset — their own counter.
create table public.upload_quota (
  user_id  uuid not null references auth.users (id) on delete cascade,
  day      date not null default current_date,
  count    integer not null default 0 constraint upload_quota_count_nonnegative check (count >= 0),
  bytes    bigint not null default 0 constraint upload_quota_bytes_nonnegative check (bytes >= 0),
  primary key (user_id, day)
);

comment on table public.upload_quota is
  'Service-role only. A member who can write this can lift their own quota (CLAUDE.md §6).';

revoke all on public.upload_quota from anon, authenticated;

alter table public.upload_quota enable row level security;
