-- 0033 · The half of a pair that was never locked down
--
-- 0012 ends with:
--
--     revoke execute on function public.post_content_hash(public.posts) from public;
--     revoke execute on function public.post_audit_snapshot(public.posts) from public;
--
-- 0013 defines user_role_snapshot(public.user_roles) — the same helper, for the other
-- audited table, called from the same kind of SECURITY DEFINER trigger — and does not.
--
-- EXECUTE on a function defaults to PUBLIC in PostgreSQL. Not revoking is not a decision;
-- it is the absence of one, and it is invisible in the migration that made it. So today
-- anon, authenticated and media_worker can all call user_role_snapshot while none of them
-- can call its twin, and nothing in the repository explains why.
--
-- ── Is it exploitable? No, and that is not the point ─────────
--
-- The function is `immutable`, takes a public.user_roles ROW as its argument, and returns a
-- jsonb reshaping of exactly what it was handed. A caller must construct the row from
-- literals they already hold; it reads nothing, and there is no version of this that
-- discloses a role the caller could not already see.
--
-- It is revoked anyway, because the asymmetry costs a reader something real. Someone
-- auditing this schema finds one snapshot helper locked and its twin open and has to work
-- out which one is the mistake — and the answer that "neither, one is harmless" is only
-- available to whoever re-derives the argument above. Consistency here is worth one line.
--
-- ── Consistent about the default, not about the grant ───────
--
-- 0012 follows its revokes with `grant execute ... to service_role`, and this file does
-- not. That is deliberate and the difference is real: post_content_hash and
-- post_audit_snapshot are needed by M2's publisher, which runs as service_role and computes
-- a hash to compare against the approved one. Nothing outside a trigger has ever needed
-- user_role_snapshot, so granting it "for symmetry" would hand out a capability to make a
-- pair of comments match.
--
-- What is being made consistent is the absence of a PUBLIC grant. What each function is
-- then deliberately granted to is a separate question with a separate answer.
--
-- ── Why this is safe ─────────────────────────────────────────
--
-- The only caller is user_roles_write_audit(), which is SECURITY DEFINER (0013) and
-- therefore executes as the function owner, not as whoever wrote to user_roles. Revoking
-- from PUBLIC cannot break the audit trail. 16_function_grants.test.sql asserts a role
-- change still writes its audit row afterwards, so this is not taken on faith.
--
-- The eight functions that KEEP their PUBLIC grant keep it for a reason, and 0016 is not
-- the place to find it — see 16_function_grants.test.sql, which names each one.

set search_path = public, extensions;

revoke execute on function public.user_role_snapshot(public.user_roles) from public;

comment on function public.user_role_snapshot(public.user_roles) is
  'Audit shaping for user_roles. Revoked from PUBLIC to match post_audit_snapshot (0012) — its only caller is a SECURITY DEFINER trigger.';
