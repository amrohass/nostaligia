// request-upload — the only door into the write path (CLAUDE.md §2, §6).
//
// A signed-in member asks for permission to upload one file. If every gate below
// passes, they get a presigned PUT into `quarantine/` that is good for five minutes,
// bound to the exact size and type they declared. Nothing they send is trusted except
// as a DECLARATION to be checked; the bytes themselves are not validated here at all,
// because they do not exist yet. That is the processing function's job (piece 2), and
// it re-checks everything by magic bytes rather than believing this declaration.
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

// ── Caps, §6 ─────────────────────────────────────────────────
// 1024-based, matching how every operating system reports a file size to the person
// choosing the file. "200 MB" in a UI that means MiB and a limit that means 10^6 is a
// support ticket from someone whose 199 MB file was refused.
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const ROLE_CAPS = {
  member: { maxBytes: 200 * MiB, maxDurationS: 3 * 60 },
  moderator: { maxBytes: 4 * GiB, maxDurationS: 20 * 60 },
  admin: { maxBytes: 4 * GiB, maxDurationS: 20 * 60 },
} as const;

type Role = keyof typeof ROLE_CAPS;

const QUARANTINE_BUCKET = "quarantine";
const URL_TTL_SECONDS = 300;

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

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

// ── CORS ─────────────────────────────────────────────────────
// Origins come from the environment, never from a constant — §2 keeps every origin in
// one place, and this function is deployed separately from the site so it cannot read
// config/site.json. An unset variable yields no CORS headers at all, which fails
// closed for browsers while leaving curl (no Origin header) working, so the endpoint
// is testable before the front end exists.
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (!origin) return {};
  const allowed = (Deno.env.get("UPLOAD_ALLOWED_ORIGINS") ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(req) },
  });
}

function fail(error: string, status: number, req: Request, detail?: unknown) {
  return json(detail === undefined ? { error } : { error, detail }, status, req);
}

/**
 * Reads app_metadata.user_role out of a JWT WITHOUT verifying it.
 *
 * That is safe only because of how the result is used: it can lower the effective
 * role and never raise it. Treat the return value as attacker-controlled — it is.
 */
function claimedRole(jwt: string): Role | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const pad = payload.length % 4 === 0 ? "" : "=".repeat(4 - (payload.length % 4));
    const decoded = atob(payload.replace(/-/g, "+").replace(/_/g, "/") + pad);
    const role = JSON.parse(decoded)?.app_metadata?.user_role;
    return role === "moderator" || role === "admin" || role === "member" ? role : null;
  } catch {
    return null;
  }
}

/** Whichever of the two grants less. Unknown or missing resolves toward member. */
function effectiveRole(claim: Role | null, db: Role): Role {
  if (claim === null) return db; // hook not enabled; the database still governs
  const rank: Record<Role, number> = { member: 0, moderator: 1, admin: 2 };
  return rank[claim] < rank[db] ? claim : db;
}

async function rpc(name: string, args: unknown, jwt: string): Promise<Response> {
  return await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env("SUPABASE_ANON_KEY"),
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
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
    return body?.success === true;
  } catch {
    return false; // a verifier we cannot reach is a verifier that did not pass us
  }
}

Deno.serve(async (req: Request) => {
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

  // §6 names SVG specifically, so it gets its own refusal rather than falling through
  // the allowlist as an anonymous "unsupported type". The reason is worth being able
  // to grep for in the logs.
  if (mime.startsWith("image/svg")) return fail("svg_rejected", 415, req);

  const family = ALLOWED_MIME[mime];
  if (!family) return fail("unsupported_type", 415, req);

  if (!Number.isSafeInteger(bytes) || bytes <= 0) return fail("invalid_bytes", 400, req);

  // Duration is meaningless for a still image and mandatory for anything timed —
  // without it the §6 duration cap is unenforceable, so absence is a refusal, not a
  // default.
  if (family !== "image") {
    if (durationS === null || !Number.isFinite(durationS) || durationS <= 0) {
      return fail("duration_required", 400, req);
    }
  }

  if (!turnstileToken) return fail("turnstile_required", 400, req);

  // ── 2 · auth ───────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return fail("unauthenticated", 401, req);
  const jwt = authHeader.slice(7).trim();
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

  // ── 5 · quota — the first thing that writes ────────────────
  const quotaRes = await rpc("claim_upload_quota", { p_bytes: bytes }, jwt);
  if (!quotaRes.ok) return fail("quota_check_failed", 502, req);
  const quota = await quotaRes.json();

  if (quota?.allowed !== true) {
    const status = quota?.reason === "unauthenticated" ? 401 : 429;
    return fail(quota?.reason ?? "quota_exceeded", status, req, {
      count: quota?.count,
      limit_count: quota?.limit_count,
      bytes: quota?.bytes,
      limit_bytes: quota?.limit_bytes,
    });
  }

  // ── 6 · the signed URL ─────────────────────────────────────
  //
  // The subject is taken from the token only after PostgREST has verified its
  // signature twice over, so it is as trustworthy as auth.uid() by this point.
  //
  // The key is a random UUID under the uploader's id. Nothing the caller sent goes
  // into the path: a filename is attacker-controlled and belongs nowhere near an
  // object key, and the original name is metadata for the posts row, not a location.
  const sub = (() => {
    try {
      const p = jwt.split(".")[1];
      const pad = p.length % 4 === 0 ? "" : "=".repeat(4 - (p.length % 4));
      return JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/") + pad))?.sub ?? null;
    } catch {
      return null;
    }
  })();
  if (typeof sub !== "string" || !sub) return fail("unauthenticated", 401, req);

  const objectKey = `${sub}/${crypto.randomUUID()}`;

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
    role,
    quota: {
      count: quota.count,
      limit_count: quota.limit_count,
      bytes: quota.bytes,
      limit_bytes: quota.limit_bytes,
    },
  }, 200, req);
});
