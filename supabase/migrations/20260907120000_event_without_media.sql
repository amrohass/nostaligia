-- 0063 · An event may be a listing, and only an event may
--
-- Amro's decision, 7 Sep 2026, final and relayed: a post may skip media ONLY if
-- kind='event'. kind='media' — the archive items — requires at least one media_assets row,
-- "unconditionally, no exceptions". kind='voice' is the same: a voice note with no audio is
-- not a voice note, so the rule below is "not an event" rather than "not media".
--
-- D6 is untouched. No new table, no new stream, one feed and one moderation queue — 0062's
-- 39_event_submission asserts the absence of a public.events table and this migration does
-- nothing to change that. What changes is that an event listing no longer has to carry a
-- photograph it never had.
--
-- ── What 0062 left, one day later ────────────────────────────
--
-- 0062 made an event SUBMITTABLE. It did not make one submittable without a file, because
-- every path into posts goes through claim_upload_slot, which takes an object key, charges
-- the byte quota and inserts ingest_state='awaiting_bytes'. An event with no poster image
-- therefore had no route at all: the member had to attach something, or send nothing.
--
-- ── The three pieces, and why each is separate ───────────────
--
--   1  parse_event_fields   the SHARED validator. 0062 put this logic inline in
--                           claim_upload_slot; a second copy in claim_event_slot is exactly
--                           the drift this codebase keeps naming. One definition, two
--                           callers, and 39_event_submission's 25 assertions already bind
--                           the behaviour — so the extraction is proven by a suite that
--                           existed before it.
--   2  claim_event_quota    a COUNT-ONLY quota, in its own column with its own ceiling. A
--                           no-media event spends no bytes and no R2 object, so charging it
--                           against §6's byte quota would be wrong in both directions: it
--                           would consume an allowance sized for 200 MB uploads, and it
--                           would let a member who had spent their uploads keep filing
--                           listings for free. Neither consumes nor bypasses the other.
--   3  posts_approved_has_media  the constraint, in both directions.
--
-- ── Where Turnstile is, because it is NOT here ───────────────
--
-- §6 requires Turnstile on submit, and a SECURITY DEFINER function granted to
-- `authenticated` is directly callable — so if the browser called claim_event_slot itself,
-- the archive would have acquired a write path with no captcha in front of it. It does not:
-- request-upload is still the only door (§2's write path), and it runs auth, Turnstile,
-- the role lookup and 0060's confirmation check before reaching this function, exactly as
-- it does for an upload. This function is reachable directly, like claim_upload_slot, and
-- like claim_upload_slot the worst that reaches is the caller's OWN quota.
--
-- 0060's gate needs no restatement either: posts_require_confirmed_email is a BEFORE INSERT
-- trigger on posts, so it fires on this path without this migration mentioning it. That is
-- the property §4's amendment was after — the trigger closes the definer paths RLS cannot
-- see, including ones written after it.

set search_path = public, extensions;

-- ── 1 · The shared event validator ───────────────────────────
--
-- Pure: it reads the draft and nothing else. No auth.uid(), no tables, no now() — so it is
-- testable on its own and cannot behave differently for the two callers.
--
-- STABLE and not IMMUTABLE, which is not a formality. `text::timestamptz` reads the session
-- TimeZone for any input that carries no zone of its own, and a draft is a jsonb blob a
-- browser composed — "2026-10-01T18:00" with no Z is a shape upload.js takes trouble to
-- avoid sending and a direct caller may send anyway. Declaring that IMMUTABLE tells the
-- planner it may fold the result and reuse it across a `SET TimeZone`, which is exactly the
-- one-line quota bypass 0024's header describes in a different guise. The first draft of
-- this function said IMMUTABLE.
--
-- Returns a refusal object or a parsed object, rather than raising. Every refusal in this
-- family reaches a member as a named reason they can read; a raise inside a SECURITY
-- DEFINER function reaches them as a 500 with a Postgres error in it, which is the failure
-- 0062's header is largely about.
create or replace function public.parse_event_fields(p_draft jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  -- 0062's numbers, moved rather than re-chosen.
  c_max_organizers    constant int := 20;
  c_max_organizer_len constant int := 200;

  v_start_raw  text := nullif(btrim(coalesce(p_draft ->> 'event_starts_at', '')), '');
  v_end_raw    text := nullif(btrim(coalesce(p_draft ->> 'event_ends_at', '')), '');
  v_start      timestamptz;
  v_end        timestamptz;
  v_venue_ar   text := nullif(btrim(coalesce(p_draft ->> 'venue_ar', '')), '');
  v_venue_en   text := nullif(btrim(coalesce(p_draft ->> 'venue_en', '')), '');
  v_org_raw    jsonb := p_draft -> 'organizers';
  v_organizers text[];
  v_details    jsonb := '{}'::jsonb;
begin
  -- posts_event_needs_a_start, pre-checked. This is the constraint that made every event
  -- submission a 500 before 0062.
  if v_start_raw is null then
    return jsonb_build_object('ok', false, 'reason', 'event_start_required');
  end if;

  /* A timestamp cannot be regex-validated into safety the way a decade can — '2026-13-45'
     matches every reasonable pattern and still raises on cast. So the cast is wrapped.
     A nested EXCEPTION block is a subtransaction, which 0029's header warns against AFTER
     a quota charge because it would strand the charge; this function never charges
     anything, and both callers run it BEFORE they do. */
  begin
    v_start := v_start_raw::timestamptz;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'invalid_event_start');
  end;

  if v_end_raw is not null then
    begin
      v_end := v_end_raw::timestamptz;
    exception when others then
      return jsonb_build_object('ok', false, 'reason', 'invalid_event_end');
    end;
    -- posts_event_range_ordered, pre-checked for the same reason as the start.
    if v_end < v_start then
      return jsonb_build_object('ok', false, 'reason', 'event_ends_before_start');
    end if;
  end if;

  -- The venue is the event's location and it is free text. A coordinate sent with an event
  -- is REFUSED rather than dropped — 0062's rule, and this codebase's general one: a value
  -- named in a call and silently discarded is worse than one refused, because nobody finds
  -- out. If events ever want a map pin, that is a decision with a migration.
  if nullif(btrim(coalesce(p_draft ->> 'place_id', '')), '') is not null
     or nullif(btrim(coalesce(p_draft ->> 'lat', '')), '') is not null
     or nullif(btrim(coalesce(p_draft ->> 'lon', '')), '') is not null then
    return jsonb_build_object('ok', false, 'reason', 'event_takes_no_coordinate');
  end if;

  if v_org_raw is not null then
    if jsonb_typeof(v_org_raw) <> 'array' then
      return jsonb_build_object('ok', false, 'reason', 'invalid_organizers');
    end if;
    if jsonb_array_length(v_org_raw) > c_max_organizers then
      return jsonb_build_object('ok', false, 'reason', 'too_many_organizers',
                                'max', c_max_organizers);
    end if;
    -- Every element must be a non-empty string. `->>` on a nested object would stringify it
    -- into the array, which is how a jsonb blob ends up in a text[].
    if exists (
      select 1 from jsonb_array_elements(v_org_raw) e
       where jsonb_typeof(e.value) <> 'string'
          or btrim(e.value #>> '{}') = ''
          or length(e.value #>> '{}') > c_max_organizer_len
    ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_organizers');
    end if;

    select array_agg(btrim(e.value #>> '{}') order by e.ordinality)
      into v_organizers
      from jsonb_array_elements(v_org_raw) with ordinality e;

    if v_organizers is not null and array_length(v_organizers, 1) > 0 then
      v_details := jsonb_build_object('organizers', to_jsonb(v_organizers));
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'event_starts_at', v_start,
    'event_ends_at', v_end,
    'venue_ar', v_venue_ar,
    'venue_en', v_venue_en,
    'details', v_details,
    -- §3's decade is GENERATED from date_earliest and is what the slider filters on, so an
    -- event with a start and no derived date would be absent from /map's decade filter
    -- while appearing in the feed — visible, and wrong, in a way nothing would report.
    -- Returned as a suggestion: an explicit decade still wins, in both callers.
    'derived_earliest', (v_start at time zone 'UTC')::date,
    'derived_latest', coalesce((v_end at time zone 'UTC')::date, (v_start at time zone 'UTC')::date)
  );
end;
$$;

comment on function public.parse_event_fields(jsonb) is
  'The one definition of an event draft''s own fields, shared by claim_upload_slot and claim_event_slot so the two cannot drift (migration 0063).';

revoke execute on function public.parse_event_fields(jsonb) from public, anon;
grant  execute on function public.parse_event_fields(jsonb) to authenticated, service_role;

-- ── 2 · The count-only quota ─────────────────────────────────
--
-- A new column on upload_quota rather than a new table: the day boundary, the identity, the
-- RLS-with-no-policy and the revokes all already exist here and are the parts that are easy
-- to get wrong. §3's row for this table gains a column and says what it counts.
--
-- It is deliberately NOT `count`. Sharing that column would make a listing spend an
-- allowance sized in 200 MB uploads, and would let a member who had exhausted their uploads
-- go on filing listings — the two failures the brief names as "consume or bypass".
alter table public.upload_quota
  add column if not exists event_count integer not null default 0
    constraint upload_quota_event_count_nonnegative check (event_count >= 0);

comment on column public.upload_quota.event_count is
  'Submissions that upload NOTHING — kind=''event'' with no media (0063). Counted apart from `count`, which is uploads, so neither can spend the other.';

-- ── The ceiling ──────────────────────────────────────────────
--
-- CHOSEN, not derived, and this is the one thing in this file worth arguing about — the
-- same standing this project gives upload_daily_limits' numbers, which were also chosen and
-- then written into §6 so the governance file stays the source of truth.
--
-- Sized against what a listing actually costs, which is not bytes. A no-media event is one
-- posts row and, once approved, one item in a release. What it spends is a MODERATOR'S
-- ATTENTION, and there is one of those for the whole archive. Ten a day from one member is
-- already far more Ramallah events than a person can know about; a hundred for a moderator
-- covers a batch of listings typed up from an institution's season programme.
--
-- Lower than the upload count (20/200) on purpose: an upload costs the member the effort of
-- having a file, and a listing costs them a sentence. The cheaper thing needs the tighter
-- bound. Raise it against an actual moderation backlog, not against a complaint.
create or replace function public.event_daily_limits(p_role public.app_role)
returns table (max_count integer)
language sql
immutable
set search_path = ''
as $$
  select case when p_role in ('moderator', 'admin') then 100 else 10 end;
$$;

comment on function public.event_daily_limits(public.app_role) is
  'Per-day ceiling on submissions that upload nothing. Numbers chosen, not specified by CLAUDE.md — recorded in §6 beside the upload quotas (migration 0063).';

revoke execute on function public.event_daily_limits(public.app_role) from public, anon;
grant  execute on function public.event_daily_limits(public.app_role) to authenticated, service_role;

-- The gate, and it is 0024's shape deliberately: read, test and write in ONE statement with
-- the limit in the WHERE clause. Two statements is a time-of-check/time-of-use race that a
-- script wins every time, and "a quota enforced across two statements is not enforced".
--
-- `set timezone = 'UTC'` is load-bearing for the same reason it is there: current_date is
-- evaluated in the CALLER's TimeZone, so without it a `SET TimeZone` on the session rolls
-- the day forward and hands out a fresh allowance on demand.
create or replace function public.claim_event_quota()
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_role      public.app_role;
  v_day       date := (now() at time zone 'UTC')::date;
  v_max_count integer;
  v_count     integer;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  -- The authoritative role, from the table rather than from any claim the caller carries.
  v_role := public.authz_role();

  select l.max_count into v_max_count from public.event_daily_limits(v_role) l;

  insert into public.upload_quota as q (user_id, day, count, bytes, event_count)
  values (v_uid, v_day, 0, 0, 1)
  on conflict (user_id, day) do update
     set event_count = q.event_count + 1
   where q.event_count + 1 <= v_max_count
  returning q.event_count into v_count;

  -- No row came back: the ON CONFLICT guard refused the update. Nothing was written, which
  -- is the property that matters — a refused request must not consume the allowance it was
  -- refused for.
  if v_count is null then
    select q.event_count into v_count
      from public.upload_quota q
     where q.user_id = v_uid and q.day = v_day;

    return jsonb_build_object(
      'allowed', false, 'reason', 'event_quota_exceeded', 'role', v_role,
      'event_count', v_count, 'limit_event_count', v_max_count
    );
  end if;

  return jsonb_build_object(
    'allowed', true, 'role', v_role, 'day', v_day,
    'event_count', v_count, 'limit_event_count', v_max_count
  );
end;
$$;

comment on function public.claim_event_quota() is
  'CLAUDE.md §6 — the daily ceiling on submissions that upload nothing, enforced in one statement so it cannot be raced (migration 0063).';

revoke execute on function public.claim_event_quota() from public, anon;
grant  execute on function public.claim_event_quota() to authenticated, service_role;

-- ── 3 · The no-media submission ──────────────────────────────
--
-- Everything claim_upload_slot does about identity, titles and refusal naming, and nothing
-- it does about objects, bytes or ingest.
--
-- ingest_state is 'ready' — 0025's default, and correct here in the way it is correct for
-- the seed importer: there is no ingest to wait for. Setting 'awaiting_bytes' would strand
-- the listing outside the moderation queue for ever, waiting for a file nobody is going to
-- send. ingest_object_key stays NULL, which is what 0025's partial unique index is built
-- for.
create or replace function public.claim_event_slot(p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- The vocabulary a member may choose from. See 0032's header for why it is not a CHECK.
  c_licenses constant text[] := array['CC-BY-SA-4.0', 'CC0-1.0', 'rights-reserved'];

  v_uid      uuid := (select auth.uid());
  v_quota    jsonb;
  v_post_id  uuid;
  v_title_ar text := nullif(btrim(coalesce(p_draft ->> 'title_ar', '')), '');
  v_title_en text := nullif(btrim(coalesce(p_draft ->> 'title_en', '')), '');
  v_body_ar  text := nullif(btrim(coalesce(p_draft ->> 'body_ar',  '')), '');
  v_body_en  text := nullif(btrim(coalesce(p_draft ->> 'body_en',  '')), '');
  v_license  text := nullif(btrim(coalesce(p_draft ->> 'license', '')), '');
  v_prov     text := nullif(btrim(coalesce(p_draft ->> 'provenance', '')), '');

  v_event    jsonb;
  v_earliest date;
  v_latest   date;

  v_decade_raw text := nullif(btrim(coalesce(p_draft ->> 'decade', '')), '');
  v_decade     int  := case when v_decade_raw ~ '^[0-9]{4}$' then v_decade_raw::int end;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  -- §9 makes the description required archival metadata, and posts_has_a_title wants a
  -- title. Both apply to an event: its name is a title and its description is a
  -- description. Checked before the quota is charged, so a malformed draft costs nothing.
  if v_title_ar is null and v_title_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'title_required');
  end if;
  if v_body_ar is null and v_body_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'description_required');
  end if;

  -- §7's rights are not asked of an event — 0062's reasoning, unchanged: a listing that a
  -- concert happened carries no third-party rights for a contributor to grant or to
  -- mis-hold. A licence sent anyway is still validated rather than waved through, because
  -- an unrecognised string in that column would mean nothing to M5's Dublin Core export.
  if v_license is not null and not (v_license = any (c_licenses)) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_license',
                              'licenses', to_jsonb(c_licenses));
  end if;

  -- The event's own fields, through the one validator both paths use.
  v_event := public.parse_event_fields(p_draft);
  if (v_event ->> 'ok')::boolean is not true then
    -- The refusal passes through WHOLE rather than being rebuilt field by field. A
    -- rebuild has to name every key the validator might carry — `max` today, whatever a
    -- later limit adds — and the day it gains one this line drops it silently, which is
    -- the "value discarded without saying so" defect this file keeps citing.
    return (v_event - 'ok') || jsonb_build_object('allowed', false);
  end if;

  -- §3's decade, bounded and REFUSED rather than clamped when out of range — silently
  -- rewriting it would file the listing under a decade nobody chose.
  if v_decade_raw is not null then
    if v_decade is null
       or v_decade % 10 <> 0
       or v_decade < 1900
       or v_decade > ((extract(year from now())::int / 10) * 10) then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_decade');
    end if;
    v_earliest := make_date(v_decade, 1, 1);
    v_latest   := make_date(v_decade + 9, 12, 31);
  else
    -- An event dates itself. The start is a fact the contributor already gave; deriving
    -- from it asks them nothing twice.
    v_earliest := (v_event ->> 'derived_earliest')::date;
    v_latest   := (v_event ->> 'derived_latest')::date;
  end if;

  -- The charge, last of the checks, and count-only.
  v_quota := public.claim_event_quota();
  if (v_quota ->> 'allowed')::boolean is not true then
    return v_quota;
  end if;

  -- No EXCEPTION block below this line. See 0029's header: catching here would strand the
  -- charge above.
  --
  -- No location, no location_precision beyond the column default, no location_source: an
  -- event carries no coordinate at all, and parse_event_fields has already refused a draft
  -- that tried to send one. consent keeps its `{}` default — §7's stamp belongs only where
  -- §7 asked the question, and fabricating one for somebody never shown a consent box is
  -- the one thing a consent column must never hold.
  insert into public.posts (
    kind, title_ar, title_en, body_ar, body_en,
    date_earliest, date_latest, date_precision,
    event_starts_at, event_ends_at, venue_ar, venue_en, details,
    license, provenance,
    created_by, ingest_state
  )
  values (
    'event', v_title_ar, v_title_en, v_body_ar, v_body_en,
    v_earliest, v_latest,
    -- 'day' when the range came from a start the contributor gave to the day, 'decade' when
    -- they chose one. posts_date_precision_needs_a_date makes a precision without a date an
    -- error, and an event always has a start, so this is never null.
    case when v_decade_raw is null then 'day'::public.date_precision
         else 'decade'::public.date_precision end,
    (v_event ->> 'event_starts_at')::timestamptz,
    (v_event ->> 'event_ends_at')::timestamptz,
    v_event ->> 'venue_ar', v_event ->> 'venue_en',
    coalesce(v_event -> 'details', '{}'::jsonb),
    v_license, v_prov,
    v_uid, 'ready'
  )
  returning id into v_post_id;

  return v_quota || jsonb_build_object('post_id', v_post_id);
end;
$$;

comment on function public.claim_event_slot(jsonb) is
  'Submits an event listing that uploads nothing: §6''s count-only daily ceiling, the shared event validator, and no object key (CLAUDE.md §1, §3, §6; migration 0063).';

revoke execute on function public.claim_event_slot(jsonb) from public, anon;
grant  execute on function public.claim_event_slot(jsonb) to authenticated, service_role;

-- ── 4 · The constraint, in both directions ───────────────────
--
-- "An event with 0 media is approvable; a media-kind post with 0 media is still refused."
--
-- ── Why this is a trigger and not a CHECK ────────────────────
--
-- posts_approved_has_rights, its nearest relative, is a CHECK because licence and
-- provenance are columns on the row. "Has at least one media_assets row" is a fact about
-- another table, and a CHECK may not read one. So it is a trigger, and it is the only
-- mechanism available: §4 gives moderators a plain RLS UPDATE on posts, there is no
-- approve_post() RPC to put the rule inside, and a rule enforced only in admin.js is
-- enforced nowhere (§5 — the browser is hostile, and that includes admin.js).
--
-- ── DEFERRABLE but INITIALLY IMMEDIATE, and the difference matters ───
--
-- media_assets.post_id references posts, so the media rows CANNOT exist before the post
-- does. A plain immediate trigger would therefore make an approved post unbornable in a
-- single statement: every INSERT of an already-approved row would fail, whatever media the
-- same transaction is about to add. That forbids M5's bulk importer outright — ~300 seed
-- items land pre-approved, post and media together.
--
-- So the trigger is DEFERRABLE, and a transaction that genuinely needs to write a post and
-- its media together opts in with one explicit line:
--
--     set constraints public.posts_approved_has_media deferred;
--
-- It is INITIALLY IMMEDIATE rather than INITIALLY DEFERRED, which was the first draft and
-- was wrong in three ways that only appeared when the suite ran:
--
--   (a) it moved EVERY approval's error to commit time, including the moderation path,
--       which is a single-statement UPDATE against a post whose media already exists and
--       has no reason to defer anything;
--   (b) it left pending trigger events on `posts` for the rest of any transaction that
--       approved something — and `ALTER TABLE ... DISABLE TRIGGER` refuses a table with
--       those, 55006. 37_email_confirmation disables posts_require_confirmed_email to test
--       §4's policy term underneath it, and stopped being able to;
--   (c) a pgTAP file never commits, so a deferred-by-default trigger fires in one only if
--       the test asks it to — which means a test that forgot to ask would pass whether or
--       not the trigger existed at all.
--
-- Immediate by default fixes all three: the rule fires where the rule is broken, the
-- importer says so in one greppable line, and (c) stops being a trap the next author has to
-- know about. 40_event_without_media still drives both modes deliberately, because the
-- deferred path is a real behaviour and an untested one is a broken one.
--
-- ── What this does NOT bind, said plainly ────────────────────
--
-- It fires on the POST, so it catches an approval with no media. It does not fire on
-- media_assets, so deleting the last asset from an already-approved post in a LATER
-- transaction is not refused here. That is deliberate and not an oversight: §8's takedown
-- is the one path that removes an approved item's media in practice, and it removes the
-- BYTES while keeping the media_assets row as the permanent record of what was taken down
-- (request_takedown updates `takedown` and touches no media row). A trigger on
-- media_assets would be guarding a door nothing walks through, at the cost of standing in
-- front of one that recovery might need to.
create or replace function public.require_media_unless_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.media_assets m where m.post_id = new.id) then
    raise exception 'post_approved_without_media'
      using errcode = 'check_violation',
            hint = 'Only kind=''event'' may be approved with no media (CLAUDE.md §1; migration 0063).';
  end if;
  return null;
end;
$$;

comment on function public.require_media_unless_event() is
  'An approved post that is not an event must have at least one media asset (migration 0063).';

revoke all on function public.require_media_unless_event()
  from public, anon, authenticated, service_role;

drop trigger if exists posts_approved_has_media on public.posts;

-- ── `not new.takedown` is a §8 requirement, not a nicety ─────
--
-- request_takedown's whole effect on this table is `update public.posts set takedown = true`
-- — it does not change `status`, and it deliberately does not touch media_assets (the row
-- stays as the permanent record of what was removed). So a takedown UPDATE lands on a row
-- that is still `approved` and still not an event, and without this term the trigger would
-- evaluate on it.
--
-- For a post with media that is harmless. For one WITHOUT — a row that predates this
-- migration, since nothing can create one after it — the takedown would be REFUSED, and
-- §8's "takedown latency must never be bounded by the publish cycle" would have been
-- answered with something far worse than the publish cycle: a moderator unable to remove an
-- item at all, told only that it has no media. The one operation that must never be blocked
-- would have been blocked by a rule about what may be published.
--
-- And it is correct on its own terms: this constraint exists so that nothing PUBLIC is an
-- empty record, publishable_posts() excludes `takedown` already, and a taken-down post is
-- not public by any route. Requiring media of it asks for something the archive has just
-- finished deleting.
--
-- The WHEN clause is evaluated when the row changes, not at commit — so this queues a check
-- for exactly the rows that became an approved, live non-event, and costs nothing for every
-- other write. `kind <> 'event'` is the whole of the kind exception, which is why it reads
-- as the brief does: only an event may skip media.
create constraint trigger posts_approved_has_media
  after insert or update on public.posts
  deferrable initially immediate
  for each row
  when (new.status = 'approved' and new.kind <> 'event' and not new.takedown)
  execute function public.require_media_unless_event();

-- ── 5 · claim_upload_slot uses the same validator ────────────
--
-- The event-with-media path keeps working exactly as 0062 built it; what changes is that
-- its event fields are now parsed by the function above rather than by a second copy of the
-- same seventy lines. Two copies of a validator is the drift this codebase keeps naming,
-- and here it would be drift between the rules for an event WITH a poster and an event
-- WITHOUT one — a difference no contributor could predict and nothing would report.
--
-- This is 0062's text with one block replaced. Everything else — the ownership check, the
-- rights refusals, the decade bounds, M4's place resolution, M5's precision floor, the
-- quota charge and the INSERT — is unchanged, and 39_event_submission's 25 assertions are
-- what say so: they were written against 0062 and must pass against this without a single
-- edit. A test suite that had to be adjusted to accept a refactor would not be evidence
-- that the refactor was faithful.

create or replace function public.claim_upload_slot(
  p_bytes      bigint,
  p_object_key text,
  p_kind       public.post_kind,
  p_draft      jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_licenses constant text[] := array['CC-BY-SA-4.0', 'CC0-1.0', 'rights-reserved'];

  v_uid        uuid := (select auth.uid());
  v_quota      jsonb;
  v_post_id    uuid;
  v_title_ar   text := nullif(btrim(coalesce(p_draft ->> 'title_ar', '')), '');
  v_title_en   text := nullif(btrim(coalesce(p_draft ->> 'title_en', '')), '');
  v_body_ar    text := nullif(btrim(coalesce(p_draft ->> 'body_ar',  '')), '');
  v_body_en    text := nullif(btrim(coalesce(p_draft ->> 'body_en',  '')), '');
  v_license    text := nullif(btrim(coalesce(p_draft ->> 'license', '')), '');
  v_provenance text := nullif(btrim(coalesce(p_draft ->> 'provenance', '')), '');
  v_granted    boolean;

  -- Read from the ARGUMENT rather than from the draft: p_kind is what the INSERT uses, so a
  -- draft claiming to be one thing while the row is another could not open a gap here.
  v_is_event   boolean := (p_kind = 'event');

  -- 0063: the parsed event, or a refusal. One definition, shared with claim_event_slot.
  v_event      jsonb;
  v_details    jsonb := '{}'::jsonb;

  v_decade_raw text := nullif(btrim(coalesce(p_draft ->> 'decade', '')), '');
  v_decade     int  := case when v_decade_raw ~ '^[0-9]{4}$' then v_decade_raw::int end;
  v_earliest   date;
  v_latest     date;

  v_place_raw  text := nullif(btrim(coalesce(p_draft ->> 'place_id', '')), '');
  v_place_id   uuid;
  v_lat_raw    text := nullif(btrim(coalesce(p_draft ->> 'lat', '')), '');
  v_lon_raw    text := nullif(btrim(coalesce(p_draft ->> 'lon', '')), '');
  v_lat        double precision;
  v_lon        double precision;
  v_location   extensions.geography;
  v_precision  public.location_precision := 'hidden';
  v_prec_raw   text := nullif(btrim(coalesce(p_draft ->> 'location_precision', '')), '');
  v_prec_req   public.location_precision;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_object_key');
  end if;

  -- The key must sit under the caller's own id. A member who could name someone else's key
  -- would attach their draft to a stranger's upload, and complete_ingest would later hand
  -- them the derivatives.
  if p_object_key not like (v_uid::text || '/%') then
    return jsonb_build_object('allowed', false, 'reason', 'object_key_not_owned');
  end if;

  if v_title_ar is null and v_title_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'title_required');
  end if;
  if v_body_ar is null and v_body_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'description_required');
  end if;

  -- §7's three, in the order the sheet asks them. 0062: not asked of an event.
  if not v_is_event then
    if v_license is null then
      return jsonb_build_object('allowed', false, 'reason', 'license_required');
    end if;
  end if;
  if v_license is not null and not (v_license = any (c_licenses)) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_license',
                              'licenses', to_jsonb(c_licenses));
  end if;
  if not v_is_event and v_provenance is null then
    return jsonb_build_object('allowed', false, 'reason', 'provenance_required');
  end if;

  if not v_is_event then
    v_granted := (p_draft -> 'consent' -> 'granted') = 'true'::jsonb;
    if v_granted is not true then
      return jsonb_build_object('allowed', false, 'reason', 'consent_required');
    end if;
  end if;

  -- posts_event_columns_only_on_events cuts both ways, so these are refused on a photograph
  -- rather than ignored: a client sending a venue with an image has misunderstood
  -- something, and finding out is better than having it vanish.
  if not v_is_event and (nullif(btrim(coalesce(p_draft ->> 'event_starts_at', '')), '') is not null
                         or nullif(btrim(coalesce(p_draft ->> 'event_ends_at', '')), '') is not null
                         or nullif(btrim(coalesce(p_draft ->> 'venue_ar', '')), '') is not null
                         or nullif(btrim(coalesce(p_draft ->> 'venue_en', '')), '') is not null
                         or p_draft -> 'organizers' is not null) then
    return jsonb_build_object('allowed', false, 'reason', 'event_fields_on_non_event');
  end if;

  -- 0063. The event's own fields, through the one validator both submission paths use.
  if v_is_event then
    v_event := public.parse_event_fields(p_draft);
    if (v_event ->> 'ok')::boolean is not true then
      -- Whole, for the reason claim_event_slot gives at the same call.
      return (v_event - 'ok') || jsonb_build_object('allowed', false);
    end if;
    v_details := coalesce(v_event -> 'details', '{}'::jsonb);
  end if;

  -- §3's decade. Bounded, and REFUSED rather than clamped when out of range.
  if v_decade_raw is not null then
    if v_decade is null
       or v_decade % 10 <> 0
       or v_decade < 1900
       or v_decade > ((extract(year from now())::int / 10) * 10) then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_decade');
    end if;
    v_earliest := make_date(v_decade, 1, 1);
    v_latest   := make_date(v_decade + 9, 12, 31);
  end if;

  -- An event dates itself; an explicit decade still wins, for a listing about a historical
  -- event rather than an upcoming one.
  if v_is_event and v_earliest is null then
    v_earliest := (v_event ->> 'derived_earliest')::date;
    v_latest   := (v_event ->> 'derived_latest')::date;
  end if;

  -- ── M4's place, resolved here rather than trusted ──────────
  --
  -- An event never reaches this: parse_event_fields has already refused a draft carrying a
  -- coordinate, so v_place_raw / v_lat_raw / v_lon_raw are all null by the time it returns
  -- ok. The branch is left whole rather than guarded on v_is_event, because that refusal is
  -- the single place the rule lives.
  if v_place_raw is not null then
    if v_place_raw !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_place');
    end if;
    v_place_id := v_place_raw::uuid;

    select pl.location into v_location from public.places pl where pl.id = v_place_id;
    if not found then
      return jsonb_build_object('allowed', false, 'reason', 'unknown_place');
    end if;
    if v_location is not null then v_precision := 'exact'; end if;

  elsif v_lat_raw is not null or v_lon_raw is not null then
    if v_lat_raw is null or v_lon_raw is null
       or v_lat_raw !~ '^-?[0-9]{1,3}(\.[0-9]+)?$'
       or v_lon_raw !~ '^-?[0-9]{1,3}(\.[0-9]+)?$' then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_coordinates');
    end if;
    v_lat := v_lat_raw::double precision;
    v_lon := v_lon_raw::double precision;
    if v_lat < -90 or v_lat > 90 or v_lon < -180 or v_lon > 180 then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_coordinates');
    end if;
    v_location  := extensions.st_setsrid(
                     extensions.st_makepoint(v_lon, v_lat), 4326)::extensions.geography;
    v_precision := 'street';
  end if;

  -- ── §7's contributor control, floored by the source (M5) ───
  --
  -- One direction only: vaguer than the source justifies, never sharper. REFUSED rather
  -- than clamped — a member who believes they chose 'exact' has been misled about a privacy
  -- setting rather than protected by one.
  if v_prec_raw is not null then
    if v_prec_raw not in ('exact', 'street', 'area', 'hidden') then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_precision');
    end if;
    v_prec_req := v_prec_raw::public.location_precision;
    if v_prec_req < v_precision then
      return jsonb_build_object('allowed', false, 'reason', 'precision_too_precise');
    end if;
    v_precision := v_prec_req;
  end if;

  if exists (select 1 from public.posts p where p.ingest_object_key = p_object_key) then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_object_key');
  end if;

  v_quota := public.claim_upload_quota(p_bytes);
  if (v_quota ->> 'allowed')::boolean is not true then
    return v_quota;
  end if;

  -- No EXCEPTION block. See 0029's header: catching here would strand the charge above.
  insert into public.posts (
    kind, title_ar, title_en, body_ar, body_en,
    date_earliest, date_latest, date_precision,
    location, location_precision, location_source, place_id,
    event_starts_at, event_ends_at, venue_ar, venue_en, details,
    license, provenance, consent,
    created_by, ingest_object_key, ingest_state
  )
  values (
    p_kind, v_title_ar, v_title_en, v_body_ar, v_body_en,
    v_earliest, v_latest,
    case
      when v_earliest is null then null
      when v_is_event and v_decade_raw is null then 'day'::public.date_precision
      else 'decade'::public.date_precision
    end,
    v_location, v_precision,
    case when v_location is null then null else 'user'::public.location_source end,
    v_place_id,
    (v_event ->> 'event_starts_at')::timestamptz,
    (v_event ->> 'event_ends_at')::timestamptz,
    v_event ->> 'venue_ar', v_event ->> 'venue_en', v_details,
    v_license, v_provenance,
    case
      when v_is_event then '{}'::jsonb
      else jsonb_build_object(
             'granted', true,
             'granted_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'may_withdraw', true)
    end,
    v_uid, p_object_key, 'awaiting_bytes'
  )
  returning id into v_post_id;

  return v_quota || jsonb_build_object('post_id', v_post_id, 'object_key', p_object_key);
end;
$$;

comment on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb) is
  'Charges the daily quota and creates the draft post in one transaction, with §7 rights capture as a precondition for media and voice, an event''s own fields through the shared validator (0063), §3''s decade expanded into an EDTF-lite range, M4''s place resolved from the gazetteer and M5''s contributor precision floored by that place''s source (CLAUDE.md §2, §3, §6, §7).';
