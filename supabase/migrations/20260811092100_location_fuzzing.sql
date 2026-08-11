-- 0021 · Location fuzzing, derived in the database
--
-- Promoted into M0 from the weakness list. Until now §7's central location guarantee
-- — "Publish location_public, NEVER location" — was a convention: location_public was
-- an ordinary client-writable column, and nothing derived it from anything. A client
-- could write the exact point straight into the column meant to protect it, and every
-- column privilege in 0015 would wave it through, because the value was in the right
-- column with the right type.
--
-- Now location_public is DERIVED, always, for every writer including the service role
-- and the M5 bulk importer. A client-supplied value is silently discarded rather than
-- rejected: an importer that has been setting it for months should quietly start
-- getting correct output, not start failing.

set search_path = public, extensions;

-- ── The fuzzing function ─────────────────────────────────────
--
-- Grid snapping, not random jitter. That choice matters:
--
--   Random jitter re-rolled on each write leaks the true point to anyone who can
--   observe several versions of the same row — average the samples and the noise
--   cancels. Deterministic jitter avoids that but is reversible by anyone who knows
--   the algorithm, and the algorithm is in this file.
--
--   Snapping DESTROYS information. Every point inside a cell maps to the same output
--   and there is no residue to average, no secret to leak, and nothing to reverse.
--   The cost is that the output is a lattice point rather than a plausible-looking
--   address, which is honest: it reads as "somewhere around here", which is what it
--   means.
--
-- The grid is in degrees on SRID 4326. At Ramallah's latitude (~31.9°N) one degree
-- of latitude is ~111 km and one of longitude ~94 km (111 × cos 31.9°), so the
-- resulting cells are:
--
--   street  0.001°   ~111 m north-south × ~94 m east-west
--   area    0.01°    ~1.11 km          × ~944 m
--
-- STATED PLAINLY, because these numbers are a privacy decision and not an emergent
-- property of a round number in a function body: 'street' narrows a residence to
-- ROUGHLY A CITY BLOCK. Anyone holding the published point knows which block someone
-- lived on, not which building. For a photograph of a shopfront that is right; for a
-- photograph of a family in their home it may not be, and the contributor choosing
-- 'street' should be understood to be accepting block-level disclosure.
--
-- 'area' at ~1 km is neighbourhood-level and carries no such implication.
--
-- If block-level proves too tight, the fix is to widen the 'street' grid here — one
-- number, one file, and the derivation trigger recomputes every row on next write.
--
-- 'exact' publishes the true point, and that is deliberate rather than an oversight:
-- Al-Manara Square is a public landmark and pretending otherwise would make the map
-- useless. The protection is that 'exact' must be chosen — the column DEFAULT is
-- 'hidden', so §7's "fuzzing is default-on" holds for anything that says nothing.
create or replace function public.fuzz_location(
  p_location  extensions.geography,
  p_precision public.location_precision
)
returns extensions.geography
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_location is null      then null
    when p_precision = 'hidden'  then null
    when p_precision = 'exact'   then p_location
    when p_precision = 'street'  then
      extensions.st_snaptogrid(p_location::extensions.geometry, 0.001)::extensions.geography
    when p_precision = 'area'    then
      extensions.st_snaptogrid(p_location::extensions.geometry, 0.01)::extensions.geography
  end;
$$;

comment on function public.fuzz_location(extensions.geography, public.location_precision) is
  'CLAUDE.md §7 — grid snapping, so the discarded precision is gone rather than recoverable.';

-- ── The trigger ──────────────────────────────────────────────
--
-- No auth.uid() early return, unlike the stamping triggers in 0014. Those defer to
-- the service role because an importer legitimately supplies its own authorship.
-- This one does not defer to anybody: §7's location rule has no exceptions, and an
-- importer is exactly the path most likely to carry precise coordinates in bulk.
--
-- Fires before posts_enforce_approval by alphabetical trigger order
-- (derive < enforce), so the content hash is computed over the fuzzed value that
-- will actually be published, not the raw one.
create or replace function public.posts_derive_location_public()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.location_public := public.fuzz_location(new.location, new.location_precision);
  return new;
end;
$$;

create trigger posts_derive_location_public
  before insert or update on public.posts
  for each row execute function public.posts_derive_location_public();

-- ── And take the column away from the client ─────────────────
-- 0015 granted these. A derived column that is still writable is not derived. This
-- is a column-level revoke of a column-level grant, which does subtract cleanly —
-- the caveat in 0004 was about column revokes against a TABLE-level grant.
revoke insert (location_public) on public.posts from authenticated;
revoke update (location_public) on public.posts from authenticated;

comment on column public.posts.location_public is
  'DERIVED from location + location_precision by trigger. Not writable by anyone.';
