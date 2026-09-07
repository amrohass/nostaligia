-- 0063 · an event may be a listing, and only an event may
--
-- Amro's decision, 7 Sep 2026: a post may skip media ONLY if kind='event'. kind='media'
-- requires at least one media_assets row, "unconditionally, no exceptions".
--
-- ── The assertion this file exists for ───────────────────────
--
-- Tests 8 and 9, paired, and they are 39's tests 7/8 pattern applied to a different
-- mechanism. §1's rule is a RELAXATION for one kind and must not be a hole for the others:
-- a trigger that simply never fired would pass "an event can be approved with no media" and
-- fail nothing, and a photograph with no photograph in it would become approvable. One
-- assertion on its own cannot tell a working exemption from a dead trigger.
--
-- Test 10 is the second half of that discrimination and is not decoration: a media post
-- WITH an asset must still be approvable. Without it, a trigger that refused every non-event
-- approval outright — including the correct ones — would pass 8 and 9 both.
--
-- ── SET CONSTRAINTS, and why this file drives BOTH modes ─────
--
-- posts_approved_has_media is DEFERRABLE INITIALLY IMMEDIATE. Immediate is the ordinary
-- case and the one the moderation path takes: a moderator's approval is a single-statement
-- UPDATE against a post whose media already exists, and the error belongs at that
-- statement. Deferral is an opt-in for the one transaction that legitimately writes a post
-- and its media together — M5's bulk importer, which cannot do otherwise because
-- media_assets.post_id references posts.
--
-- approve_checked() drives both, in the order a real transaction would: it sets DEFERRED,
-- inserts the post, inserts the media if the case calls for it, then sets IMMEDIATE to
-- force the check at a point this transaction actually reaches. A pgTAP file ROLLS BACK,
-- so a check left waiting for commit never happens at all — and an assertion that never
-- ran is one that passes whether or not the trigger exists. That last line is the whole
-- difference between this file and a decoration.
--
-- The `set constraints ... deferred` at the top of the helper is not symmetry either: it
-- is a bug this file already had. IMMEDIATE holds for the REST of the transaction, so the
-- first call left the trigger immediate, the later ones fired at the INSERT before their
-- media row could exist, and the control at test 10 failed against a correct migration.
--
-- ── Why the refusals are matched on MESSAGE, not only 23514 ──
--
-- posts_approved_has_rights, posts_approved_is_attributable and this trigger all raise
-- check_violation. A media post with no licence fails the rights constraint with the same
-- SQLSTATE the missing-media trigger uses, so an assertion on the code alone would go green
-- for a post refused for an entirely different reason — and would keep going green if this
-- migration were reverted. The fixtures below therefore supply valid rights, and the
-- assertion names the message.

begin;
create extension if not exists pgtap;

-- 2 the shape · 5 the no-media submission · 5 the constraint pair + controls + §8
-- 5 the quota separation · 4 refusals · 2 grants
select plan(23);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'nomedia-one@t.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'nomedia-two@t.local');

-- 0060 gates every contribution on a confirmed address; these are ordinary confirmed
-- members. The unconfirmed case is 37's.
update public.email_confirmations set confirmed_at = now() where confirmed_at is null;

-- posts is unreadable by the member we impersonate below (0015 grants column subsets and
-- 0017's policies decide the rows), so the harness needs owner-rights observers.
create function pg_temp.post_field(p_id uuid, p_field text) returns text
language plpgsql stable security definer set search_path = '' as $fn$
declare v text;
begin
  execute format('select (%I)::text from public.posts where id = $1', p_field)
    into v using p_id;
  return v;
end;
$fn$;

create function pg_temp.details_of(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $fn$
  select p.details from public.posts p where p.id = p_id;
$fn$;

/* Finding a row by a field the impersonated member cannot read.

   §1 of the pgTAP traps, and it cost this file a run: `authenticated` holds a COLUMN SUBSET
   on posts (0015), so a plain `select ... from public.posts where venue_ar = ...` is refused
   42501 before any assertion is evaluated — and `ingest_object_key` is deliberately not
   granted at all (0025: an R2 path is not something §7 shows anybody). Both lookups
   therefore go through owner rights, which is also the only way to put the BEHAVIOUR under
   test in front of the assertion rather than a permission error. */
create function pg_temp.event_id_by_venue(p_venue text) returns uuid
language sql stable security definer set search_path = '' as $fn$
  select p.id from public.posts p
   where p.venue_ar = p_venue and p.ingest_object_key is null
   order by p.created_at desc limit 1;
$fn$;

/* The day's remaining allowance, spent in a loop rather than in a lateral join.

   SECURITY INVOKER deliberately: the quota is charged against auth.uid(), and this must
   spend the impersonated member's allowance rather than anybody else's. */
create function pg_temp.fill_event_quota(p_n int) returns int
language plpgsql set search_path = '' as $fn$
declare i int; c int := 0; r jsonb;
begin
  for i in 1..p_n loop
    r := public.claim_event_slot(format(
      '{"title_ar":"ح%s","body_ar":"وصف","event_starts_at":"2026-10-04T18:00:00Z"}', i)::jsonb);
    if (r ->> 'post_id') is not null then c := c + 1; end if;
  end loop;
  return c;
end;
$fn$;

-- The quota row, which `authenticated` cannot read at all (0011 revokes everything and
-- enables RLS with no policy).
create function pg_temp.quota_of(p_uid uuid, p_field text) returns integer
language plpgsql stable security definer set search_path = '' as $fn$
declare v integer;
begin
  execute format('select coalesce((%I)::integer, 0) from public.upload_quota
                   where user_id = $1 and day = (now() at time zone ''UTC'')::date', p_field)
    into v using p_uid;
  return coalesce(v, 0);
end;
$fn$;

/* The approval harness, and the `set constraints` line is the whole point of it.

   Owner rights, and the jwt claims cleared, for 39's reason: posts_stamp_authorship pins
   `new.status := 'pending'` for any session where auth.uid() is not null, so an approved
   row inserted while impersonating a member is rewritten to pending before any constraint
   is consulted — the assertion then passes for a reason that has nothing to do with what it
   claims to test. Clearing the claims takes the trigger's auth.uid() IS NULL branch, which
   is the service-role path M5's importer uses.

   Rights are supplied on every fixture even though only the media ones need them: it costs
   nothing, and it means a refusal below can only be this migration's trigger. */
create function pg_temp.approve_checked(p_kind public.post_kind, p_with_media boolean)
returns uuid
language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid;
begin
  /* Back to DEFERRED first, and this is not belt and braces — it is the bug this helper
     had on its first run. `SET CONSTRAINTS ... IMMEDIATE` holds for the REST of the
     transaction, so the first call left the trigger immediate and every later one fired at
     the INSERT, before the media row below could exist. The control at test 10 then failed
     against a correct migration. Each call resets the mode so each is self-contained. */
  set constraints public.posts_approved_has_media deferred;

  insert into public.posts (kind, title_ar, body_ar, event_starts_at,
                            license, provenance, created_by, ingest_state,
                            status, approved_by, approved_at, content_hash)
  values (p_kind, 'عنوان', 'وصف',
          case when p_kind = 'event' then '2026-10-01T18:00:00Z'::timestamptz end,
          'CC0-1.0', 'family',
          '00000000-0000-0000-0000-0000000000f1', 'ready',
          'approved', '00000000-0000-0000-0000-0000000000f2', now(), repeat('a', 64))
  returning id into v_id;

  if p_with_media then
    insert into public.media_assets (post_id, role, storage_path, bucket, mime, bytes)
    values (v_id, 'thumb', v_id::text || '/thumb.webp', 'public', 'image/webp', 4096);
  end if;

  -- Force the deferred check HERE rather than at a commit this transaction will never
  -- reach. Named rather than ALL, so an unrelated deferrable constraint added later cannot
  -- quietly change what this file is testing.
  set constraints public.posts_approved_has_media immediate;
  return v_id;
end;
$fn$;

-- ═══ 1–2 · The shape did not change ══════════════════════════
--
-- §3 again, because "give events a no-media path" is one misreading away from "give events
-- their own table", exactly as 0062's scope change was.

select hasnt_table('public', 'events',
  'D6 — a no-media event is still a row in posts (§3: one table, one feed, one queue)');

select has_function('public', 'claim_event_slot', array['jsonb'],
  'the no-media path is its own function, not an overload of the upload slot');

-- ═══ 3–7 · The no-media submission ═══════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}';

select is(
  public.claim_event_slot(
    '{"title_ar":"مهرجان","body_ar":"وصف","event_starts_at":"2026-10-01T18:00:00Z"}')
    ->> 'post_id' is not null,
  true,
  'CONTROL: an event with a name, a description and a start needs no file at all');

/* The row it made. Asserted rather than assumed, because the refusals above would all pass
   against a function that accepted the draft and stored something else.

   The write and the read are separate STATEMENTS, and that is §2 of the pgTAP traps rather
   than style: post_field is STABLE, so folded into the same SELECT as the call that creates
   the row it is evaluated against a snapshot taken before the insert and returns NULL —
   which looks exactly like a function that never stored the value. This file lost a run to
   it, in the same way 39 records losing one. */
select is(
  public.claim_event_slot(
    '{"title_ar":"عرض","body_ar":"وصف","event_starts_at":"2026-11-01T19:00:00Z",
      "venue_ar":"قصر رام الله الثقافي","organizers":["بلدية رام الله"]}')
    ->> 'post_id' is not null,
  true,
  'CONTROL: a no-media event carrying a venue and organizers is accepted');

/* ingest_state is the load-bearing field: 'awaiting_bytes' would strand the listing outside
   the moderation queue for ever, waiting for a file nobody is going to send, and
   publishable_posts() would never return it either. It would look exactly like a submission
   that silently vanished. */
select is(
  pg_temp.post_field(pg_temp.event_id_by_venue('قصر رام الله الثقافي'), 'ingest_state'),
  'ready',
  'a no-media event lands ready — there is no ingest to wait for');

select is(
  pg_temp.details_of(pg_temp.event_id_by_venue('قصر رام الله الثقافي')) -> 'organizers',
  '["بلدية رام الله"]'::jsonb,
  'organizers still land in details.organizers on the no-media path (the shared validator)');

select is(
  pg_temp.post_field(pg_temp.event_id_by_venue('قصر رام الله الثقافي'), 'ingest_object_key'),
  null,
  'and it holds NO object key — 0025''s partial unique index is what makes that legal');

-- ═══ 8–11 · The constraint, in both directions ═══════════════
--
-- The pair the brief asks for, plus the two controls that stop either half passing for the
-- wrong reason.

reset role;
set local request.jwt.claims to '';

select lives_ok(
  $$select pg_temp.approve_checked('event', false)$$,
  'an event can be APPROVED with no media at all (the relaxation)');

-- THE PAIR. Same helper, one argument changed, and it must be refused — by NAME, because
-- three different constraints on this table raise 23514.
select throws_ok(
  $$select pg_temp.approve_checked('media', false)$$,
  'post_approved_without_media',
  '...and a PHOTOGRAPH still cannot be — the relaxation is conditional, not a hole');

-- The control that says the trigger discriminates rather than refusing everything. Without
-- this, a trigger that raised on every non-event approval would pass both assertions above.
select lives_ok(
  $$select pg_temp.approve_checked('media', true)$$,
  '...while a photograph WITH a media asset is approved exactly as before');

-- §1's rule is "only an event", not "not media". A voice note with no audio is not a voice
-- note, and the migration says so by testing kind <> 'event' rather than kind = 'media'.
select throws_ok(
  $$select pg_temp.approve_checked('voice', false)$$,
  'post_approved_without_media',
  'a VOICE note with no audio is refused too — the exemption names events, not "not media"');

/* §8 — a TAKEDOWN must never be what this rule blocks.

   request_takedown's whole effect on posts is `update ... set takedown = true`: status stays
   'approved', kind stays 'media', and media_assets is deliberately untouched. So a takedown
   lands on exactly the row shape the trigger fires for, and a post with no media — one that
   predates 0063, since nothing can create one after it — would have had its takedown
   REFUSED. §8 says takedown latency must never be bounded by the publish cycle; being
   unable to take an item down at all is the worse version of that.

   The legacy row is created with the trigger DISABLED rather than deferred, and that is the
   only construction that models it. Deferring does not work: the pending check fires at the
   `set constraints ... immediate` that would make the rule live again, so the fixture is
   refused before the takedown is ever attempted — which is the trigger behaving correctly
   against a row it is right to refuse. Disabling reproduces the real situation instead: the
   row predates the rule, and the rule is live by the time somebody asks for a takedown. */
select lives_ok(
  $$do $blk$
    declare v_id uuid;
    begin
      alter table public.posts disable trigger posts_approved_has_media;
      insert into public.posts (kind, title_ar, body_ar, license, provenance, created_by,
                                ingest_state, status, approved_by, approved_at, content_hash)
      values ('media','قديم','وصف','CC0-1.0','family',
              '00000000-0000-0000-0000-0000000000f1','ready','approved',
              '00000000-0000-0000-0000-0000000000f2', now(), repeat('c', 64))
      returning id into v_id;
      -- The legacy row exists and the rule is live again from here.
      alter table public.posts enable trigger posts_approved_has_media;
      update public.posts set takedown = true where id = v_id;
    end
  $blk$;$$,
  'a TAKEDOWN of a media post with no media still succeeds — §8 is not bounded by this rule');

-- ═══ 12–16 · The quota is separate in BOTH directions ════════
--
-- "Do not let a no-media event consume or bypass the media upload quota." Two failures,
-- and one assertion cannot see both: a shared counter would let a listing SPEND an upload,
-- and a missing counter would let listings run for ever.

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}';

select is(
  public.claim_event_slot(
    '{"title_ar":"حدث","body_ar":"وصف","event_starts_at":"2026-10-03T18:00:00Z"}')
    ->> 'post_id' is not null,
  true,
  'CONTROL: the second member''s first listing is accepted');

select is(
  pg_temp.quota_of('00000000-0000-0000-0000-0000000000f2', 'event_count'), 1,
  'a no-media event charges event_count');

select is(
  pg_temp.quota_of('00000000-0000-0000-0000-0000000000f2', 'count'), 0,
  '...and does NOT consume the upload count — a listing cannot spend an upload');

select is(
  pg_temp.quota_of('00000000-0000-0000-0000-0000000000f2', 'bytes'), 0,
  '...nor any bytes, which is the allowance sized for 200 MB files');

-- And the other direction: an upload must not spend the listing allowance either.
select is(
  (public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000f2/up-1', 'media',
     '{"title_ar":"صورة","body_ar":"وصف","license":"CC0-1.0","provenance":"family",
       "consent":{"granted":true}}') ->> 'post_id') is not null
   and pg_temp.quota_of('00000000-0000-0000-0000-0000000000f2', 'event_count') = 1,
  true,
  'an UPLOAD leaves event_count untouched — the separation holds both ways');

-- ═══ 17–20 · The ceiling, and the refusals ═══════════════════
--
-- The member limit is 10 (event_daily_limits). The row already holds 1, so nine more fill
-- it and the eleventh is refused. Run as a set rather than eleven statements.

select is(
  pg_temp.fill_event_quota(9), 9,
  'CONTROL: the rest of the day''s allowance is admitted');

select is(
  public.claim_event_slot(
    '{"title_ar":"زائد","body_ar":"وصف","event_starts_at":"2026-10-05T18:00:00Z"}')
    ->> 'reason',
  'event_quota_exceeded',
  'the eleventh listing of the day is refused — the ceiling is enforced in the database');

-- The bypass half, and it is the one a shared counter would fail: exhausting the LISTING
-- allowance must leave the upload allowance alone.
select is(
  (public.claim_upload_slot(1024, '00000000-0000-0000-0000-0000000000f2/up-2', 'media',
     '{"title_ar":"صورة","body_ar":"وصف","license":"CC0-1.0","provenance":"family",
       "consent":{"granted":true}}') ->> 'post_id') is not null,
  true,
  '...and a member out of listings can still upload — neither quota gates the other');

select is(
  public.claim_event_slot('{"body_ar":"وصف","event_starts_at":"2026-10-06T18:00:00Z"}')
    ->> 'reason',
  'title_required',
  'the no-media path names its refusals, and checks them BEFORE the quota is charged');

-- ═══ 21–22 · The grants ══════════════════════════════════════
--
-- A submission path reachable by anon would be a write path with no account behind it.

select ok(
  not has_function_privilege('anon', 'public.claim_event_slot(jsonb)', 'execute'),
  'anon cannot submit a listing');

select ok(
  not has_function_privilege('anon', 'public.claim_event_quota()', 'execute'),
  '...nor charge the counter that bounds one');

select * from finish();
rollback;
