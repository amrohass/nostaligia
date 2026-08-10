-- 0001 · Extensions
--
-- PostGIS only. Two things CLAUDE.md might imply that we deliberately do NOT install:
--
--   pgcrypto — not needed. `gen_random_uuid()` is core from PG13, and content hashes
--              use core `sha256(bytea)` (PG11+). One less extension in the trust path.
--   pgtap    — a TEST dependency. It is created inside the test transaction in
--              supabase/tests/, never in a migration, so it cannot reach production.
--
-- PostGIS lands in `extensions`, per Supabase convention, never in `public`. Every
-- migration that names a geography type or builds a GiST index therefore opens with
--     set search_path = public, extensions;
-- because GiST default-operator-class lookup only considers opclasses visible on the
-- search path. Without it, `using gist (location)` fails to resolve an opclass.

create schema if not exists extensions;

create extension if not exists postgis with schema extensions;
