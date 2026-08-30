-- Rollback, and the hold that makes it last longer than two minutes (migration 0039).
--
-- §2 says "Rollback = flip back", and the ledger half of that is one call that has existed
-- since 0034. This file is about the two things that sentence leaves out.
--
-- ── The test that carries the file ───────────────────────────
--
-- Test 12. publish_pending() compares the live revision against the ACTIVE release's stamped
-- one, so a rolled-back release — which by definition carries an OLDER watermark — reads as
-- out of date. The next two-minute tick republishes exactly what was rolled away from.
--
-- Test 12 asserts the hold suppresses that; test 14 then removes the hold and watches the
-- predicate go to 'content_changed', which is the revert about to happen. Without both, the
-- hold could be doing nothing and every other assertion in this file would still pass.
--
-- ── The object half is not here ──────────────────────────────
--
-- manifest.json is what a browser reads (§2: "Zero database reads for public visitors"), and
-- rewriting it is the Edge Function's job. rollback.test.ts holds those assertions, and they
-- are the ones a ledger-only rollback fails. SQL cannot see the bucket, so this file does not
-- pretend to.
--
-- ── Which of these actually catch something ──────────────────
--
-- 17 of the 19 are DISCRIMINATING: for each, there is a single change to 0039 that fails
-- that assertion and no other. 2 are CORROBORATING — they cannot fail unless a
-- discriminating one fails with them, so they add readability and no coverage. They are
-- marked at the site, because a corroborating assertion that looks load-bearing is how a
-- suite comes to be trusted for something it does not check.
--
-- Measured, not reasoned, wherever it was cheap to measure. Two examples, both run:
--
--   hold write deleted from rollback_release   → 11, 12 fail, nothing else
--   hold branch deleted from publish_pending   → 12, 17 fail, nothing else
--
-- Test 7 was initially filed as corroborating and is not: a rollback_release that writes
-- the hold BEFORE validating the reason leaves a hold behind on the refusal path, and that
-- mutation fails 7 alone. Ordering bugs are exactly what a "nothing was left behind"
-- assertion exists for.
--
-- ── §11 gate 5, and what this file can and cannot enforce ────
--
-- A hold nobody clears stops the archive as silently as a broken cron. The real defence is
-- the publish-age alert §11 gate 5 now requires, and it does not exist yet. What CAN be
-- enforced here is that a hold is never anonymous: reason and held_by are NOT NULL with no
-- defaults and reason may not be blank, so whoever finds a stopped pipeline learns who
-- stopped it and why. Tests 5–8. That is the cheapest version of the failure, not the whole
-- of it, and it is not offered as a substitute for the alert.

begin;
create extension if not exists pgtap;

-- 4 privileges · 4 attribution · 3 the flip · 4 the hold and the revert
-- · 2 resume · 2 refusals
select plan(19);

-- ── Fixtures ─────────────────────────────────────────────────

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000da01', 'rollback-author@t.local'),
  ('00000000-0000-0000-0000-00000000da02', 'rollback-mod@t.local');

insert into public.profiles (id, handle) values
  ('00000000-0000-0000-0000-00000000da01', 'rollback_author')
  -- 0057 provisions a profile on the auth.users insert above, so this is an UPSERT:
  -- the fixture handle this file asserts on must win over the generated placeholder.
  on conflict (id) do update set handle = excluded.handle;


-- An approved post, so publish_revision.content_revision is above zero. Without it the
-- rolled-back release's stamped revision and the live one would both be 0 and test 13 would
-- report 'unchanged' for the wrong reason — passing while testing nothing.
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          location_precision, status, ingest_state,
                          approved_by, approved_at, content_hash)
values ('00000000-0000-0000-0000-0000000000e1', 'media', 'live', 'visible',
        'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000da01',
        'hidden', 'approved', 'ready',
        '00000000-0000-0000-0000-00000000da02', now(), repeat('a', 64));

create function pg_temp.reason() returns text language sql stable as $fn$
  select public.publish_pending() ->> 'reason';
$fn$;

create function pg_temp.pending() returns boolean language sql stable as $fn$
  select (public.publish_pending() ->> 'pending')::boolean;
$fn$;

create function pg_temp.active() returns text language sql stable as $fn$
  select path from public.releases where active;
$fn$;

create temp table qbase as select count(*) as n from net.http_request_queue;

create function pg_temp.queued() returns bigint language sql stable as $fn$
  select (select count(*) from net.http_request_queue) - (select n from qbase);
$fn$;

-- The publisher holds the lease for the whole sequence; 0038 refuses every ledger write
-- without it, and rollback_release is no exception.
select public.claim_publish_lease('00000000-0000-0000-0000-00000000db01',
                                  interval '5 minutes', 'rollback test');

-- Two releases: an old one stamped BEFORE the approval above, and the live one stamped at
-- the current revision. That gap is what makes a rollback look out of date to the debounce.
select public.record_release('/v/2026-08-19T12:00:00Z/', 0, 0,
                             '00000000-0000-0000-0000-00000000db01');
select public.record_release('/v/2026-08-19T13:00:00Z/',
                             (select content_revision from public.publish_revision where id),
                             (select counter_revision from public.publish_revision where id),
                             '00000000-0000-0000-0000-00000000db01');
select public.activate_release(
  (select id from public.releases where path = '/v/2026-08-19T13:00:00Z/'),
  '00000000-0000-0000-0000-00000000db01');

-- ═══ 1–4 · Who may stop the archive ══════════════════════════

select ok(
  not has_function_privilege('anon', 'public.rollback_release(text,uuid,text)', 'execute'),
  'anon cannot roll the archive back to an arbitrary release');

select ok(
  not has_function_privilege('authenticated', 'public.release_publish_hold(uuid)', 'execute'),
  '...nor can a signed-in member resume a pipeline somebody deliberately stopped');

-- Supabase grants ALL on new tables in public to authenticated by default. Without 0039's
-- revoke, any member could insert a hold row and stop the archive for everyone.
select ok(
  not has_table_privilege('authenticated', 'public.publish_hold', 'INSERT'),
  '...nor write the hold row directly, which would stop publishing for everybody');

select ok(
  has_function_privilege('service_role', 'public.rollback_release(text,uuid,text)', 'execute'),
  'the publisher can — it runs server-side with the service key');

-- ═══ 5–8 · A hold is never anonymous ═════════════════════════
--
-- §11 gate 5's cheapest failure is a stopped pipeline nobody can attribute. The alert is the
-- real defence and does not exist yet; this is the floor under it.

select is(
  public.rollback_release('/v/2026-08-19T12:00:00Z/',
                          '00000000-0000-0000-0000-00000000db01', null) ->> 'reason',
  'reason_required',
  'a rollback with no reason is refused');

select is(
  public.rollback_release('/v/2026-08-19T12:00:00Z/',
                          '00000000-0000-0000-0000-00000000db01', '   ') ->> 'reason',
  'reason_required',
  '...and a blank one too — NOT NULL alone would accept three spaces');

select is(
  (select count(*)::integer from public.publish_hold), 0,
  '...leaving no hold behind, and no rollback either');

-- The constraints under the RPC, tested directly: a future caller that bypasses
-- rollback_release must not be able to stop the archive anonymously either.
select throws_ok(
  $$insert into public.publish_hold (id, held_by) values (true, '00000000-0000-0000-0000-00000000db01')$$,
  '23502', null,
  'the hold row itself cannot be written without a reason');

-- ═══ 9–11 · The flip, and the hold that comes with it ════════

select is(
  public.rollback_release('/v/2026-08-19T12:00:00Z/',
                          '00000000-0000-0000-0000-00000000db01',
                          'shard builder regression') ->> 'previous_path',
  '/v/2026-08-19T13:00:00Z/',
  'the rollback reports what was live before it');

select is(
  pg_temp.active(), '/v/2026-08-19T12:00:00Z/',
  '...and the older release is now the active one');

select is(
  (select reason || ' / ' || held_by::text from public.publish_hold where id),
  'shard builder regression / 00000000-0000-0000-0000-00000000db01',
  '...and the hold names who stopped the archive and why');

-- ═══ 12–15 · The two-minute revert ═══════════════════════════

select is(
  pg_temp.reason() || ' / ' || pg_temp.pending()::text,
  'held_by_operator / false',
  'while held, nothing is due — the cron will not undo the rollback');

-- CORROBORATING, not discriminating. It guards §11 gate 5's requirement that a held reason
-- is never spelled the same as an idle one — but it cannot fail on its own: test 12 pins the
-- exact string 'held_by_operator', so anything that breaks this breaks 12 first. It does NOT
-- catch the hold write going missing (without a hold the reason is 'content_changed', which
-- is still not 'unchanged', so this passes). Kept because the requirement it names is a
-- launch gate and should be legible here rather than inferred from a string comparison.
select isnt(
  pg_temp.reason(), 'unchanged',
  '...and "held" is not reported as "unchanged", so a monitor can tell them apart');

-- THE COUNTER-TEST. Remove the hold and nothing else. If the predicate stays quiet, the hold
-- was decoration and every assertion above it proved nothing.
select public.release_publish_hold('00000000-0000-0000-0000-00000000da02');

select is(
  pg_temp.reason() || ' / ' || pg_temp.pending()::text,
  'content_changed / true',
  'without the hold the SAME rolled-back release is due again — the revert this exists to stop');

-- CORROBORATING. release_publish_hold does not touch `releases`, so this can only fail if
-- the flip in test 9/10 was already wrong. It is here to make the previous assertion legible
-- — "due again" means nothing unless you can see WHAT is about to be republished over.
select is(
  pg_temp.active(), '/v/2026-08-19T12:00:00Z/',
  '...and it is still the rolled-back release, so the revert would undo real work');

-- ═══ 16–17 · Resume, and the tick ════════════════════════════

select is(
  public.release_publish_hold('00000000-0000-0000-0000-00000000da02') ->> 'reason',
  'no_hold',
  'releasing a hold that is not there is a named no-op, not an error');

-- Re-held, and this time through the tick. publish_tick needed no change in 0039 — it
-- already refuses whatever publish_pending refuses — so this asserts that inheritance
-- rather than assuming it.
insert into public.publish_hold (id, reason, held_by)
values (true, 'incident 42', '00000000-0000-0000-0000-00000000db01');

select is(
  public.publish_tick() ->> 'reason' || ' q+' || pg_temp.queued(),
  'held_by_operator q+0',
  'a held pipeline dispatches nothing at all — the hold reaches the cron, not just the query');

-- ═══ 18–19 · Refusals ════════════════════════════════════════

select is(
  public.rollback_release('/v/2026-08-19T12:00:00Z/',
                          '00000000-0000-0000-0000-00000000db01', 'again') ->> 'reason',
  'already_active',
  'rolling back onto what is already live is refused, not reported as a move');

-- 0038's rule, inherited: no ledger write without a live lease. Tested here because
-- rollback_release is a third writer and the check is per-function, not ambient.
select public.release_publish_lease('00000000-0000-0000-0000-00000000db01');

select is(
  public.rollback_release('/v/2026-08-19T13:00:00Z/',
                          '00000000-0000-0000-0000-00000000db01', 'no lease now') ->> 'reason',
  'no_lease',
  'and a rollback without the lease is refused like every other ledger write');

select * from finish();
rollback;