-- The publish trigger, now that it is the moderation action rather than a clock (0042).
--
-- 20_publish_cron pins the SIGNAL — which writes move content_revision, which move
-- counter_revision, and what publish_pending concludes from the pair. This file pins the
-- part 0042 added: that something actually asks for a publish, that it asks once, and that
-- a change landing mid-build is not lost now that no tick is coming to collect it.
--
-- ── Reading the assertions ───────────────────────────────────
--
-- Every dispatch here answers `not_configured`: publish_tick decides first and only then
-- reads Vault, and a local stack has neither secret set. That is not a limitation of the
-- test, it is the branch that proves the decision was reached — `unchanged` and
-- `not_configured` are different answers, and only the second one means "I would have
-- POSTed". Test 24 in 20_publish_cron makes the same distinction for the cron path.
--
-- So the queue depth stays 0 throughout and the assertions read publish_tick's own verdict.
-- Asserting on net.http_request_queue instead would need a Vault fixture and would test
-- pg_net rather than this.
--
-- Every approval below names its approver explicitly. posts_approved_is_attributable
-- refuses an approved row with no approver, and auth.uid() is null in a pgTAP session that
-- sets no JWT claims — the same reason 20_publish_cron wraps its approvals in a helper.

begin;
create extension if not exists pgtap;

-- 4 the trigger fires · 3 once per transaction · 4 the follow-up · 2 the deferred cron
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'approval-author@t.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'approval-mod@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000f2', 'moderator',
        '00000000-0000-0000-0000-0000000000f2');

insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          ingest_state, status)
values
  ('00000000-0000-0000-0000-00000000fa01', 'media', 'first', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000f1', 'ready', 'pending'),
  ('00000000-0000-0000-0000-00000000fa02', 'media', 'second', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000f1', 'ready', 'pending'),
  ('00000000-0000-0000-0000-00000000fa03', 'media', 'third', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000f1', 'ready', 'pending'),
  ('00000000-0000-0000-0000-00000000fa04', 'media', 'a draft', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000f1', 'ready', 'pending');

-- An active release, so publish_pending has a watermark to compare against and answers
-- 'unchanged' rather than 'no_active_release' at rest.
create function pg_temp.settle() returns void
language sql as $fn$
  select public.record_release(
           '/v/2026-08-20T10:00:00Z/',
           (select content_revision from public.publish_revision where id),
           (select counter_revision from public.publish_revision where id),
           h.holder) ->> 'id'
    from (select holder from public.publish_lease where id) h;
$fn$;

create function pg_temp.content_rev() returns bigint
language sql stable as $fn$
  select content_revision from public.publish_revision where id;
$fn$;

/* How many requests pg_net has queued. Named so an assertion can say "and nothing was
   actually sent", which is the difference between deciding to dispatch and dispatching. */
create function pg_temp.queued() returns integer
language sql stable as $fn$
  select count(*)::integer from net.http_request_queue;
$fn$;

-- A release, activated, so the archive starts from 'unchanged'.
do $do$
declare
  v_holder uuid := '00000000-0000-0000-0000-00000000fb01';
  v_id     uuid;
begin
  perform public.claim_publish_lease(v_holder, interval '5 minutes', 'fixture');
  v_id := (public.record_release('/v/2026-08-20T10:00:00Z/',
             (select content_revision from public.publish_revision where id),
             (select counter_revision from public.publish_revision where id),
             v_holder) ->> 'id')::uuid;
  perform public.activate_release(v_id, v_holder);
  perform public.release_publish_lease(v_holder);
end;
$do$;

-- ═══ 1–3 · An approval asks for a publish ════════════════════

select is(
  public.publish_pending() ->> 'reason', 'unchanged',
  'the fixture starts from a published archive, so any change below is the one under test');

-- THE assertion of this milestone. Before 0042 nothing here reached publish_tick at all:
-- the row moved, the revision moved, and the only thing that would ever have noticed was a
-- cron tick two minutes later.
--
-- 'not_configured' rather than 'dispatched' because no Vault secret exists on a local
-- stack — see the file header. What it proves is that the decision was reached, which
-- 'unchanged' would not.
select lives_ok($$
  update public.posts
     set status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000f2'
   where id = '00000000-0000-0000-0000-00000000fa01'
$$, 'a moderator approves');

select is(
  public.publish_pending() ->> 'reason', 'content_changed',
  '...and the archive is now out of date, which is what the trigger reacts to');

-- The negative half, and it is the one that costs money if it is wrong. A member editing a
-- draft is the highest-volume write this table takes and appears in no shard; 0037's WHEN
-- clauses exclude it, and because 0042 hangs the dispatch off those same clauses rather
-- than writing its own, it is excluded here too. If this ever fires, every draft keystroke
-- rebuilds ~325 objects.
select lives_ok($$
  update public.posts set title_en = 'a draft, edited'
   where id = '00000000-0000-0000-0000-00000000fa04'
$$, 'a member edits a draft, and nothing about the published archive changed');

-- ═══ 4–6 · Once per transaction ══════════════════════════════
--
-- bump_publish_revision is a ROW trigger. Approving in bulk — the M5 importer's shape —
-- would otherwise queue one POST per row, all but the first answered `held` by the lease.
--
-- The guard is a transaction-local setting, and pgTAP runs the whole file in ONE
-- transaction, so everything above has already set it. That is why these three assert on
-- the setting rather than on a queue depth: the observable effect of the guard is that the
-- flag is set once and stays set, and the queue is empty for an unrelated reason.

select is(
  current_setting('rma.publish_dispatched', true), '1',
  'the first content bump marked this transaction as having asked for a publish');

select lives_ok($$
  update public.posts
     set status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000f2'
   where id in ('00000000-0000-0000-0000-00000000fa02',
                '00000000-0000-0000-0000-00000000fa03')
$$, 'two more approvals in one statement');

-- The revision still counts every row — the guard bounds the DISPATCH, never the signal.
-- Conflating the two would be the expensive mistake: a coalesced signal would let a release
-- stamp a watermark over an approval it never read.
select is(
  pg_temp.content_rev() > 0 and current_setting('rma.publish_dispatched', true) = '1',
  true,
  'the signal counted every row while the dispatch stayed at one for the transaction');

-- ═══ 7–10 · The follow-up ════════════════════════════════════
--
-- The hole the cron used to cover. publish() claims the lease and THEN reads the archive,
-- so an approval committing between those two moments is not in the release being built —
-- and its own dispatch was answered `held` by the lease it collided with. With no tick
-- coming, the follow-up at release time is the only thing left that can notice.

-- A publisher claims, and records what it read at claim time.
do $do$
declare
  v_holder uuid := '00000000-0000-0000-0000-00000000fb02';
  v_claim  jsonb;
  v_id     uuid;
begin
  v_claim := public.claim_publish_lease(v_holder, interval '5 minutes', 'mid-build');
  -- The approval that lands DURING the build.
  update public.posts
     set status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000f2'
   where id = '00000000-0000-0000-0000-00000000fa04';
  v_id := (public.record_release('/v/2026-08-20T11:00:00Z/',
             (v_claim ->> 'content_revision')::bigint,
             (v_claim ->> 'counter_revision')::bigint,
             v_holder) ->> 'id')::uuid;
  perform public.activate_release(v_id, v_holder);
  perform set_config('rma.test_claim_rev', v_claim ->> 'content_revision', true);
  perform set_config('rma.test_holder', v_holder::text, true);
end;
$do$;

select is(
  public.publish_pending() ->> 'reason', 'content_changed',
  'the mid-build approval is still outstanding after the release that missed it (0038)');

select is(
  public.release_publish_lease(
    current_setting('rma.test_holder')::uuid,
    current_setting('rma.test_claim_rev')::bigint) ->> 'followed_up',
  'true',
  'releasing the lease asks for the publish the cron would have asked for');

-- THE bound, and the reason the follow-up compares against the CLAIM-time revision instead
-- of just asking publish_pending. A build that fails leaves work outstanding every time it
-- runs; re-dispatching on "work outstanding" would POST forever at whatever rate the
-- publisher can fail. Nothing changed while this lease was held, so nothing follows up —
-- even though the archive is still out of date and publish_pending still says so.
do $do$
declare v_holder uuid := '00000000-0000-0000-0000-00000000fb03';
begin
  perform public.claim_publish_lease(v_holder, interval '5 minutes', 'a build that fails');
  perform set_config('rma.test_rev2', (select content_revision from public.publish_revision where id)::text, true);
  perform set_config('rma.test_holder2', v_holder::text, true);
end;
$do$;

select is(
  public.release_publish_lease(
    current_setting('rma.test_holder2')::uuid,
    current_setting('rma.test_rev2')::bigint) ->> 'followed_up',
  'false',
  'a build during which nothing changed follows up nothing — this is what bounds the loop');

select is(
  public.publish_pending() ->> 'reason', 'content_changed',
  '...while the work is still outstanding, so the two conditions really are different');

-- ═══ 11–12 · The cron is deferred, and reachable ═════════════

select is(
  (select count(*)::integer from cron.job where jobname = 'rma-publish'),
  0,
  'no schedule — 0042 unscheduled it rather than deleting the machinery');

-- The other half of "deferred, not deleted": restoring it is one cron.schedule line, which
-- is only true while pg_cron is still installed and publish_tick still callable with no
-- arguments. Both are asserted, because a later migration dropping either would turn a
-- one-line change into a migration and nobody would find out until they tried.
select ok(
  exists (select 1 from pg_extension where extname = 'pg_cron')
  and exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'publish_tick'
       and p.pronargs = 1 and p.pronargdefaults = 1),
  'pg_cron is still installed and publish_tick still takes a defaulted argument');

select * from finish();
rollback;
