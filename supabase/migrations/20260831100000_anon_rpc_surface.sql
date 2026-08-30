-- 0058 · Two RPCs stop being reachable by `anon`.
--
-- NOT DRIFT. Both grants are written down in 16_function_grants and were deliberate when
-- made. The systematic privilege sweep this session — every table and every function in
-- `public`, table-level AND column-level, for anon and authenticated — found no drift at
-- all: `anon` holds nothing on any of the 18 tables, RLS is on for all of them, and every
-- executable-by-anon function matched the pinned matrix. What it found instead is these
-- two, which a later milestone outgrew.
--
-- ── Why they are wrong NOW ───────────────────────────────────
--
-- §2's M3 amendment moved the public projection of a profile into a SHARD:
--
--     profile/{handle}.json — the PUBLIC projection of a profile — §7's visibility map is
--     applied at publish time, so a hidden list is an empty list in the file rather than
--     data the browser is asked to be discreet about.
--
-- public.js says the same thing from the other side: "A stranger's browser never receives
-- the hidden fields at all — it is not asked to be discreet about data it holds." And it
-- means it: the RPC is called only when `own || state.signedIn`. A signed-out visitor's
-- browser never calls it.
--
-- But the GRANT does not know that, and PostgREST publishes it. Measured on the live API
-- with nothing but the public anon key:
--
--     POST /rest/v1/rpc/profile_view {"p_handle":"member_c3f0c2dddd95"}  → 200
--     [{"id":"a12af40e-…","handle":"member_c3f0c2dddd95","role_cache":"member",
--       "member_since":2026,"is_own":false,"is_deleted":false}]
--
-- Three things wrong with that answer, in increasing order of how much they matter:
--
--   1. §2 says "Zero database reads for public visitors", and this is one.
--   2. It returns the account UUID. The published archive deliberately does not: a feed
--      item's author is {handle, display_name, avatar_path, label} and carries no id. So
--      the RPC hands out a stable cross-surface identifier that the archive withholds.
--   3. It answers for accounts with NO public presence at all — no posts, so no shard, no
--      byline, nothing. That makes it a membership oracle keyed by handle, and after 0057
--      every account has a handle. §7's stated threat is the aggregate, and "does this
--      person have an account here" is a fact this archive should not confirm to strangers.
--
-- post_like_count is simpler: no client code calls it, at all, in any role. The counts the
-- front end shows are baked into the shards at publish time (§2). It is surface with no
-- user.
--
-- ── What is NOT changed, and why ─────────────────────────────
--
-- `authenticated` and `service_role` keep both. The owner's and moderator's view of the
-- private half of a profile IS profile_view, called with their own token, and that is the
-- design §7 wants.
--
-- The ~24 trigger functions still carrying PostgreSQL's default PUBLIC grant are left
-- alone. Not out of laziness: they were tested, as anon, on the deployed database, and
-- PostgreSQL refuses every one of them independently of the grant —
--
--     select public.bump_publish_revision()  →  0A000  trigger functions can only be
--                                                      called as triggers
--
-- so revoking would be tidying a door that has no wall behind it, at the cost of a
-- migration touching two dozen functions. The same probe run against the plain helpers
-- anon can genuinely call (is_admin, authz_role, strip_bidi, normalized_handle,
-- fuzz_location) returned nothing about anybody: they report the caller's own role or
-- transform a value handed to them. fuzz_location is a documented grid snap and therefore
-- many-to-one, so calling it reveals nothing the published point does not already.

revoke execute on function public.profile_view(text)     from anon;
revoke execute on function public.post_like_count(uuid)  from anon;

-- ── And 0057 made the same mistake this file is about ────────
--
-- 0057 wrote `revoke all on function public.ensure_profile(uuid) from public, anon,
-- authenticated` — and left service_role holding EXECUTE, because Supabase's default
-- privileges grant it directly and a revoke from PUBLIC does not touch a direct grant.
-- That is 0056's lesson exactly, reproduced hours after reading it, in a migration written
-- to close a different hole. It was caught by 16_function_grants' exhaustive matrix within
-- the same session, which is the argument for having an exhaustive matrix.
--
-- Nothing is lost by revoking: ensure_profile is called only from provision_profile(), a
-- SECURITY DEFINER trigger body, so the inner call is made with the definer's rights and
-- never with the session role's. The service key could insert a profile row directly in
-- any case — this is about not publishing a second way to do it through PostgREST.
revoke execute on function public.ensure_profile(uuid)   from service_role;

comment on function public.profile_view(text) is
  'The owner''s and moderator''s view of the private half of a profile, with their own '
  'token. The PUBLIC projection is profile/{handle}.json (CLAUDE.md §2). Not anon-callable '
  'since 0058 — it returned the account uuid, and answered for accounts with no public '
  'presence at all.';
