// Who is allowed to give this worker work.
//
// The worker is reachable on the public internet (see worker/README.md for why Cloud Run
// IAM was not used instead), so this function is the entire front door. It runs before any
// I/O: before R2 is contacted, before a byte is read, before ffmpeg exists as a thought.
// A request that fails here has cost one HMAC.
//
// ── The signature covers the timestamp ───────────────────────
//
// complete-upload puts issued_at INSIDE the signed payload rather than beside it. A
// signature that does not cover the time it was made is valid forever, so anyone who
// observes one legitimate job — a proxy log, a retained error report — can replay it. The
// window below is what makes the signature expire, and it only works because the timestamp
// is inside the bytes being verified.
//
// ── Verified against the raw body, never against a re-encode ─
//
// The body is verified as the exact text that arrived. Parsing first and re-serialising to
// check the signature would compare against JSON.stringify's key order rather than the
// sender's, and two encoders that agree today are two encoders that can disagree after an
// upgrade. Parse only after the bytes are proven.

export interface Job {
  object_key: string;
  post_id: string;
  issued_at: string;
}

export type JobVerdict =
  | { ok: true; job: Job }
  | { ok: false; reason: "missing_signature" | "bad_signature" | "malformed_job" | "stale_job" };

/** How old a signed job may be. Long enough for a retry, short enough to be worthless later. */
export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function signBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
}

/**
 * Compares two hex digests without leaking where they first differ.
 *
 * A plain `===` on strings short-circuits at the first differing character, and the timing
 * of that is measurable across enough requests — which turns forging a signature from
 * "break SHA-256" into "send a few million requests and read the clock". The length check
 * is not constant-time and does not need to be: both sides are fixed-length hex, so length
 * carries no secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Is this a job from complete-upload, issued recently enough to act on?
 *
 * `now` is injected so the replay window is testable without waiting five minutes.
 */
export async function verifyJob(
  rawBody: string,
  signature: string | null,
  secret: string,
  now: Date = new Date(),
): Promise<JobVerdict> {
  if (!signature) return { ok: false, reason: "missing_signature" };

  const expected = await signBody(rawBody, secret);
  if (!timingSafeEqual(signature.trim().toLowerCase(), expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Only now is the content worth looking at.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "malformed_job" };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "malformed_job" };
  }
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.object_key !== "string" || p.object_key.trim() === "" ||
    typeof p.post_id !== "string" || p.post_id.trim() === "" ||
    typeof p.issued_at !== "string"
  ) {
    return { ok: false, reason: "malformed_job" };
  }

  const issued = Date.parse(p.issued_at);
  if (!Number.isFinite(issued)) return { ok: false, reason: "malformed_job" };

  // Math.abs, so a job stamped in the future is refused too. Clock skew between the Edge
  // Function and Cloud Run is real but small; a timestamp hours ahead is not skew, it is
  // someone extending the window in the only direction a one-sided check leaves open.
  if (Math.abs(now.getTime() - issued) > REPLAY_WINDOW_MS) {
    return { ok: false, reason: "stale_job" };
  }

  return {
    ok: true,
    job: {
      object_key: p.object_key.trim(),
      post_id: p.post_id.trim(),
      issued_at: p.issued_at,
    },
  };
}
