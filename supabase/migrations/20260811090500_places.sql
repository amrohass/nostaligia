-- 0005 · places
--
-- The gazetteer. Place-name autocomplete resolves against this (M4); the bulk
-- importer seeds it (M5). `unconfirmed` is the yellow pin in the existing admin
-- gazetteer screen — a place we have a name for but no verified coordinates.

set search_path = public, extensions;

create table public.places (
  id           uuid primary key default gen_random_uuid(),

  name_ar      text,
  name_en      text,

  aliases      text[] not null default '{}',

  location     extensions.geography(Point, 4326),

  -- §2: "Geohash is a derived publish-time shard key ONLY." It is stored here as a
  -- convenience for the publisher's shard naming, never queried as truth. PostGIS
  -- above is the source of truth for anything spatial.
  geohash      text
                 constraint places_geohash_format
                 check (geohash is null or geohash ~ '^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$'),

  unconfirmed  boolean not null default false,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- A place with neither name is not a place.
  constraint places_has_a_name
    check (name_ar is not null or name_en is not null),

  -- Confirmed means we know where it is.
  constraint places_confirmed_has_location
    check (unconfirmed or location is not null)
);

create trigger places_touch_updated_at
  before update on public.places
  for each row execute function public.touch_updated_at();

comment on column public.places.geohash is
  'Derived publish-time shard key only (CLAUDE.md §2). Never the source of spatial truth.';

revoke all on public.places from anon, authenticated;
grant select on public.places to anon, authenticated;
-- Members do not create places directly; an unresolved place name arrives on the
-- post and a moderator promotes it into the gazetteer (M4).

alter table public.places enable row level security;
