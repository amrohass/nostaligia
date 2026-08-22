-- 0048 · The gazetteer becomes writable, and searchable through PostGIS
--
-- §10's M4: "place-name autocomplete → gazetteer resolution → drag-to-confirm pin fallback".
-- This is the database half of that sentence. 0005 created `places`, 0017 settled who may
-- write it ("the grants exist now so M4 has somewhere to land") and 0011 built the GiST and
-- GIN indexes. Nothing has ever read or written a row.
--
-- Four things land here:
--
--   places_search()   name and alias autocomplete
--   places_near()     what is close to a dropped pin — the resolution step
--   save_place()      create or correct an entry, as a moderator
--   places_write_audit  §4's trail, by trigger rather than by call site
--
-- ── Why RPCs and not PostgREST on the table ──────────────────
--
-- `location` is `geography(Point,4326)`. Through PostgREST a browser would read it as WKB
-- hex and write it as an EWKT string it had concatenated itself — coordinates formatted by
-- the client, into a spatial literal, in a text column cast at the boundary. That is a
-- string-assembly surface for no benefit, and it makes every caller responsible for the
-- SRID.
--
-- So the wire carries two numbers and this file owns the geometry. Both functions are
-- SECURITY INVOKER: 0017's policies still decide who may write (`is_moderator()`), 0015's
-- column grants still decide what, and a member calling save_place() is refused by the
-- policy rather than by a check written here. §5 keeps its single boundary.
--
-- ── §6's bidi strip, and why it still does not apply here ────
--
-- 0045 stripped the override and isolate controls from every column carrying text a USER
-- typed, and carved out `places` with a parenthetical — "(moderator-curated gazetteer, M4)"
-- — which deferred the question to this milestone. The answer is that the carve-out stands,
-- for the same reason content_blocks has one: 0017 admits only `is_moderator()` here, so the
-- attacker the strip defends against would be a moderator attacking their own archive, and
-- the trigger below records every write of theirs in two tables.
--
-- What changed in M4 and does NOT change the answer: these names are now published to every
-- visitor and drawn on the map. The exposure is wider; the author is the same. And the
-- contributor-facing path creates no rows here at all — the share sheet sends a place ID or
-- a pair of coordinates, never a name, so there is no route from an untrusted keyboard into
-- this table.
--
-- ── What is NOT stored ───────────────────────────────────────
--
-- `places.geohash` stays null and this file never writes it. §2: "Geohash is a derived
-- publish-time shard key ONLY", and 0021 made the same argument for location_public —
-- a stored derivation is a second copy that can disagree with the coordinates it claims to
-- describe. shards.ts derives every cell from the point at publish time and the column
-- remains what 0005's comment says it is: a convenience nobody queries as truth.

set search_path = public, extensions;

-- ── §4's target vocabulary gains a place ─────────────────────
--
-- moderation_actions.target_type is an enum and a gazetteer edit is a moderator action, so
-- without this the trail would have to be audit_log alone — and §4 says "moderation_actions
-- AND audit_log" in as many words.
--
-- Safe inside the migration's transaction because nothing here USES the new value: the
-- trigger body below is not executed until a row is written, long after this commits.
alter type public.moderation_target add value if not exists 'place';

-- ── The public shape of a place ──────────────────────────────
--
-- One definition, used by the audit snapshot, both search functions and (via 0050) the
-- published shard. Coordinates come out as numbers rather than WKT because every consumer
-- wants numbers, and st_astext round-trips through a locale-independent parser for nothing.
--
-- There is no §7 problem here and it is worth saying why, since every other projection in
-- this schema exists to withhold something: a gazetteer entry is a curated public landmark,
-- not a contribution. It names no person, carries no author and is not fuzzed. `location`
-- on a POST is the coordinate §7 protects; `location` on a PLACE is the map.
--
-- ── COLUMNS, not a row, and that is not a style choice ───────
--
-- The obvious signature is a whole `public.places` row — it is what post_content_hash and
-- post_audit_snapshot take, and it reads better at every call site. It is also wrong here,
-- and it is wrong invisibly until a browser role calls it:
--
--     permission denied for table places
--
-- A whole-row reference requires SELECT on EVERY column of the table, not on the columns
-- the function goes on to read. 0015 revoked table-level SELECT on `places` and re-granted
-- seven columns; created_at and updated_at are not among them, so the row reference is
-- refused for `authenticated` while each of the seven reads is allowed. The two functions
-- above get away with it because they are granted to service_role alone and called from
-- triggers, which run as the owner.
--
-- The same rule produced the M1 defect db.js records at length: `Prefer:
-- return=representation` with no `select=` is a SELECT of `*`, and the moderation queue
-- could not approve anything. This cost a CI run to rediscover from the other direction —
-- and it is why RETURNING in save_place below names its columns too.
create or replace function public.place_public(
  p_id          uuid,
  p_name_ar     text,
  p_name_en     text,
  p_aliases     text[],
  p_location    extensions.geography,
  p_unconfirmed boolean
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'id',          p_id,
    'name_ar',     p_name_ar,
    'name_en',     p_name_en,
    'aliases',     to_jsonb(coalesce(p_aliases, '{}'::text[])),
    'lat',         case when p_location is null then null
                        else extensions.st_y(p_location::extensions.geometry) end,
    'lon',         case when p_location is null then null
                        else extensions.st_x(p_location::extensions.geometry) end,
    'unconfirmed', p_unconfirmed
  );
$$;

comment on function public.place_public(uuid, text, text, text[], extensions.geography, boolean) is
  'A gazetteer entry as everything outside the table sees it. Takes columns, not a row — see the header.';

-- ── §4's trail ───────────────────────────────────────────────
--
-- Attached to the table for the reason 0012's header gives for posts_write_audit: "no
-- privileged action may bypass this" can only mean a trigger. A service-role importer
-- seeding the gazetteer in M5 writes audit rows without knowing this exists.
--
-- SECURITY DEFINER because no browser role holds INSERT on either governance table — 0010
-- revokes all and grants SELECT only.
create or replace function public.places_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action text;
  v_before jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'place.create';
    v_before := null;
  else
    v_before := public.place_public(old.id, old.name_ar, old.name_en, old.aliases,
                                    old.location, old.unconfirmed);
    -- Confirming a place is the decision worth being able to query for on its own: it is
    -- the moment a name someone typed becomes a coordinate the map draws.
    v_action := case
      when old.unconfirmed and not new.unconfirmed then 'place.confirm'
      else 'place.edit'
    end;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (auth.uid(), v_action, 'place', new.id, v_before,
          public.place_public(new.id, new.name_ar, new.name_en, new.aliases,
                              new.location, new.unconfirmed));

  insert into public.moderation_actions (actor, action, target_type, target_id)
  values (auth.uid(), v_action, 'place', new.id);

  return null;
end;
$$;

comment on function public.places_write_audit() is
  'CLAUDE.md §4 — every gazetteer write is recorded in both tables, by trigger.';

create trigger places_write_audit
  after insert or update on public.places
  for each row execute function public.places_write_audit();

-- ── Autocomplete ─────────────────────────────────────────────
--
-- §10 asks for "place-name autocomplete → gazetteer resolution". This is the first arrow:
-- a contributor types, and the gazetteer answers with entries it already holds so the
-- archive accumulates one spelling of Al-Manara rather than nine.
--
-- ── The match, and why it is this and not full-text search ───
--
-- Substring, case-insensitive, over name_ar, name_en and every alias. Not to_tsvector:
-- Postgres ships no Arabic text-search configuration, so `to_tsvector('simple', …)` would
-- match on whitespace-separated tokens with no stemming and no normalisation — which for
-- Arabic is worse than a substring match, because the definite article ال fuses to the noun
-- and "المنارة" would then never match a search for "منارة". A substring match finds it.
--
-- What a substring match does NOT do is normalise Arabic orthography: أ/إ/ا and ة/ه and
-- ى/ي are distinct characters and a contributor typing one will not match an entry spelling
-- the other. That is a real limit, it is why `aliases` exists, and the moderator's answer is
-- to add the variant spelling as an alias rather than to widen the matcher.
--
-- ── PostGIS, when there is a point to measure from ───────────
--
-- With a pin, results are ordered by distance from it: the whole reason a contributor drops
-- a pin and then types is that they are looking for what is THERE. The `<->` operator is the
-- KNN one and it uses places_location_gix; the fallback ordering is name, so a search
-- without a pin is deterministic rather than whatever the heap returns.
--
-- The operator is written OPERATOR(extensions.<->) and it HAS to be. Every function here
-- pins `set search_path = ''` — the escalation rule 00_structure asserts — PostGIS lives in
-- `extensions`, and an unqualified OPERATOR resolves through the search path exactly like an
-- unqualified function name. The bare form does not parse:
--
--     operator does not exist: extensions.geography <-> extensions.geography
--
-- and because these two are `language sql`, the body is validated at CREATE time, so the
-- migration itself fails rather than the first call. Qualifying a function call is the
-- familiar half of that rule; an operator looks like syntax rather than like a name, which
-- is why this half took a CI run to find.
--
-- Unconfirmed entries sort last in both orderings. They are offered — a place we have a
-- name for and no coordinate is still the right label — but they are never the first answer.
--
-- ── An empty term is the whole gazetteer ─────────────────────
--
-- The dashboard's places screen and the share sheet's autocomplete are the same question
-- with and without a filter, so they are the same function rather than a second one that
-- would have its own grant, its own row shape and its own way of drifting. The sheet does
-- not call it under two characters; the dashboard calls it with no term and a high limit.
--
-- p_limit is capped at 200, which is a size bound rather than a permission: 0017 already
-- grants every signed-in user SELECT on this table, so the cap stops a careless caller from
-- pulling a whole gazetteer into an autocomplete list, not from seeing it.
create or replace function public.places_search(
  p_q     text,
  p_lat   double precision default null,
  p_lon   double precision default null,
  p_limit int default 8
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with q as (
    select nullif(btrim(coalesce(p_q, '')), '') as term,
           case when p_lat is null or p_lon is null then null
                else extensions.st_setsrid(
                       extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography
           end as origin,
           least(greatest(coalesce(p_limit, 8), 1), 200) as lim
  ),
  -- The ordering is INSIDE the limit and repeated outside it. A LIMIT applied to an
  -- unordered set takes an arbitrary N and sorting those afterwards produces a neatly
  -- ordered list of the wrong eight places.
  ranked as (
    select public.place_public(pl.id, pl.name_ar, pl.name_en, pl.aliases,
                              pl.location, pl.unconfirmed) as hit,
           pl.unconfirmed                   as un,
           case when q.origin is null or pl.location is null then null
                else pl.location OPERATOR(extensions.<->) q.origin end as dist,
           coalesce(pl.name_ar, pl.name_en) as nm
    from public.places pl, q
    where q.term is null
       or pl.name_ar ilike '%' || q.term || '%'
       or pl.name_en ilike '%' || q.term || '%'
       or exists (select 1 from unnest(pl.aliases) a where a ilike '%' || q.term || '%')
    order by un, dist nulls last, nm
    limit (select lim from q)
  )
  select coalesce(jsonb_agg(hit order by un, dist nulls last, nm), '[]'::jsonb) from ranked;
$$;

comment on function public.places_search(text, double precision, double precision, int) is
  'Name and alias autocomplete over the gazetteer, ordered by distance from a pin when there is one (CLAUDE.md §10 M4).';

-- ── Resolution, from a pin ───────────────────────────────────
--
-- The second arrow in "gazetteer resolution → drag-to-confirm pin fallback", and it runs
-- the other way: somebody has dropped a pin, and before the archive accepts a bare
-- coordinate it offers the named places already within reach of it. A contributor who meant
-- Al-Manara and dropped a pin thirty metres off should end up attached to Al-Manara, not
-- filed at a coordinate that is nearly it.
--
-- ST_DWithin on geography, so the radius is metres on the spheroid rather than degrees —
-- and it is the form that uses the GiST index, unlike a bare ST_Distance in a WHERE clause.
-- Unconfirmed places are excluded here, because this list is specifically "what is at this
-- coordinate" and an entry with no coordinate cannot answer that.
create or replace function public.places_near(
  p_lat      double precision,
  p_lon      double precision,
  p_radius_m double precision default 400,
  p_limit    int default 6
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with q as (
    select extensions.st_setsrid(
             extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography as origin,
           least(greatest(coalesce(p_radius_m, 400), 1), 5000) as radius,
           least(greatest(coalesce(p_limit, 6), 1), 25)        as lim
  ),
  ranked as (
    select public.place_public(pl.id, pl.name_ar, pl.name_en, pl.aliases,
                              pl.location, pl.unconfirmed)
             || jsonb_build_object(
                  'distance_m',
                  round((pl.location OPERATOR(extensions.<->) q.origin)::numeric, 1)) as hit,
           pl.location OPERATOR(extensions.<->) q.origin                  as dist
    from public.places pl, q
    where p_lat is not null and p_lon is not null
      and pl.location is not null
      and not pl.unconfirmed
      and extensions.st_dwithin(pl.location, q.origin, q.radius)
    -- Ordered before the limit, for the reason places_search states: nearest six, not six
    -- of the ones within reach.
    order by dist
    limit (select lim from q)
  )
  select coalesce(jsonb_agg(hit order by dist), '[]'::jsonb) from ranked;
$$;

comment on function public.places_near(double precision, double precision, double precision, int) is
  'Named places within a radius of a dropped pin — the resolution step before a bare coordinate is accepted (CLAUDE.md §10 M4).';

-- ── Writing one ──────────────────────────────────────────────
--
-- Create when p_id is null, correct when it is not. One function rather than two because
-- the validation is identical and the dashboard's form is the same form either way.
--
-- SECURITY INVOKER, so this is NOT a boundary: 0017's places_insert and places_update
-- policies refuse a member here exactly as they would refuse a direct INSERT, and the
-- refusal is a policy violation rather than a message this function composed. What the
-- function owns is the geometry and the shape of a refusal a moderator can act on.
create or replace function public.save_place(
  p_id          uuid default null,
  p_name_ar     text default null,
  p_name_en     text default null,
  p_aliases     text[] default '{}',
  p_lat         double precision default null,
  p_lon         double precision default null,
  p_unconfirmed boolean default false
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_name_ar  text := nullif(btrim(coalesce(p_name_ar, '')), '');
  v_name_en  text := nullif(btrim(coalesce(p_name_en, '')), '');
  v_aliases  text[];
  v_location extensions.geography;

  -- Named columns rather than a `public.places` row, for the reason place_public's header
  -- gives: RETURNING * is a SELECT of every column, and 0015 grants seven of nine.
  v_id           uuid;
  v_out_name_ar  text;
  v_out_name_en  text;
  v_out_aliases  text[];
  v_out_location extensions.geography;
  v_out_unconf   boolean;
begin
  if v_name_ar is null and v_name_en is null then
    return jsonb_build_object('saved', false, 'reason', 'name_required');
  end if;

  -- Blank entries dropped rather than stored: an alias of '' matches every ILIKE search.
  select coalesce(array_agg(a), '{}')
    into v_aliases
    from unnest(coalesce(p_aliases, '{}'::text[])) a
   where nullif(btrim(a), '') is not null;

  if p_lat is not null or p_lon is not null then
    if p_lat is null or p_lon is null then
      return jsonb_build_object('saved', false, 'reason', 'incomplete_coordinates');
    end if;
    -- Bounded rather than left to PostGIS, which accepts a latitude of 1000 on a geography
    -- and only surprises you later, in a distance calculation nobody is looking at.
    if p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
      return jsonb_build_object('saved', false, 'reason', 'coordinates_out_of_range');
    end if;
    v_location := extensions.st_setsrid(
                    extensions.st_makepoint(p_lon, p_lat), 4326)::extensions.geography;
  end if;

  -- places_confirmed_has_location says a confirmed place knows where it is. Checked here so
  -- the caller gets a named reason instead of a constraint name.
  if not p_unconfirmed and v_location is null then
    return jsonb_build_object('saved', false, 'reason', 'confirmed_needs_location');
  end if;

  if p_id is null then
    insert into public.places (name_ar, name_en, aliases, location, unconfirmed)
    values (v_name_ar, v_name_en, v_aliases, v_location, p_unconfirmed)
    returning id, name_ar, name_en, aliases, location, unconfirmed
         into v_id, v_out_name_ar, v_out_name_en, v_out_aliases, v_out_location, v_out_unconf;
  else
    update public.places
       set name_ar     = v_name_ar,
           name_en     = v_name_en,
           aliases     = v_aliases,
           location    = v_location,
           unconfirmed = p_unconfirmed
     where id = p_id
    returning id, name_ar, name_en, aliases, location, unconfirmed
         into v_id, v_out_name_ar, v_out_name_en, v_out_aliases, v_out_location, v_out_unconf;

    -- Zero rows is what an RLS refusal looks like on an UPDATE, and it is also what a
    -- deleted id looks like. Named as one thing because the caller cannot act differently
    -- on the two, and because guessing which it was would mean telling a member whether a
    -- given id exists.
    if v_id is null then
      return jsonb_build_object('saved', false, 'reason', 'not_found_or_refused');
    end if;
  end if;

  return jsonb_build_object('saved', true, 'place',
    public.place_public(v_id, v_out_name_ar, v_out_name_en, v_out_aliases,
                        v_out_location, v_out_unconf));
end;
$$;

comment on function public.save_place(uuid, text, text, text[], double precision, double precision, boolean) is
  'Create or correct a gazetteer entry. SECURITY INVOKER — 0017''s policies decide who (CLAUDE.md §4, §5).';

-- ── Grants ───────────────────────────────────────────────────
--
-- All three to `authenticated`, and that is deliberate for the two read functions: a
-- contributor filling in the share sheet needs autocomplete, and 0017's places_select
-- already grants every signed-in user SELECT on the whole table. These read no more than
-- that.
--
-- `anon` gets nothing, including on the read functions. §2: "zero database reads for public
-- visitors" — a signed-out visitor sees place names in the published shard (0050) and never
-- through a query.
-- place_public is granted to `authenticated` and that is a requirement, not a widening:
-- places_search, places_near and save_place are all SECURITY INVOKER, so they run with the
-- CALLER's rights and a caller without EXECUTE on this would be refused inside a function
-- it was granted. It returns the columns 0015 already grants every signed-in user SELECT on,
-- from a row the caller had to have in hand to pass it.
revoke execute on function public.place_public(uuid, text, text, text[], extensions.geography, boolean)
  from public, anon;
grant  execute on function public.place_public(uuid, text, text, text[], extensions.geography, boolean)
  to authenticated, service_role;

revoke execute on function public.places_search(text, double precision, double precision, int)
  from public, anon;
grant  execute on function public.places_search(text, double precision, double precision, int)
  to authenticated, service_role;

revoke execute on function public.places_near(double precision, double precision, double precision, int)
  from public, anon;
grant  execute on function public.places_near(double precision, double precision, double precision, int)
  to authenticated, service_role;

revoke execute on function public.save_place(uuid, text, text, text[], double precision, double precision, boolean)
  from public, anon;
grant  execute on function public.save_place(uuid, text, text, text[], double precision, double precision, boolean)
  to authenticated, service_role;
