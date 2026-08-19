-- 0038 · The lease, verified where the writes happen
--
-- 0034 built a lease that survives a pooled connection and said, in bold, that the lock is
-- what prevents races. It then shipped two functions that never look at it.
--
--   record_release(path, revisions)   inserts a release row
--   activate_release(id)              moves the pointer every visitor reads
--
-- Neither took a holder, neither read publish_lease, and both were granted to service_role.
-- So the lease governed who may BEGIN a publish and nothing at all about who may finish
-- one, which is the half that touches the archive.
--
-- ── The failure this closes ──────────────────────────────────
--
-- Publisher A claims the lease and starts building. The build outruns the five-minute TTL —
-- reachable today, because release.ts never renews and every release is a full rewrite of
-- every shard, growing linearly with the archive. A's lease lapses. B reclaims it, which
-- 0034 permits by design so a crashed publisher cannot wedge the pipeline, builds a NEWER
-- release from NEWER data, records it and flips the pointer. Then A finishes, records its
-- release, and flips the pointer to its own older one.
--
-- The archive is now serving content that predates an approval a moderator already watched
-- go live. Nothing raised. Both publishers behaved exactly as written.
--
-- 17_publish_lease tests 22–27 are that sequence. Test 27 runs the same two statements with
-- the check removed and shows the stale release winning, because a guard that is never
-- observed failing is a guard nobody can tell is still connected.
--
-- ── Why BOTH functions, when only one moves the pointer ──────
--
-- activate_release is the flip and is obviously the one to guard. record_release is guarded
-- too, and not for symmetry: a release row recorded without a lease is a row some later
-- operator can activate by id, so leaving it unguarded moves the same hazard from now to
-- whenever somebody reads the ledger during an incident. Refusing at the insert means a
-- publisher that lost its lease leaves nothing behind to be found and trusted later.
--
-- ── Refuse BEFORE writing, which is what makes retry work ────
--
-- The check runs before the INSERT and before either UPDATE. That ordering is the whole of
-- "a refusal leaves the archive where the next tick retries":
--
--   no release row is recorded  →  the ACTIVE release keeps its old watermark
--                               →  publish_pending() still sees current > published
--                               →  the next cron tick publishes, with a live lease
--
-- Had the refusal come after the insert, the abandoned row would carry the CLAIM-time
-- revision of a build that never went live, and any later activation of it would stamp the
-- watermark forward over work that was never published. 20_publish_cron test 28 asserts the
-- pending state survives a refusal, because the ordering is invisible from the return value.
--
-- ── A correction to 0037's header ────────────────────────────
--
-- 0037 argued for carrying the revision explicitly rather than stashing it on the lease row,
-- and gave as its reason: "a stale flip moves the watermark BACKWARD and the predicate goes
-- true", so the archive self-heals. That sentence is now wrong, and it is wrong because of
-- this file: the stale flip is REFUSED, so it no longer happens and there is nothing to heal
-- from. 0037 is applied and pushed and is not edited; the correction lives here.
--
-- Two consequences, stated rather than left implied:
--
--   1. The self-heal is not dead code, but it no longer has that job. The comparison
--      `current_revision > active.content_revision` is the same one that drives every
--      ordinary publish decision, and it still fires when an operator deliberately
--      activates an older release — the rollback path §2 names and nothing implements yet.
--      What died is the CLAIM that it defends the stale-flip case. Prevention replaced it.
--
--   2. The argument 0037 used to reject the lease-row alternative no longer holds. With a
--      verified lease, record_release could safely read the revision from publish_lease,
--      because it has just proved the lease is its own. The explicit parameter stays —
--      the value's provenance is visible at the call site rather than fetched from shared
--      state — but that is a readability preference now, not a safety argument, and it
--      should not be defended as one.

set search_path = public, extensions;

-- ── The check, once ──────────────────────────────────────────

/*
 * NULL when p_holder currently holds the lease; otherwise the reason it does not.
 *
 * Named for what it returns. A boolean would force both callers to invent their own
 * refusal text and the two would drift; the reasons here are 0034's own vocabulary —
 * no_lease, not_holder, lease_expired — so an operator reading a publisher log sees the
 * same words whichever function refused.
 *
 * An EXPIRED lease is refused even when the holder matches, exactly as renew_publish_lease
 * refuses it. Once it lapsed, somebody else may already have taken it and begun writing,
 * and "it is still mine" is a belief the row stopped supporting.
 *
 * Granted to nobody. Its only callers are the two functions below, which are SECURITY
 * DEFINER and therefore run as this function's owner.
 */
create or replace function public.publish_lease_fault(p_holder uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_holder is null then 'holder_required'
    when not exists (select 1 from public.publish_lease l where l.id) then 'no_lease'
    when (select l.holder from public.publish_lease l where l.id) is distinct from p_holder
      then 'not_holder'
    when (select l.expires_at from public.publish_lease l where l.id) <= now()
      then 'lease_expired'
    else null
  end;
$$;

comment on function public.publish_lease_fault(uuid) is
  'NULL when the caller holds a live publish lease, else why not (CLAUDE.md §2).';

-- ── record_release ───────────────────────────────────────────
--
-- DROP and CREATE, not CREATE OR REPLACE: adding p_holder would OVERLOAD rather than
-- replace, leaving the unguarded three-argument version callable and making the PostgREST
-- call ambiguous besides. Same reasoning as 0037's own drop, and the same trap.

drop function public.record_release(text, bigint, bigint);

create function public.record_release(
  p_path             text,
  p_content_revision bigint,
  p_counter_revision bigint,
  p_holder           uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fault text;
  v_id    uuid;
begin
  -- First, before any write. See the header: this ordering is what leaves the archive in a
  -- state the next tick retries from.
  v_fault := public.publish_lease_fault(p_holder);
  if v_fault is not null then
    return jsonb_build_object('recorded', false, 'reason', v_fault);
  end if;

  if p_path is null or p_path !~ '^/v/[0-9TZ:.-]+/$' then
    return jsonb_build_object('recorded', false, 'reason', 'invalid_path');
  end if;
  if p_content_revision is null or p_counter_revision is null then
    return jsonb_build_object('recorded', false, 'reason', 'revision_required');
  end if;
  -- Pre-checked rather than left to the unique constraint: a violation would abort the
  -- caller's transaction, and the caller is a publisher that has already written objects.
  if exists (select 1 from public.releases r where r.path = p_path) then
    return jsonb_build_object('recorded', false, 'reason', 'duplicate_path');
  end if;

  insert into public.releases (path, active, content_revision, counter_revision)
  values (p_path, false, p_content_revision, p_counter_revision)
  returning id into v_id;

  return jsonb_build_object('recorded', true, 'id', v_id, 'path', p_path,
                            'content_revision', p_content_revision,
                            'counter_revision', p_counter_revision);
end;
$$;

comment on function public.record_release(text, bigint, bigint, uuid) is
  'Record a built release, inactive, stamped with its claim-time revision. Lease required.';

-- ── activate_release ─────────────────────────────────────────

drop function public.activate_release(uuid);

create function public.activate_release(p_id uuid, p_holder uuid)
returns jsonb
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
    return jsonb_build_object('activated', false, 'reason', v_fault);
  end if;

  select * into v_target from public.releases where id = p_id;
  if not found then
    return jsonb_build_object('activated', false, 'reason', 'unknown_release');
  end if;

  select r.path into v_previous from public.releases r where r.active;

  -- TWO statements, not one. `set active = (id = p_id)` reads better and is wrong:
  -- releases_only_one_active is a non-deferrable partial unique index, so a single UPDATE
  -- checks it row by row and whether it succeeds depends on the order the planner happens
  -- to touch rows in. Clearing first and setting second is order-independent, and both are
  -- in one transaction, so no observer ever sees zero active releases.
  update public.releases set active = false where active;
  update public.releases set active = true where id = p_id;

  return jsonb_build_object('activated', true, 'path', v_target.path,
                            'previous_path', v_previous);
end;
$$;

comment on function public.activate_release(uuid, uuid) is
  'CLAUDE.md §2 — the atomic pointer flip, refused unless the caller still holds the lease.';

-- ── Grants ───────────────────────────────────────────────────
--
-- The two release functions keep service_role and nothing else, as 0034 and 0037 had them.
-- publish_lease_fault goes to nobody: its callers are SECURITY DEFINER and run as its owner,
-- so a grant would widen the surface without enabling anything.

revoke execute on function public.publish_lease_fault(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function public.record_release(text, bigint, bigint, uuid)
  from public, anon, authenticated;
revoke execute on function public.activate_release(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.record_release(text, bigint, bigint, uuid) to service_role;
grant execute on function public.activate_release(uuid, uuid)                to service_role;
