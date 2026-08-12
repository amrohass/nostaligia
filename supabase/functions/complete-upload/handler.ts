// complete-upload — the client says its bytes are in quarantine.
//
// request-upload signed a URL and created a draft post. The browser PUT the file straight
// to R2, which tells nobody. This is how the system finds out, and how the worker gets
// woken.
//
//   1  shape      an object key, nothing else
//   2  auth       who is this
//   3  begin      awaiting_bytes -> processing, ownership checked in the database
//   4  invoke     hand the job to the worker
//
// ── No Turnstile here, deliberately ──────────────────────────
//
// §6 puts Turnstile on signup and submit, and the submit is request-upload — the caller
// already solved one to get the signed URL. A Turnstile token is single-use, so requiring
// a second here would mean solving the widget twice for one logical action, and the
// widget cannot be solved at all from the background retry this endpoint is designed to
// tolerate. What this endpoint needs protecting from is repetition, and that is handled
// where it can actually be enforced: begin_ingest moves the row out of awaiting_bytes on
// the first call, so the second one invokes nothing.
//
// ── Why the caller cannot lie about the key ──────────────────
//
// It could send someone else's object key. begin_ingest refuses it twice over — the key
// must be under auth.uid(), and the row's created_by must match — and auth.uid() comes
// from PostgREST verifying the token, not from anything this function asserts. So the
// ownership check is not in this file at all, which is where §5 says it belongs.

import { bearer, corsHeaders, fail, json, rpc } from "../_shared/http.ts";

interface WorkerJob {
  object_key: string;
  post_id: string;
}

/**
 * Signs the job with a shared secret so the worker will not take work from anyone else.
 *
 * The timestamp is inside the signed payload rather than beside it: a signature that does
 * not cover the time it was made can be replayed forever. The worker rejects anything
 * older than its own window.
 */
async function signJob(job: WorkerJob, secret: string): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify({ ...job, issued_at: new Date().toISOString() });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const signature = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { body, signature };
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

  const objectKey = typeof body.object_key === "string" ? body.object_key.trim() : "";
  if (!objectKey) return fail("invalid_object_key", 400, req);

  // ── 2 · auth ───────────────────────────────────────────────
  const jwt = bearer(req);
  if (!jwt) return fail("unauthenticated", 401, req);

  // ── 3 · claim the transition ───────────────────────────────
  const res = await rpc("begin_ingest", { p_object_key: objectKey }, jwt);
  if (res.status === 401 || res.status === 403) return fail("unauthenticated", 401, req);
  if (!res.ok) return fail("begin_ingest_failed", 502, req);

  const begun = await res.json();
  if (begun?.ok !== true) {
    const reason = begun?.reason ?? "begin_ingest_failed";
    const status = reason === "unauthenticated"
      ? 401
      : reason === "object_key_not_owned"
      ? 403
      : reason === "unknown_object"
      ? 404
      : reason === "terminal_state"
      ? 409
      : 400;
    return fail(reason, status, req, { state: begun?.state });
  }

  // Already handed to a worker by an earlier call. Reporting 200 rather than an error is
  // deliberate: a client retrying after a dropped response has done nothing wrong, and
  // the correct outcome for it is "your upload is being processed".
  if (begun.already_processing === true) {
    return json({ ok: true, post_id: begun.post_id, status: "processing" }, 200, req);
  }

  // ── 4 · wake the worker ────────────────────────────────────
  //
  // Unset until the worker is deployed. Reported as 503 rather than pretending success,
  // because the post is now in 'processing' and a client told "ok" would never retry —
  // it would simply never finish. The state is recoverable; a silent lie is not.
  const workerUrl = Deno.env.get("MEDIA_WORKER_URL");
  const workerSecret = Deno.env.get("MEDIA_WORKER_SECRET");
  if (!workerUrl || !workerSecret) {
    return fail("worker_not_configured", 503, req, { post_id: begun.post_id });
  }

  const { body: jobBody, signature } = await signJob(
    { object_key: objectKey, post_id: begun.post_id },
    workerSecret,
  );

  try {
    const workerRes = await fetch(`${workerUrl.replace(/\/$/, "")}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body: jobBody,
    });
    if (!workerRes.ok) {
      // The row stays in 'processing'. Until the M6 reaper exists that is a stuck job
      // rather than a lost one, and saying so is more useful than a generic 502.
      return fail("worker_rejected_job", 502, req, {
        post_id: begun.post_id,
        worker_status: workerRes.status,
      });
    }
  } catch {
    return fail("worker_unreachable", 502, req, { post_id: begun.post_id });
  }

  return json({ ok: true, post_id: begun.post_id, status: "processing" }, 202, req);
}
