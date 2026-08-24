/* The takedown endpoint.
 *
 * Called from admin.js by a moderator, so it carries CORS and a user JWT — unlike the
 * publisher, which no browser touches.
 *
 * ── This handler authorises nothing ──────────────────────────
 *
 * §5: "The sign-in gate and the admin UI are UX only — never a guard." The same applies
 * here. There is no role check in this file. request_takedown checks is_moderator() inside
 * the database, from the caller's own token, and a member calling this endpoint directly
 * with a valid JWT gets `forbidden` from Postgres rather than from TypeScript.
 *
 * The 401 below is not authorisation either: it is the absence of a token to pass on, which
 * makes the RPC unmakeable rather than unauthorised.
 */

import { bearer, corsHeaders, env, fail, json } from "../_shared/http.ts";
import { r2BucketPrefix, r2Endpoint, R2Sink } from "../_shared/r2.ts";
import { cloudflareFromEnv, CloudflarePurger } from "./cdn.ts";
import { PostgrestTakedownDb } from "./db.ts";
import { takeDown } from "./takedown.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** moderation_actions_note_length. Trimmed here, not left to abort the insert. */
const NOTE_MAX = 200;

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return fail("method_not_allowed", 405, req);

  const jwt = bearer(req);
  if (!jwt) return fail("unauthenticated", 401, req);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_json", 400, req);
  }

  const postId = typeof body.post_id === "string" ? body.post_id.trim() : "";
  if (!UUID.test(postId)) return fail("invalid_post_id", 400, req);

  // Trimmed rather than left to violate the constraint — a note that aborted the insert
  // would do so AFTER the post was marked, inside the same statement, rolling back a
  // takedown the moderator believes they performed.
  const rawNote = typeof body.note === "string" ? body.note.trim() : "";
  const note = rawNote ? rawNote.slice(0, NOTE_MAX) : null;

  // endpoint: unset in production, which signs for Cloudflare. §8 says takedown deletes the
  // bytes; until this was here, "the bytes are gone" had only ever been asserted against a
  // fake sink that recorded the call. Read once and shared by both buckets, so a takedown
  // can never end up deleting the derivative from one store and the master from another.
  const r2 = {
    accountId: env("R2_ACCOUNT_ID"),
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    endpoint: r2Endpoint(),
    bucketPrefix: r2BucketPrefix(),
  };
  const publicSink = new R2Sink({ ...r2, bucket: "public" });

  const outcome = await takeDown(postId, note, {
    db: new PostgrestTakedownDb(jwt),
    sinks: {
      public: publicSink,
      originals: new R2Sink({ ...r2, bucket: "originals" }),
    },
    cdn: new CloudflarePurger(cloudflareFromEnv(Deno.env.get("CDN_ORIGIN") ?? "")),
    redactionSink: publicSink,
  });

  const status = outcome.ok
    ? 200
    : outcome.reason === "forbidden"
    ? 403
    : outcome.reason === "unknown_post"
    ? 404
    // 207: the post IS marked and hidden, and some part of the removal did not complete.
    // Not 200, because a moderator must never be told a takedown finished while bytes are
    // still served; not 500, because the thing that matters most — the item is no longer
    // listed and the database says so — did happen, and a 500 reads as total failure and
    // invites a retry from scratch rather than the targeted one this needs.
    : 207;

  return json(outcome, status, req);
}
