-- §5's boundary, asserted as a boundary rather than one function at a time.
--
-- ── The gap this closes ──────────────────────────────────────
--
-- §5: "Authorization lives in RLS policies and Edge Functions. Nowhere else." A
-- SECURITY DEFINER function is the one construct in Postgres that makes that sentence
-- false by existing: it runs as the owner, so RLS does not apply to it, and its own WHERE
-- clause becomes the entire security boundary. 04_definer_functions says exactly this and
-- then pins the row sets for the seven callable ones.
--
-- What nothing pinned is how one becomes reachable in the first place. Two ways, and both
-- are silent:
--
--   1. Postgres grants EXECUTE on a new function to PUBLIC by default. Every migration in
--      this repository revokes it — `revoke execute ... from public, anon, authenticated`
--      sits at the bottom of each one — but that is a convention held by whoever writes
--      the next migration. Forget it once and a function that bypasses RLS is callable
--      with the anon key, and nothing in the suite notices.
--
--   2. A definer function that takes an identity as a PARAMETER rather than deriving it
--      from the token is §5 inverted: the caller says who they are, and the function RLS
--      cannot check believes them. `p_user_id uuid` on a browser-reachable definer
--      function is the whole vulnerability, and it reads like ordinary code.
--
-- ── Why an invariant and not an enumerated list ──────────────
--
-- The obvious shape is `set_eq` over "definer functions authenticated may execute". It was
-- written that way first and replaced, because an enumerated list has to be edited every
-- time the schema grows — and a list that fails on every legitimate addition is a list
-- people update reflexively without reading. It would have caught the forgotten revoke on
-- the same day it stopped being read.
--
-- Tests 1 and 2 need no maintenance: they say no definer function may be PUBLIC-executable
-- except the ones deliberately named, and that the named set is exactly one. A new
-- function without its revoke fails test 1 and prints its own name. Deliberately widening
-- the exception fails test 2, which is the review trigger the list was wanted for.
--
-- ── What this does NOT cover ─────────────────────────────────
--
-- Whether each function's predicate is CORRECT. That is per-function work and it is where
-- 04_definer_functions, 12_begin_ingest and 14_release_ingest already are; this file is the
-- frame around them, not a replacement. A function can pass every assertion here,
-- reference auth.uid(), and still have the comparison backwards.
--
-- Trigger functions are excluded throughout: they cannot be invoked from SQL at all, which
-- 04 asserts directly, so their grants are not a browser-reachable surface.

begin;
create extension if not exists pgtap;

-- 2 how a definer function becomes reachable · 3 identity is derived · 3 crossing
select plan(8);

-- ── Fixtures ─────────────────────────────────────────────────

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'owner@t.local'),
  ('00000000-0000-0000-0000-0000000000f2', 'stranger@t.local');

insert into public.profiles (id, handle) values
  ('00000000-0000-0000-0000-0000000000f1', 'boundary_owner'),
  ('00000000-0000-0000-0000-0000000000f2', 'boundary_stranger')
  -- 0057 provisions a profile on the auth.users insert above, so this is an UPSERT:
  -- the fixture handle this file asserts on must win over the generated placeholder.
  on conflict (id) do update set handle = excluded.handle;


-- Identity arguments, not just names: an overload is a separate grant and a separate
-- boundary, and record_release has had three live signatures in this repository.
create function pg_temp.definer_public_execute()
returns table (sig text) language sql stable as $fn$
  select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.prorettype <> 'trigger'::regtype
    -- proacl NULL means the default ACL, which is EXECUTE to PUBLIC. grantee 0 is PUBLIC
    -- named explicitly. Both are the same reachability and neither is visible by reading
    -- the CREATE statement.
    and (p.proacl is null
         or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0));
$fn$;

-- ═══ 1–2 · Reachable only on purpose ═════════════════════════

select set_eq(
  $$ select sig from pg_temp.definer_public_execute() $$,
  $$ values ('authz_role()') $$,
  'exactly one SECURITY DEFINER function is PUBLIC-executable, and it is the intended one');

-- Why authz_role is the exception, stated here so the previous assertion is a decision
-- rather than a tolerated leftover: request-upload calls it with the member's own JWT to
-- learn their role, and it returns the CALLER's role and nothing else. An anonymous caller
-- learns that they are anonymous. There is no argument to lie about — which is exactly the
-- property test 3 requires of everything else.
select ok(
  (select count(*) = 0
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'authz_role' and p.pronargs > 0),
  '...and that one takes no arguments, so there is no identity in it to forge');

-- ═══ 3–5 · Identity is DERIVED, or the answer is public ══════
--
-- The §5 inversion, caught structurally. Anything a browser role can execute that runs
-- with the owner's rights must work out who is calling from the token — auth.uid(), or one
-- of the helpers that reads it — rather than from an argument.
--
-- prosrc, because there is no other way to ask this of a function body. Coarse on purpose:
-- it proves the function CONSULTS an identity, not that it consults it correctly. That
-- line is where this file stops and 04_definer_functions starts.
--
-- There is a second legitimate shape, and this assertion FOUND it rather than anticipating
-- it: a function whose answer does not depend on who is asking, because it restricts
-- itself to rows that are public to everyone. post_like_count is the case — §7 keeps
-- `likes` rows owner-only since "who liked what" is the correlation it warns about, while
-- the COUNT is public information baked into every shard. It needs no identity because
-- there is no answer it could give one caller and not another.
--
-- That exception is named in test 4 and CHECKED in test 5, rather than taken on trust:
-- what makes it safe is its own `status = 'approved' and not takedown` predicate, so test
-- 5 fails if that predicate is ever removed. An exception nobody verifies is a hole with a
-- comment next to it.

create function pg_temp.definer_without_identity()
returns table (sig text) language sql stable as $fn$
  select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('authenticated', p.oid, 'execute')
    and p.prosrc !~ 'auth\.uid\(\)'
    and p.prosrc !~ 'is_moderator\(\)'
    and p.prosrc !~ 'is_admin\(\)'
    and p.prosrc !~ 'authz_role\(\)'
    and p.prosrc !~ 'request\.jwt';
$fn$;

select is_empty(
  $$
    select sig from pg_temp.definer_without_identity()
    where sig <> 'post_like_count(p_post_id uuid)'
  $$,
  'every definer function a member can execute derives the caller from the token, not from an argument');

select set_eq(
  $$ select sig from pg_temp.definer_without_identity() $$,
  $$ values ('post_like_count(p_post_id uuid)') $$,
  '...and the set excused from that rule is exactly one, so it cannot grow unnoticed');

-- WHY it is excused, as an assertion rather than a comment. Strip the approved/takedown
-- filter and post_like_count starts answering for pending and taken-down posts — which
-- turns a public count into a way to probe the moderation queue, and this fails.
select ok(
  (select p.prosrc ~ 'status\s*=\s*''approved''' and p.prosrc ~ 'not\s+p\.takedown'
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'post_like_count'),
  '...and it earns the exemption by restricting itself to approved, non-taken-down posts');

-- ═══ 6–8 · The crossing, run directly against the RPC ════════
--
-- 12 and 14 already assert this for begin_ingest and release_ingest. The two below had no
-- direct crossing test: the function that WRITES the draft row, and the only definer
-- function §4 lets a member call that acts on content.

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000f2","role":"authenticated"}';

-- claim_upload_slot mints the draft AND accepts the object key. A member who could claim a
-- slot under another member's key prefix would own the upload the worker later completes.
select is(
  public.claim_upload_slot(
    1024,
    '00000000-0000-0000-0000-0000000000f1/not-mine',
    'media',
    '{"title_en":"t","body_en":"b","license":"CC-BY-SA-4.0","provenance":"p","consent":{"granted":true}}'::jsonb
  ) ->> 'reason',
  'object_key_not_owned',
  'a member cannot claim an upload slot under another member''s key prefix');

-- §4 gives "trigger takedown" to moderator and admin only, and request_takedown is granted
-- to `authenticated` — which is safe ONLY because it re-derives the role from the database
-- rather than from anything the caller said.
select is(
  public.request_takedown(
    '00000000-0000-0000-0000-0000000000f1'::uuid, 'because I say so') ->> 'reason',
  'forbidden',
  'a member cannot trigger a takedown, and the refusal comes from the database not the UI');

reset role;

-- THE counter-test for the assertion above. `forbidden` has to be about the ROLE, not
-- about the post belonging to someone else — otherwise §4's matrix would be enforced by
-- ownership, the previous assertion would pass for the wrong reason, and a member could
-- take their own approved contribution out of the archive without a moderator.
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}';

select is(
  public.request_takedown(
    '00000000-0000-0000-0000-0000000000f1'::uuid, 'my own post') ->> 'reason',
  'forbidden',
  '...and refuses the owner too — it is a role check, not an ownership check');

reset role;

select * from finish();
rollback;