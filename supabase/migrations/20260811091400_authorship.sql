-- 0014 · Authorship, day-precision timestamps, self-approval
--
-- Three things that have to exist before the privilege pass in 0015, because that
-- migration withholds the columns these triggers fill in.
--
-- The pattern throughout: if a column must not be forgeable, do not grant it and let
-- a trigger set it. A member cannot type `created_by` into an INSERT at all, so
-- there is nothing for a WITH CHECK to catch. The policy check stays anyway — two
-- independent mechanisms, which is the point.

set search_path = public, extensions;

-- ── Day-precision public timestamps (§7) ─────────────────────
--
-- §7: "Public timestamps are day-precision. Never expose exact submission times
-- publicly." Exact submission times are part of the same correlation vector as
-- coordinates — knowing an item was submitted at 02:14 local narrows who submitted
-- it far more than the date does.
--
-- A generated column is cleaner than a view: the raw timestamp stays for moderators
-- and the publisher, the truncated one is what gets granted, and no application code
-- has to remember to truncate. UTC is pinned explicitly because `created_at::date`
-- would depend on the session TimeZone and therefore not be immutable.
alter table public.posts
  add column created_on date
    generated always as ((created_at at time zone 'UTC')::date) stored;

alter table public.comments
  add column created_on date
    generated always as ((created_at at time zone 'UTC')::date) stored;

comment on column public.posts.created_on is
  'Day-precision submission date (CLAUDE.md §7). created_at is not granted to the browser.';
comment on column public.comments.created_on is
  'Day-precision submission date (CLAUDE.md §7). created_at is not granted to the browser.';

-- ── Authorship stamping ──────────────────────────────────────
--
-- author_label deserves a note. §4 grants moderators the right to "publish own
-- content labeled moderator", so the label follows the author's role — which means
-- it must NOT be client-supplied. A member who can write author_label can publish
-- material badged as coming from the archive team. It is set here, from
-- authz_role(), and never granted.
--
-- The auth.uid() IS NULL branch leaves the row alone: that is the service-role path
-- (the M5 bulk importer, which legitimately inserts pre-approved seed material with
-- an explicit author). A browser session always has auth.uid().
create or replace function public.posts_stamp_authorship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  new.created_by   := (select auth.uid());
  new.author_label := coalesce(public.authz_role(), 'member')::text::public.author_label;

  -- §1: everything user-submitted is reviewed before it is public. A submission
  -- enters the queue; it cannot enter approved, and it cannot arrive taken down.
  new.status       := 'pending';
  new.takedown     := false;
  new.approved_by  := null;
  new.approved_at  := null;
  new.content_hash := null;

  return new;
end;
$$;

create trigger posts_stamp_authorship
  before insert on public.posts
  for each row execute function public.posts_stamp_authorship();

create or replace function public.comments_stamp_authorship()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  new.created_by := (select auth.uid());
  new.status     := 'pending';   -- pre-moderation
  return new;
end;
$$;

create trigger comments_stamp_authorship
  before insert on public.comments
  for each row execute function public.comments_stamp_authorship();

create or replace function public.reports_stamp_reporter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  new.reported_by := (select auth.uid());
  new.status      := 'open';
  return new;
end;
$$;

create trigger reports_stamp_reporter
  before insert on public.reports
  for each row execute function public.reports_stamp_reporter();

-- content_blocks.updated_by is not in the INSERT or UPDATE grant either — for the
-- same reason as everything else in this file. Without this it would sit permanently
-- NULL, which in a schema whose whole argument is "the audit trail is a trigger, not
-- application code" is a hole rather than a cosmetic gap: §4 wants every admin edit
-- attributable, and editing site copy is an admin capability.
create or replace function public.content_blocks_stamp_editor()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create trigger content_blocks_stamp_editor
  before insert or update on public.content_blocks
  for each row execute function public.content_blocks_stamp_editor();

-- ── Self-approval, made queryable ────────────────────────────
--
-- §4 explicitly permits a moderator to publish their own content. That is a
-- separation-of-duties gap the project accepts deliberately — a solo maintainer with
-- a small team cannot require a second pair of eyes on everything.
--
-- A gap you cannot close, you make visible. `post.status.approved.self` means the
-- approver and the author were the same person, and
--
--   select * from public.audit_log where action = 'post.status.approved.self';
--
-- is the review query. Replaces the function from 0012; the trigger is unchanged.
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
      if new.status = 'approved'
         and new.approved_by is not null
         and new.approved_by is not distinct from new.created_by then
        v_action := v_action || '.self';
      end if;
    elsif old.takedown is distinct from new.takedown then
      v_action := case when new.takedown then 'post.takedown' else 'post.restore' end;
    else
      v_action := 'post.edit';
    end if;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (auth.uid(), v_action, 'post', new.id, v_before, public.post_audit_snapshot(new));

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
