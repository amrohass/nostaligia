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
select plan(21);

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
  not has_function_privilege('media_worker', 'public.activate_release(uuid)', 'execute'),
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
  public.record_release('not-a-release-path', 0, 0) ->> 'reason',
  'invalid_path',
  'a release path that is not /v/{timestamp}/ is refused');

select is(
  (public.record_release('/v/2026-08-19T12:00:00Z/', 4, 2) -> 'recorded')::text,
  'true',
  'a well-formed one is recorded');

-- Inactive on purpose: §2's order is build → validate → flip. A row that went live on
-- creation would make a half-built release visible the moment the first shard landed.
select is(
  (select active from public.releases r where r.path = '/v/2026-08-19T12:00:00Z/'),
  false,
  '...and is NOT live — activation is a separate, deliberate step');

select is(
  public.record_release('/v/2026-08-19T12:00:00Z/', 4, 2) ->> 'reason',
  'duplicate_path',
  'recording the same path twice is refused, not left to abort the publisher''s transaction');

-- The flip. Two releases, one active, and the index makes any other state unrepresentable.
select public.record_release('/v/2026-08-19T13:00:00Z/', 9, 5);

select public.activate_release(
  (select id from public.releases where path = '/v/2026-08-19T12:00:00Z/'));

select is(
  public.activate_release(
    (select id from public.releases where path = '/v/2026-08-19T13:00:00Z/')) ->> 'previous_path',
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

select * from finish();
rollback;
