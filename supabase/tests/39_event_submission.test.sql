-- 0062 · an event is not a photograph
--
-- Amro's decision, 7 Sep 2026: events get their own submission form and field set, inside
-- the single posts table. D6 stands — this file asserts that the SPLIT did not happen as
-- loudly as it asserts the new behaviour, because "give events their own form" is one
-- misreading away from "give events their own table", and §3 forbids the second.
--
-- ── The assertion this file exists for ───────────────────────
--
-- Tests 4 and 5, paired. §7's licence and provenance are no longer demanded of an event —
-- and are still demanded of everything else. A migration that dropped
-- posts_approved_has_rights outright would pass test 4 and fail test 5, and a moderator
-- would be able to approve a family photograph carrying no rights at all. The relaxation
-- is conditional or it is a hole, and one assertion on its own cannot tell the two apart.
--
-- ── Paired, throughout ───────────────────────────────────────
--
-- Every "an event may" has "and a photograph may not" beside it, run against the SAME
-- statement with one field changed. A refusal is also what a broken grant, a missing
-- fixture and a typo'd reason string look like, and this repository's characteristic
-- defect is a test that cannot fail (see docs/session-report-2026-09-02-testing.md).
--
-- The event fixtures deliberately use a real timestamp rather than now(): posts_event_
-- range_ordered compares the two columns, and a test whose start and end are both now()
-- passes an ordering check that a reversed pair would also pass.

begin;
create extension if not exists pgtap;

-- 2 the table is not split · 4 the form + 2 the constraint · 5 the event fields
-- 4 organizers · 4 the date derivation · 4 the coordinate refusal
select plan(25);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'event-one@t.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'event-two@t.local');

-- 0060 gates every contribution on a confirmed address; these are ordinary confirmed
-- members. The unconfirmed case is 37's, not this file's.
update public.email_confirmations set confirmed_at = now() where confirmed_at is null;

-- posts is unreadable by the member we impersonate below (0015 grants column subsets and
-- 0017's policies decide the rows), so the harness needs owner-rights observers.
create function pg_temp.post_field(p_key text, p_field text) returns text
language plpgsql stable security definer set search_path = '' as $fn$
declare v text;
begin
  execute format('select (%I)::text from public.posts where ingest_object_key = $1', p_field)
    into v using p_key;
  return v;
end;
$fn$;

create function pg_temp.details_of(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $fn$
  select p.details from public.posts p where p.ingest_object_key = p_key;
$fn$;

-- consent is not granted to `authenticated` at all (0015).
create function pg_temp.consent_of(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $fn$
  select p.consent from public.posts p where p.ingest_object_key = p_key;
$fn$;

/* The allowlist check has to be attempted with OWNER rights, and this is §1 of the pgTAP
   traps rather than a convenience. `authenticated` holds a column SUBSET on posts and
   `details` is not in its UPDATE list, so the direct statement is refused 42501 — which is
   a permission error dressed as a constraint test, and it passes whether or not the
   allowlist exists. Running it as the owner is what puts the CHECK, and only the CHECK, in
   front of the write. */
create function pg_temp.set_details(p_key text, p_details jsonb) returns void
language plpgsql security definer set search_path = '' as $fn$
begin
  update public.posts set details = p_details where ingest_object_key = p_key;
end;
$fn$;

-- ═══ 1–2 · D6 — the table was NOT split ══════════════════════
--
-- §3: "Single `posts` table with a `kind` enum. Do not split by type — one feed, one
-- moderation queue, one comment model; splitting turns every feed read into a UNION."
-- This is the constraint the whole scope change was checked against, so it is asserted
-- rather than assumed.

select hasnt_table('public', 'events',
  'D6 — events did NOT get their own table (§3: one posts table, one feed, one queue)');

select ok(
  (select count(*) from pg_enum e
    join pg_type t on t.oid = e.enumtypid
   where t.typname = 'post_kind' and e.enumlabel = 'event') = 1,
  'an event is still a `kind` on posts, which is what keeps the feed one query');

-- ═══ 3–6 · The rights relaxation, and its other half ═════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}';

-- CONTROL first: the happy path works at all, so a refusal below means the boundary and
-- not a broken fixture.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-ok', 'event',
    '{"title_ar":"مهرجان","body_ar":"وصف","event_starts_at":"2026-10-01T18:00:00Z"}') ->> 'post_id'
    is not null,
  true,
  'CONTROL: an event with a name, a description and a start is accepted');

select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-norights', 'event',
    '{"title_ar":"ندوة","body_ar":"وصف","event_starts_at":"2026-10-02T18:00:00Z"}') ->> 'post_id'
    is not null,
  true,
  'an event needs no licence and no provenance (§7 — no third-party rights to hold)');

-- THE PAIR. Same call, one field changed, and it must still be refused. Without this, a
-- migration that dropped the requirement for everything passes the assertion above.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ph-norights', 'media',
    '{"title_ar":"صورة","body_ar":"وصف"}') ->> 'reason',
  'license_required',
  '...and a PHOTOGRAPH still does — the relaxation is conditional, not a hole');

select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ph-noprov', 'media',
    '{"title_ar":"صورة","body_ar":"وصف","license":"CC0-1.0","consent":{"granted":true}}') ->> 'reason',
  'provenance_required',
  '...including provenance, which is the field §7 names first');

/* ── The CONSTRAINT itself, which is the actual relaxation ────

   The four assertions above are claim_upload_slot's refusals — what a contributor is
   ASKED. posts_approved_has_rights is a different mechanism at a different moment: it
   fires when a moderator approves, and before 0062 it refused an event 23514 no matter
   what the submission path had accepted. A version of this file that stopped at the
   refusals would have left the constraint untested, and an event would have been
   submittable and unapprovable — which is a worse failure than the one being fixed,
   because it appears only after a moderator has done the work.

   Attempted with owner rights for the same reason as set_details: `authenticated` cannot
   write `status` at all, so a direct statement would be refused for a reason that has
   nothing to do with the constraint under test.

   AND the jwt claims are cleared, which is the half that matters. posts_stamp_authorship
   is a BEFORE INSERT trigger that pins `new.status := 'pending'` for any session where
   auth.uid() is not null — §1's "everything user-submitted is reviewed before it is
   public". `reset role` alone does not clear a `set local request.jwt.claims`, so the
   first draft of these two assertions inserted rows whose status was rewritten to
   'pending' before the constraint was ever consulted: the CHECK was trivially satisfied,
   the "cannot" went green for the wrong reason, and the "can" beside it proved nothing
   either. Clearing the claims takes the trigger's own auth.uid() IS NULL branch — the
   service-role path M5's bulk importer uses to insert pre-approved seed material, which
   is exactly the situation being modelled. */
reset role;
set local request.jwt.claims to '';

select lives_ok(
  $$insert into public.posts (kind, title_ar, body_ar, event_starts_at, created_by,
                              ingest_state, status, approved_by, approved_at, content_hash)
    values ('event','مهرجان','وصف','2026-10-01T18:00:00Z'::timestamptz,
            '00000000-0000-0000-0000-0000000000e1', 'ready', 'approved',
            '00000000-0000-0000-0000-0000000000e2', now(), repeat('a', 64))$$,
  'an event can be APPROVED with no licence and no provenance (the constraint, not the form)');

-- THE PAIR, and the one that says the relaxation is conditional. Dropping
-- posts_approved_has_rights outright passes the assertion above and fails this one.
select throws_ok(
  $$insert into public.posts (kind, title_ar, body_ar, created_by,
                              ingest_state, status, approved_by, approved_at, content_hash)
    values ('media','صورة','وصف','00000000-0000-0000-0000-0000000000e1', 'ready', 'approved',
            '00000000-0000-0000-0000-0000000000e2', now(), repeat('b', 64))$$,
  '23514',
  null,
  '...and a PHOTOGRAPH still cannot be — §7''s rights requirement is intact for media');

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}';

-- ═══ 7–11 · The event's own fields ═══════════════════════════

-- posts_event_needs_a_start is the constraint that made every event submission a 500
-- before 0062. It is a named refusal now, and it is checked BEFORE the quota charge.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-nostart', 'event',
    '{"title_ar":"حدث","body_ar":"وصف"}') ->> 'reason',
  'event_start_required',
  'an event without a start is refused by name, not by a 23514 out of a definer function');

-- A timestamp cannot be regex-checked into safety: this one matches every reasonable
-- pattern and still raises on cast.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-baddate', 'event',
    '{"title_ar":"حدث","body_ar":"وصف","event_starts_at":"2026-13-45T99:99:99Z"}') ->> 'reason',
  'invalid_event_start',
  'a malformed start is a refusal a member can read, not a 500');

select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-backwards', 'event',
    '{"title_ar":"حدث","body_ar":"وصف","event_starts_at":"2026-10-05T18:00:00Z",
      "event_ends_at":"2026-10-01T18:00:00Z"}') ->> 'reason',
  'event_ends_before_start',
  'an event that ends before it starts is refused (posts_event_range_ordered, pre-checked)');

-- The venue is free text and it is the event's location. Asserted on the ROW, because the
-- refusals above would all pass against a function that accepted the fields and dropped
-- them on the floor.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-venue', 'event',
    '{"title_ar":"عرض","body_ar":"وصف","event_starts_at":"2026-11-01T19:00:00Z",
      "event_ends_at":"2026-11-01T22:00:00Z","venue_ar":"قصر رام الله الثقافي"}') ->> 'post_id'
    is not null,
  true,
  'CONTROL: an event with a venue and an end time is accepted');

select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000e1/ev-venue', 'venue_ar'),
  'قصر رام الله الثقافي',
  '...and the venue is STORED, as the free text §7 does not need to fuzz');

-- ═══ 12–15 · organizers ══════════════════════════════════════

select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-org', 'event',
    '{"title_ar":"مهرجان","body_ar":"وصف","event_starts_at":"2026-12-01T18:00:00Z",
      "organizers":["بلدية رام الله","مركز خليل السكاكيني"]}') ->> 'post_id' is not null,
  true,
  'CONTROL: an event carrying organizers is accepted');

select is(
  pg_temp.details_of('00000000-0000-0000-0000-0000000000e1/ev-org') -> 'organizers',
  '["بلدية رام الله","مركز خليل السكاكيني"]'::jsonb,
  'organizers land in details.organizers, in order (0022''s allowlist, extended by 0062)');

-- The allowlist is what makes `details` safe to grant to `authenticated`, so a key that is
-- not on it must still be refused — otherwise 0062 widened more than it meant to.
select throws_ok(
  $$select pg_temp.set_details('00000000-0000-0000-0000-0000000000e1/ev-org',
                               '{"contributor_email":"x@t.local"}'::jsonb)$$,
  '23514',
  null,
  'a key NOT on the allowlist is still refused — 0062 added one key, not an escape hatch');

select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-badorg', 'event',
    '{"title_ar":"حدث","body_ar":"وصف","event_starts_at":"2026-12-02T18:00:00Z",
      "organizers":[{"name":"nested"}]}') ->> 'reason',
  'invalid_organizers',
  'a nested object in organizers is refused, not stringified into the text[]');

-- ═══ 16–18 · An event dates itself ═══════════════════════════
--
-- §3's `decade` is GENERATED from date_earliest and is what the slider filters on, so an
-- event with a start and no derived date would be absent from /map's decade filter while
-- appearing in the feed — visible, and wrong, in a way nothing would report.

select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000e1/ev-venue', 'decade'),
  '2020',
  'an event''s decade is derived from its start, so the slider can find it');

select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000e1/ev-venue', 'date_precision'),
  'day',
  '...at day precision, because a start date is a fact the contributor gave to the day');

/* An explicit decade still wins, for a listing ABOUT a historical event.

   The write and the read are two STATEMENTS, deliberately. Folded into one SELECT this
   returned NULL: post_field is STABLE, so within a single statement it may be evaluated
   against a snapshot taken before the insert in the same expression — §2 of the pgTAP
   traps, and it looks exactly like a function that did not store the value. */
select ok(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-1960s', 'event',
    '{"title_ar":"حدث","body_ar":"وصف","event_starts_at":"2026-12-03T18:00:00Z","decade":"1960"}')
    ->> 'post_id' is not null,
  'CONTROL: an event carrying an explicit decade is accepted');

select is(
  pg_temp.post_field('00000000-0000-0000-0000-0000000000e1/ev-1960s', 'decade'),
  '1960',
  'an explicit decade still wins over the one derived from the start date');

-- ═══ 19–22 · The coordinate, refused rather than dropped ═════

select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ev-pin', 'event',
    '{"title_ar":"حدث","body_ar":"وصف","event_starts_at":"2026-12-04T18:00:00Z",
      "lat":"31.9","lon":"35.2"}') ->> 'reason',
  'event_takes_no_coordinate',
  'an event given a pin is REFUSED — a value silently discarded is one nobody finds out about');

-- And the pair: the same coordinate on a photograph is exactly how M4 works.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ph-pin', 'media',
    '{"title_ar":"صورة","body_ar":"وصف","license":"CC0-1.0","provenance":"family",
      "consent":{"granted":true},"lat":"31.9","lon":"35.2"}') ->> 'post_id' is not null,
  true,
  '...while a photograph with a pin is still accepted, which is M4 unchanged');

-- posts_event_columns_only_on_events cuts both ways.
select is(
  public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000e1/ph-venue', 'media',
    '{"title_ar":"صورة","body_ar":"وصف","license":"CC0-1.0","provenance":"family",
      "consent":{"granted":true},"venue_ar":"مكان"}') ->> 'reason',
  'event_fields_on_non_event',
  'a venue on a photograph is refused, not ignored (posts_event_columns_only_on_events)');

-- §7's consent stamp is a record of an agreement. An event was never shown a consent box,
-- so fabricating one for it would be the one thing a consent column must never hold.
select is(
  pg_temp.consent_of('00000000-0000-0000-0000-0000000000e1/ev-venue'),
  '{}'::jsonb,
  'an event records NO consent affirmation, because nobody was asked for one');

select * from finish();
rollback;
