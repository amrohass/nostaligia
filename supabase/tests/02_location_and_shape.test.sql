-- Location fuzzing (0021) and jsonb shape (0022).
--
-- Two assertions here are deliberately built so that they FAIL under the previous
-- implementation, because an assertion that passes either way is worthless — the
-- lesson from a size-ceiling test that never ran and a timezone row that could not
-- discriminate:
--
--   · the exact -> hidden UPDATE transition, which passes trivially if the trigger
--     only fires on INSERT
--   · the 4500-Arabic-character payload, which is 4500 under length() and 9000 under
--     octet_length(). It passes the old ceiling and fails the new one. If this test
--     goes green with `length`, the change to octet_length did nothing.

begin;
create extension if not exists pgtap;

select plan(17);

insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-00000000c001', 'fuzz@test.local');
insert into public.profiles (id, handle)
  values ('00000000-0000-0000-0000-00000000c001', 'fuzz_user')
  -- 0057 provisions a profile on the auth.users insert above, so this is an UPSERT:
  -- the fixture handle this file asserts on must win over the generated placeholder.
  on conflict (id) do update set handle = excluded.handle;


-- Al-Manara Square, to nine decimal places. Every fuzzed value below derives from it.
insert into public.posts
  (id, kind, title_ar, body_ar, created_by, location, location_precision, location_public)
values
  -- note the client ALSO supplies an exact location_public on a2/a4. It must be discarded.
  ('00000000-0000-0000-0000-0000000000a1', 'media', 'مساحة', 'وصف',
   '00000000-0000-0000-0000-00000000c001',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography, 'area',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography),
  ('00000000-0000-0000-0000-0000000000a2', 'media', 'شارع', 'وصف',
   '00000000-0000-0000-0000-00000000c001',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography, 'street', null),
  ('00000000-0000-0000-0000-0000000000a3', 'media', 'مخفي', 'وصف',
   '00000000-0000-0000-0000-00000000c001',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography, 'hidden',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography),
  ('00000000-0000-0000-0000-0000000000a4', 'media', 'دقيق', 'وصف',
   '00000000-0000-0000-0000-00000000c001',
   st_setsrid(st_makepoint(35.2034, 31.9038), 4326)::geography, 'exact', null);

-- ── Snapping, compared numerically ───────────────────────────
-- Not by st_astext string equality: float64 renders the snapped 31.9 as
-- 31.900000000000002, which is the same number and a different string.
select is(round(st_x(location_public::geometry)::numeric, 9), 35.2::numeric,
          'area snaps longitude to the 0.01 grid')
  from public.posts where id = '00000000-0000-0000-0000-0000000000a1';
select is(round(st_y(location_public::geometry)::numeric, 9), 31.9::numeric,
          'area snaps latitude to the 0.01 grid')
  from public.posts where id = '00000000-0000-0000-0000-0000000000a1';
select is(round(st_x(location_public::geometry)::numeric, 9), 35.203::numeric,
          'street snaps longitude to the 0.001 grid')
  from public.posts where id = '00000000-0000-0000-0000-0000000000a2';
select is(round(st_y(location_public::geometry)::numeric, 9), 31.904::numeric,
          'street snaps latitude to the 0.001 grid')
  from public.posts where id = '00000000-0000-0000-0000-0000000000a2';

select is((select location_public from public.posts
           where id = '00000000-0000-0000-0000-0000000000a3'), null,
          'hidden publishes no coordinate at all (CLAUDE.md §7)');

select is((select st_astext(location_public) from public.posts
           where id = '00000000-0000-0000-0000-0000000000a4'),
          (select st_astext(location) from public.posts
           where id = '00000000-0000-0000-0000-0000000000a4'),
          'exact publishes the true point — it must be chosen, the default is hidden');

-- The client supplied an exact location_public on a1 and a3. Both were overwritten.
select isnt((select st_astext(location_public) from public.posts
             where id = '00000000-0000-0000-0000-0000000000a1'),
            'POINT(35.2034 31.9038)',
            'a client-supplied location_public is discarded on INSERT');

select is((select st_astext(location) from public.posts
           where id = '00000000-0000-0000-0000-0000000000a1'),
          'POINT(35.2034 31.9038)',
          'raw location survives fuzzing intact — it is the archival truth');

-- ── UPDATE transitions ───────────────────────────────────────
-- The one that matters: a precision DOWNGRADE after publication. If the trigger only
-- fired on INSERT, location_public would keep its old fuzzed value here and the
-- contributor's decision to hide would silently do nothing.
update public.posts set location_precision = 'hidden'
  where id = '00000000-0000-0000-0000-0000000000a4';
select is((select location_public from public.posts
           where id = '00000000-0000-0000-0000-0000000000a4'), null,
          'exact -> hidden on UPDATE recomputes location_public to NULL');

-- And the reverse, so the trigger is not merely nulling things.
update public.posts set location_precision = 'street'
  where id = '00000000-0000-0000-0000-0000000000a3';
select is((select round(st_x(location_public::geometry)::numeric, 9) from public.posts
           where id = '00000000-0000-0000-0000-0000000000a3'), 35.203::numeric,
          'hidden -> street on UPDATE recomputes from NULL to a snapped point');

update public.posts
  set location_public = st_setsrid(st_makepoint(0, 0), 4326)::geography
  where id = '00000000-0000-0000-0000-0000000000a1';
select is((select round(st_x(location_public::geometry)::numeric, 9) from public.posts
           where id = '00000000-0000-0000-0000-0000000000a1'), 35.2::numeric,
          'a client-supplied location_public is discarded on UPDATE too');

update public.posts
  set location = st_setsrid(st_makepoint(35.3034, 31.8038), 4326)::geography
  where id = '00000000-0000-0000-0000-0000000000a1';
select is((select round(st_x(location_public::geometry)::numeric, 9) from public.posts
           where id = '00000000-0000-0000-0000-0000000000a1'), 35.3::numeric,
          'moving location recomputes location_public');

-- ── jsonb shape ──────────────────────────────────────────────
select throws_ok(
  $q$ update public.posts set details = '{"evil":"x"}'::jsonb
      where id = '00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null,
  'details rejects a key outside the allowlist'
);

select throws_ok(
  $q$ update public.posts set consent = '{"whoami":"x"}'::jsonb
      where id = '00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null,
  'consent rejects a key outside the allowlist'
);

select lives_ok(
  $q$ update public.posts
      set details = '{"tags":["أعراس"],"alt_ar":"وصف للصورة"}'::jsonb
      where id = '00000000-0000-0000-0000-0000000000a1' $q$,
  'details accepts allowlisted keys'
);

-- THE DISCRIMINATING ONE for octet_length. 4500 Arabic characters is:
--   length()       = 4500  -> under the 8192 ceiling, would have PASSED
--   octet_length() = 9000  -> over it, must FAIL
-- An allowlisted key is used deliberately, so the key check cannot reject it first
-- and leave the size check untested — which is exactly what happened the first time.
select throws_ok(
  format(
    $q$ update public.posts set details = jsonb_build_object('transcript_ar', %L)
        where id = '00000000-0000-0000-0000-0000000000a1' $q$,
    repeat('ا', 4500)),
  '23514', null,
  '4500 Arabic chars = 9000 bytes is refused: the ceiling counts bytes, not characters'
);

-- ── privilege ────────────────────────────────────────────────
select is_empty(
  $q$
    select acl.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'location_public'
    cross join lateral aclexplode(a.attacl) acl
    where n.nspname = 'public' and c.relname = 'posts'
      and acl.grantee = 'authenticated'::regrole::oid
      and acl.privilege_type in ('INSERT', 'UPDATE')
  $q$,
  'location_public is not writable by authenticated — a derived column that is writable is not derived'
);

select * from finish();
rollback;