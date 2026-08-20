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
 * The two things this function does that reach outside itself.
 *
 * Injectable for one reason: the rollback below is the fix for a defect that only appears
 * when the worker invocation FAILS, and a failure that cannot be simulated cannot be
 * asserted. Without this seam the most consequential branch in the file would ship with
 * every other branch tested and this one reasoned about.
 *
 * Production passes nothing and gets the real pair.
 */
export interface Deps {
  rpc: typeof rpc;
  fetch: typeof fetch;
}

const LIVE: Deps = { rpc, fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

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

export async function handleRequest(req: Request, deps: Deps = LIVE): Promise<Response> {
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
  const res = await deps.rpc("begin_ingest", { p_object_key: objectKey }, jwt);
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
      // Out of retries (migration 0031). 429 rather than 400: nothing about the request is
      // malformed, the caller has simply exhausted a ceiling, which is what 429 means.
      : reason === "too_many_attempts"
      ? 429
      : 400;
    return fail(reason, status, req, {
      state: begun?.state,
      attempts: begun?.attempts,
      max_attempts: begun?.max_attempts,
    });
  }

  // Already handed to a worker by an earlier call. Reporting 200 rather than an error is
  // deliberate: a client retrying after a dropped response has done nothing wrong, and
  // the correct outcome for it is "your upload is being processed".
  if (begun.already_processing === true) {
    return json({ ok: true, post_id: begun.post_id, status: "processing" }, 200, req);
  }

  // ── 4 · wake the worker ────────────────────────────────────
  //
  // Every exit from here that is not a successful hand-off releases the row first. That is
  // the fix for a defect worth naming precisely, because the 502s below always looked
  // correct and the damage was one call later:
  //
  //   1  begin_ingest moves the row to 'processing'
  //   2  the invocation fails — the function returns 502, honestly
  //   3  the client retries; begin_ingest answers already_processing
  //   4  this function returns 200 { status: "processing" } — for a job no worker ever saw
  //
  // Step 4 is the lie, and it is permanent: the client is told to stop worrying, so nothing
  // ever retries and the upload neither completes nor fails. Releasing at step 2 means
  // step 3 finds the row back in 'awaiting_bytes' and actually re-invokes.
  //
  // The retry is bounded by posts.ingest_attempts (migration 0031), which is what stops
  // this from becoming a way to spawn Cloud Run instances in a loop.
  const abandon = async (error: string, status: number, detail: Record<string, unknown>) => {
    let released = false;
    try {
      const r = await deps.rpc("release_ingest", { p_object_key: objectKey }, jwt);
      released = r.ok && (await r.json())?.ok === true;
    } catch {
      // The database is unreachable too. The row stays in 'processing' — the state this
      // whole block exists to avoid — but there is nothing further to try, and reporting
      // `released: false` is what tells an operator which of the two happened.
      released = false;
    }
    return fail(error, status, req, { ...detail, post_id: begun.post_id, released });
  };

  // Unset until the worker is deployed. Reported as 503 rather than pretending success,
  // because the post is now in 'processing' and a client told "ok" would never retry.
  const workerUrl = Deno.env.get("MEDIA_WORKER_URL");
  const workerSecret = Deno.env.get("MEDIA_WORKER_SECRET");
  if (!workerUrl || !workerSecret) {
    return await abandon("worker_not_configured", 503, {});
  }

  const { body: jobBody, signature } = await signJob(
    { object_key: objectKey, post_id: begun.post_id },
    workerSecret,
  );

  try {
    const workerRes = await deps.fetch(`${workerUrl.replace(/\/$/, "")}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Signature": signature },
      body: jobBody,
    });
    if (!workerRes.ok) {
      // Includes the worker's own 503 when it is already busy: that is a job it did not
      // take, so releasing sends the retry to a different instance rather than stranding
      // this one behind a queue that does not exist.
      return await abandon("worker_rejected_job", 502, { worker_status: workerRes.status });
    }
  } catch {
    return await abandon("worker_unreachable", 502, {});
  }

  // Handed over. From here the row is genuinely a worker's responsibility, and a worker
  // that accepts a job and then dies is the stuck-job gap 0028 named — still open, and the
  // only way to reach it.
  //
  // attempt and max_attempts (migration 0040) are what stop "processing" from being an
  // open-ended promise. A client that knows it is on attempt 3 of 3 knows a failure now is
  // terminal; one on attempt 1 knows a retry is coming. Both used to see the same word.
  //
  // NOT reported yet: when to stop waiting. That is expect_by, and it is derived from the
  // reaper's lease, which is derived from JOB_DEADLINE_MS — a number still carrying an
  // unmeasured factor. It is a client-facing contract, so it ships once, at the real
  // figure, rather than being published now and corrected later.
  return json({
    ok: true,
    post_id: begun.post_id,
    status: "processing",
    attempt: begun.attempts,
    max_attempts: begun.max_attempts,
  }, 202, req);
}
