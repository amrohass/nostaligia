/* The worker's front door — what it spends on a caller who has no business here.
 *
 *     deno test --allow-read --allow-write --allow-env worker/
 *
 * job.test.ts covers whether a signature is accepted. This file covers what happens
 * BEFORE that question can be asked, which is a different concern with a different
 * failure mode: the signature check protects the archive, and the checks here protect
 * availability. Concurrency is 1 and max-instances is 3, so anything an anonymous caller
 * can make an instance do, three of them can make the whole fleet do.
 *
 * Every assertion below is written so that deleting the thing it guards makes it fail and
 * makes nothing else fail. Where that took an unusual setup — unsetting the worker secret
 * — the reason is written at the test.
 */

import { handleRequest, MAX_JOB_BODY_BYTES } from "./main.ts";
import { signBody } from "./job.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const SECRET = "worker-secret-for-tests";

/** A POST to /jobs with a body and an already-computed signature header. */
function jobRequest(body: BodyInit, signature: string): Request {
  return new Request("https://worker.test/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": signature },
    body,
  });
}

/* ── 1 · The cap, and that it is checked first ──────────────── */

Deno.test("the cap is derived from the job payload, not chosen round", () => {
  assertEquals(MAX_JOB_BODY_BYTES, 8 * 1024, "8 KiB — see main.ts for the arithmetic");
});

// THE ordering assertion, and the reason MEDIA_WORKER_SECRET is deleted rather than set.
//
// handleRequest reads that variable to verify a signature, and env() throws when it is
// missing. So with it unset there are only two possible outcomes: a 413 from the cap,
// which is this test passing, or a thrown "missing required environment variable", which
// is what happens the moment the cap check moves below verifyJob. There is no way for
// this to pass while the body is being verified before it is bounded.
//
// `pulled` is what makes this discriminate the DECLARED branch specifically, and finding
// that out took a mutation. Asserting only the 413 does not work: disable the header check
// and the running total refuses the same request with the same status, so the assertion
// stays green over a branch that no longer exists. What the header check uniquely buys is
// that the body is never read at all — so that is the thing asserted.
//
// Content-Length is also set BY HAND here, which is not decoration either. A Request
// constructed in-process from a string carries no Content-Length — measured, not assumed —
// so a test that merely sends 9 KiB is exercising the counter while claiming to test the
// header.
Deno.test("an honest over-cap declaration is refused without reading a byte", async () => {
  Deno.env.delete("MEDIA_WORKER_SECRET");

  let pulled = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        // Bounded, so that a regression here FAILS instead of hanging. An unbounded
        // stream plus a missing cap is an infinite read, and a suite that hangs under a
        // mutation is a suite that gets its timeout raised rather than its bug fixed.
        // Measured: disabling the cap hung this file until the bound was added.
        if (++pulled > 8) return controller.close();
        controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
      },
    },
    // highWaterMark 0, or this measures nothing. A ReadableStream with the default
    // strategy calls pull() as soon as it is CONSTRUCTED, to fill a queue of one — so
    // `pulled` would be true before the handler had seen the request, and the assertion
    // below would fail against correct code. Measured, after it did exactly that.
    { highWaterMark: 0 },
  );

  const req = new Request("https://worker.test/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": "0".repeat(64),
      "Content-Length": String(MAX_JOB_BODY_BYTES + 1),
    },
    body,
  });

  const res = await handleRequest(req);
  assertEquals(res.status, 413, "an over-cap body was not refused on size");
  assertEquals((await res.json()).error, "job_too_large", "refused, but not as a size problem");
  assertEquals(pulled, 0, "the body was read despite a declaration that already refused it");
});

// The second refusal, and the one Content-Length cannot give. This request declares ten
// bytes and sends sixteen thousand: the header check reads it, believes it, and lets it
// through, so the only thing that can catch it is the running total. Chunked requests —
// which carry no declaration at all — are the same case with the lie left implicit.
//
// Removing the running total leaves the declared-length branch intact and the test above
// still green. That is the split, and it was verified by mutation rather than reasoned:
// `if (total > cap)` disabled fails this test alone.
Deno.test("...and so is a body that lies about how long it is", async () => {
  Deno.env.delete("MEDIA_WORKER_SECRET");

  const chunk = new TextEncoder().encode("x".repeat(4096));
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      // Deliberately more than the cap, in pieces each smaller than it. A counter that
      // only inspected the first chunk would let this through.
      if (sent >= MAX_JOB_BODY_BYTES * 2) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });

  const req = new Request("https://worker.test/jobs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": "0".repeat(64),
      "Content-Length": "10",
    },
    body,
  });
  assertEquals(req.headers.get("Content-Length"), "10", "test setup: the lie was not sent");

  const res = await handleRequest(req);
  assertEquals(res.status, 413, "a body that under-declared its length was read to the end");
});

// The boundary, in the direction that costs something. An off-by-one here refuses
// legitimate work, and the failure would look like a worker that intermittently drops
// jobs. 401 rather than 202 because the payload is not a valid Job — which is the proof
// that it got PAST the cap and reached verification rather than passing for some
// unrelated reason.
Deno.test("a body at exactly the cap reaches verification", async () => {
  Deno.env.set("MEDIA_WORKER_SECRET", SECRET);

  const filler = "y".repeat(MAX_JOB_BODY_BYTES - `{"pad":""}`.length);
  const body = `{"pad":"${filler}"}`;
  assertEquals(body.length, MAX_JOB_BODY_BYTES, "test setup: body is not exactly at the cap");

  const res = await handleRequest(jobRequest(body, await signBody(body, SECRET)));
  assertEquals(res.status, 401, "the largest permitted body was refused on size");
  assertEquals((await res.json()).error, "malformed_job", "it did not reach the job parser");
});

/* ── 2 · The health check says nothing but that it is alive ─── */

// /healthz is unauthenticated by necessity — a platform probe holds no signing secret —
// so its response shape is a public API. It used to carry `busy`, which told anyone with
// the URL whether the fleet was saturated. Asserting the KEY SET rather than the value of
// `ok` is what makes this discriminating: adding any field back fails here and nowhere
// else, whereas checking `ok === true` would stay green through it.
Deno.test("/healthz reports liveness and no state at all", async () => {
  const res = await handleRequest(new Request("https://worker.test/healthz"));
  assertEquals(res.status, 200, "the health check does not answer");

  const raw = await res.text();
  assertEquals(raw, JSON.stringify({ ok: true }), "the health check leaks something");
  assertEquals(
    Object.keys(JSON.parse(raw)).sort().join(","),
    "ok",
    "liveness is the only thing an anonymous caller is entitled to learn here",
  );
});
