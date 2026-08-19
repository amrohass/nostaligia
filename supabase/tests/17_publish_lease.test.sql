-- The single writer (migration 0034).
--
-- Everything here runs in ONE session, which is a real limitation for a file about mutual
-- exclusion and is stated rather than papered over: what this proves is that the lease
-- semantics are right and that the advisory lock is genuinely taken. The cross-session race
-- — two connections contending inside open transactions — is scripts/publish-race.sh, which
-- needs two real backends and cannot be expressed in a pgTAP file.
--
-- ── Why not dblink, which is installed ───────────────────────
--
-- dblink refuses a passwordless connection from a non-superuser, and `postgres` is not a
-- superuser on Supabase. Making it work means putting a database password in this file.
-- §6 draws that line in one direction only, and "it is only the local dev password" is
-- precisely the sentence that precedes a credential in a repository — the local password
-- is also the one a contributor reuses. So the race moved to a script that reads its
-- connection from the environment, which is how store-roundtrip.ts already handles MinIO.
--
-- ── What test 13 does instead ────────────────────────────────
--
-- Asserts the advisory lock is HELD, by key, after a claim — pg_locks is visible within
-- the transaction that took it. That is not the same as observing a race, but it is not
-- decoration either: delete pg_try_advisory_xact_lock from 0034 and test 13 fails, while
-- every other assertion in this file still passes.

begin;
create extension if not exists pgtap;

-- 4 privileges · 8 lease semantics · 1 the lock itself · 6 the ledger · 2 the watermark
-- · 6 the lease covers the writes (0038)
select plan(27);

-- ═══ 1–4 · Nobody but the publisher ══════════════════════════
--
-- A member who could claim the lease could stop the archive updating forever with one RPC
-- every four minutes. No exploit required, so no grant given.

select ok(
  not has_function_privilege('anon', 'public.claim_publish_lease(uuid,interval,text)', 'execute'),
  'anon cannot claim the publish lease');

select ok(
  not has_function_privilege('authenticated', 'public.claim_publish_lease(uuid,interval,text)', 'execute'),
  '...nor can a signed-in member');

select ok(
  not has_function_privilege('media_worker', 'public.activate_release(uuid,uuid)', 'execute'),
  '...nor can the media worker flip the pointer');

select ok(
  has_function_privilege('service_role', 'public.claim_publish_lease(uuid,interval,text)', 'execute'),
  'the publisher can — it runs with the service key, server-side');

-- ═══ 5–12 · Lease semantics ══════════════════════════════════

select is(
  (public.claim_publish_lease('00000000-0000-0000-0000-00000000aa01') ->> 'acquired')::boolean,
  true,
  'the first claim on an empty table is granted');

select is(
  public.claim_publish_lease('00000000-0000-0000-0000-00000000aa02') ->> 'reason',
  'held',
  'a second publisher is refused while the first lease is good');

-- Re-entrant on purpose: a publisher that retries its own claim after a transient error
-- must not deadlock itself out of a lease it already holds.
select is(
  public.claim_publish_lease('00000000-0000-0000-0000-00000000aa01') ->> 'reason',
  'reheld',
  '...but the holder may re-take its own lease');

-- A lease longer than any possible build is a wedge waiting to happen, so there is a ceiling.
select is(
  public.claim_publish_lease('00000000-0000-0000-0000-00000000aa01', interval '2 hours') ->> 'reason',
  'ttl_out_of_range',
  'a lease longer than the ceiling is refused — the lease is also the crash recovery');

-- Expiry is the whole reason this is a lease and not a boolean flag. A publisher that dies
-- mid-build stops renewing; without this the pipeline wedges until a human clears it.
-- acquired_at moves back too. A lease that expired was necessarily TAKEN in the past, and
-- publish_lease_forward refuses the impossible state where it was not — correctly, which is
-- why this simulation has to be faithful rather than convenient.
update public.publish_lease
   set acquired_at = now() - interval '10 minutes',
       expires_at  = now() - interval '1 second'
 where id;

select is(
  public.claim_publish_lease('00000000-0000-0000-0000-00000000aa02') ->> 'reason',
  'reclaimed_expired',
  'an expired lease is reclaimable — a crashed publisher does not wedge the pipeline');

select is(
  (select holder from public.publish_lease where id),
  '00000000-0000-0000-0000-00000000aa02'::uuid,
  '...and the new holder really is recorded');

-- The dangerous recovery path. aa01 crashed, its lease lapsed, aa02 took it and is writing.
-- If aa01 wakes up and renews successfully, there are now two live leases and two writers.
update public.publish_lease
   set acquired_at = now() - interval '10 minutes',
       expires_at  = now() - interval '1 second'
 where id;

select is(
  public.renew_publish_lease('00000000-0000-0000-0000-00000000aa02') ->> 'reason',
  'lease_expired',
  'renewing an EXPIRED lease is refused even for the holder — by then it may not be theirs');

select is(
  public.release_publish_lease('00000000-0000-0000-0000-00000000aa01') ->> 'reason',
  'not_holder',
  'and only the holder may release it, so a restarted publisher cannot drop somebody else''s');

-- ═══ 13 · The lock is really taken ══════════════════════════
--
-- The state right now: aa02 holds an EXPIRED lease. Release it and take a fresh one, then
-- look at pg_locks — the xact lock from claim_publish_lease is still held, because this
-- transaction has not ended.
--
-- 20260819/1 is the two-part key 0034 uses. Written out here rather than imported, so that
-- changing the key in the migration fails this test instead of silently moving the lock
-- somewhere the next reader will not think to look.

select public.release_publish_lease('00000000-0000-0000-0000-00000000aa02');
select public.claim_publish_lease('00000000-0000-0000-0000-00000000aa01', interval '5 minutes', 'run A');

select is(
  (select count(*)::integer from pg_locks
    where locktype = 'advisory'
      and classid = 20260819 and objid = 1
      and granted),
  1,
  'claiming takes the advisory lock — this is what makes the claim atomic across sessions');

-- ═══ 14–19 · The release ledger ══════════════════════════════

select is(
  public.record_release('not-a-release-path', 0, 0, '00000000-0000-0000-0000-00000000aa01') ->> 'reason',
  'invalid_path',
  'a release path that is not /v/{timestamp}/ is refused');

select is(
  (public.record_release('/v/2026-08-19T12:00:00Z/', 4, 2, '00000000-0000-0000-0000-00000000aa01') -> 'recorded')::text,
  'true',
  'a well-formed one is recorded');

-- Inactive on purpose: §2's order is build → validate → flip. A row that went live on
-- creation would make a half-built release visible the moment the first shard landed.
select is(
  (select active from public.releases r where r.path = '/v/2026-08-19T12:00:00Z/'),
  false,
  '...and is NOT live — activation is a separate, deliberate step');

select is(
  public.record_release('/v/2026-08-19T12:00:00Z/', 4, 2, '00000000-0000-0000-0000-00000000aa01') ->> 'reason',
  'duplicate_path',
  'recording the same path twice is refused, not left to abort the publisher''s transaction');

-- The flip. Two releases, one active, and the index makes any other state unrepresentable.
select public.record_release('/v/2026-08-19T13:00:00Z/', 9, 5, '00000000-0000-0000-0000-00000000aa01');

select public.activate_release(
  (select id from public.releases where path = '/v/2026-08-19T12:00:00Z/'), '00000000-0000-0000-0000-00000000aa01');

select is(
  public.activate_release(
    (select id from public.releases where path = '/v/2026-08-19T13:00:00Z/'), '00000000-0000-0000-0000-00000000aa01') ->> 'previous_path',
  '/v/2026-08-19T12:00:00Z/',
  'the flip returns what was live before it — rollback is one call, not an investigation');

select is(
  (select count(*)::integer from public.releases where active), 1,
  '...and exactly one release is active, before and after');

-- ═══ 20–21 · The watermark the debounce reads ════════════════
--
-- 0037 added two columns to `releases` and two fields to this function's answer, and the
-- pair is the whole of §2's debounce: publish_pending compares the live counters against
-- the ones stamped here. A release that recorded the wrong number does not fail — it makes
-- the archive stop updating, quietly, which is why the number is asserted rather than
-- assumed.

select is(
  (select r.content_revision || '/' || r.counter_revision
     from public.releases r where r.path = '/v/2026-08-19T13:00:00Z/'),
  '9/5',
  'a release stores the revision it was told, not one it looked up for itself');

-- The claim is where the revision is READ, because it is the only step that happens before
-- the publisher reads the archive. 20_publish_cron test 21 is the counter-test for this:
-- reading it any later marks a mid-build approval as published without publishing it.
select is(
  public.claim_publish_lease('00000000-0000-0000-0000-00000000aa01') ? 'content_revision',
  true,
  'and the claim reports the revision it was taken at, for the release to be stamped with');

-- ═══ 22–27 · The lease covers the WRITES, not just the start ══
--
-- 0034 shipped a lease that governed who may BEGIN a publish and said nothing about who may
-- finish one. record_release and activate_release took no holder and never read the row, so
-- the guarded step was the cheap one and the two that touch the archive were open. 0038
-- closes that.
--
-- The sequence below is the real failure, not an abstract one. It is reachable today:
-- release.ts never renews its lease, and every release is a full rewrite of every shard, so
-- a build that outgrows the five-minute TTL is a matter of how large the archive is.

delete from public.releases;
delete from public.publish_lease;

-- 22–23 · No lease at all. The refusal has to come BEFORE the insert, because a row left
-- behind by a refused publisher is a row somebody can activate later by id.

select is(
  public.record_release('/v/2026-08-19T14:00:00Z/', 1, 1, '00000000-0000-0000-0000-00000000aa01') ->> 'reason',
  'no_lease',
  'recording a release with no lease at all is refused');

select is(
  (select count(*)::integer from public.releases), 0,
  '...and nothing was written — the check runs before the insert, so a retry starts clean');

-- ── A lapses, B takes over and publishes, A finishes late ────

select public.claim_publish_lease('00000000-0000-0000-0000-00000000aa01', interval '5 minutes', 'publisher A');

-- A's build outran its TTL. acquired_at moves back too: a lease that expired was
-- necessarily taken in the past, and publish_lease_forward refuses the impossible state.
update public.publish_lease
   set acquired_at = now() - interval '10 minutes',
       expires_at  = now() - interval '1 second'
 where id;

-- B reclaims — which 0034 permits on purpose, so a crashed publisher cannot wedge the
-- pipeline — and publishes NEWER content built from a NEWER revision.
select public.claim_publish_lease('00000000-0000-0000-0000-00000000aa02', interval '5 minutes', 'publisher B');
select public.record_release('/v/2026-08-19T15:00:00Z/', 20, 10, '00000000-0000-0000-0000-00000000aa02');
select public.activate_release(
  (select id from public.releases where path = '/v/2026-08-19T15:00:00Z/'), '00000000-0000-0000-0000-00000000aa02');

-- 24–25 · A wakes up and tries to finish. Before 0038 this succeeded.

select is(
  public.record_release('/v/2026-08-19T14:30:00Z/', 5, 2, '00000000-0000-0000-0000-00000000aa01') ->> 'reason',
  'not_holder',
  'the publisher whose lease lapsed cannot record — somebody else holds it now');

select is(
  (select path from public.releases where active),
  '/v/2026-08-19T15:00:00Z/',
  '...and the newer release is still the one being served');

-- 26 · The other half. B records legitimately, THEN its own lease lapses before the flip.
-- Refused even though the holder matches: once it expired, another publisher may already
-- have taken it, and "it is still mine" is a belief the row stopped supporting.

select public.record_release('/v/2026-08-19T14:30:00Z/', 5, 2, '00000000-0000-0000-0000-00000000aa02');
update public.publish_lease
   set acquired_at = now() - interval '10 minutes',
       expires_at  = now() - interval '1 second'
 where id;

select is(
  public.activate_release(
    (select id from public.releases where path = '/v/2026-08-19T14:30:00Z/'), '00000000-0000-0000-0000-00000000aa02') ->> 'reason',
  'lease_expired',
  'the flip is refused once the lease lapsed, even for the holder that recorded it');

-- ═══ 27 · The counter-test ═══════════════════════════════════
--
-- The same two statements activate_release runs, with the lease check removed and nothing
-- else changed. If this did not flip the stale release over the newer one, the guard above
-- would be decoration and no test in this file would be able to tell.

create function pg_temp.activate_release_unchecked(p_id uuid) returns void
language plpgsql as $fn$
begin
  update public.releases set active = false where active;
  update public.releases set active = true where id = p_id;
end $fn$;

select pg_temp.activate_release_unchecked(
  (select id from public.releases where path = '/v/2026-08-19T14:30:00Z/'));

select is(
  (select path from public.releases where active),
  '/v/2026-08-19T14:30:00Z/',
  'without the check the SAME flip succeeds, and the stale release wins over the newer one');

select * from finish();
rollback;
