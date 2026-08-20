-- 0042 · The publish trigger moves from the clock to the moderation action
--
-- §12, approved 20 Aug 2026, and it changes ONE thing: what causes a publish to happen.
-- Everything after that point — the advisory lock, the lease, the build, the validation,
-- the pointer flip, the rollback — is 0034 to 0039 unchanged and is not touched here.
--
--   before   pg_cron fires every two minutes; publish_tick decides whether to POST.
--   after    a change to publishable content POSTs directly; the cron job is unscheduled.
--
-- The cron is DEFERRED, not deleted. pg_cron stays installed, publish_tick keeps its shape,
-- and restoring the scheduler is the single line at the bottom of this file. That is the
-- point of doing it this way: the trigger is the only variable.
--
-- ── Why an approval is a better signal than a clock ──────────
--
-- Not latency — the two-minute cron was already fast enough. Cost, and what the signal
-- means.
--
-- The publisher rewrites EVERY shard on every release; §2's incremental diff is deferred,
-- and its 19 Aug amendment says so. A clock firing 720 times a day at an archive that
-- changes a few times a week spends its whole existence asking a question whose answer is
-- almost always no, and the only thing between that and the R2 bill is a debounce predicate
-- that has to stay exactly right forever. An approval-driven publish inverts it: nothing
-- asks unless something happened.
--
-- ── Where the dispatch is attached, and why not on `posts` ───
--
-- The obvious implementation is a trigger on public.posts watching for status = 'approved'.
-- This is not that, and the reason is drift.
--
-- 0037 already decided, carefully and in one place, what "publishable content changed"
-- means: the WHEN clauses on the bump_publish_revision triggers. They exclude a member
-- editing a draft, which is the highest-volume write this database takes and appears in no
-- shard. They include an approval, a rejection after approval, a withdrawal, an edit to an
-- approved row, a takedown, an ingest completing on an approved row, a profile rename, a
-- place rename, and a profile DELETE that would strip a byline. A second set of conditions
-- on `posts` would be a second definition of one idea, and the one that goes stale is the
-- one nobody is looking at.
--
-- So the dispatch happens inside bump_publish_revision itself. The signal and the trigger
-- are the same event by construction, and 20_publish_cron's assertion 27 — every table the
-- publisher reads has a bump trigger — keeps them together as M3 and M4 add tables.
--
-- ── Counters are NOT dispatched, and that is a real loss ─────
--
-- Only the 'content' branch dispatches. A like or a comment bumps counter_revision and
-- POSTs nothing, so baked counts (§2/D20) now go live whenever the next CONTENT change
-- does, rather than within an hour of changing.
--
-- Recorded rather than hidden. §6's counter floor is a ceiling — "at most once an hour" —
-- and never a promise of freshness, so nothing here is violated; but on a quiet week a like
-- count can be days stale. Dispatching on the counter branch would fix it and would mean an
-- ordinary member's like sends an HTTP request from inside the database, which is a cost
-- decision this milestone was not asked to take. Restoring the cron restores hourly
-- counters, which is the other reason the schedule below is kept ready rather than removed.
--
-- ── Once per transaction ─────────────────────────────────────
--
-- bump_publish_revision is a ROW trigger. Approving forty items in one statement would
-- otherwise queue forty POSTs, thirty-nine of them answered `held` by the lease. The guard
-- is a transaction-local setting, so a statement, a transaction and a bulk import each
-- produce exactly one dispatch.
--
-- pg_net queues into a table inside the caller's transaction, so the POST is sent after
-- COMMIT and not at all if the approval rolls back. That is a property of pg_net, not
-- something arranged here, and it is the behaviour this design wants.

set search_path = public, extensions;

-- ── publish_dispatch says where the request came from ────────
--
-- 0037 hardcoded {"source":"cron"}. With the cron unscheduled that is a lie in the
-- publisher's logs, and the publisher's logs are where a stuck archive gets diagnosed.
--
-- Dropped and recreated rather than replaced: the argument list changes, and CREATE OR
-- REPLACE cannot do that. Still owner-only — read without its name it is an arbitrary POST
-- to an arbitrary URL with an arbitrary Authorization header, which is an SSRF primitive
-- with a credential slot and not a grantable thing.
drop function if exists public.publish_dispatch(text, text);

create function public.publish_dispatch(p_url text, p_secret text, p_source text default 'unknown')
returns bigint
language sql
volatile
security definer
set search_path = ''
as $fn$
  select net.http_post(
    url     := p_url,
    body    := jsonb_build_object('source', p_source),
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || p_secret),
    timeout_milliseconds := 120000);
$fn$;

comment on function public.publish_dispatch(text, text, text) is
  'One POST to the publisher. Owner-only: an arbitrary-URL POST is not a grantable thing.';

-- ── publish_tick carries the source through ──────────────────
--
-- Same body as 0037's, with the source threaded and a default, so the cron line at the
-- bottom of this file stays one line.
drop function if exists public.publish_tick();

create function public.publish_tick(p_source text default 'manual')
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_pending    jsonb;
  v_url        text;
  v_secret     text;
  v_request_id bigint;
begin
  v_pending := public.publish_pending();
  if not (v_pending ->> 'pending')::boolean then
    return jsonb_build_object('dispatched', false, 'reason', v_pending ->> 'reason');
  end if;

  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'rma_publish_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'rma_publish_secret';

  if v_url is null or v_secret is null then
    -- Fails closed and says so. Before the maintainer sets both secrets this is every
    -- caller's answer, locally and on a fresh project, and it is not an error.
    return jsonb_build_object('dispatched', false, 'reason', 'not_configured',
                              'would_publish_because', v_pending ->> 'reason');
  end if;

  v_request_id := public.publish_dispatch(v_url, v_secret, p_source);

  return jsonb_build_object('dispatched', true, 'reason', v_pending ->> 'reason',
                            'request_id', v_request_id, 'source', p_source);
end;
$fn$;

comment on function public.publish_tick(text) is
  'CLAUDE.md §2 — decide, then dispatch. Called by the approval trigger; the cron is deferred.';

-- ── The dispatch, attached to the signal ─────────────────────
--
-- Body is 0037's with one block added to the content branch.
create or replace function public.bump_publish_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_argv[0] = 'counter' then
    update public.publish_revision
       set counter_revision = counter_revision + 1, changed_at = now()
     where id;
    -- Deliberately no dispatch. See this migration's header: a like would otherwise send an
    -- HTTP request from inside the database on an ordinary member's write.
    return null;
  end if;

  update public.publish_revision
     set content_revision = content_revision + 1, changed_at = now()
   where id;

  -- Once per transaction. `true` makes the setting transaction-local, so it is discarded on
  -- COMMIT and on ROLLBACK alike and cannot survive into the next transaction on a pooled
  -- connection. The `true` on current_setting is the missing-ok flag: an unset name reads as
  -- NULL instead of raising, which is the state of every transaction that has not bumped.
  if coalesce(current_setting('rma.publish_dispatched', true), '') <> '1' then
    perform set_config('rma.publish_dispatched', '1', true);
    -- The trigger runs as whoever wrote the row — a moderator through PostgREST, the media
    -- worker, the service role. publish_tick is owner-only, and this function is SECURITY
    -- DEFINER owned by that same role, so the call is reachable here and nowhere else.
    perform public.publish_tick('content');
  end if;

  -- AFTER trigger; the return value is discarded.
  return null;
end;
$fn$;

comment on function public.bump_publish_revision() is
  'Signals that a release is out of date, and on the content branch asks for one. Once per transaction.';

-- ── The follow-up, which is what the cron used to be for ─────
--
-- THE hole this milestone had to close, and it is invisible from either side alone.
--
-- publish() claims the lease, THEN reads the archive. An approval committing between those
-- two moments is not in the release being built, and its own dispatch was answered `held`
-- by the lease it just collided with. Under a two-minute cron that approval waited one
-- tick. With the cron gone nothing was ever going to ask again: the item would sit approved
-- and unpublished until some unrelated change happened to trigger a publish.
--
-- 0038's watermark is what makes the fix exact. record_release stamps a release with the
-- revision as of the CLAIM, so an approval that landed mid-build leaves publish_pending
-- reporting content_changed afterwards — 20_publish_cron assertion 20 asserts precisely
-- that. All that was missing was somebody to notice.
--
-- The release of the lease is where the follow-up goes, because it is the one point that
-- always runs: release.ts calls it from a `finally`, so a publish that succeeded, failed
-- validation, or threw all reach it.
--
-- ── Why the caller passes the revision it claimed at ─────────
--
-- The condition is "the revision moved WHILE I held the lease", not "there is work
-- outstanding". They differ in exactly the case that matters: a build that fails repeatedly
-- leaves work outstanding every time, and re-dispatching on that condition would POST
-- forever at whatever rate the publisher can fail. Comparing against the claim-time revision
-- makes a failed build dispatch nothing and a genuine mid-build change dispatch once.
--
-- NULL — the default — means "do not follow up", so every existing caller and every test
-- keeps the behaviour it has today.
drop function if exists public.release_publish_lease(uuid);

create function public.release_publish_lease(
  p_holder                   uuid,
  p_claimed_content_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_lease   public.publish_lease%rowtype;
  v_now_rev bigint;
  v_follow  boolean := false;
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

  -- Read AFTER the delete, so the publish this may ask for finds the lease free. Reading
  -- first would be harmless today, because the dispatch is asynchronous — but it would make
  -- the ordering an accident rather than a decision.
  if p_claimed_content_revision is not null then
    select content_revision into v_now_rev from public.publish_revision where id;
    v_follow := v_now_rev > p_claimed_content_revision;
    if v_follow then
      -- Not guarded by rma.publish_dispatched. This runs in the publisher's own
      -- transaction, which bumped nothing, so the flag is unset and the guard would be a
      -- no-op that only looked like protection.
      perform public.publish_tick('followup');
    end if;
  end if;

  return jsonb_build_object('released', true, 'followed_up', v_follow);
end;
$fn$;

comment on function public.release_publish_lease(uuid, bigint) is
  'Release the lease, and ask for another publish if content changed while it was held.';

-- ── The schedule, deferred ───────────────────────────────────
--
-- Unscheduled, not dropped. cron.unschedule raises if the job is absent, so this is written
-- to be re-runnable on a database where 0037 never created one.
--
-- pg_cron and pg_net both stay installed: pg_net is how publish_dispatch works at all, and
-- removing pg_cron would make restoring the schedule a migration rather than a line.
--
-- TO RESTORE THE CRON, this is the entire change:
--
--     select cron.schedule('rma-publish', '*/2 * * * *',
--                          'select public.publish_tick(''cron'')');
--
-- Nothing else moves. The lock, the lease, the watermark, the flip and the follow-up are
-- all indifferent to who asked.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'rma-publish') then
    perform cron.unschedule('rma-publish');
  end if;
end;
$do$;

-- ── Grants ───────────────────────────────────────────────────
--
-- Restated in full. Both recreated functions lost their grants when they were dropped, and
-- PostgreSQL grants EXECUTE on a new function to PUBLIC — 22_rpc_ownership exists because
-- forgetting this is silent.
revoke execute on function public.publish_dispatch(text, text, text)  from public, anon, authenticated, service_role;
revoke execute on function public.publish_tick(text)                  from public, anon, authenticated, service_role;
revoke execute on function public.release_publish_lease(uuid, bigint)  from public, anon, authenticated;

grant execute on function public.release_publish_lease(uuid, bigint)   to service_role;
