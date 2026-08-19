-- 0039 · Rollback, and the hold that makes it survive two minutes
--
-- §2: "Rollback = flip back." That sentence is true about the LEDGER and false about the
-- archive, and the gap between those two facts is this migration.
--
-- Housekeeping first, per the standing rule that a correction lands in a migration header
-- rather than a ledger nobody keeps:
--
--   0037's "repeated in CLAUDE.md's growth note" resolves to CLAUDE.md §6,
--   recorded there in 1ca93cb.
--
-- ── Why the flip alone rolls nothing back ────────────────────
--
-- activate_release updates a row in `releases`. §2's read path is "Zero database reads for
-- public visitors": a browser's entire notion of which release is live is manifest.json on
-- the CDN. So a ledger-only rollback inverts the invariant release.ts was built around —
-- the ledger would name a release the archive is not serving, and the bad release would go
-- on being served indefinitely while every dashboard said it had been rolled back.
--
-- The object write therefore lives in the Edge Function (rollback.ts), which writes
-- manifest.json BEFORE calling this file's RPC, for the same reason publish() does: if the
-- two ever disagree, the archive must be the one that is already right.
--
-- ── The two-minute revert, which is the real cost of D-2 ─────
--
-- publish_pending() compares the live counters against the ACTIVE release's stamped
-- revision. Roll back to an older release and its watermark is LOWER than current, so the
-- predicate goes true and the next tick republishes the release you just rolled away from.
-- Within two minutes. A rollback that survives 120 seconds is not a rollback.
--
-- So a rollback stops the pipeline. publish_hold is a singleton row; while it exists,
-- publish_pending() reports pending=false with reason 'held_by_operator' and publish_tick()
-- therefore dispatches nothing — no change to publish_tick was needed, because it already
-- refuses whatever publish_pending refuses.
--
-- ── The alternative, and why it is worse than it looks ───────
--
-- Stamping the restored release's watermark forward to the current revision is one
-- statement, needs no table, and silences the cron immediately. It is wrong twice.
--
-- It makes the ledger lie about the revision that release was built from, destroying the
-- provenance 0038 spent a whole migration protecting. And it buys quiet only until the next
-- approval, which re-runs the same publisher that produced the bad release — two minutes of
-- calm, then re-breakage, with no signal that anything is wrong. A rollback means the
-- pipeline is not trusted; the honest response is to stop it, not to tell it all is well.
--
-- ── The trade-off, stated because it is a launch gate ────────
--
-- A hold nobody clears stops the archive exactly as silently as a broken cron — the failure
-- class this whole milestone is built to refuse. That is survivable only because the hold is
-- DISTINGUISHABLE: 'held_by_operator' is not 'unchanged', so a monitor can tell a stopped
-- pipeline from an idle one. CLAUDE.md §11 gate 5 now requires exactly that alert before
-- launch. This migration is not safe to rely on without it.
--
-- Until that alert exists, the cheapest version of the failure is closed here instead: a
-- hold cannot be anonymous or unexplained. `reason` and `held_by` are NOT NULL with no
-- defaults and reason may not be blank, so the row always says who stopped the archive and
-- why. That is not a substitute for the alert and is not offered as one.

set search_path = public, extensions;

-- ── The hold ─────────────────────────────────────────────────

create table public.publish_hold (
  -- Singleton, the same shape as publish_lease and publish_revision: `id` can only be true,
  -- so "two holds that disagree" is unrepresentable rather than merely unlikely.
  id      boolean primary key default true,

  -- NO DEFAULTS on either of these, deliberately. A default would let a caller stop the
  -- archive without saying who or why, and the operator who finds a held pipeline at 3am
  -- has nothing to go on but this row. An unattributed hold is the cheapest version of the
  -- failure §11 gate 5 exists to catch.
  reason  text        not null,
  held_by uuid        not null,
  held_at timestamptz not null default now(),

  constraint publish_hold_singleton check (id),
  -- btrim, because '' and '   ' are the same evasion and NOT NULL stops neither.
  constraint publish_hold_reason_present check (btrim(reason) <> ''),
  constraint publish_hold_reason_length check (length(reason) <= 500)
);

comment on table public.publish_hold is
  'CLAUDE.md §2/§11 — the pipeline is stopped, by this person, for this reason.';

alter table public.publish_hold enable row level security;

-- No policies, and none coming. RLS with no policy denies everything, which is right for a
-- table no browser session reaches. Supabase grants ALL on new public tables to anon and
-- authenticated by default, so not revoking would hand a member a switch that stops the
-- archive for everybody. service_role gets full DML because 07_triggers test 18 requires it
-- on every table — BYPASSRLS exempts a role from row POLICIES and confers no privilege, and
-- a hold nobody can clear is worse than no hold at all.
revoke all on public.publish_hold from anon, authenticated;
grant select, insert, update, delete on public.publish_hold to service_role;

-- ── The predicate learns about it ────────────────────────────
--
-- The hold branch is FIRST. A held pipeline publishes nothing regardless of what changed,
-- and reporting 'content_changed' while refusing to act on it would be the monitoring
-- failure §11 gate 5 names, written into the function itself.
--
-- Body is 0037's, with one branch added and the hold fields reported.

create or replace function public.publish_pending()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Named here and in CLAUDE.md §6. Lowering it costs money in a straight line; raising it
  -- makes like counts staler and nothing else.
  c_counter_floor constant interval := interval '1 hour';

  v_rev    public.publish_revision%rowtype;
  v_active public.releases%rowtype;
  v_hold   public.publish_hold%rowtype;
  v_reason text;
begin
  select * into v_rev from public.publish_revision where id;
  select * into v_hold from public.publish_hold where id;

  if found then
    -- Deliberately not 'unchanged'. §11 gate 5: the alert must separate a pipeline a human
    -- stopped from one with nothing to do, and it can only do that if they are named apart.
    return jsonb_build_object(
      'pending',          false,
      'reason',           'held_by_operator',
      'hold_reason',      v_hold.reason,
      'held_by',          v_hold.held_by,
      'held_at',          v_hold.held_at,
      'content_revision', v_rev.content_revision,
      'counter_revision', v_rev.counter_revision);
  end if;

  select * into v_active from public.releases where active;

  if not found then
    v_reason := 'no_active_release';
  elsif v_rev.content_revision > v_active.content_revision then
    v_reason := 'content_changed';
  elsif v_rev.counter_revision > v_active.counter_revision then
    v_reason := case
      when now() - v_active.created_at > c_counter_floor then 'counters_changed'
      else 'counters_within_floor'
    end;
  else
    v_reason := 'unchanged';
  end if;

  return jsonb_build_object(
    'pending',                    v_reason in ('no_active_release', 'content_changed', 'counters_changed'),
    'reason',                     v_reason,
    'content_revision',           v_rev.content_revision,
    'counter_revision',           v_rev.counter_revision,
    'published_content_revision', v_active.content_revision,
    'published_counter_revision', v_active.counter_revision,
    'active_release',             v_active.path,
    'active_created_at',          v_active.created_at,
    'changed_at',                 v_rev.changed_at,
    'counter_floor',              c_counter_floor::text);
end;
$$;

comment on function public.publish_pending() is
  'CLAUDE.md §2 — the debounce. Says why, not just whether, and names a hold as a hold.';

-- ── The rollback ─────────────────────────────────────────────

/*
 * Flip the pointer back, and stop the pipeline in the same transaction.
 *
 * Keyed by PATH, not id. §2 says "Rollback = flip back" and activate_release already hands
 * back `previous_path` — a path is what the operator actually has in front of them at the
 * moment they decide, and it is what the Edge Function has to write into manifest.json
 * anyway. An id would mean a lookup RPC whose only purpose was to turn one into the other.
 *
 * The lease is required and checked by 0038's publish_lease_fault, which is also what makes
 * the ordering safe: the caller has held the lease since before it wrote manifest.json, so
 * no publisher can be running concurrently and no cron tick can interleave between the
 * object and this row.
 *
 * Flip and hold are ONE transaction. A rollback that flipped without holding would be
 * reverted by the next tick two minutes later; a rollback that held without flipping would
 * stop the archive on the bad release. Neither half is useful alone.
 */
create or replace function public.rollback_release(
  p_path   text,
  p_holder uuid,
  p_reason text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fault    text;
  v_target   public.releases%rowtype;
  v_previous text;
begin
  v_fault := public.publish_lease_fault(p_holder);
  if v_fault is not null then
    return jsonb_build_object('rolled_back', false, 'reason', v_fault);
  end if;

  -- Checked before anything is written, so a caller that forgot the reason is refused
  -- rather than recorded anonymously. The table constraint would catch it too; this makes
  -- the refusal a named answer instead of an exception at a caller that has already
  -- rewritten the pointer object.
  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('rolled_back', false, 'reason', 'reason_required');
  end if;

  select * into v_target from public.releases r where r.path = p_path;
  if not found then
    return jsonb_build_object('rolled_back', false, 'reason', 'unknown_release');
  end if;
  if v_target.active then
    -- Idempotent-ish, and named: rolling back onto what is already live is a no-op the
    -- caller should be told about rather than a silent success that suggests something moved.
    return jsonb_build_object('rolled_back', false, 'reason', 'already_active');
  end if;

  select r.path into v_previous from public.releases r where r.active;

  -- Two statements, for the reason 0034 gave: releases_only_one_active is a non-deferrable
  -- partial unique index, so a single `set active = (path = p_path)` succeeds or fails
  -- depending on the order the planner touches rows in.
  update public.releases set active = false where active;
  update public.releases set active = true where id = v_target.id;

  insert into public.publish_hold (id, reason, held_by)
  values (true, btrim(p_reason), p_holder)
  on conflict (id) do update
    set reason = excluded.reason, held_by = excluded.held_by, held_at = now();

  return jsonb_build_object('rolled_back', true, 'path', v_target.path,
                            'previous_path', v_previous, 'held', true);
end;
$$;

comment on function public.rollback_release(text, uuid, text) is
  'CLAUDE.md §2 — flip back AND stop the pipeline, so the next tick cannot undo it.';

/*
 * Resume.
 *
 * No lease required, on purpose. A hold means publishing is stopped, so there is nothing to
 * race; requiring a lease would add a way for the resume to fail at the moment it is most
 * needed. The actor is recorded in the return value rather than the table, because the row
 * is about to stop existing.
 */
create or replace function public.release_publish_hold(p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hold public.publish_hold%rowtype;
begin
  select * into v_hold from public.publish_hold where id;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'no_hold');
  end if;

  delete from public.publish_hold where id;

  return jsonb_build_object('released', true, 'was_held_by', v_hold.held_by,
                            'was_reason', v_hold.reason, 'released_by', p_actor);
end;
$$;

comment on function public.release_publish_hold(uuid) is
  'Resume publishing after a rollback. Deliberately needs no lease — nothing is running.';

-- ── Grants ───────────────────────────────────────────────────
--
-- service_role and nothing else. A member who could roll the archive back to an arbitrary
-- release, or stop it publishing, needs no exploit to do real damage — and rollback_release
-- also demands a publish lease, which §2 already keeps out of browser reach entirely.

revoke execute on function public.rollback_release(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.release_publish_hold(uuid)         from public, anon, authenticated;
revoke execute on function public.publish_pending()                  from public, anon, authenticated;

grant execute on function public.rollback_release(text, uuid, text)  to service_role;
grant execute on function public.release_publish_hold(uuid)          to service_role;
grant execute on function public.publish_pending()                   to service_role;
