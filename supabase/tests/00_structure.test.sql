-- Structural assertions about the security model itself.
--
-- These do not test behaviour — they test that the MECHANISMS are still in place.
-- The distinction matters because policy regressions are loud (something stops
-- working) while privilege regressions are silent (something starts working). A
-- forgotten `grant select on public.posts to authenticated` re-exposes raw
-- coordinates and every other test in this suite still passes.
--
-- pgTAP is created inside this transaction and rolled back with it, so it never
-- appears in a migration and cannot reach production.

begin;
create extension if not exists pgtap;

select plan(9);

-- ── 1 · RLS is on, everywhere ────────────────────────────────
select is_empty(
  $q$
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  $q$,
  'RLS is enabled on every table in schema public'
);

-- ── 2 · No policy trusts role_cache ──────────────────────────
-- §4 calls profiles.role_cache display-only. This turns that from a promise into
-- something CI enforces: authorization reads public.authz_role(), which goes to
-- user_roles, and no policy expression may so much as mention the cache column.
select is_empty(
  $q$
    select c.relname || '.' || p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    where coalesce(pg_get_expr(p.polqual, p.polrelid), '') ilike '%role_cache%'
       or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ilike '%role_cache%'
  $q$,
  'no RLS policy reads profiles.role_cache (CLAUDE.md §4)'
);

-- ── 3 · anon holds no table-level grant, anywhere ────────────
-- §2: public visitors cause zero database reads. The grant was never load-bearing,
-- and its absence is what closes the whole column-leak class at once.
select is_empty(
  $q$
    select c.relname || ' / ' || acl.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relkind = 'r'
      and acl.grantee = 'anon'::regrole::oid
  $q$,
  'anon holds no table-level privilege on any table in public'
);

-- ── 4 · …and no column-level grant either ────────────────────
select is_empty(
  $q$
    select c.relname || '.' || a.attname || ' / ' || acl.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(coalesce(a.attacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relkind = 'r'
      and acl.grantee = 'anon'::regrole::oid
  $q$,
  'anon holds no column-level privilege on any table in public'
);

-- ── 5 · authenticated has no TABLE-level SELECT on posts ─────
-- A table-level grant silently re-includes every column, including the four below,
-- and would leave test 6 passing while the hole is wide open.
select is_empty(
  $q$
    select acl.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relname = 'posts'
      and acl.grantee = 'authenticated'::regrole::oid
      and acl.privilege_type = 'SELECT'
  $q$,
  'authenticated holds no table-level SELECT on posts — column grants only'
);

-- ── 6 · The four columns §7 exists to protect ────────────────
select is_empty(
  $q$
    select a.attname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(coalesce(a.attacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relname = 'posts'
      and acl.grantee = 'authenticated'::regrole::oid
      and acl.privilege_type = 'SELECT'
      and a.attname in ('location', 'approved_by', 'consent', 'created_at')
  $q$,
  'authenticated cannot SELECT posts.location / approved_by / consent / created_at'
);

-- ── 7 · Approval attribution is unforgeable ──────────────────
-- These four are written by trigger. If any becomes writable, a moderator can forge
-- who approved what, or a member can badge their own post as coming from the team.
select is_empty(
  $q$
    select a.attname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    cross join lateral aclexplode(coalesce(a.attacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relname = 'posts'
      and acl.grantee = 'authenticated'::regrole::oid
      and acl.privilege_type in ('INSERT', 'UPDATE')
      and a.attname in ('approved_by', 'approved_at', 'content_hash', 'created_by', 'author_label')
  $q$,
  'authenticated cannot write posts.approved_by / approved_at / content_hash / created_by / author_label'
);

-- ── 8 · role_cache is unwritable from a browser ──────────────
select is_empty(
  $q$
    select acl.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'role_cache'
    cross join lateral aclexplode(coalesce(a.attacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relname = 'profiles'
      and acl.grantee in ('anon'::regrole::oid, 'authenticated'::regrole::oid)
      and acl.privilege_type in ('INSERT', 'UPDATE')
  $q$,
  'profiles.role_cache is not writable by anon or authenticated'
);

-- ── 9 · Policy-free tables are exactly the intended four ─────
-- Adding a table without deciding its policy fails here rather than shipping open.
select set_eq(
  $q$
    select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_policy p on p.polrelid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    group by c.relname
    having count(p.polname) = 0
  $q$,
  array['user_roles', 'reserved_handles', 'releases', 'upload_quota'],
  'exactly four tables are intentionally policy-free (deny-all, service role only)'
);

select * from finish();
rollback;
