-- 0034 · The single writer, and the ledger it writes to
--
-- §2: "Debounced cron (2–5 min) → single writer via advisory lock → rebuild only changed
-- shards into /v/{ISO-ts}/ → validate → atomically flip the manifest.json pointer." And,
-- in bold: "The single-writer lock is what prevents races — not the cron. Do not remove it."
--
-- This is that lock. It is not, however, `pg_try_advisory_lock` on its own, and the reason
-- is worth being precise about because the naive version LOOKS correct.
--
-- ── Why a session advisory lock alone would protect nothing ──
--
-- pg_advisory_lock is held by a SESSION. The publisher is an Edge Function talking to
-- PostgREST over HTTP: every RPC gets a connection from a pool and hands it straight back.
-- A session lock taken in call #1 is released before call #2 is dialled — and worse, the
-- connection is then handed to somebody else while still holding nothing.
--
-- So a publisher written as
--
--     rpc('take_lock')  →  build shards for 90 seconds  →  rpc('flip_pointer')
--
-- would acquire a lock, drop it immediately, and publish with no mutual exclusion at all,
-- while every line of it read as if it were guarded. That is the failure this file exists
-- to not have.
--
-- ── What actually holds across HTTP ──────────────────────────
--
-- A LEASE: a row naming who is publishing and until when. It survives the connection going
-- back to the pool because it is data, not session state. A publisher that crashes mid-build
-- stops renewing and the lease expires, which is the property a session lock gives you for
-- free and a naive `is_publishing boolean` flag does not — that flag would wedge the
-- pipeline permanently on the first crash, and someone would have to clear it by hand at
-- the exact moment nobody is looking.
--
-- The advisory lock is still here and still load-bearing, but for one statement rather than
-- one publish: pg_try_advisory_XACT_lock serialises the CLAIM.
--
-- This was measured against a copy of the function below with the lock deleted and nothing
-- else changed, two real sessions, in scripts/publish-race.sh:
--
--   first claim, empty table   The second publisher cannot see the first one's row — the
--                              INSERT is uncommitted and therefore invisible — so it
--                              inserts too, and hits `duplicate key value violates unique
--                              constraint publish_lease_pkey`. The primary key does stop
--                              this shape, but by raising an exception at a publisher that
--                              has already written objects to R2, rather than telling it
--                              cleanly that somebody else is busy.
--
--   reclaiming an EXPIRED      A gets `reclaimed`. B gets `reclaimed`. No error, no
--   lease                      constraint violation, two publishers each holding what they
--                              believe is an exclusive lease, both writing into the same
--                              release directory.
--
-- The second case has no backstop of any kind, because both sessions UPDATE an existing row
-- instead of inserting a new one, and an UPDATE that blocks and then proceeds is
-- indistinguishable from one that never contended. It is also the path taken on every
-- recovery from a crashed publisher — which is to say, at the moment nobody is watching.
--
-- That is why the lock is not optional, and why "the unique index already prevents two
-- leases" is a true sentence that does not mean what it appears to mean.
--
-- ── Scope ────────────────────────────────────────────────────
--
-- Everything here is service_role only. No browser role, and not media_worker: the publisher
-- runs server-side with the service key, and a lease is not something a member has any
-- business observing, let alone taking. 16_function_grants pins that.

set search_path = public, extensions;

-- ── The lease ────────────────────────────────────────────────

create table public.publish_lease (
  -- Singleton. `id` can only ever be true, so the primary key admits exactly one row and
  -- "two leases" is unrepresentable rather than merely unlikely.
  id          boolean primary key default true,
  holder      uuid        not null,
  acquired_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  -- Free text for a human reading the table during an incident: which run, which trigger.
  note        text,

  constraint publish_lease_singleton check (id),
  constraint publish_lease_forward check (expires_at > acquired_at),
  constraint publish_lease_note_length check (note is null or length(note) <= 200)
);

comment on table public.publish_lease is
  'CLAUDE.md §2 — the single writer, held as data so it survives a pooled connection.';

alter table public.publish_lease enable row level security;

-- No policies, and none coming. RLS with no policy denies everything, which is the correct
-- posture for a table no browser session has any reason to reach. The grants below are the
-- real control; RLS is the floor under them.
revoke all on public.publish_lease from anon, authenticated;
grant select, insert, update, delete on public.publish_lease to service_role;

-- ── The functions ────────────────────────────────────────────

/*
 * Take the lease, or find out who has it.
 *
 * Returns { acquired, holder, expires_at, reason } — never raises for a contended or held
 * lease, because "somebody else is publishing" is a normal outcome of a cron that fires
 * every two minutes, not an error. A publisher that got an exception here would log an
 * exception every other run and teach its operator to ignore the log.
 */
create or replace function public.claim_publish_lease(
  p_holder uuid,
  p_ttl    interval default interval '5 minutes',
  p_note   text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- One fixed key, written as a literal rather than hashed from a string: hashtext() is
  -- explicitly not guaranteed stable across PostgreSQL versions, and a lock key that
  -- changes on a minor upgrade is a single-writer guarantee that silently becomes two.
  -- The two-argument form namespaces it, so a collision with somebody else's advisory
  -- lock would need both halves to match.
  c_lock_class constant integer := 20260819;
  c_lock_key   constant integer := 1;

  -- A ceiling, because the lease is also the thing that unwedges a crashed publisher and a
  -- long lease is a long wedge. Fifteen minutes is far beyond any build this archive will
  -- ever do; a publisher that needs more has a different problem than lease duration.
  c_max_ttl    constant interval := interval '15 minutes';

  v_now    timestamptz := now();
  v_lease  public.publish_lease%rowtype;
begin
  if p_holder is null then
    return jsonb_build_object('acquired', false, 'reason', 'holder_required');
  end if;
  if p_ttl is null or p_ttl <= interval '0' or p_ttl > c_max_ttl then
    return jsonb_build_object('acquired', false, 'reason', 'ttl_out_of_range',
                              'max_ttl', c_max_ttl::text);
  end if;

  -- The serialisation point. Transaction-scoped, so it is released when this function's
  -- transaction ends — which is the right lifetime for a claim and the wrong one for a
  -- publish, hence the lease below.
  if not pg_try_advisory_xact_lock(c_lock_class, c_lock_key) then
    return jsonb_build_object('acquired', false, 'reason', 'contended');
  end if;

  select * into v_lease from public.publish_lease where id;

  -- Nobody has ever published, or the row was released.
  if not found then
    insert into public.publish_lease (holder, acquired_at, expires_at, note)
    values (p_holder, v_now, v_now + p_ttl, p_note);
    return jsonb_build_object('acquired', true, 'holder', p_holder,
                              'expires_at', v_now + p_ttl, 'reason', 'granted');
  end if;

  -- Somebody else is publishing, and their lease is still good.
  if v_lease.holder <> p_holder and v_lease.expires_at > v_now then
    return jsonb_build_object('acquired', false, 'reason', 'held',
                              'holder', v_lease.holder, 'expires_at', v_lease.expires_at);
  end if;

  -- Either it is ours already (a retry, or a second claim in the same run) or the previous
  -- holder stopped renewing and its lease ran out. Both take the row.
  update public.publish_lease
     set holder = p_holder,
         acquired_at = v_now,
         expires_at = v_now + p_ttl,
         note = p_note
   where id;

  return jsonb_build_object(
    'acquired', true, 'holder', p_holder, 'expires_at', v_now + p_ttl,
    'reason', case when v_lease.holder = p_holder then 'reheld' else 'reclaimed_expired' end,
    'previous_holder', v_lease.holder);
end;
$$;

comment on function public.claim_publish_lease(uuid, interval, text) is
  'CLAUDE.md §2 — take the single-writer lease. Refuses rather than raises when held.';

/*
 * Extend a lease you already hold.
 *
 * Refuses an EXPIRED lease even when the holder matches. That is the discriminating case:
 * once it lapsed, another publisher may already have taken it and begun writing, and a
 * renew that silently succeeded would give two writers a lease each — the exact state the
 * whole file exists to prevent, arrived at through the recovery path.
 */
create or replace function public.renew_publish_lease(
  p_holder uuid,
  p_ttl    interval default interval '5 minutes'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_ttl constant interval := interval '15 minutes';
  v_now     timestamptz := now();
  v_lease   public.publish_lease%rowtype;
begin
  if p_ttl is null or p_ttl <= interval '0' or p_ttl > c_max_ttl then
    return jsonb_build_object('renewed', false, 'reason', 'ttl_out_of_range');
  end if;

  select * into v_lease from public.publish_lease where id;
  if not found then
    return jsonb_build_object('renewed', false, 'reason', 'no_lease');
  end if;
  if v_lease.holder <> p_holder then
    return jsonb_build_object('renewed', false, 'reason', 'not_holder',
                              'holder', v_lease.holder);
  end if;
  if v_lease.expires_at <= v_now then
    return jsonb_build_object('renewed', false, 'reason', 'lease_expired',
                              'expired_at', v_lease.expires_at);
  end if;

  update public.publish_lease set expires_at = v_now + p_ttl where id;
  return jsonb_build_object('renewed', true, 'expires_at', v_now + p_ttl);
end;
$$;

comment on function public.renew_publish_lease(uuid, interval) is
  'Extend the publish lease. Refuses once expired — by then it may not be yours.';

/*
 * Give it back.
 *
 * Only the holder may. A publisher that crashed, was restarted, and released "its" lease
 * would otherwise drop the lease of whoever legitimately reclaimed it in the meantime.
 */
create or replace function public.release_publish_lease(p_holder uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lease public.publish_lease%rowtype;
begin
  select * into v_lease from public.publish_lease where id;
  if not found then
    return jsonb_build_object('released', false, 'reason', 'no_lease');
  end if;
  if v_lease.holder <> p_holder then
    return jsonb_build_object('released', false, 'reason', 'not_holder',
                              'holder', v_lease.holder);
  end if;

  delete from public.publish_lease where id;
  return jsonb_build_object('released', true);
end;
$$;

comment on function public.release_publish_lease(uuid) is
  'Release the publish lease. Only the holder may, so a restarted publisher cannot drop somebody else''s.';

-- ── The release ledger ───────────────────────────────────────

/*
 * Record a built-but-not-yet-live release.
 *
 * Inactive on purpose. §2's order is "rebuild → validate → atomically flip the pointer":
 * the row exists so a half-built release is visible to an operator and cleanable, and it
 * becomes live only when activate_release says so. A killed build leaves an inactive row
 * and a directory nobody is pointed at, which is exactly "never visible".
 */
create or replace function public.record_release(p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_path is null or p_path !~ '^/v/[0-9TZ:.-]+/$' then
    return jsonb_build_object('recorded', false, 'reason', 'invalid_path');
  end if;
  -- Pre-checked rather than left to the unique constraint: a violation would abort the
  -- caller's transaction, and the caller is a publisher that has already written objects.
  if exists (select 1 from public.releases r where r.path = p_path) then
    return jsonb_build_object('recorded', false, 'reason', 'duplicate_path');
  end if;

  insert into public.releases (path, active) values (p_path, false)
  returning id into v_id;

  return jsonb_build_object('recorded', true, 'id', v_id, 'path', p_path);
end;
$$;

comment on function public.record_release(text) is
  'Record a built release, inactive. Activation is a separate, deliberate step (CLAUDE.md §2).';

/*
 * The pointer flip, database side.
 *
 * TWO statements, not one. `update releases set active = (id = p_id)` reads better and is
 * wrong: releases_only_one_active is a non-deferrable partial unique index, and a single
 * UPDATE checks it row by row as it goes — so whether it succeeds depends on the order the
 * planner happens to touch rows in. Clearing first and setting second is order-independent,
 * and both statements are in one transaction, so no observer ever sees zero active
 * releases.
 *
 * Returns the previous path, because rollback is "flip it back" and the operator doing that
 * at 3am should not have to go looking for what it was.
 */
create or replace function public.activate_release(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target   public.releases%rowtype;
  v_previous text;
begin
  select * into v_target from public.releases where id = p_id;
  if not found then
    return jsonb_build_object('activated', false, 'reason', 'unknown_release');
  end if;

  select r.path into v_previous from public.releases r where r.active;

  update public.releases set active = false where active;
  update public.releases set active = true where id = p_id;

  return jsonb_build_object('activated', true, 'path', v_target.path,
                            'previous_path', v_previous);
end;
$$;

comment on function public.activate_release(uuid) is
  'CLAUDE.md §2 — the atomic pointer flip. Returns the previous path so rollback is one call.';

/** What is live right now. The publisher needs it to diff; takedown needs it to know what to rewrite. */
create or replace function public.active_release()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object('id', r.id, 'path', r.path, 'created_at', r.created_at)
       from public.releases r where r.active),
    jsonb_build_object('path', null));
$$;

comment on function public.active_release() is
  'The currently active release, or {"path": null} before the first publish.';

-- ── Grants ───────────────────────────────────────────────────
--
-- service_role and nothing else. These are not browser-reachable at any privilege level:
-- a member who could claim the publish lease could stop the archive updating, which is a
-- denial of service that requires no exploit at all, just an RPC call every four minutes.

revoke execute on function public.claim_publish_lease(uuid, interval, text) from public, anon, authenticated;
revoke execute on function public.renew_publish_lease(uuid, interval)        from public, anon, authenticated;
revoke execute on function public.release_publish_lease(uuid)                from public, anon, authenticated;
revoke execute on function public.record_release(text)                       from public, anon, authenticated;
revoke execute on function public.activate_release(uuid)                     from public, anon, authenticated;
revoke execute on function public.active_release()                           from public, anon, authenticated;

grant execute on function public.claim_publish_lease(uuid, interval, text) to service_role;
grant execute on function public.renew_publish_lease(uuid, interval)        to service_role;
grant execute on function public.release_publish_lease(uuid)                to service_role;
grant execute on function public.record_release(text)                       to service_role;
grant execute on function public.activate_release(uuid)                     to service_role;
grant execute on function public.active_release()                           to service_role;
