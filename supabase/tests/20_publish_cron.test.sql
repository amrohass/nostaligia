-- The debounce (migration 0037).
--
-- The cron half of piece 5 is four lines and is not what this file is about. The debounce
-- is, because it is the only thing standing between a publisher that rewrites every shard
-- on every run and 720 full-archive rebuilds a day — more than §9's entire monthly ceiling
-- spent on bytes that did not change.
--
-- A debounce fails in two directions and only one of them is survivable:
--
--   too eager   a release nobody needed. Litter, and it costs money.
--   too quiet   the archive stops updating. Nothing raises, nothing logs, the moderation
--               queue drains normally, and the site simply stops changing. That is the
--               failure this file exists to catch, and the discriminating tests below are
--               all aimed at it.
--
-- ── The two tests that carry the file ────────────────────────
--
-- Test 9 is the unlike. The obvious predicate — `max(updated_at) > releases.created_at` —
-- is one line and reads as correct. It is blind to DELETE, and §2/D20 bakes like_count into
-- the shards, so an unlike changes the published bytes while moving no timestamp anywhere.
-- Test 9 runs that naive predicate beside the real one and shows it answering "nothing
-- changed" immediately after a count changed.
--
-- Test 21 is the mid-build approval. It stamps a release with the revision read AFTER the
-- archive was read instead of before — what happens if anybody ever "simplifies"
-- record_release into reading publish_revision itself — and shows the approval marked as
-- published without being in the release. Silently, permanently, on the ordinary path.
--
-- ── On now() ─────────────────────────────────────────────────
--
-- now() is transaction start time, so every row this file inserts carries the same
-- timestamp and any `>` between two of them is false by construction. Where the ORDER of
-- two events matters it is arranged explicitly, and said so at the site. A test that
-- ordered its events by accident would pass without testing anything.

begin;
create extension if not exists pgtap;

-- 4 privileges · 9 the signal · 5 the debounce · 3 the mid-build race
-- · 3 the tick and the dispatch · 2 the cron job · 1 the binding · 1 the refusal retries
select plan(28);

-- ── Fixtures ─────────────────────────────────────────────────

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000ca01', 'cron-author@t.local'),
  ('00000000-0000-0000-0000-00000000ca02', 'cron-mod@t.local'),
  ('00000000-0000-0000-0000-00000000ca03', 'cron-liker@t.local');

insert into public.profiles (id, handle, display_name, bio) values
  ('00000000-0000-0000-0000-00000000ca01', 'cron_author', 'صاحب الصورة', 'سيرة')
  -- 0057 provisions a profile on the auth.users insert above, so this is an UPSERT:
  -- the fixture handle this file asserts on must win over the generated placeholder.
  on conflict (id) do update set handle = excluded.handle, display_name = excluded.display_name, bio = excluded.bio;


insert into public.places (id, name_ar, name_en, location) values
  ('00000000-0000-0000-0000-00000000cb01', 'المنارة', 'Al-Manara',
   st_setsrid(st_makepoint(35.2042, 31.8996), 4326)::geography);

-- c1 is live; c2–c6 are waiting, one for each approval this file performs.
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          place_id, location_precision, status, ingest_state,
                          approved_by, approved_at, content_hash)
values
  ('00000000-0000-0000-0000-0000000000c1', 'media', 'live', 'visible',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ca01',
   '00000000-0000-0000-0000-00000000cb01', 'hidden', 'approved', 'ready',
   '00000000-0000-0000-0000-00000000ca02', now(), repeat('a', 64)),
  ('00000000-0000-0000-0000-0000000000c2', 'media', 'waiting two', 'w',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ca01',
   null, 'hidden', 'pending', 'ready', null, null, null),
  ('00000000-0000-0000-0000-0000000000c3', 'media', 'waiting three', 'w',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ca01',
   null, 'hidden', 'pending', 'ready', null, null, null),
  ('00000000-0000-0000-0000-0000000000c4', 'media', 'waiting four', 'w',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ca01',
   null, 'hidden', 'pending', 'ready', null, null, null),
  ('00000000-0000-0000-0000-0000000000c5', 'media', 'waiting five', 'w',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ca01',
   null, 'hidden', 'pending', 'ready', null, null, null),
  ('00000000-0000-0000-0000-0000000000c6', 'media', 'waiting six', 'w',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ca01',
   null, 'hidden', 'pending', 'ready', null, null, null);

insert into public.likes (user_id, post_id) values
  ('00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-0000000000c1');

insert into public.comments (post_id, body, status, created_by) values
  ('00000000-0000-0000-0000-0000000000c1', 'تعليق', 'published',
   '00000000-0000-0000-0000-00000000ca01');

-- ── Helpers ──────────────────────────────────────────────────

create function pg_temp.content() returns bigint language sql stable as $fn$
  select content_revision from public.publish_revision where id;
$fn$;

create function pg_temp.counter() returns bigint language sql stable as $fn$
  select counter_revision from public.publish_revision where id;
$fn$;

create function pg_temp.reason() returns text language sql stable as $fn$
  select public.publish_pending() ->> 'reason';
$fn$;

create function pg_temp.pending() returns boolean language sql stable as $fn$
  select (public.publish_pending() ->> 'pending')::boolean;
$fn$;

-- Deltas rather than absolute values throughout. The absolute numbers depend on how many
-- rows the fixtures above happened to insert, which would make every assertion in the file
-- fail together the moment somebody adds a seventh post.
create temp table revmark(k text primary key, c bigint, n bigint);

create function pg_temp.mark(p_k text) returns void language sql as $fn$
  insert into revmark values (p_k, pg_temp.content(), pg_temp.counter())
  on conflict (k) do update set c = excluded.c, n = excluded.n;
$fn$;

create function pg_temp.dcontent(p_k text) returns bigint language sql stable as $fn$
  select pg_temp.content() - (select c from revmark where k = p_k);
$fn$;

create function pg_temp.dcounter(p_k text) returns bigint language sql stable as $fn$
  select pg_temp.counter() - (select n from revmark where k = p_k);
$fn$;

/*
 * The predicate this design rejected, written out so it can be RUN rather than argued
 * about.
 *
 * "Has anything been touched since p_since." Every table it consults is a real source of
 * shard bytes and the query is not sloppy. Its defect is that a DELETE leaves nothing
 * behind to look at.
 */
create function pg_temp.naive_pending(p_since timestamptz) returns boolean
language sql stable as $fn$
  select greatest(
           coalesce((select max(p.updated_at) from public.posts p where p.status = 'approved'),
                    '-infinity'::timestamptz),
           coalesce((select max(l.created_at) from public.likes l), '-infinity'::timestamptz),
           coalesce((select max(c.updated_at) from public.comments c), '-infinity'::timestamptz)
         ) > p_since;
$fn$;

-- Approval through a helper because posts_approved_is_attributable refuses an approved row
-- with no approver, and auth.uid() is null in a pgTAP session that sets no claims. Naming
-- the moderator explicitly is also more honest about what the trigger records.
create function pg_temp.approve(p_id uuid) returns void language sql as $fn$
  update public.posts
     set status = 'approved',
         approved_by = '00000000-0000-0000-0000-00000000ca02'
   where id = p_id;
$fn$;

-- 0038 requires a live lease at BOTH ledger calls, so every simulated publish here holds
-- one. A single holder throughout, so a re-claim is 'reheld' rather than refused — the
-- alternative is releasing and re-taking around each call, which would add lease churn this
-- file is not about.
create function pg_temp.publish_at(p_path text, p_c bigint, p_n bigint, p_holder uuid)
returns void language plpgsql as $fn$
declare v_id uuid;
begin
  select (public.record_release(p_path, p_c, p_n, p_holder) ->> 'id')::uuid into v_id;
  perform public.activate_release(v_id, p_holder);
end $fn$;

/** Claim, then record and activate a release stamped with the revision as of right now. */
create function pg_temp.publish_now(p_path text) returns void language plpgsql as $fn$
begin
  perform public.claim_publish_lease('00000000-0000-0000-0000-00000000ce01', interval '5 minutes', 'test publish');
  perform pg_temp.publish_at(p_path, pg_temp.content(), pg_temp.counter(), '00000000-0000-0000-0000-00000000ce01');
end $fn$;

-- pg_net's queue is a real table shared with the cron job that is running in this database
-- right now, so every assertion about it is a DELTA against this baseline rather than a
-- claim that it is empty.
create temp table qbase as select count(*) as n from net.http_request_queue;

create function pg_temp.queued() returns bigint language sql stable as $fn$
  select (select count(*) from net.http_request_queue) - (select n from qbase);
$fn$;

-- ═══ 1–4 · Who may reach any of this ═════════════════════════

select ok(
  not has_function_privilege('anon', 'public.publish_tick(text)', 'execute'),
  'anon cannot run a cron tick');

select ok(
  not has_function_privilege('authenticated', 'public.publish_pending()', 'execute'),
  '...nor can a signed-in member ask whether a publish is due');

-- The one that is not obvious. Strip the name off publish_dispatch and it reads: POST to an
-- arbitrary URL with an arbitrary Authorization header, from inside the database. That is a
-- server-side request forgery primitive with a credential slot. pg_cron runs it as the
-- owner, which needs no grant, so there is nothing here for a leaked token to reach.
select ok(
  not has_function_privilege('service_role', 'public.publish_dispatch(text,text,text)', 'execute'),
  'not even service_role may dispatch — an arbitrary-URL POST is not a grantable thing');

-- Supabase grants ALL on new tables in public to authenticated by default. Without 0037's
-- revoke, a member could freeze the archive by holding the counters still, or force a full
-- rebuild every two minutes. No exploit required, and no privileged call.
select ok(
  not has_table_privilege('authenticated', 'public.publish_revision', 'UPDATE'),
  'a member cannot write the revision counters — that is the archive''s on/off switch');

-- ═══ 5–13 · What counts as a change ══════════════════════════

-- 5–6 · An approval is the whole point of the pipeline.
select pg_temp.mark('approve');
select pg_temp.approve('00000000-0000-0000-0000-0000000000c2');

select is(pg_temp.dcontent('approve'), 1::bigint,
  'approving a post moves the content revision');

select is(pg_temp.dcounter('approve'), 0::bigint,
  '...and not the counter revision — content is never throttled, counters are');

-- 7 · A like changes published bytes, because §2/D20 bakes the count into every shard.
select pg_temp.mark('like');
insert into public.likes (user_id, post_id)
values ('00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-0000000000c1');

select is(pg_temp.dcounter('like') || '/' || pg_temp.dcontent('like'), '1/0',
  'a like moves the counter revision and nothing else');

-- 8–9 · THE UNLIKE. The reason this is a counter and not a timestamp.
select pg_temp.mark('unlike');
delete from public.likes
 where user_id = '00000000-0000-0000-0000-00000000ca03'
   and post_id = '00000000-0000-0000-0000-0000000000c1';

select is(pg_temp.dcounter('unlike'), 1::bigint,
  'an UNLIKE moves the counter revision too — a delete counts exactly like an insert');

-- The same moment, asked the naive way. Nothing was written, so nothing has a timestamp
-- after the instant the release was cut; the like count on c1 has nevertheless just
-- changed, and a shard built from the old count is now wrong and will stay wrong.
select ok(
  not pg_temp.naive_pending(now()),
  '...while `max(updated_at) > release` reports nothing changed — the bug this design avoids');

-- 10 · Drafts are the highest-volume write on posts and appear in no shard.
select pg_temp.mark('draft');
update public.posts set title_en = 'edited draft'
 where id = '00000000-0000-0000-0000-0000000000c6';

select is(pg_temp.dcontent('draft') + pg_temp.dcounter('draft'), 0::bigint,
  'editing a PENDING post moves nothing — the WHEN clause discriminates');

-- 11–12 · profiles, narrowed to the columns a release actually carries.
select pg_temp.mark('displayname');
update public.profiles set display_name = 'اسم آخر'
 where id = '00000000-0000-0000-0000-00000000ca01';

select is(pg_temp.dcontent('displayname'), 1::bigint,
  'a display_name change moves content — it is printed on every card the author wrote');

-- This assertion was inverted until 0051, and it was correct when written: at M2 a
-- profile's whole presence in a release was shards.ts `author()`, so a bio lived on the
-- profile PAGE and in no shard. M3's 0044 added profile/{handle}.json, which carries `bio`,
-- `member_since` and both visibility flags — and 0033's WHEN clause was not widened to
-- match. For three milestones a bio or visibility edit therefore moved shard bytes and
-- signalled nothing, going live only when some unrelated content change happened to
-- publish, which on a quiet week is days. 0051 widened the clause; this is the assertion
-- that now holds it.
select pg_temp.mark('bio');
update public.profiles set bio = 'سيرة أطول'
 where id = '00000000-0000-0000-0000-00000000ca01';

select is(pg_temp.dcontent('bio'), 1::bigint,
  '...and so does a bio change, because 0044 put the bio in profile/{handle}.json');

-- 13 · A derivative landing is what turns an approved post into a publishable one.
select pg_temp.mark('asset');
insert into public.media_assets (post_id, role, storage_path, bucket, mime)
values ('00000000-0000-0000-0000-0000000000c1', 'thumb',
        '00000000-0000-0000-0000-0000000000c1/thumb.webp', 'public', 'image/webp');

select is(pg_temp.dcontent('asset'), 1::bigint,
  'a new media asset moves content — until it lands the card has no image');

-- ═══ 14–18 · The debounce itself ═════════════════════════════

-- 14 · Nothing has ever been published. Kept distinct from "content changed" because on a
-- system that has been running a week the two mean entirely different things.
select is(pg_temp.reason(), 'no_active_release',
  'before the first release, a publish is always due');

select pg_temp.publish_now('/v/2026-08-19T12:00:00Z/');

-- 15 · The assertion the whole piece exists for. Without it the cron is a no-op wrapper
-- around 720 full rebuilds a day.
select is(pg_temp.reason(), 'unchanged',
  'a quiet archive does NOT republish — this is the debounce doing its job');

-- 16 · Content is never throttled.
select pg_temp.approve('00000000-0000-0000-0000-0000000000c3');

select is(pg_temp.reason(), 'content_changed',
  'an approval is due on the next tick — a moderator expects to see their decision');

select pg_temp.publish_now('/v/2026-08-19T12:05:00Z/');

-- 17 · Counters are.
insert into public.likes (user_id, post_id)
values ('00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-0000000000c1');

select is(pg_temp.reason(), 'counters_within_floor',
  'a like alone does not trigger a rebuild inside the hour — 325 R2 writes for one integer');

-- 18 · ...but they are not ignored. Same pending change, older release.
update public.releases set created_at = now() - interval '2 hours' where active;

select is(pg_temp.reason(), 'counters_changed',
  '...and once the release is old enough it does — the floor delays, it never drops');

-- ═══ 19–21 · The mid-build race ══════════════════════════════
--
-- The publisher claims the lease, THEN reads the archive, THEN uploads ~325 objects, THEN
-- records the release. Thirty to ninety seconds separate the first step from the last, and
-- a moderator does not stop working during them.

create temp table claimed as
  select public.claim_publish_lease('00000000-0000-0000-0000-00000000ce01',
                                    interval '5 minutes', 'test build') as lease;

select is(
  (select (lease ->> 'content_revision')::bigint from claimed),
  pg_temp.content(),
  'the lease reports the revision it was claimed at — nothing else in the sequence can');

-- The approval lands mid-build: after the claim, after the read, before the release row.
select pg_temp.approve('00000000-0000-0000-0000-0000000000c4');

select pg_temp.publish_at('/v/2026-08-19T12:10:00Z/',
                          (select (lease ->> 'content_revision')::bigint from claimed),
                          (select (lease ->> 'counter_revision')::bigint from claimed),
                          '00000000-0000-0000-0000-00000000ce01');

-- 20 · Stamped with the CLAIM-time revision, the approval is still outstanding and gets
-- published on the next tick. One extra release is the whole cost of being right here.
select is(pg_temp.reason(), 'content_changed',
  'an approval that landed mid-build is still pending afterwards — it is not lost');

-- 21 · The counter-test. Stamp a release the other way — with the revision as of AFTER the
-- build — and the same approval is recorded as published without ever being in a release.
-- It would never publish again until something unrelated happened to change.
select pg_temp.publish_now('/v/2026-08-19T12:15:00Z/');

select is(pg_temp.reason(), 'unchanged',
  '...whereas stamping the POST-read revision marks it published while it is not — silently');

-- ═══ 22–24 · The tick, and the dispatch ══════════════════════

-- 22 · The state left by test 21 is 'unchanged'. No decision to make, no credential to
-- decrypt, no request.
select is(
  public.publish_tick() ->> 'reason' || ' q+' || pg_temp.queued(),
  'unchanged q+0',
  'a tick with nothing to do makes no HTTP request at all');

-- 23 · Pending, and no secrets configured — the state of every local stack and every fresh
-- project. It fails CLOSED, names why, and still says what it would have done.
--
-- THIS ASSERTION AND 24 ARE RED WHEN RUN AGAINST A CONFIGURED DEPLOYMENT, and that is the
-- assertion being right rather than a defect. Tests 14, 23 and 24 describe a database that
-- has never published and has no Vault entries; the staging project has both since 28 Aug
-- 2026, so publish_tick() takes the configured branch, `would_publish_because` is absent
-- (NULL), and each tick queues a real dispatch — test 23 calls publish_tick() twice, so
-- test 24 then counts q+3 where a virgin database gives q+1. Left as-is deliberately:
-- making them pass on a deployed database would mean deleting live vault.secrets rows
-- inside a test transaction, and a test file that can destroy the publish credential if it
-- ever runs outside one is a worse trade than three known-red assertions.
-- See scripts/pgtap-deployed.mjs and docs/audit-2026-08-31.md.
select pg_temp.approve('00000000-0000-0000-0000-0000000000c5');

select is(
  public.publish_tick() ->> 'reason' || '/' ||
    (public.publish_tick() ->> 'would_publish_because') || ' q+' || pg_temp.queued(),
  'not_configured/content_changed q+0',
  'an unconfigured deployment dispatches nothing, and says which it is');

-- 24 · The dispatch itself, called directly because publish_tick cannot reach it without a
-- Vault fixture. This is the only assertion in the suite that the bearer header is built at
-- all — the publisher refuses every request without it.
select public.publish_dispatch('http://publisher.invalid/publish', 'test-only-not-a-secret', 'test');

select is(
  (select method || ' ' || url || ' ' || (headers ->> 'Authorization')
     from net.http_request_queue order by id desc limit 1)
  || ' q+' || pg_temp.queued(),
  'POST http://publisher.invalid/publish Bearer test-only-not-a-secret q+1',
  'one POST, to the given URL, carrying the secret as a bearer — and exactly one');

-- ═══ 25–26 · The job ═════════════════════════════════════════

-- 0042 deferred the cron: the publish trigger is now the moderation action, through
-- bump_publish_revision. The job is UNSCHEDULED rather than the extension removed, so
-- restoring it is one cron.schedule line and nothing else moves.
--
-- Asserted as zero rather than deleted from the file, because "no job" is a decision this
-- milestone took and a job reappearing would mean two things dispatch the same publisher.
select is(
  (select count(*)::integer from cron.job where jobname = 'rma-publish'),
  0,
  'no publish job is scheduled — 0042 made the moderation action the trigger');

-- §6, at the one place in this design where a credential could plausibly get hardcoded.
-- cron.job.command is a text column in a table, and a migration that wrote the secret into
-- it would put the secret in the repository too — which gitleaks would catch, but only if
-- somebody ran it. This catches it either way.
--
-- Scanning EVERY job rather than one by name, and stated plainly: with the cron deferred
-- there are no rows, so this passes over an empty set today. That is a vacuous pass and it
-- is kept anyway — it costs nothing, and it becomes load-bearing again on the same commit
-- that restores the schedule, which is exactly when somebody might paste a secret into it.
-- The assertion above is what stops the emptiness from being a surprise.
select ok(
  not exists (
    select 1 from cron.job
     where command ~* '(bearer|secret|token|[0-9a-f]{32})'
  ),
  'no scheduled job carries a credential — the secret lives in Vault, read at dispatch time');

-- ═══ 27 · The binding ════════════════════════════════════════
--
-- The trigger set and the publisher's read side have to agree, and nothing about the
-- migration makes them. A future join added to publishable_posts() — a venue table, a
-- translations table — would flow into every shard while moving no revision, and the
-- archive would serve that column's first value forever.
--
-- So the set is derived from the function bodies rather than written down. Adding a table
-- to the publisher's read side fails here, by name, until it gets a trigger.
--
-- The FUNCTION list below is the part that has to be maintained by hand, and M3 extended it:
-- published_content_blocks (0043) and publishable_profiles (0044) build shard CONTENT and
-- belong here. unpublishable_post_ids (0046) deliberately does NOT — it drives deletions of
-- prerendered pages and nothing it returns is written anywhere, and it reads `posts`, which
-- already has triggers for every transition that lands a row in it.

select set_eq(
  $q$
    select distinct c.relname::text
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    where t.tgfoid = 'public.bump_publish_revision'::regproc
  $q$,
  $q$
    select distinct m[1]
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral regexp_matches(p.prosrc, 'public\.([a-z_]+)', 'g') m
    join pg_class c on c.relname = m[1] and c.relkind = 'r'
    join pg_namespace cn on cn.oid = c.relnamespace and cn.nspname = 'public'
    where n.nspname = 'public'
      and p.proname in ('publishable_posts', 'redacted_post_ids',
                        'published_content_blocks', 'publishable_profiles')
  $q$,
  'every table the publisher reads has a trigger that says when it changed'
);

-- ═══ 28 · A refused write leaves the next tick able to retry ══
--
-- 0038 refuses record_release when the caller no longer holds the lease. The refusal has to
-- come BEFORE the insert, and this is the assertion that says so from the outside: no
-- release row means the ACTIVE release keeps its old watermark, so publish_pending still
-- reports work outstanding and the next cron tick picks it up with a live lease.
--
-- Had the refusal come after the insert, the abandoned row would carry the claim-time
-- revision of a build that never went live, and activating it later would stamp the
-- watermark forward over work nobody published. Nothing in the return value distinguishes
-- the two orderings, which is why this is asserted against the archive instead.

select public.release_publish_lease('00000000-0000-0000-0000-00000000ce01');

select is(
  public.record_release('/v/2026-08-19T12:20:00Z/', pg_temp.content(), pg_temp.counter(),
                        '00000000-0000-0000-0000-00000000ce01') ->> 'reason'
    || ' / ' || pg_temp.reason(),
  'no_lease / content_changed',
  'a refused record changes nothing — the archive is still pending and the next tick retries');

select * from finish();
rollback;