// request-upload — the only door into the write path (CLAUDE.md §2, §6).
//
// A signed-in member asks for permission to upload one file. If every gate below
// passes, they get a presigned PUT into `quarantine/` that is good for five minutes,
// bound to the exact size and type they declared. Nothing they send is trusted except
// as a DECLARATION to be checked; the bytes themselves are not validated here at all,
// because they do not exist yet. That is the processing function's job (piece 2), and
// it re-checks everything by magic bytes rather than believing this declaration.
//
// The handler is exported from here rather than passed straight to Deno.serve in
// index.ts so that it can be called directly from a test with a constructed Request.
// Gate 1 reaches no network and reads no environment, so every refusal in it is
// unit-testable with no credentials and no deployment — see handler.test.ts.
//
// ── The order of the gates is deliberate ─────────────────────
//
//   1  shape        cheap, no I/O, rejects nonsense before it costs anything
//   2  auth         who is this
//   3  Turnstile    is it a human
//   4  caps         may this role upload something this big / this long   (§6)
//   5  quota        have they had enough today                           (§6)
//   6  signed URL   the only side effect
//
// Quota is charged LAST of the checks, because a charge is a write and every earlier
// gate can refuse. Charge first and a member who declares an SVG twenty times has
// spent their day without uploading anything — a self-inflicted denial of service that
// an attacker can also inflict on someone else's account if they ever get a token.
//
// ── Where authorization actually comes from ──────────────────
//
// §6: caps are read "from the JWT role claim — never from a client-declared value."
// This does that, and then does not stop there. The claim is read from the token, and
// the authoritative role is read from the DATABASE by the same call that charges the
// quota — `claim_upload_quota` resolves authz_role() itself. The effective role is
// whichever of the two grants LESS.
//
// That matters in one direction that a claim alone gets wrong: a moderator demoted
// five minutes ago still carries `moderator` in an unexpired token, and would keep 4 GB
// caps for up to an hour. Taking the minimum closes that window. The reverse case — a
// member just promoted, whose token has not refreshed — resolves to member caps until
// they sign in again, which is the conservative direction and the correct one.
//
// When the claim is ABSENT the database role is used alone. Absence means the
// access-token hook is not enabled on the project, not that anything was stripped: the
// token is signed, so a claim cannot be removed without invalidating it. The database
// is authoritative either way, so this cannot over-grant.
//
// ── This does not depend on verify_jwt ───────────────────────
//
// The Edge gateway verifies the bearer token before this code runs, and config.toml
// asks for that explicitly. But a function whose only authentication is a platform
// setting fails open the day someone deploys with --no-verify-jwt. So the token is
// also handed to PostgREST, which verifies the signature itself and derives auth.uid()
// from it. An unauthenticated caller gets `unauthenticated` back from the database and
// never reaches the signing step, whatever the gateway did or did not do.

import { presignR2Put } from "../_shared/sigv4.ts";
import { bearer, corsHeaders, env, fail, json, rpc, unverifiedClaim } from "../_shared/http.ts";
import { r2BucketPrefix, r2Endpoint } from "../_shared/r2.ts";

// ── Caps, §6 ─────────────────────────────────────────────────
// 1024-based, matching how every operating system reports a file size to the person
// choosing the file. "200 MB" in a UI that means MiB and a limit that means 10^6 is a
// support ticket from someone whose 199 MB file was refused.
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// Exported so the table itself can be pinned, not merely the ceiling derived from it.
// ABSOLUTE_MAX_BYTES is a Math.max over these rows, so widening the MEMBER row leaves it
// unchanged at 4 GiB — every assertion about the ceiling stays green while a member
// silently acquires a moderator's per-file allowance. Measured by mutation.
export const ROLE_CAPS = {
  member: { maxBytes: 200 * MiB, maxDurationS: 3 * 60 },
  moderator: { maxBytes: 4 * GiB, maxDurationS: 20 * 60 },
  admin: { maxBytes: 4 * GiB, maxDurationS: 20 * 60 },
} as const;

type Role = keyof typeof ROLE_CAPS;

// The largest cap ANY role has. Derived from the table rather than written as a literal,
// so raising a role's cap cannot leave a stale absolute ceiling quietly refusing what §6
// now permits.
export const ABSOLUTE_MAX_BYTES = Math.max(
  ...Object.values(ROLE_CAPS).map((c) => c.maxBytes),
);

const QUARANTINE_BUCKET = "quarantine";

/**
 * How long the presigned PUT stays usable.
 *
 * Exported so it can be pinned. A leaked or logged upload URL is a write into the
 * quarantine bucket by anyone holding it, bounded only by this number and by the
 * content-length the signature covers — so it is a security parameter, not a convenience
 * one, and it must not be able to grow unnoticed.
 *
 * Five minutes is set against the slowest legitimate case: a member on a Ramallah mobile
 * connection has to START the PUT within it, not finish it. S3 checks the signature's
 * expiry when the request begins.
 */
export const URL_TTL_SECONDS = 300;

/**
 * Where the presigned PUT points. Undefined — the normal case — means Cloudflare R2.
 *
 * The rule is the one worker/src/main.ts states at buildStore(), and it is the same rule
 * here: it is selected by an explicit opt-in, never by a missing credential — a store that
 * silently falls back when R2 is misconfigured would report success while writing the
 * archive nowhere. There is no inference from an absent variable, no "if not production",
 * and no default other than Cloudflare. Unset R2_ENDPOINT signs for R2, and nothing else
 * can cause that not to happen.
 *
 * It exists so scripts/lifecycle.sh can drive the real upload path against MinIO — the
 * browser has to PUT to something, and a URL signed for Cloudflare is not usable by a
 * harness with no R2 account. Not a security surface: see ../_shared/sigv4.ts:101-112 —
 * the endpoint is not a secret, it is covered by the signature through the host header,
 * and pointing it somewhere else cannot widen what the URL authorises, only produce a URL
 * R2 would reject.
 *
 * A malformed value THROWS. The caller below turns that into `signing_failed` without
 * echoing a reason, which is the same treatment a malformed R2 credential already gets.
 * Falling back to R2 on a broken override would mean a harness that believed it was
 * talking to MinIO while handing out Cloudflare URLs — the silent success this whole
 * comment exists to refuse, inverted.
 *
 * MOVED to ../_shared/r2.ts, and re-exported here so this module's public surface and its
 * tests are unchanged. It used to be six lines duplicated from the worker; the publisher
 * and takedown now need the same behaviour, and a third copy is where a rule starts
 * drifting. _shared/r2.ts rather than _shared/sigv4.ts, because the signer is deliberately
 * free of I/O and of anything ambient and an environment read belongs nowhere near it —
 * see that file's header. The WORKER still keeps its own copy, on the reasoning its own
 * header gives: it imports exactly two modules from _shared and a third dependency is a
 * worse trade than six lines.
 */
export { r2Endpoint } from "../_shared/r2.ts";

// Declared types only. The processing function re-derives the real type from magic
// bytes and rejects anything that disagrees with this — an allowlist here keeps the
// obvious junk out of the bucket, it does not establish what the file is.
const ALLOWED_MIME: Record<string, "image" | "video" | "audio"> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/webp": "image",
  "image/avif": "image",
  "image/tiff": "image",
  "image/heic": "image",
  "image/heif": "image",
  "video/mp4": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "video/x-matroska": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/aac": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "audio/webm": "audio",
  "audio/flac": "audio",
};

/**
 * Reads app_metadata.user_role out of a JWT WITHOUT verifying it.
 *
 * That is safe only because of how the result is used: it can lower the effective
 * role and never raise it. Treat the return value as attacker-controlled — it is.
 */
export function claimedRole(jwt: string): Role | null {
  const role = unverifiedClaim(jwt, ["app_metadata", "user_role"]);
  return role === "moderator" || role === "admin" || role === "member" ? role : null;
}

/** Whichever of the two grants less. Unknown or missing resolves toward member. */
export function effectiveRole(claim: Role | null, db: Role): Role {
  if (claim === null) return db; // hook not enabled; the database still governs
  const rank: Record<Role, number> = { member: 0, moderator: 1, admin: 2 };
  return rank[claim] < rank[db] ? claim : db;
}

async function turnstileOk(token: string, remoteIp: string | null): Promise<boolean> {
  const form = new FormData();
  form.append("secret", env("TURNSTILE_SECRET_KEY"));
  form.append("response", token);
  // §7 says do not store IPs. Cloudflare's own verification is not storage by us, and
  // it materially improves the signal, so it is passed and never written down.
  if (remoteIp) form.append("remoteip", remoteIp);

  try {
    const r = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
    );
    const body = await r.json();
    if (body?.success === true) return true;

    // ── Why the error codes are LOGGED and still not returned ──
    //
    // Collapsing this to a boolean is what made the 1 Sep drift invisible. `invalid-input-
    // secret` (the SECRET is not one Cloudflare recognises — an operator's mistake, and
    // every upload fails for everyone) and `invalid-input-response` (the TOKEN was judged
    // and refused — one visitor, working as designed) are opposite conditions with opposite
    // responses, and both reached the caller as the same `turnstile_failed`. There was
    // nowhere to look, so the only way to learn which one was happening was for somebody to
    // notice uploads were broken.
    //
    // The distinction belongs to the operator, not the caller: telling a client which of the
    // two it hit would let an attacker probe our configuration, and it does not change what
    // they should do. So it goes to the function log, and the response is unchanged.
    console.error("turnstile: verification failed", {
      codes: Array.isArray(body?.["error-codes"]) ? body["error-codes"] : [],
    });
    return false;
  } catch (e) {
    // A verifier we cannot reach is a verifier that did not pass us -- but a Cloudflare
    // outage and a wrong secret are also different problems, and this used to look like
    // neither.
    console.error("turnstile: verifier unreachable", { error: String(e) });
    return false;
  }
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") return fail("method_not_allowed", 405, req);

  // ── 1 · shape ──────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_json", 400, req);
  }

  const mime = typeof body.mime === "string" ? body.mime.toLowerCase().trim() : "";
  const bytes = Number(body.bytes);
  const durationS = body.duration_s === undefined ? null : Number(body.duration_s);
  const turnstileToken = typeof body.turnstile_token === "string" ? body.turnstile_token : "";
  const kind = typeof body.kind === "string" ? body.kind.trim() : "";
  // Passed through to claim_upload_slot rather than validated here. The database already
  // names the refusals (title_required, description_required) and enforces the matching
  // constraints, so re-checking in the client-facing layer would be a second copy of a
  // rule that can drift from the one that actually binds.
  const draft = (body.draft && typeof body.draft === "object" && !Array.isArray(body.draft))
    ? body.draft
    : {};

  // §6 names SVG specifically, so it gets its own refusal rather than falling through
  // the allowlist as an anonymous "unsupported type". The reason is worth being able
  // to grep for in the logs.
  if (mime.startsWith("image/svg")) return fail("svg_rejected", 415, req);

  const family = ALLOWED_MIME[mime];
  if (!family) return fail("unsupported_type", 415, req);

  if (!Number.isSafeInteger(bytes) || bytes <= 0) return fail("invalid_bytes", 400, req);

  // A declaration above the largest cap in §6 can never be admitted, whoever is asking.
  // It is refused HERE, in the free gate, rather than at gate 4 after a Turnstile
  // round-trip — and the round-trip is not the point. A Turnstile token is SINGLE-USE,
  // so a refusal after gate 3 makes the member re-solve the widget before they can
  // retry with a smaller file. Refusing an impossible size costs them nothing.
  //
  // This does not replace the role cap at gate 4. That one is the real limit; this only
  // rules out what no role could ever permit, which is why it can run before we know
  // who is asking.
  if (bytes > ABSOLUTE_MAX_BYTES) {
    return fail("over_absolute_cap", 413, req, { max_bytes: ABSOLUTE_MAX_BYTES });
  }

  // Duration is meaningless for a still image and mandatory for anything timed —
  // without it the §6 duration cap is unenforceable, so absence is a refusal, not a
  // default.
  if (family !== "image") {
    if (durationS === null || !Number.isFinite(durationS) || durationS <= 0) {
      return fail("duration_required", 400, req);
    }
  }

  if (!turnstileToken) return fail("turnstile_required", 400, req);

  // The client declares what this is going to be. The alternative — inferring it from the
  // sniffed family after ingest — would mean the worker mutating `kind`, and `kind` is
  // inside the approval content hash, so a worker write there could un-approve a post.
  // The front end knows the upload context, so it says so up front.
  if (kind !== "media" && kind !== "voice" && kind !== "event") {
    return fail("invalid_kind", 400, req);
  }

  // ── 2 · auth ───────────────────────────────────────────────
  const jwt = bearer(req);
  if (!jwt) return fail("unauthenticated", 401, req);

  // ── 3 · Turnstile ──────────────────────────────────────────
  const ip = req.headers.get("CF-Connecting-IP");
  if (!await turnstileOk(turnstileToken, ip)) return fail("turnstile_failed", 403, req);

  // ── 4 · role, then caps ────────────────────────────────────
  const roleRes = await rpc("authz_role", {}, jwt);
  if (roleRes.status === 401 || roleRes.status === 403) {
    return fail("unauthenticated", 401, req);
  }
  if (!roleRes.ok) return fail("role_lookup_failed", 502, req);

  const dbRoleRaw = await roleRes.json();
  if (dbRoleRaw === null) return fail("unauthenticated", 401, req);
  if (dbRoleRaw !== "member" && dbRoleRaw !== "moderator" && dbRoleRaw !== "admin") {
    return fail("role_lookup_failed", 502, req);
  }

  const role = effectiveRole(claimedRole(jwt), dbRoleRaw as Role);
  const caps = ROLE_CAPS[role];

  if (bytes > caps.maxBytes) {
    return fail("over_size_cap", 413, req, { role, max_bytes: caps.maxBytes });
  }
  if (durationS !== null && durationS > caps.maxDurationS) {
    return fail("over_duration_cap", 413, req, { role, max_duration_s: caps.maxDurationS });
  }

  // ── 5 · the object key ─────────────────────────────────────
  //
  // Built before the quota is claimed, because the key is now part of what is claimed:
  // the slot and the draft post are one transaction (migration 0027).
  //
  // The subject is read from the token, which PostgREST has already verified twice over
  // by this point, so it is as trustworthy as auth.uid(). It is not trusted blindly
  // either — claim_upload_slot re-derives auth.uid() itself and refuses a key that is not
  // under it, so a bug here cannot attach a draft to somebody else's upload.
  //
  // A random UUID under the uploader's id. Nothing the caller sent goes into the path: a
  // filename is attacker-controlled and belongs nowhere near an object key, and the
  // original name is metadata for the posts row, not a location.
  const sub = unverifiedClaim(jwt, ["sub"]);
  if (typeof sub !== "string" || !sub) return fail("unauthenticated", 401, req);

  const objectKey = `${sub}/${crypto.randomUUID()}`;

  // ── 6 · quota and draft — the first thing that writes ──────
  const slotRes = await rpc("claim_upload_slot", {
    p_bytes: bytes,
    p_object_key: objectKey,
    p_kind: kind,
    p_draft: draft,
  }, jwt);
  if (!slotRes.ok) return fail("quota_check_failed", 502, req);
  const slot = await slotRes.json();

  if (slot?.allowed !== true) {
    // Refusals split three ways. The malformed-draft ones are the caller's mistake to
    // fix and retry; the ownership one should be unreachable from this function and is a
    // 403 rather than a 400 precisely so it stands out in the logs if it ever appears.
    const reason = slot?.reason ?? "quota_exceeded";
    const status = reason === "unauthenticated"
      ? 401
      : reason === "object_key_not_owned"
      ? 403
      : reason === "duplicate_object_key"
      ? 409
      : ["invalid_object_key", "title_required", "description_required", "invalid_bytes",
         "license_required", "invalid_license", "provenance_required", "consent_required"]
          .includes(reason)
      ? 400
      : 429;
    return fail(reason, status, req, {
      count: slot?.count,
      limit_count: slot?.limit_count,
      bytes: slot?.bytes,
      limit_bytes: slot?.limit_bytes,
      // The vocabulary invalid_license was measured against. A client that cannot
      // discover it cannot offer it, and a hardcoded second copy would drift.
      licenses: slot?.licenses,
    });
  }

  // ── 7 · the signed URL ─────────────────────────────────────

  let presigned;
  try {
    presigned = await presignR2Put({
      accountId: env("R2_ACCOUNT_ID"),
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
      bucket: QUARANTINE_BUCKET,
      key: objectKey,
      contentType: mime,
      contentLength: bytes,
      expiresIn: URL_TTL_SECONDS,
      endpoint: r2Endpoint(),
      bucketPrefix: r2BucketPrefix(),
    });
  } catch {
    // Never echo the reason: the only way this throws is a missing or malformed R2
    // credential, and naming which one is a hint nobody outside needs.
    return fail("signing_failed", 500, req);
  }

  return json({
    upload: presigned,
    bucket: QUARANTINE_BUCKET,
    object_key: objectKey,
    // The draft the client must reference when it calls complete-upload after the PUT.
    post_id: slot.post_id,
    role,
    quota: {
      count: slot.count,
      limit_count: slot.limit_count,
      bytes: slot.bytes,
      limit_bytes: slot.limit_bytes,
    },
  }, 200, req);
}
