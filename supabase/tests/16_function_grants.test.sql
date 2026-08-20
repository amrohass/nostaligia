-- Who may EXECUTE what — the other half of 05's matrix.
--
-- 05_matrix pins 4 roles × 15 tables × 4 operations and is the reason RLS can be trusted.
-- It says nothing about functions, and by M1 the function surface is where most of the
-- authorization actually lives: eleven SECURITY DEFINER functions now reach past RLS by
-- design, and for each of them the GRANT is the policy. There is nothing behind it.
--
-- ── The default that makes this necessary ────────────────────
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC. Not revoking is not a decision;
-- it is the absence of one, and it leaves no trace in the migration that made it. A
-- SECURITY DEFINER function written next month and shipped without a revoke is callable by
-- anon, through PostgREST, with the owner's rights — which is the whole trust boundary
-- inverted by an omission that reviews as a blank line.
--
-- So the matrix below is exhaustive and literal. A new function appears in it or the test
-- fails; a widened grant changes a row; set_eq prints exactly which cells differ. Adding a
-- function means writing its access down, which is the point.
--
-- ── And what the worker can reach, stated once ───────────────
--
-- §6's cost incident was a compromised credential. The worker holds a long-lived JWT in a
-- container, which is the credential most likely to leak next, so "what could that token
-- do" deserves an answer that is checked rather than remembered. Tests 2–4 are that answer:
-- two functions, no tables, no columns.

begin;
create extension if not exists pgtap;

-- 1 the matrix · 3 the worker's reach · 1 the PUBLIC set · 2 the revoke in 0033 did no harm
select plan(7);

-- ═══ 1 · Every (function, role) pair that can execute ════════
--
-- Trigger functions are excluded: they return `trigger`, cannot be called from SQL at all
-- (04 asserts that), and their grants are meaningless. `postgres` is excluded because it
-- owns everything and would fill the matrix with noise.

select set_eq(
  $q$
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || r.rolname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral (values ('anon'), ('authenticated'), ('service_role'),
                               ('media_worker'), ('supabase_auth_admin')) as r(rolname)
    where n.nspname = 'public'
      and p.prorettype <> 'pg_catalog.trigger'::regtype
      and has_function_privilege(r.rolname, p.oid, 'execute')
      -- Functions belonging to an EXTENSION are not ours to govern, and where an extension
      -- installs itself is not fixed: pgtap lands in `extensions` under this project's
      -- config and in `public` in a bare psql session, which would otherwise make this test
      -- pass or fail depending on how it was invoked.
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  $q$,
  $q$ values
    -- Your own role, from the database rather than the JWT claim beside it (§4). Harmless
    -- to anyone: it reports the CALLER's role and nobody else's.
    ('authz_role() -> anon'),
    ('authz_role() -> authenticated'),
    ('authz_role() -> media_worker'),
    ('authz_role() -> service_role'),
    ('authz_role() -> supabase_auth_admin'),

    -- The upload path. `authenticated`, because each runs as the uploader and derives
    -- auth.uid() itself — 11, 12, 13 and 14 pin what happens when one is called directly.
    ('begin_ingest(p_object_key text) -> authenticated'),
    ('begin_ingest(p_object_key text) -> service_role'),
    ('claim_upload_quota(p_bytes bigint) -> authenticated'),
    ('claim_upload_quota(p_bytes bigint) -> service_role'),
    ('claim_upload_slot(p_bytes bigint, p_object_key text, p_kind post_kind, p_draft jsonb) -> authenticated'),
    ('claim_upload_slot(p_bytes bigint, p_object_key text, p_kind post_kind, p_draft jsonb) -> service_role'),
    ('release_ingest(p_object_key text) -> authenticated'),
    ('release_ingest(p_object_key text) -> service_role'),
    ('upload_daily_limits(p_role app_role) -> authenticated'),
    ('upload_daily_limits(p_role app_role) -> service_role'),

    -- The worker's entire reach. NOT authenticated: a member who could call complete_ingest
    -- would attach arbitrary storage paths to their own post.
    ('complete_ingest(p_object_key text, p_sniffed_mime text, p_assets jsonb) -> media_worker'),
    ('complete_ingest(p_object_key text, p_sniffed_mime text, p_assets jsonb) -> service_role'),
    ('fail_ingest(p_object_key text, p_reason text) -> media_worker'),
    ('fail_ingest(p_object_key text, p_reason text) -> service_role'),

    -- Reads that widen what RLS allows, each with its own predicate as the boundary (04).
    ('can_read_post_media(p_post_id uuid, p_bucket media_bucket) -> authenticated'),
    ('can_read_post_media(p_post_id uuid, p_bucket media_bucket) -> service_role'),
    ('content_blocks_draft() -> authenticated'),
    ('content_blocks_draft() -> service_role'),
    ('posts_full() -> authenticated'),
    ('posts_full() -> service_role'),
    ('post_like_count(p_post_id uuid) -> anon'),
    ('post_like_count(p_post_id uuid) -> authenticated'),
    ('post_like_count(p_post_id uuid) -> service_role'),
    ('profile_view(p_handle text) -> anon'),
    ('profile_view(p_handle text) -> authenticated'),
    ('profile_view(p_handle text) -> service_role'),

    -- The publisher's, and nobody else's (0012). M2 computes a hash to compare against the
    -- one recorded at approval; a member who could call post_content_hash could compute the
    -- hash of an edit and learn whether it would be accepted.
    ('post_audit_snapshot(p posts) -> service_role'),
    ('post_content_hash(p posts) -> service_role'),

    -- Auth's, and only auth's. §4: the role claim is minted here.
    ('custom_access_token_hook(event jsonb) -> supabase_auth_admin'),

    -- The publish pipeline (0034). service_role and nothing else, not even media_worker:
    -- a caller who could take the publish lease could stop the archive updating with one
    -- RPC every four minutes, which is a denial of service that needs no exploit.
    ('claim_publish_lease(p_holder uuid, p_ttl interval, p_note text) -> service_role'),
    ('renew_publish_lease(p_holder uuid, p_ttl interval) -> service_role'),
    -- 0042: the second argument is the revision the lease was claimed at, which is how a
    -- change that landed mid-build gets a follow-up publish now that the cron is deferred.
    ('release_publish_lease(p_holder uuid, p_claimed_content_revision bigint) -> service_role'),
    -- 0038: both carry the lease holder now. publish_lease_fault, which does the checking,
    -- appears nowhere in this matrix — its only callers are these two, which are SECURITY
    -- DEFINER and run as its owner, so a grant would widen the surface without enabling
    -- anything.
    ('record_release(p_path text, p_content_revision bigint, p_counter_revision bigint, p_holder uuid) -> service_role'),
    ('activate_release(p_id uuid, p_holder uuid) -> service_role'),
    ('active_release() -> service_role'),

    -- The publisher's read side (0035). §2's read path is "zero database reads for public
    -- visitors", and an RPC that returns the entire archive in one call is the most
    -- attractive possible way to violate that by accident.
    ('publishable_posts() -> service_role'),
    ('redacted_post_ids() -> service_role'),

    -- The debounce (0037). publish_pending is the only part of piece 5 anything may call:
    -- it answers "is a publish due" in two integers and a release path, which the publisher
    -- can use to skip a pointless build and M6's publish-age monitor needs outright.
    --
    -- publish_tick and publish_dispatch are absent from this list, and that absence IS the
    -- assertion. pg_cron runs the job as its owner, so neither needs a grant to work, and
    -- publish_dispatch without its name is a POST to an arbitrary URL with an arbitrary
    -- Authorization header — the last function in this schema that should be reachable by a
    -- credential somebody might leak.
    ('publish_pending() -> service_role'),

    -- Rollback (0039). service_role only, like the rest of the publish path. rollback_release
    -- also demands a live publish lease, which no browser role can take at any privilege.
    ('rollback_release(p_path text, p_holder uuid, p_reason text) -> service_role'),
    ('release_publish_hold(p_actor uuid) -> service_role'),

    -- Takedown (0036). `authenticated` may CALL it — the role check is is_moderator()
    -- inside the function, so a member gets a named refusal instead of a silent nothing,
    -- and the audit row names them rather than the service key.
    ('request_takedown(p_post_id uuid, p_note text) -> authenticated'),
    ('request_takedown(p_post_id uuid, p_note text) -> service_role'),

    -- Takedown (0036). `authenticated` may CALL it — the role check is is_moderator()
    -- inside the function, so a member gets a named refusal instead of a silent nothing,
    -- and the audit row names them rather than the service key.
    ('request_takedown(p_post_id uuid, p_note text) -> authenticated'),
    ('request_takedown(p_post_id uuid, p_note text) -> service_role'),

    -- ── Still on the PUBLIC default, each for a reason ────────
    --
    -- fuzz_location: pure and IMMUTABLE, and grid snapping destroys the precision rather
    -- than hiding it (0021), so knowing the algorithm and being able to run it buys nothing.
    -- There is no inverse to compute.
    ('fuzz_location(p_location geography, p_precision location_precision) -> anon'),
    ('fuzz_location(p_location geography, p_precision location_precision) -> authenticated'),
    ('fuzz_location(p_location geography, p_precision location_precision) -> media_worker'),
    ('fuzz_location(p_location geography, p_precision location_precision) -> service_role'),
    ('fuzz_location(p_location geography, p_precision location_precision) -> supabase_auth_admin'),

    -- is_admin / is_moderator: these are CALLED BY RLS POLICIES, and a policy is evaluated
    -- as the querying role. Revoking from anon would make every policy that mentions one
    -- raise 42501 instead of returning false — the table would stop being readable rather
    -- than start being protected. They report the caller's own role and nothing else.
    ('is_admin() -> anon'),
    ('is_admin() -> authenticated'),
    ('is_admin() -> media_worker'),
    ('is_admin() -> service_role'),
    ('is_admin() -> supabase_auth_admin'),
    ('is_moderator() -> anon'),
    ('is_moderator() -> authenticated'),
    ('is_moderator() -> media_worker'),
    ('is_moderator() -> service_role'),
    ('is_moderator() -> supabase_auth_admin'),

    -- is_allowed_handle / is_valid_visibility / jsonb_keys_allowed / normalized_handle:
    -- called from CHECK constraints and index expressions, which are evaluated as the
    -- writing role. Revoking would refuse the INSERT, not the attack. All four are pure
    -- functions of their arguments and read nothing.
    ('is_allowed_handle(h text) -> anon'),
    ('is_allowed_handle(h text) -> authenticated'),
    ('is_allowed_handle(h text) -> media_worker'),
    ('is_allowed_handle(h text) -> service_role'),
    ('is_allowed_handle(h text) -> supabase_auth_admin'),
    ('is_valid_visibility(v jsonb) -> anon'),
    ('is_valid_visibility(v jsonb) -> authenticated'),
    ('is_valid_visibility(v jsonb) -> media_worker'),
    ('is_valid_visibility(v jsonb) -> service_role'),
    ('is_valid_visibility(v jsonb) -> supabase_auth_admin'),
    ('jsonb_keys_allowed(v jsonb, allowed text[]) -> anon'),
    ('jsonb_keys_allowed(v jsonb, allowed text[]) -> authenticated'),
    ('jsonb_keys_allowed(v jsonb, allowed text[]) -> media_worker'),
    ('jsonb_keys_allowed(v jsonb, allowed text[]) -> service_role'),
    ('jsonb_keys_allowed(v jsonb, allowed text[]) -> supabase_auth_admin'),
    ('normalized_handle(h text) -> anon'),
    ('normalized_handle(h text) -> authenticated'),
    ('normalized_handle(h text) -> media_worker'),
    ('normalized_handle(h text) -> service_role'),
    ('normalized_handle(h text) -> supabase_auth_admin')
  $q$,
  'the EXECUTE matrix is exactly what the migrations say it is'
);

-- ═══ 2–4 · What the worker's token could do ══════════════════
--
-- Two functions above, and below: nothing else. Not a row, not a column. §2 gives the
-- worker one job — resolve an ingest — and complete_ingest is SECURITY DEFINER precisely so
-- that job needs no table rights to do.

select is_empty(
  $q$
    select c.relname || ' ' || p.priv
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'),
                               ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) as p(priv)
    where n.nspname = 'public' and c.relkind = 'r'
      and has_table_privilege('media_worker', c.oid, p.priv)
  $q$,
  'media_worker holds no privilege on any table — a leaked worker token reads nothing'
);

-- A table-level revoke does not remove a column-level grant, which is the trap 0004's
-- header describes. Asked separately, because "no table privilege" would not have caught it.
select is_empty(
  $q$
    select c.relname || '.' || a.attname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
      and has_column_privilege('media_worker', c.oid, a.attnum, 'SELECT,INSERT,UPDATE,REFERENCES')
  $q$,
  '...nor on any column of one'
);

-- Sequences are the third thing a GRANT ALL would have handed over.
select is_empty(
  $q$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
      and (has_sequence_privilege('media_worker', c.oid, 'SELECT')
        or has_sequence_privilege('media_worker', c.oid, 'USAGE')
        or has_sequence_privilege('media_worker', c.oid, 'UPDATE'))
  $q$,
  '...nor on any sequence'
);

-- ═══ 5 · The PUBLIC default, named ═══════════════════════════
--
-- The matrix above would catch a new function too, but it would catch it as one row among
-- seventy. This is the same fact stated so the failure reads as what it is: somebody added
-- a function and did not decide who may call it.

select set_eq(
  $q$
    select p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype <> 'pg_catalog.trigger'::regtype
      and has_function_privilege('public', p.oid, 'execute')
      -- Functions belonging to an EXTENSION are not ours to govern, and where an extension
      -- installs itself is not fixed: pgtap lands in `extensions` under this project's
      -- config and in `public` in a bare psql session, which would otherwise make this test
      -- pass or fail depending on how it was invoked.
      and not exists (
        select 1 from pg_depend d
        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
      )
  $q$,
  $q$ values ('authz_role'), ('fuzz_location'), ('is_admin'), ('is_allowed_handle'),
             ('is_moderator'), ('is_valid_visibility'), ('jsonb_keys_allowed'),
             ('normalized_handle') $q$,
  'exactly eight functions keep PostgreSQL''s PUBLIC default, and each is argued for above'
);

-- ═══ 6–7 · 0033 revoked a helper; the audit still writes ═════
--
-- user_role_snapshot lost its PUBLIC grant. Its only caller is user_roles_write_audit(),
-- which is SECURITY DEFINER and therefore runs as the owner — so the revoke should be
-- invisible to it. "Should be" is why this is here: §3 makes audit rows permanent and §4
-- makes them mandatory, and a silently broken audit trail is the worst outcome available.

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'grant-subject@t.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'grant-actor@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000f1', 'moderator',
        '00000000-0000-0000-0000-0000000000f2');

select is(
  (select count(a.id)::integer from public.audit_log a
    where a.action = 'role.grant'
      and a.target_id = '00000000-0000-0000-0000-0000000000f1'
      and a.after ->> 'role' = 'moderator'),
  1,
  'a role grant still writes its audit row, with the snapshot the revoked helper built');

select is(
  (select count(m.id)::integer from public.moderation_actions m
    where m.action = 'role.grant'
      and m.target_id = '00000000-0000-0000-0000-0000000000f1'),
  1,
  '...and the moderation_actions row beside it (§4: both, always)');

select * from finish();
rollback;
