-- 0037 · The debounced cron, and what "changed" has to mean
--
-- §2: "Debounced cron (2–5 min) → single writer via advisory lock → rebuild only changed
-- shards into /v/{ISO-ts}/ → validate → atomically flip the manifest.json pointer."
--
-- Pieces 1–4 built everything after the arrow. Nothing so far causes a publish to happen
-- at all; a release exists only because somebody called the function by hand. This file is
-- the trigger, and it is two separate things that are easy to conflate:
--
--   the CRON       pg_cron fires every two minutes; pg_net POSTs the publish function with
--                  PUBLISH_SECRET as a bearer. Mechanical, and the lease already makes a
--                  double-fire harmless — a second publisher is told `held` and returns 200.
--
--   the DEBOUNCE   the decision NOT to fire. This is the part that had to be designed.
--
-- ── Why the debounce is load-bearing and not an optimisation ─
--
-- The publisher rewrites EVERY shard on every release. releaseFiles() builds all of them
-- and publish() puts all of them; §2's "rebuild only changed shards" is specified and not
-- yet implemented. At ~300 items that is ~325 objects and ~0.7 MB per release. Firing every
-- two minutes regardless would be 720 releases a day — ~234,000 R2 writes daily, which at
-- Class A pricing is more than §9's ENTIRE monthly ceiling, spent on rewriting bytes that
-- did not change.
--
-- So the predicate below is the only thing standing between this archive and its budget,
-- which is why it gets a counter for a signal rather than a timestamp.
--
-- ── Why not `max(updated_at) > releases.created_at` ──────────
--
-- It is the obvious spelling, it is one line, and it is wrong in a way that never reports
-- itself. §2/D20 bakes like_count and comment_count INTO the shards, so a like changes the
-- published bytes — and an UNLIKE changes them too, by deleting a row. A deletion moves no
-- timestamp anywhere. The archive would then serve a like count that is wrong and stays
-- wrong until some unrelated edit happens to trigger a publish.
--
-- The same blindness covers a deleted comment, a deleted media_asset and a deleted profile.
-- 20_publish_cron tests 8 and 9 run the naive predicate beside the real one and show it
-- answering "unchanged" while a count has visibly changed.
--
-- So: a revision COUNTER, bumped by triggers, which a delete moves exactly like an insert.
--
-- ── Why a counter row and not a sequence or an insert-only log ─
--
-- Both of those avoid the row lock this design takes on every bump, and both reintroduce
-- the bug the row lock exists to prevent.
--
-- nextval() is not transactional: the cron could read revision 7 from a value assigned by
-- a transaction that has not committed, publish without that transaction's data, record 7,
-- and never publish the change. An insert-only signal table has the same shape — row id 5
-- can commit before row id 4, so max(id) at any instant may skip a change still in flight.
--
-- `update publish_revision set content_revision = content_revision + 1` cannot do that. The
-- row lock serialises the bumps, so revision N is committed before N+1 can even be assigned,
-- and a reader that sees N has seen every change up to N. THE CONTENTION IS THE CORRECTNESS
-- PROPERTY, not a cost to engineer away. At this archive's write volume — a handful of likes
-- a minute at the very most — it is unmeasurable.
--
-- ── Why two counters ─────────────────────────────────────────
--
-- Content and counters do not deserve the same latency, and treating them alike costs money.
--
--   content_revision   posts, media_assets, profiles, places. Publishes on the next tick.
--                      A moderator approving an item wants to see it within two minutes.
--
--   counter_revision   likes, comments. Publishes at most once an hour (the floor in
--                      publish_pending). A like is worth showing; it is not worth 325 R2
--                      writes within two minutes of happening. 24 counter-driven releases
--                      a day is about $1/month; unthrottled it is $30+.
--
-- ── Where the watermark lives, and when it is read ───────────
--
-- On the RELEASE row, and captured at lease-claim time. Both halves matter.
--
-- On the release row, because the ledger already IS the record of what was published, and
-- because a failed publish then records nothing and the next tick retries for free.
--
-- Captured at claim time, because the alternative loses changes. record_release runs AFTER
-- the publisher has read the archive, uploaded ~325 objects and validated them — thirty to
-- ninety seconds later. A watermark read at that moment would include an approval that
-- landed mid-build and was NOT in the release, and that approval would then never publish.
-- Reading it inside claim_publish_lease, before the read, can only err the other way: a
-- change that made it into the release but not into the watermark causes one spurious
-- republish. Litter, not a defect.
--
-- The rejected alternative was stashing the revision on publish_lease so no signature had
-- to change. It fails the recovery path: if A's five-minute lease lapses mid-build and B
-- reclaims it, A's record_release would read B's revision and stamp its own older release
-- with it, dropping everything between — silently, on the path taken when a publisher has
-- already crashed once. Carrying the value explicitly costs two arguments and self-heals
-- instead, because a stale flip moves the watermark BACKWARD and the predicate goes true.
--
-- ── The two extensions ───────────────────────────────────────
--
-- 0001 installs PostGIS and names what it deliberately does not install. These two are the
-- first additions since, so they get the same treatment.
--
--   pg_cron   The scheduler. Supabase preloads it and lists it in
--             supautils.privileged_extensions, so `postgres` may create it even though
--             `postgres` is not a superuser here. Jobs run in cron.database_name, which is
--             `postgres`, as this one does.
--   pg_net    Asynchronous HTTP from SQL. The alternative was `http`, which is synchronous
--             and would hold a cron worker open for the entire publish — a minute or more
--             of a backend blocked on a remote server, inside a scheduler with a fixed
--             worker pool. pg_net queues the request and returns immediately.
--
-- Both create cleanly inside a transaction, which is how the Supabase CLI applies migration
-- files; verified against postgres 17.6.1 before this file was written.

set search_path = public, extensions;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── The signal ───────────────────────────────────────────────

create table public.publish_revision (
  -- Singleton, the same shape as publish_lease and for the same reason: `id` can only be
  -- true, so "two revision counters that disagree" is unrepresentable rather than unlikely.
  id               boolean primary key default true,
  content_revision bigint      not null default 0,
  counter_revision bigint      not null default 0,
  -- Not used by the predicate — reported by it. "When did the archive last change" is the
  -- first question anybody asks when a publish looks stuck, and deriving it from two
  -- opaque integers is not an answer.
  changed_at       timestamptz not null default now(),

  constraint publish_revision_singleton check (id),
  constraint publish_revision_forward check (content_revision >= 0 and counter_revision >= 0)
);

comment on table public.publish_revision is
  'CLAUDE.md §2 — what has changed since the active release, counted so deletes count too.';

insert into public.publish_revision (id) values (true);

alter table public.publish_revision enable row level security;

-- No policies, and none coming — RLS with no policy denies everything, which is right for a
-- table no browser session reaches. The revoke is the real control: Supabase grants ALL on
-- new public tables to anon and authenticated by default, so not revoking would hand a
-- member the ability to force a republish every two minutes, or to freeze the archive by
-- holding the counters still. Neither needs an exploit.
revoke all on public.publish_revision from anon, authenticated;

-- Full DML to service_role, not just SELECT, and 07_triggers test 18 is why: it asserts
-- that every table in public carries all four privileges for service_role, because
-- BYPASSRLS exempts a role from row POLICIES and grants no table privilege at all. A table
-- service_role cannot write is a table nobody can repair when the counters wedge, and the
-- first anyone would know is a publish that stopped happening. It adds no capability to a
-- credential that can already read the whole archive and flip the pointer.
grant select, insert, update, delete on public.publish_revision to service_role;

-- ── The watermark, on the ledger ─────────────────────────────
--
-- default 0 rather than null: a release recorded before this migration existed (there are
-- none, but the default outlives that fact) reads as "built from revision zero", so the
-- predicate says pending and one extra release fixes it. A null would have to be special-
-- cased in the predicate, and a special case in a predicate is where the next bug lives.

alter table public.releases
  add column content_revision bigint not null default 0,
  add column counter_revision bigint not null default 0;

comment on column public.releases.content_revision is
  'publish_revision.content_revision as of the lease claim that built this release.';
comment on column public.releases.counter_revision is
  'publish_revision.counter_revision as of the lease claim that built this release.';

-- ── The bump ─────────────────────────────────────────────────

/*
 * Bump one of the two counters. TG_ARGV[0] selects which.
 *
 * SECURITY DEFINER is not tidiness here, it is the whole reason this works: a member
 * liking a post executes this trigger as `authenticated`, and without DEFINER the UPDATE
 * would need a grant on publish_revision to `authenticated` — which is exactly the grant
 * revoked above, because it is the ability to force or suppress publishing.
 */
create or replace function public.bump_publish_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_argv[0] = 'counter' then
    update public.publish_revision
       set counter_revision = counter_revision + 1, changed_at = now()
     where id;
  else
    update public.publish_revision
       set content_revision = content_revision + 1, changed_at = now()
     where id;
  end if;
  -- AFTER trigger; the return value is discarded.
  return null;
end;
$$;

comment on function public.bump_publish_revision() is
  'Signals that a release is out of date. Row-level so a DELETE counts (CLAUDE.md §2).';

-- posts · three triggers rather than one, because a trigger that handles both INSERT and
-- DELETE may not reference NEW or OLD in its WHEN clause. The filter is worth the extra two
-- lines: members editing DRAFTS is the highest-volume write this table takes, and a draft
-- is not in any shard. Everything that matters — approval, rejection after approval,
-- withdrawal, an edit to an approved row, a takedown, an ingest completing on an approved
-- row — moves status to or from 'approved' or happens while it is already there.
create trigger posts_bump_publish_revision_insert
  after insert on public.posts
  for each row when (new.status = 'approved')
  execute function public.bump_publish_revision('content');

create trigger posts_bump_publish_revision_update
  after update on public.posts
  for each row when (old.status = 'approved' or new.status = 'approved')
  execute function public.bump_publish_revision('content');

create trigger posts_bump_publish_revision_delete
  after delete on public.posts
  for each row when (old.status = 'approved')
  execute function public.bump_publish_revision('content');

-- media_assets · unconditional. Every row here belongs to a post, and whether that post is
-- publishable is a join away; over-signalling costs one release, under-signalling costs a
-- card with a broken image.
create trigger media_assets_bump_publish_revision
  after insert or update or delete on public.media_assets
  for each row execute function public.bump_publish_revision('content');

-- profiles · only the three columns a shard actually carries (shards.ts `author()`). A bio
-- or visibility edit is a profile-page change and publishes nothing.
create trigger profiles_bump_publish_revision_update
  after update on public.profiles
  for each row when (old.handle       is distinct from new.handle
                  or old.display_name is distinct from new.display_name
                  or old.avatar_path  is distinct from new.avatar_path)
  execute function public.bump_publish_revision('content');

-- INSERT and DELETE unconditionally, and DELETE is the one that matters: posts.created_by
-- references auth.users, not profiles, so removing a profile row leaves approved posts
-- whose author join finds nothing and whose shards must lose their byline. No trigger on
-- posts fires for that.
create trigger profiles_bump_publish_revision_insert
  after insert on public.profiles
  for each row execute function public.bump_publish_revision('content');

create trigger profiles_bump_publish_revision_delete
  after delete on public.profiles
  for each row execute function public.bump_publish_revision('content');

-- places · name_ar and name_en ride along in every shard as place_name_*.
create trigger places_bump_publish_revision
  after insert or update or delete on public.places
  for each row execute function public.bump_publish_revision('content');

-- likes / comments · the baked counters (§2/D20). Throttled by the floor in
-- publish_pending, not by being ignored here — the signal has to be honest even when the
-- response to it is deliberately slow.
create trigger likes_bump_publish_revision
  after insert or update or delete on public.likes
  for each row execute function public.bump_publish_revision('counter');

create trigger comments_bump_publish_revision
  after insert or update or delete on public.comments
  for each row execute function public.bump_publish_revision('counter');

-- ── claim_publish_lease, now reporting the revision ──────────
--
-- Replaced, not edited in place: 0034 is where this function is defined and 0034 has been
-- applied. Grepped first, per the trap that cost two silent reverts in M1 — 0034 is its
-- ONLY definition, unlike posts_write_audit which had three.
--
-- The body below is 0034's, changed in exactly one way: the current revisions are read
-- under the advisory lock and returned on the branches that grant the lease. Reading them
-- HERE is the point of the whole exercise — this runs before the publisher reads the
-- archive, so the number it reports can only be older than the data that gets published,
-- never newer. See the header.

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
  c_lock_class constant integer := 20260819;
  c_lock_key   constant integer := 1;
  c_max_ttl    constant interval := interval '15 minutes';

  v_now    timestamptz := now();
  v_lease  public.publish_lease%rowtype;
  v_rev    public.publish_revision%rowtype;
begin
  if p_holder is null then
    return jsonb_build_object('acquired', false, 'reason', 'holder_required');
  end if;
  if p_ttl is null or p_ttl <= interval '0' or p_ttl > c_max_ttl then
    return jsonb_build_object('acquired', false, 'reason', 'ttl_out_of_range',
                              'max_ttl', c_max_ttl::text);
  end if;

  if not pg_try_advisory_xact_lock(c_lock_class, c_lock_key) then
    return jsonb_build_object('acquired', false, 'reason', 'contended');
  end if;

  select * into v_rev   from public.publish_revision where id;
  select * into v_lease from public.publish_lease    where id;

  if not found then
    insert into public.publish_lease (holder, acquired_at, expires_at, note)
    values (p_holder, v_now, v_now + p_ttl, p_note);
    return jsonb_build_object('acquired', true, 'holder', p_holder,
                              'expires_at', v_now + p_ttl, 'reason', 'granted',
                              'content_revision', v_rev.content_revision,
                              'counter_revision', v_rev.counter_revision);
  end if;

  if v_lease.holder <> p_holder and v_lease.expires_at > v_now then
    return jsonb_build_object('acquired', false, 'reason', 'held',
                              'holder', v_lease.holder, 'expires_at', v_lease.expires_at);
  end if;

  update public.publish_lease
     set holder = p_holder,
         acquired_at = v_now,
         expires_at = v_now + p_ttl,
         note = p_note
   where id;

  return jsonb_build_object(
    'acquired', true, 'holder', p_holder, 'expires_at', v_now + p_ttl,
    'reason', case when v_lease.holder = p_holder then 'reheld' else 'reclaimed_expired' end,
    'previous_holder', v_lease.holder,
    'content_revision', v_rev.content_revision,
    'counter_revision', v_rev.counter_revision);
end;
$$;

comment on function public.claim_publish_lease(uuid, interval, text) is
  'CLAUDE.md §2 — take the single-writer lease, and report the revision it was taken at.';

-- ── record_release, now stamping the watermark ───────────────
--
-- DROP and CREATE rather than CREATE OR REPLACE: adding a parameter to a PostgreSQL
-- function does not replace it, it OVERLOADS it. Leaving record_release(text) beside
-- record_release(text,bigint,bigint) would keep a callable path that records a release with
-- no watermark — which reads as "built from revision zero" and republishes forever — and
-- would make the PostgREST call ambiguous besides.
--
-- No defaults on the two new arguments, deliberately. A caller that forgets them gets a
-- function-not-found from PostgREST and db.ts throws; a caller that silently defaulted to
-- 0 would publish successfully and leave the archive rebuilding itself every two minutes
-- with nothing to show for it.

drop function public.record_release(text);

create function public.record_release(
  p_path             text,
  p_content_revision bigint,
  p_counter_revision bigint
) returns jsonb
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

comment on function public.record_release(text, bigint, bigint) is
  'Record a built release, inactive, stamped with the revision its build was claimed at.';

-- ── The predicate ────────────────────────────────────────────

/*
 * Is a publish worth doing right now?
 *
 * Returns the whole reasoning, not a bare boolean, because the first thing anyone debugging
 * a stuck archive needs is which of the four ways this can answer "no" it actually took.
 *
 * The hour floor applies to counters ONLY, and the arithmetic is the argument: 325 objects
 * per release against R2's Class A pricing means an unthrottled like-driven publish is
 * $30+/month, over §9's entire ceiling, while twenty-four counter-driven releases a day is
 * about a dollar. Content is never throttled — a moderator who approves an item expects to
 * see it, and two minutes is already the longest that should take.
 */
create or replace function public.publish_pending()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Named here and repeated in CLAUDE.md's growth note. Lowering it costs money in a
  -- straight line; raising it makes like counts staler and nothing else.
  c_counter_floor constant interval := interval '1 hour';

  v_rev    public.publish_revision%rowtype;
  v_active public.releases%rowtype;
  v_reason text;
begin
  select * into v_rev from public.publish_revision where id;
  select * into v_active from public.releases where active;

  if not found then
    -- Nothing has ever been published. Not a change — an absence — and the distinction is
    -- worth keeping because "no active release" on a system that has been running for a
    -- week means something entirely different from "content changed".
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
  'CLAUDE.md §2 — the debounce. Says why, not just whether.';

-- ── The dispatch ─────────────────────────────────────────────

/*
 * POST to the publisher, once, asynchronously.
 *
 * Granted to NOBODY. Not service_role, not media_worker, not authenticated. Read what it
 * is without the name attached: a function that sends an arbitrary POST to an arbitrary URL
 * with an arbitrary Authorization header, running inside the database. That is a
 * server-side request forgery primitive with a credential slot, and the only thing that
 * makes it safe is that its sole caller is publish_tick(), which pg_cron runs as this
 * function's owner. An owner-only function needs no grant to be called by its owner, so
 * there is nothing here for a leaked token to reach.
 *
 * timeout_milliseconds is 120000, not pg_net's 5000 default. The publish is a full archive
 * rebuild — thirty to ninety seconds of R2 uploads — and pg_net closing the connection at
 * five seconds would abandon the response and risk the Edge Function being torn down with
 * the client. Two minutes matches the cron interval: if a publish somehow runs longer than
 * that, the next tick finds the lease held and does nothing, which is the correct outcome
 * and needs no timeout to arrange.
 */
create or replace function public.publish_dispatch(p_url text, p_secret text)
returns bigint
language sql
volatile
security definer
set search_path = ''
as $$
  select net.http_post(
    url     := p_url,
    body    := jsonb_build_object('source', 'cron'),
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || p_secret),
    timeout_milliseconds := 120000);
$$;

comment on function public.publish_dispatch(text, text) is
  'One POST to the publisher. Owner-only: an arbitrary-URL POST is not a grantable thing.';

/*
 * The cron body.
 *
 * Order matters and is not the obvious one. The pending check runs FIRST, before the
 * credential is decrypted, for three reasons: 719 ticks out of 720 stop there and never
 * touch Vault; an unconfigured deployment still reports what it WOULD have done, which is
 * the difference between "the cron is broken" and "the cron is waiting for secrets"; and
 * both no-op branches become testable in pgTAP without a Vault fixture.
 *
 * The secret is read inline rather than through a publish_cron_config() helper. A function
 * whose return value is a bearer token is one careless GRANT away from being an oracle, so
 * there is no such function to grant. §6's rule is about capability-bearing credentials
 * reaching places they should not, and a SECURITY DEFINER accessor is such a place.
 *
 * Vault rather than a literal in cron.job.command: the command text is stored in a table
 * and, more to the point, would have to be written into this migration, where gitleaks
 * would correctly refuse it. 20_publish_cron test 22 asserts no bearer-shaped literal ever
 * appears in a job command.
 */
create or replace function public.publish_tick()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
    -- tick's answer, locally and on a fresh project, and it is not an error.
    return jsonb_build_object('dispatched', false, 'reason', 'not_configured',
                              'would_publish_because', v_pending ->> 'reason');
  end if;

  v_request_id := public.publish_dispatch(v_url, v_secret);

  return jsonb_build_object('dispatched', true, 'reason', v_pending ->> 'reason',
                            'request_id', v_request_id);
end;
$$;

comment on function public.publish_tick() is
  'CLAUDE.md §2 — one cron tick: decide, then dispatch. Owner-only.';

-- ── The schedule ─────────────────────────────────────────────
--
-- Two minutes: the fast end of §2's "2–5 min", because the latency a contributor actually
-- experiences is approval-to-visible and the debounce means a quiet archive costs nothing
-- to check. The interval IS the debounce in the classical sense — every change inside one
-- window coalesces into a single release. There is deliberately no settle timer on top of
-- it; waiting for changes to stop arriving would only add delay to an archive that has
-- already decided what it wants to publish.
--
-- cron.schedule with a job NAME is an upsert, so re-running this migration re-points the
-- existing job rather than accumulating duplicates.

select cron.schedule('rma-publish', '*/2 * * * *', $job$select public.publish_tick()$job$);

-- ── Grants ───────────────────────────────────────────────────
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC. Not revoking is the absence of a
-- decision, not a decision — 16_function_grants exists to make that impossible to forget.
--
-- publish_pending is the only one anything else may call: the publisher can use it to skip
-- a pointless build, and M6's publish-age monitor needs exactly this answer. It discloses
-- two integers and a release path.
--
-- publish_dispatch and publish_tick go to nobody at all. pg_cron runs the job as its owner,
-- which is `postgres`, which needs no grant to execute its own functions.

revoke execute on function public.publish_pending()                     from public, anon, authenticated;
revoke execute on function public.publish_dispatch(text, text)          from public, anon, authenticated, service_role;
revoke execute on function public.publish_tick()                        from public, anon, authenticated, service_role;
revoke execute on function public.record_release(text, bigint, bigint)  from public, anon, authenticated;

grant execute on function public.publish_pending()                      to service_role;
grant execute on function public.record_release(text, bigint, bigint)   to service_role;
