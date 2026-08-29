/* The withdrawal endpoint.
 *
 * Called from the member's own profile screen, and from the admin dashboard for somebody
 * else, so it carries CORS and a user JWT.
 *
 * ── This handler authorises nothing ──────────────────────────
 *
 * §5: "The sign-in gate and the admin UI are UX only — never a guard." There is no role
 * check in this file. 0051 checks `is_admin()` inside the database from the caller's own
 * token, and a member who POSTs somebody else's id here gets `forbidden` from Postgres
 * rather than from TypeScript.
 *
 * The 401 below is not authorisation either: it is the absence of a token to pass on, which
 * makes the RPC unmakeable rather than unauthorised.
 *
 * ── `user_id` is optional, and omitting it is the common case ─
 *
 * 0051 defaults the target to auth.uid(). A member withdrawing their own account sends an
 * empty body, so the browser never has to name an id at all — there is no request shape in
 * which a typo aims this at somebody else.
 */

import { bearer, corsHeaders, env, fail, json } from "../_shared/http.ts";
import { r2BucketPrefix, r2Endpoint, R2Sink } from "../_shared/r2.ts";
import { PostgrestDeletionDb } from "./db.ts";
import { deleteAccount } from "./deletion.ts";
import { GoTrueScrubber } from "./gotrue.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return fail("method_not_allowed", 405, req);

  const jwt = bearer(req);
  if (!jwt) return fail("unauthenticated", 401, req);

  // An empty body is legal and means "me" — see the header. Only a malformed one is not.
  let body: Record<string, unknown> = {};
  const raw = (await req.text()).trim();
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return fail("invalid_json", 400, req);
    }
  }

  let userId: string | null = null;
  if (typeof body.user_id === "string" && body.user_id.trim()) {
    userId = body.user_id.trim();
    if (!UUID.test(userId)) return fail("invalid_user_id", 400, req);
  }

  const outcome = await deleteAccount(userId, {
    db: new PostgrestDeletionDb(jwt),
    auth: new GoTrueScrubber(),
    avatars: new R2Sink({
      accountId: env("R2_ACCOUNT_ID"),
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
      endpoint: r2Endpoint(),
      bucketPrefix: r2BucketPrefix(),
      bucket: "public",
    }),
  });

  const status = !outcome.ok
    ? outcome.reason === "forbidden"
      ? 403
      : outcome.reason === "unknown_profile"
      ? 404
      : 400
    : outcome.auth_scrubbed && outcome.avatar_removed !== false
    ? 200
    // 207: the profile IS anonymized — the name, avatar and bio are gone from every surface
    // a reader can reach — and something behind it did not finish. Not 200, because a
    // contributor must never be told their account is gone while their email is still in
    // auth.users; not 500, because the half that governs what anyone can see did happen,
    // and a 500 reads as total failure and invites a retry from scratch rather than the
    // idempotent one this needs.
    : 207;

  return json(outcome, status, req);
}
