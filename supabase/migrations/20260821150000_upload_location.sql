-- 0049 · Where a contribution happened stops being unanswerable
--
-- §10's M4 asks for "place-name autocomplete → gazetteer resolution → drag-to-confirm pin
-- fallback". 0048 built the gazetteer side of that. This is the other end: the answer the
-- contributor gives has somewhere to land.
--
-- Until now nothing in the system ever wrote posts.location. The column has existed since
-- 0006, 0021 derives location_public from it by trigger, 0035 publishes the fuzzed result
-- and shards.ts files it into a geo cell — an entire pipeline over a column that was null
-- on every row a member ever created. `/map` could only ever have been empty.
--
-- ── The precision follows the SOURCE of the coordinate ───────
--
-- This is the one real decision in the file, and it is not M5's to make even though M5 owns
-- the contributor-facing precision CONTROL. A row has to be inserted with some precision
-- today, and the column default is 'hidden', which publishes nothing.
--
--   a gazetteer place  → 'exact'
--   a dropped pin      → 'street'
--
-- Not symmetry for its own sake. A gazetteer coordinate is ALREADY PUBLIC: 0050 publishes
-- every confirmed place, with its point, into the release the map reads. Snapping it to a
-- 0.001° grid would protect nobody — the unfuzzed point is in the next file down — while
-- moving the item ~50 m off the landmark it is a photograph of. 0021's header makes exactly
-- this argument for Al-Manara Square, and it adds the condition this satisfies: "'exact'
-- must be chosen". Picking a named place out of a curated list IS the choice; the default
-- for saying nothing is still 'hidden'.
--
-- A dropped pin is the opposite case. It is a coordinate the contributor placed themselves,
-- nobody has curated it, and the thing it most plausibly is — for a photograph of a family
-- indoors — is where somebody lived. 'street' snaps it to roughly a city block (0021), which
-- is what §7 means by fuzzing being default-on for anything domestic.
--
-- Both remain editable: a moderator can change either through set_post_location below, and
-- M5's control gives the contributor the same choice at upload time. What this file settles
-- is only what happens before anyone has said otherwise.
--
-- ── THE BODY BELOW IS 0047's ─────────────────────────────────
--
-- Fourth definition of claim_upload_slot. 0029 created it, 0032 added §7's rights capture,
-- 0047 added §3's decade, and this adds the place. Same warning as 0047's header, which was
-- written after making exactly this mistake: CREATE OR REPLACE takes whatever text it is
-- given, so rebuilding from an earlier version silently reverts everything added since.
-- Copied from 0047 and altered in three places — the declared variables, one resolution
-- block, and four columns in the INSERT.

set search_path = public, extensions;

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
  if v_title_ar is null and v_title_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'title_required');
  end if;
  if v_body_ar is null and v_body_en is null then
    return jsonb_build_object('allowed', false, 'reason', 'description_required');
  end if;

  -- §7's three, in the order the sheet asks them. Each gets its own reason because "your
  -- upload was refused" is not something a contributor can act on, and the one thing worse
  -- than asking someone for a licence is asking them for it twice.
  if v_license is null then
    return jsonb_build_object('allowed', false, 'reason', 'license_required');
  end if;
  if not (v_license = any (c_licenses)) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_license',
                              'licenses', to_jsonb(c_licenses));
  end if;
  if v_provenance is null then
    return jsonb_build_object('allowed', false, 'reason', 'provenance_required');
  end if;

  -- Anything that is not the boolean true is a refusal, including the string "true", a
  -- missing key, and a malformed consent object. A cast is deliberately avoided: the draft
  -- is attacker-controlled, and `'nonsense'::boolean` raises rather than returning false —
  -- which here would mean a 500 where a named refusal belongs.
  v_granted := (p_draft -> 'consent' -> 'granted') = 'true'::jsonb;
  if v_granted is not true then
    return jsonb_build_object('allowed', false, 'reason', 'consent_required');
  end if;

  -- §3's decade. Bounded, and REFUSED rather than clamped when it is out of range: 1900 is
  -- well before photography reached these albums and the upper bound is the current decade,
  -- so a value outside that is a client that is confused or hostile, and silently rewriting
  -- it to something plausible would file the item under a decade nobody chose.
  --
  -- Checked here, with the other refusals and before the quota charge, so a bad decade
  -- costs a member nothing.
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
    license, provenance, consent,
    created_by, ingest_object_key, ingest_state
  )
  values (
    p_kind, v_title_ar, v_title_en, v_body_ar, v_body_en,
    v_earliest, v_latest,
    -- Null when there is no date, because posts_date_precision_needs_a_date says a
    -- precision without a date is not a thing.
    case when v_earliest is null then null else 'decade'::public.date_precision end,
    v_location, v_precision,
    -- Only when there is something to attribute. location_source on a post with no
    -- location would assert that a member chose a coordinate they never gave.
    case when v_location is null then null else 'user'::public.location_source end,
    v_place_id,
    v_license, v_provenance,
    jsonb_build_object(
      'granted', true,
      -- Stamped, not accepted. See 0032's header.
      'granted_at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'may_withdraw', true
    ),
    v_uid, p_object_key, 'awaiting_bytes'
  )
  returning id into v_post_id;

  return v_quota || jsonb_build_object('post_id', v_post_id, 'object_key', p_object_key);
end;
$$;

comment on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb) is
  'Charges the daily quota and creates the draft post in one transaction, with §7 rights capture as a precondition, §3''s decade expanded into an EDTF-lite range and M4''s place resolved from the gazetteer (CLAUDE.md §2, §3, §6, §7).';

-- Restated in full. CREATE OR REPLACE keeps the existing grants, but 22_rpc_ownership exists
-- because assuming that is how a function ends up executable by PUBLIC.
revoke execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  from public, anon;
grant execute on function public.claim_upload_slot(bigint, text, public.post_kind, jsonb)
  to authenticated, service_role;

-- ── Correcting one, as a moderator ───────────────────────────
--
-- R1 (carried from M0, done in M1) makes the queue flag every submission whose precision is
-- 'exact', "so publishing a precise coordinate is reviewed as a decision rather than
-- accepted as a default". A flag with no control beside it is only half of that: until now
-- a moderator who saw a wrong pin could reject the item and nothing else.
--
-- SECURITY INVOKER, so this grants nobody anything. 0018's posts_update policy decides who
-- may write the row and 0015's column grants decide which columns — both already permit
-- exactly this, through PostgREST, for a moderator. What the function adds is the geometry
-- (see 0048's header) and one place where the three location columns move together, because
-- a post with a place_id and a stale coordinate is the state that reads as correct in the
-- queue and is wrong on the map.
--
-- ── A member can reach this, and it grants them nothing ──────
--
-- 0018's posts_update policy admits the AUTHOR of a pending post as well as a moderator,
-- so a member can call this on their own submission — including with an explicit
-- p_precision. That is not a hole this function opens: 0015 already grants `authenticated`
-- UPDATE on location, location_precision, location_source and place_id, so the same member
-- can write the same columns through PostgREST directly. §5 again — the boundary is the
-- policy and the column grants, and this is a convenience over them rather than beside them.
--
-- What it means in practice is that a member may set 'exact' on their own item before a
-- moderator sees it. R1's flag is the control for exactly that, and it fires on the value
-- rather than on who set it.
--
-- ── This can un-approve the post, and that is the point ──────
--
-- location, location_precision, place_id and location_public are all in 0012's content hash,
-- so an edit to an approved post fires posts_enforce_approval and sends it back to 'pending'
-- with its approval erased. That is §5 working, not a side effect to route around: whoever
-- approves must have seen the final content, and a coordinate is content. The caller is told
-- which happened so the dashboard can say so rather than leaving an item to quietly reappear
-- in the queue.
create or replace function public.set_post_location(
  p_post_id   uuid,
  p_place_id  uuid default null,
  p_lat       double precision default null,
  p_lon       double precision default null,
  p_precision public.location_precision default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_location  extensions.geography;
  v_precision public.location_precision;
  v_status    public.post_status;
begin
  if p_post_id is null then
    return jsonb_build_object('saved', false, 'reason', 'post_required');
  end if;

  if p_place_id is not null then
    select pl.location into v_location from public.places pl where pl.id = p_place_id;
    if not found then
      return jsonb_build_object('saved', false, 'reason', 'unknown_place');
    end if;
    -- Both branches cast, and they have to be. A CASE whose arms are bare quoted literals
    -- resolves to `text` before COALESCE ever sees it, so the expression becomes
    -- coalesce(location_precision, text) and the function fails to PARSE:
    --
    --     COALESCE types public.location_precision and text cannot be matched
    --
    -- plpgsql defers that to first execution rather than to CREATE, so the migration
    -- applies cleanly and the error arrives on the first call. A single unknown literal
    -- beside an enum is fine — it is coerced from the other operand, which is why the
    -- 'street' line below needs no help and this one did.
    v_precision := coalesce(
      p_precision,
      case when v_location is null then 'hidden'::public.location_precision
           else 'exact'::public.location_precision end);
  elsif p_lat is not null or p_lon is not null then
    if p_lat is null or p_lon is null
       or p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
      return jsonb_build_object('saved', false, 'reason', 'invalid_coordinates');
    end if;
    v_location  := extensions.st_setsrid(
                     extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography;
    v_precision := coalesce(p_precision, 'street');
  else
    -- Clearing it. The item stops being on the map, which is the correct answer for a pin
    -- that should never have been public and the reason this branch exists at all.
    v_precision := 'hidden';
  end if;

  update public.posts
     set location           = v_location,
         location_precision = v_precision,
         -- Derived from WHO is calling, not from the fact that an RPC was used. 0018 lets a
         -- member update their own pending post, so this function is reachable by one — and
         -- recording their correction as 'admin' would put a false attribution in a column
         -- whose only job is attribution.
         location_source    = case
                                when v_location is null then null
                                when public.is_moderator() then 'admin'::public.location_source
                                else 'user'::public.location_source
                              end,
         place_id           = p_place_id
   where id = p_post_id
  returning status into v_status;

  if v_status is null then
    return jsonb_build_object('saved', false, 'reason', 'not_found_or_refused');
  end if;

  return jsonb_build_object(
    'saved', true,
    -- After the trigger, so this is what the row IS rather than what was asked for.
    'status', v_status,
    'precision', v_precision);
end;
$$;

comment on function public.set_post_location(uuid, uuid, double precision, double precision, public.location_precision) is
  'A moderator corrects an item''s place or pin. SECURITY INVOKER — 0018 decides who, and 0012 may return the post to the queue (CLAUDE.md §5, R1).';

revoke execute on function public.set_post_location(uuid, uuid, double precision, double precision, public.location_precision)
  from public, anon;
grant  execute on function public.set_post_location(uuid, uuid, double precision, double precision, public.location_precision)
  to authenticated, service_role;
