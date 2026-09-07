-- 0062 · An event is not a photograph, and the form that asks for one must not pretend it is
--
-- Amro's decision, 7 Sep 2026, final: events get their own submission form and field set.
-- This deliberately does NOT split the posts table — D6 stands, and §3 is unchanged:
-- "Single `posts` table with a `kind` enum. Do not split by type — one feed, one moderation
-- queue, one comment model." Events keep publishing into the same shards and the same feed.
-- What changes is what a contributor is ASKED, and what the database therefore requires.
--
-- ── What was actually broken, measured before it was written ─
--
-- The share sheet has offered an "event" button since M3 and it could never have worked.
-- Probed against the deployed database, in a rolled-back transaction:
--
--   event insert, no start          REFUSED 23514 posts_event_needs_a_start
--   event approved, no rights       REFUSED 23514 posts_approved_has_rights
--   organizers in details           REFUSED 23514 posts_details_keys
--
-- claim_upload_slot never set event_starts_at, so the first of those is what a member got
-- for pressing "event": a raise inside a SECURITY DEFINER function, which reaches the
-- browser as a 500 with a Postgres error in it. The whole call rolls back, so no quota was
-- spent — that part of 0032's no-EXCEPTION-block design held — but the feature was dead
-- from the day the button appeared.
--
-- ── Why the rights fields do not apply to an event ───────────
--
-- §7 asks for provenance, licence and consent because a heritage photograph carries rights
-- somebody else may hold: "a contributor granting a license they do not hold is how
-- heritage archives acquire liability". A listing that says a concert happened at the
-- Cultural Palace on a date is not that. There is no orphan work to trace, no family to ask
-- and no licence for the archive to mis-hold.
--
-- So the requirement becomes CONDITIONAL rather than removed. posts_approved_has_rights
-- still binds every media and voice post exactly as it did; it exempts kind='event'.
-- Note what is NOT relaxed: an event may still CARRY a licence and provenance, and a
-- moderator submitting one on an institution's behalf can record both. It is no longer a
-- precondition of the event being approved.
--
-- Consent is a separate matter and is left alone at the column: `consent` is
-- `not null default '{}'`, so an event simply lands with the empty object the default
-- already provides. Nothing is asked, nothing is asserted on the contributor's behalf, and
-- 0022's shape check is satisfied. Stamping `granted: true` for somebody who was never
-- shown a consent box would be inventing a record of an agreement that did not happen,
-- which is the one thing a consent column must never contain.
--
-- ── The venue is text, and that is the point ─────────────────
--
-- §7's location machinery — the fuzzing trigger, location_public, the precision floor from
-- 0049 — exists because a coordinate on a personal photograph is most plausibly somebody's
-- home. A public event's venue is public by construction; it is the thing the poster was
-- advertising. venue_ar/venue_en are already free text on the table and are what an event
-- gets. There is no pin picker for an event and no coordinate is derived from one.
--
-- A coordinate sent WITH an event is REFUSED by name rather than dropped. This codebase's
-- own rule, from 0049: a value named in a call and silently discarded is worse than one
-- refused, because nobody finds out. If events ever want a map pin, that is a decision with
-- a migration, not a field that quietly started working.
--
-- ── organizers ──────────────────────────────────────────────
--
-- Into details, not a new column, and Amro named the reason: it matches the existing
-- pattern for kind-specific data and is the smallest change. It is added to 0022's key
-- allowlist, which is where "adding a key must be a migration, not an accident" is enforced.
--
-- It satisfies that allowlist's own standing rule — everything in `details` is safe for a
-- signed-in stranger to read, because 0015 grants the column to `authenticated`. An
-- organiser is an institution or a public billing on a poster, which is exactly the class
-- of fact that belongs there. It is NOT a contributor name and must never be used as one.

set search_path = public, extensions;

-- ── 1 · Rights bind media and voice, not events ──────────────

alter table public.posts drop constraint posts_approved_has_rights;

alter table public.posts
  add constraint posts_approved_has_rights
  check (
    status <> 'approved'
    or kind = 'event'
    or (license is not null and provenance is not null)
  );

comment on constraint posts_approved_has_rights on public.posts is
  'Nothing goes public without recorded provenance and a licence — except an event listing, which carries no third-party rights to hold (CLAUDE.md §7; migration 0062).';

-- ── 2 · organizers joins the details allowlist ───────────────

alter table public.posts drop constraint posts_details_keys;

alter table public.posts
  add constraint posts_details_keys
  check (public.jsonb_keys_allowed(details, array[
    'tags',            -- text[]  editorial tags
    'alt_ar',          -- text    accessibility description, Arabic
    'alt_en',          -- text    accessibility description, English
    'source_url',      -- text    public URL this was published at, if any
    'medium',          -- text    'photograph' | 'negative' | 'print' | 'born-digital'
    'condition',       -- text    physical condition of the original
    'transcript_ar',   -- text    voice note transcript
    'transcript_en',
    'organizers'       -- text[]  kind='event' — who put it on (0062)
  ]));

-- ── 3 · claim_upload_slot learns what an event is ────────────
--
-- Replaced whole rather than patched, because it is one function and a partial redefinition
-- is not a thing Postgres offers. Everything outside the event branches is 0056's text
-- unchanged; the diff worth reading is the v_is_event guard on the three rights refusals,
-- the event field parsing below it, and the two extra columns in the INSERT.

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
  -- The vocabulary a member may choose from. See 0032's header for why it is not a CHECK.
  c_licenses constant text[] := array['CC-BY-SA-4.0', 'CC0-1.0', 'rights-reserved'];

  -- An event's organiser list. Bounded here rather than left to posts_details_size, so a
  -- member gets a named refusal instead of a 23514 raised out of a definer function — the
  -- same reason every other limit in this function is pre-checked.
  c_max_organizers constant int := 20;
  c_max_organizer_len constant int := 200;

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

  -- 0062. The one branch in this function, and it is read from the ARGUMENT rather than
  -- from the draft: p_kind is what the INSERT uses, so a draft claiming to be one thing
  -- while the row is another could not open a gap here.
  v_is_event   boolean := (p_kind = 'event');

  v_start_raw  text := nullif(btrim(coalesce(p_draft ->> 'event_starts_at', '')), '');
  v_end_raw    text := nullif(btrim(coalesce(p_draft ->> 'event_ends_at', '')), '');
  v_start      timestamptz;
  v_end        timestamptz;
  v_venue_ar   text := nullif(btrim(coalesce(p_draft ->> 'venue_ar', '')), '');
  v_venue_en   text := nullif(btrim(coalesce(p_draft ->> 'venue_en', '')), '');
  v_org_raw    jsonb := p_draft -> 'organizers';
  v_organizers text[];
  v_details    jsonb := '{}'::jsonb;

  -- Parsed defensively rather than cast. The draft is a jsonb blob a browser composed, so
  -- `(p_draft ->> 'decade')::int` on the string "banana" raises inside a SECURITY DEFINER
  -- function and reaches the member as a 500 with a Postgres error in it. The regex first
  -- means a malformed value is simply not a number, and the check below names it.
  v_decade_raw text := nullif(btrim(coalesce(p_draft ->> 'decade', '')), '');
  v_decade     int  := case when v_decade_raw ~ '^[0-9]{4}$' then v_decade_raw::int end;
  v_earliest   date;
  v_latest     date;

  -- The place, by the same defensive rule: a uuid cast on attacker-controlled text raises,
  -- and a coordinate cast on "north" does too.
  v_place_raw  text := nullif(btrim(coalesce(p_draft ->> 'place_id', '')), '');
  v_place_id   uuid;
  v_lat_raw    text := nullif(btrim(coalesce(p_draft ->> 'lat', '')), '');
  v_lon_raw    text := nullif(btrim(coalesce(p_draft ->> 'lon', '')), '');
  v_lat        double precision;
  v_lon        double precision;
  v_location   extensions.geography;
  v_precision  public.location_precision := 'hidden';
  -- Read as TEXT and validated below, never cast straight from the draft: an unknown
  -- value cast to the enum inside a SECURITY DEFINER function raises, and the member gets
  -- a 500 instead of a refusal they can read. Same reason 0049 reads lat/lon as text.
  v_prec_raw   text := nullif(btrim(coalesce(p_draft ->> 'location_precision', '')), '');
  v_prec_req   public.location_precision;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  if p_object_key is null or btrim(p_object_key) = '' then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_object_key');
  end if;

  -- The key must sit under the caller's own id. request-upload builds it that way, but
  -- this function is granted to `authenticated` and is therefore directly callable: a
  -- member who could name someone else's key would attach their draft to a stranger's
  -- upload, and complete_ingest would later hand them the derivatives.
  if p_object_key not like (v_uid::text || '/%') then
    return jsonb_build_object('allowed', false, 'reason', 'object_key_not_owned');
  end if;

  -- §9 makes the description required archival metadata, and posts_has_a_title wants a
  -- title. Both are checked here so the caller gets a named refusal rather than a raw
  -- constraint violation — and, more importantly, before the quota is charged.
  --
  -- Both apply to an event too: its name is a title and its description is a description.
  if v_title_ar is null and v_title_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'title_required');
  end if;
  if v_body_ar is null and v_body_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'description_required');
  end if;

  -- §7's three, in the order the sheet asks them. Each gets its own reason because "your
  -- upload was refused" is not something a contributor can act on, and the one thing worse
  -- than asking someone for a licence is asking them for it twice.
  --
  -- 0062: not asked of an event. See the header — a listing that a concert happened
  -- carries no third-party rights for a contributor to grant or to mis-hold. A licence
  -- sent anyway is still validated against the allowlist rather than waved through: an
  -- unrecognised string in that column would mean nothing to M5's Dublin Core export
  -- whatever the kind of post it sits on.
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

  -- Anything that is not the boolean true is a refusal, including the string "true", a
  -- missing key, and a malformed consent object. A cast is deliberately avoided: the draft
  -- is attacker-controlled, and `'nonsense'::boolean` raises rather than returning false —
  -- which here would mean a 500 where a named refusal belongs.
  --
  -- 0062: an event is not asked, and therefore nothing is stamped for it. The column keeps
  -- its `{}` default. A `granted: true` written for somebody who was never shown a consent
  -- box would be a fabricated record of an agreement.
  if not v_is_event then
    v_granted := (p_draft -> 'consent' -> 'granted') = 'true'::jsonb;
    if v_granted is not true then
      return jsonb_build_object('allowed', false, 'reason', 'consent_required');
    end if;
  end if;

  -- ── 0062 · The event's own fields ──────────────────────────
  --
  -- posts_event_columns_only_on_events cuts both ways, so these are refused on a
  -- photograph rather than ignored: a client sending a venue with an image has
  -- misunderstood something, and finding out is better than having it vanish.
  if not v_is_event and (v_start_raw is not null or v_end_raw is not null
                         or v_venue_ar is not null or v_venue_en is not null
                         or v_org_raw is not null) then
    return jsonb_build_object('allowed', false, 'reason', 'event_fields_on_non_event');
  end if;

  if v_is_event then
    -- posts_event_needs_a_start, pre-checked. This is the constraint that made every
    -- event submission a 500 before this migration.
    if v_start_raw is null then
      return jsonb_build_object('allowed', false, 'reason', 'event_start_required');
    end if;

    /* A timestamp cannot be regex-validated into safety the way a decade can — '2026-13-45'
       matches every reasonable pattern and still raises on cast. So the cast is wrapped.
       A nested EXCEPTION block is a subtransaction, which 0029's header warns against
       AFTER the quota charge because it would strand the charge; here it is before it,
       nothing has been counted, and there is nothing to strand. */
    begin
      v_start := v_start_raw::timestamptz;
    exception when others then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_event_start');
    end;

    if v_end_raw is not null then
      begin
        v_end := v_end_raw::timestamptz;
      exception when others then
        return jsonb_build_object('allowed', false, 'reason', 'invalid_event_end');
      end;
      -- posts_event_range_ordered, pre-checked for the same reason as the start.
      if v_end < v_start then
        return jsonb_build_object('allowed', false, 'reason', 'event_ends_before_start');
      end if;
    end if;

    -- The venue is the event's location and it is free text. A coordinate sent with an
    -- event is refused rather than dropped — see the header.
    if v_place_raw is not null or v_lat_raw is not null or v_lon_raw is not null then
      return jsonb_build_object('allowed', false, 'reason', 'event_takes_no_coordinate');
    end if;

    if v_org_raw is not null then
      if jsonb_typeof(v_org_raw) <> 'array' then
        return jsonb_build_object('allowed', false, 'reason', 'invalid_organizers');
      end if;
      if jsonb_array_length(v_org_raw) > c_max_organizers then
        return jsonb_build_object('allowed', false, 'reason', 'too_many_organizers',
                                  'max', c_max_organizers);
      end if;
      -- Every element must be a non-empty string. `->>` on a nested object would
      -- stringify it into the array, which is how a jsonb blob ends up in a text[].
      if exists (
        select 1 from jsonb_array_elements(v_org_raw) e
         where jsonb_typeof(e.value) <> 'string'
            or btrim(e.value #>> '{}') = ''
            or length(e.value #>> '{}') > c_max_organizer_len
      ) then
        return jsonb_build_object('allowed', false, 'reason', 'invalid_organizers');
      end if;

      select array_agg(btrim(e.value #>> '{}') order by e.ordinality)
        into v_organizers
        from jsonb_array_elements(v_org_raw) with ordinality e;

      if v_organizers is not null and array_length(v_organizers, 1) > 0 then
        v_details := jsonb_build_object('organizers', to_jsonb(v_organizers));
      end if;
    end if;
  end if;

  -- §3's decade. Bounded, and REFUSED rather than clamped when it is out of range: 1900 is
  -- well before photography reached these albums and the upper bound is the current decade,
  -- so a value outside that is a client that is confused or hostile, and silently rewriting
  -- it to something plausible would file the item under a decade nobody chose.
  --
  -- Checked here, with the other refusals and before the quota charge, so a bad decade
  -- costs a member nothing.
  --
  -- An event may carry one: §1 puts events on the same grid, and the decade slider is how
  -- an archive of them is browsed. It is the event's own date that decides, below.
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

  /* An event dates itself. §3's `decade` is GENERATED from date_earliest and is what the
     slider filters on, so an event with a start and no decade would be invisible to it.
     The start date is a fact the contributor already gave; deriving from it asks them
     nothing twice. An explicit decade still wins, for a listing about a historical event
     rather than an upcoming one. */
  if v_is_event and v_earliest is null then
    v_earliest := (v_start at time zone 'UTC')::date;
    v_latest   := coalesce((v_end at time zone 'UTC')::date, v_earliest);
  end if;

  -- ── M4's place, resolved here rather than trusted ──────────
  --
  -- The gazetteer wins when both are present, and it is not a preference: a place id is a
  -- reference to a curated coordinate this function looks up, while lat/lon is whatever the
  -- client sent. Taking the pin over the id would let a caller name Al-Manara and file the
  -- item somewhere else entirely, with the queue showing the landmark's name against it.
  if v_place_raw is not null then
    -- The full uuid shape, not "36 characters of hex and hyphens": the loose form still
    -- admits strings the cast below rejects, and a failed cast inside a SECURITY DEFINER
    -- function reaches the member as a 500 rather than as a refusal they can read.
    if v_place_raw !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      return jsonb_build_object('allowed', false, 'reason', 'invalid_place');
    end if;
    v_place_id := v_place_raw::uuid;

    -- The coordinate comes from the ROW, never from the request. An unconfirmed place has
    -- none, which is legitimate: the item is filed under the name and carries no point,
    -- exactly as though no location had been given.
    select pl.location into v_location from public.places pl where pl.id = v_place_id;
    if not found then
      return jsonb_build_object('allowed', false, 'reason', 'unknown_place');
    end if;
    -- See the header: the gazetteer's own point is already published, so fuzzing it costs
    -- accuracy and buys nothing.
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
    -- §7. A pin is a coordinate nobody curated; block-level is where it starts.
    v_precision := 'street';
  end if;

  -- ── §7's contributor control, floored by the source (M5) ───
  --
  -- Until now the precision was decided ENTIRELY by where the coordinate came from and the
  -- contributor had no say. M5 gives them one, in a single direction: they may publish
  -- something VAGUER than the source justifies, never sharper.
  --
  -- The asymmetry is the whole point and it is §7's. A gazetteer point is already public
  -- in places.json, so 'exact' costs nobody anything; a dropped pin is a coordinate nobody
  -- curated and most plausibly a home. Letting a member relabel a pin as 'exact' would
  -- turn "fuzzing is default-on" into an opt-out, which is exactly what 0021 exists to
  -- prevent — and it would do it through a control that LOOKS like a privacy setting.
  --
  -- The comparison is the enum's own ordering, not a lookup table beside it. The type is
  -- declared most-precise-first — 'exact','street','area','hidden' — so "less precise"
  -- is simply GREATER, and a table that could drift from the type does not exist.
  --
  -- REFUSED rather than clamped, deliberately. Clamping would publish something other
  -- than what the member was shown, and a member who believes they chose 'exact' has been
  -- misled about a privacy setting rather than protected by one. A refusal they can read
  -- is the honest failure, and upload.js maps it to a sentence.
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

  -- Pre-checked rather than left to the unique index, for the same reason: a constraint
  -- violation here would abort after the charge.
  if exists (select 1 from public.posts p where p.ingest_object_key = p_object_key) then
    return jsonb_build_object('allowed', false, 'reason', 'duplicate_object_key');
  end if;

  -- The charge. Refusals are passed through untouched so the caller sees the same
  -- reasons and the same limit fields it would from claim_upload_quota directly.
  v_quota := public.claim_upload_quota(p_bytes);
  if (v_quota ->> 'allowed')::boolean is not true then
    return v_quota;
  end if;

  -- No EXCEPTION block. See 0029's header: catching here would strand the charge above.
  --
  -- location_public is deliberately absent: 0021's trigger derives it from the two columns
  -- below and revoked the ability to write it directly. Naming it here would be a value
  -- silently discarded.
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
    -- Null when there is no date, because posts_date_precision_needs_a_date says a
    -- precision without a date is not a thing. An event's range came from a start the
    -- contributor gave to the day, so it is 'day' rather than 'decade'.
    case
      when v_earliest is null then null
      when v_is_event and v_decade_raw is null then 'day'::public.date_precision
      else 'decade'::public.date_precision
    end,
    v_location, v_precision,
    -- Only when there is something to attribute. location_source on a post with no
    -- location would assert that a member chose a coordinate they never gave.
    case when v_location is null then null else 'user'::public.location_source end,
    v_place_id,
    v_start, v_end, v_venue_ar, v_venue_en, v_details,
    v_license, v_provenance,
    -- §7's stamp, and only where §7 asked the question. An event keeps the column's `{}`
    -- default rather than an affirmation nobody made.
    case
      when v_is_event then '{}'::jsonb
      else jsonb_build_object(
             'granted', true,
             -- Stamped, not accepted. See 0032's header.
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
  'Charges the daily quota and creates the draft post in one transaction, with §7 rights capture as a precondition for media and voice, an event''s own date/venue/organizers where kind=''event'' (0062), §3''s decade expanded into an EDTF-lite range, M4''s place resolved from the gazetteer and M5''s contributor precision floored by that place''s source (CLAUDE.md §2, §3, §6, §7).';
