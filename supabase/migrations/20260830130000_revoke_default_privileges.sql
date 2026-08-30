-- 0056 · `revoke from public` is not enough on a hosted Supabase project
--
-- Found 30 Aug 2026 by running 16_function_grants against the DEPLOYED database instead of
-- against a fresh one. It failed there and passes in CI, and the gap is not drift somebody
-- introduced — it is a difference between the two stacks that every migration in this repo
-- has been silently subject to since M0.
--
-- == The mechanism ===========================================
--
-- A hosted project carries default privileges that a local stack does not:
--
--     pg_default_acl, schema public, objtype f (functions), grantor postgres
--       anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- So a function created in `public` arrives with EXECUTE granted **explicitly to anon and
-- authenticated**, not via the PUBLIC pseudo-role. And
--
--     revoke execute on function f() from public;
--
-- removes the PUBLIC grant and leaves both explicit ones exactly where they are. The
-- statement looks like it closed the door. On the deployed database it did not.
--
-- Five functions were written that way and five were still callable by `anon` or by
-- `authenticated` on the hosted project while CI reported them closed:
--
--   post_content_hash(posts)        0012 · revoked from public only
--   post_audit_snapshot(posts)      0012 · revoked from public only
--   user_role_snapshot(user_roles)  0031 · revoked from public only
--   upload_daily_limits(app_role)   0024 · revoked from public only
--   custom_access_token_hook(jsonb) 0013 · revoked anon/authenticated/public, not service_role
--
-- **Tables were never affected**, and the reason is worth keeping: every table migration says
-- `revoke all on <table> from anon, authenticated` — naming the roles — before granting a
-- column subset back. Checked on the deployed database: the only table-level privilege
-- either role holds anywhere in `public` is DELETE on likes and saves, which is unlike and
-- unsave. The habit was already right for tables and wrong for functions.
--
-- == What the exposure actually was ==========================
--
-- Low, and stated rather than glossed. Three of the five take a COMPOSITE ROW as their
-- argument (`posts`, `user_roles`), so a caller has to supply the row itself — the function
-- hashes or shapes what it was handed and reads nothing the caller did not already have.
-- 0015's column grants are what keep a member from assembling a real one. upload_daily_limits
-- returns the quota figures §6 publishes in this file anyway. custom_access_token_hook
-- gained only service_role, which never reaches a browser (§6).
--
-- It is fixed because it is wrong, not because it was dangerous. §11 gate 1 is "every
-- mutation run as anon, member, moderator; all denials asserted" — a denial that holds only
-- on the stack the test runs on is not asserted, it is assumed.
--
-- == The rule this leaves behind ============================
--
-- **Name the roles. `from public` alone is a no-op against a default privilege.** 0055's
-- save_content_block revokes `from public, anon` and came out correct on the deployed
-- database without anyone noticing this; every function added from here should do the same.
--
-- This file is re-runnable and is a no-op on a database that never had the grants — a revoke
-- of a privilege nobody holds succeeds quietly, which is what makes it safe to apply to both
-- stacks and keep them converged.

set search_path = public, extensions;

-- 0012's pair. §5: the publisher records a content hash at approval and refuses rows whose
-- hash no longer matches; the computation belongs to the publisher, which is service_role.
revoke execute on function public.post_content_hash(public.posts)   from anon, authenticated;
revoke execute on function public.post_audit_snapshot(public.posts) from anon, authenticated;

-- 0031 revoked this one and said why in as many words: "user_role_snapshot ... granting it
-- 'for symmetry' would hand out a capability to make a [role record]". Its only caller is a
-- SECURITY DEFINER trigger, which needs no grant at all.
revoke execute on function public.user_role_snapshot(public.user_roles)
  from anon, authenticated, service_role;

-- 0024. `authenticated` keeps it — a member's client may ask what its own ceiling is; a
-- signed-out visitor has no upload path and no reason to.
revoke execute on function public.upload_daily_limits(public.app_role) from anon;

-- 0013. supabase_auth_admin is the only caller by design: GoTrue invokes it while minting a
-- token. service_role arrived from the default privilege rather than from a decision.
revoke execute on function public.custom_access_token_hook(jsonb) from service_role;
