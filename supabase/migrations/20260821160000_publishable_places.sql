-- 0050 · The gazetteer reaches the map without a query
--
-- §2: "Zero database reads for public visitors." M4's basemap is PMTiles vector geometry —
-- coastline, water, roads, buildings — and it is rendered without labels ON PURPOSE. Every
-- name the map draws comes from here instead, which is the only way an Arabic-first archive
-- gets an Arabic-first map: a basemap extract carries whatever names its renderer chose,
-- while this carries what a moderator typed, in both languages, editable in the dashboard
-- like every other string in §9's "all content comes from the store".
--
-- So one more shard. The publisher calls this, shards.ts writes places.json into the
-- release, and it is immutable with the release like everything else under /v/.
--
-- ── What is published, and what is withheld ──────────────────
--
-- Confirmed entries that have a point. An unconfirmed place is "a name we have and no
-- verified coordinates" (0005) — there is nowhere to draw it, and shipping it would put a
-- label at a coordinate nobody has checked, which on a map about a contested city is a claim
-- rather than a gap.
--
-- Nothing is withheld for §7 reasons and 0048's header says why: a gazetteer entry is a
-- curated public landmark, with no author, no contributor and no fuzzing. This is the one
-- projection in the schema that is not narrower than its table. It is still an allowlist,
-- built field by field, for the reason shards.ts gives: the column somebody adds in a future
-- migration must appear nowhere until someone decides it should.
--
-- ── Size ─────────────────────────────────────────────────────
--
-- Unbounded by design and small in fact: a gazetteer for one city is tens to low hundreds of
-- rows, and each is under 200 bytes. It is not in §9's first-load budget — map.js and this
-- shard are both fetched on /map and nowhere else. If the gazetteer ever grows past a
-- thousand entries the answer is the same one the geo shards already use: split it by cell.

set search_path = public, extensions;

create or replace function public.publishable_places()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- Ordered by name and then by id. The sort keys are columns of the subquery rather than
  -- fields of the published object, so they order the shard without appearing in it — and
  -- the id tiebreak is what makes two places sharing a name produce the same bytes on every
  -- rebuild, which is the determinism rule shards.ts states at length.
  select coalesce(jsonb_agg(item order by nm, id), '[]'::jsonb)
  from (
    select jsonb_build_object(
             'id',      pl.id,
             'name_ar', pl.name_ar,
             'name_en', pl.name_en,
             'lat',     extensions.st_y(pl.location::extensions.geometry),
             'lon',     extensions.st_x(pl.location::extensions.geometry)
           )                                as item,
           coalesce(pl.name_ar, pl.name_en) as nm,
           pl.id                            as id
    from public.places pl
    where pl.unconfirmed = false
      and pl.location is not null
  ) rows;
$$;

comment on function public.publishable_places() is
  'Confirmed gazetteer entries, for the labels M4''s basemap deliberately does not carry (CLAUDE.md §2, §9).';

-- Same reasoning as publishable_posts (0035): nothing here is secret, and it is still not a
-- browser endpoint. §2's read path is the shard; the publisher runs with the service key.
revoke execute on function public.publishable_places() from public, anon, authenticated;
grant  execute on function public.publishable_places() to service_role;
