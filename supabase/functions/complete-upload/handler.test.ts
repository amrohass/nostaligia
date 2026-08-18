// complete-upload, the gates that need no network.
//
// Everything past gate 2 talks to PostgREST, so what is unit-testable here is the shape
// and auth handling — plus one assertion that matters more than it looks: an
// unauthenticated caller must be refused BEFORE any database round trip, because that
// round trip is the expensive part of a request an attacker can send for free.
//
//     deno test --allow-env supabase/functions/complete-upload/

import { type Deps, handleRequest } from "./handler.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/complete-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function refusal(body: unknown, headers: Record<string, string> = {}) {
  const res = await handleRequest(post(body, headers));
  const parsed = await res.json();
  return { status: res.status, error: parsed.error };
}

Deno.test("a malformed body is refused before anything reads a field", async () => {
  const res = await handleRequest(
    new Request("https://example.test/complete-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400, "unparseable JSON is a 400");
  assertEquals((await res.json()).error, "invalid_json", "and says which problem it was");
});

Deno.test("an object key is required", async () => {
  assertEquals((await refusal({})).error, "invalid_object_key", "absent");
  assertEquals((await refusal({ object_key: "" })).error, "invalid_object_key", "empty");
  assertEquals((await refusal({ object_key: "   " })).error, "invalid_object_key", "whitespace");
  assertEquals((await refusal({ object_key: 42 })).error, "invalid_object_key", "not a string");
});

// The ordering assertion. With no Authorization header this must stop at gate 2 rather
// than attempting an RPC — which it would fail anyway, but only after a round trip, and
// only if SUPABASE_URL happened to be set. A 401 here proves the gate ran first.
Deno.test("an unauthenticated caller is refused before any database round trip", async () => {
  const r = await refusal({ object_key: "someone/else" });
  assertEquals(r.status, 401, "no bearer token is a 401");
  assertEquals(r.error, "unauthenticated", "named");
});

Deno.test("a malformed Authorization header is not a token", async () => {
  for (const h of ["", "Bearer", "Bearer ", "Basic abc", "bearer lowercase"]) {
    const r = await refusal({ object_key: "a/b" }, { Authorization: h });
    assertEquals(r.status, 401, `"${h}" must not pass as a bearer token`);
  }
});

Deno.test("only POST and OPTIONS are answered", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const res = await handleRequest(
      new Request("https://example.test/complete-upload", { method }),
    );
    assertEquals(res.status, 405, `${method} is refused`);
  }
});

// ── The rollback ─────────────────────────────────────────────
//
// Gate 3 moves the row to 'processing' and gate 4 hands it to a worker. If gate 4 fails and
// nothing undoes gate 3, the row is stuck: the next call gets already_processing and this
// function answers 200 "processing" forever, for a job no worker ever received. A 502 that
// strands state is recoverable; a 200 that strands state is not, because nothing retries.
//
// These use the injected deps because that failure cannot otherwise be produced — and an
// untested rollback is a rollback that is one refactor away from being dropped.

const TOKEN = { Authorization: "Bearer not.a.real.token" };
const POST_ID = "00000000-0000-0000-0000-00000000bb01";

interface Recorder {
  deps: Deps;
  rpcs: string[];
  workerCalls: number;
}

/**
 * @param begun what begin_ingest answers
 * @param worker how the worker responds: a status code, or "throw" for unreachable
 */
function recorder(begun: Record<string, unknown>, worker: number | "throw"): Recorder {
  const rpcs: string[] = [];
  const rec: Recorder = {
    rpcs,
    workerCalls: 0,
    deps: {
      rpc: (name: string, _args: unknown, _jwt: string) => {
        rpcs.push(name);
        const body = name === "begin_ingest" ? begun : { ok: true, post_id: POST_ID };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      },
      fetch: () => {
        rec.workerCalls++;
        if (worker === "throw") return Promise.reject(new Error("connection refused"));
        return Promise.resolve(new Response("{}", { status: worker }));
      },
    } as Deps,
  };
  return rec;
}

function configureWorker(on: boolean): void {
  if (on) {
    Deno.env.set("MEDIA_WORKER_URL", "https://worker.example.test");
    Deno.env.set("MEDIA_WORKER_SECRET", "test-secret");
  } else {
    Deno.env.delete("MEDIA_WORKER_URL");
    Deno.env.delete("MEDIA_WORKER_SECRET");
  }
}

const FRESH = { ok: true, post_id: POST_ID, already_processing: false, attempts: 1 };

Deno.test("an unreachable worker releases the row instead of stranding it", async () => {
  configureWorker(true);
  const r = recorder(FRESH, "throw");
  const res = await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);
  const body = await res.json();

  assertEquals(res.status, 502, "the caller is told the truth");
  assertEquals(body.error, "worker_unreachable", "named");
  assertEquals(r.rpcs.includes("release_ingest"), true, "and the row is handed back");
  assertEquals(body.detail.released, true, "which the response reports, so a retry is known to be useful");
});

Deno.test("a worker that refuses the job releases the row too", async () => {
  configureWorker(true);
  const r = recorder(FRESH, 500);
  const res = await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);

  assertEquals(res.status, 502, "still a 502");
  assertEquals((await res.json()).error, "worker_rejected_job", "named");
  assertEquals(r.rpcs.includes("release_ingest"), true, "released");
});

// The worker answers 503 when it is already transcoding. That is a job it did not take, so
// releasing sends the retry to a fresh instance rather than queueing behind a busy one.
Deno.test("a busy worker is a released row, not a queued one", async () => {
  configureWorker(true);
  const r = recorder(FRESH, 503);
  await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);
  assertEquals(r.rpcs.includes("release_ingest"), true, "released");
});

// The state this defect was first reachable from, before a worker existed at all.
Deno.test("an unconfigured worker releases the row", async () => {
  configureWorker(false);
  const r = recorder(FRESH, 202);
  const res = await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);

  assertEquals(res.status, 503, "nothing to hand it to");
  assertEquals((await res.json()).error, "worker_not_configured", "named");
  assertEquals(r.workerCalls, 0, "and no invocation was attempted");
  assertEquals(r.rpcs.includes("release_ingest"), true, "but the row is still handed back");
});

Deno.test("a successful hand-off does NOT release — the worker owns it now", async () => {
  configureWorker(true);
  const r = recorder(FRESH, 202);
  const res = await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);

  assertEquals(res.status, 202, "accepted");
  assertEquals(r.workerCalls, 1, "invoked once");
  assertEquals(
    r.rpcs.includes("release_ingest"),
    false,
    "releasing here would invite a second worker onto a job already in progress",
  );
});

Deno.test("an already-processing row invokes nothing and releases nothing", async () => {
  configureWorker(true);
  const r = recorder({ ok: true, post_id: POST_ID, already_processing: true, attempts: 1 }, 202);
  const res = await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);

  assertEquals(res.status, 200, "a retry after a dropped response has done nothing wrong");
  assertEquals(r.workerCalls, 0, "and must not spawn a second worker");
  assertEquals(r.rpcs.includes("release_ingest"), false, "nor take the job off the first one");
});

Deno.test("exhausting the attempt ceiling is a 429, not a 400", async () => {
  configureWorker(true);
  const r = recorder(
    { ok: false, reason: "too_many_attempts", attempts: 3, max_attempts: 3 },
    202,
  );
  const res = await handleRequest(post({ object_key: "a/b" }, TOKEN), r.deps);
  const body = await res.json();

  assertEquals(res.status, 429, "nothing is malformed — a ceiling was reached");
  assertEquals(body.error, "too_many_attempts", "named");
  assertEquals(body.detail.max_attempts, 3, "and the ceiling is reported");
  assertEquals(r.workerCalls, 0, "no invocation, which is the entire point of the ceiling");
});

Deno.test("an unlisted origin gets no CORS headers at all", async () => {
  Deno.env.delete("UPLOAD_ALLOWED_ORIGINS");
  const res = await handleRequest(
    new Request("https://example.test/complete-upload", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    }),
  );
  assertEquals(res.status, 204, "the preflight is still answered");
  assertEquals(
    res.headers.get("Access-Control-Allow-Origin"),
    null,
    "but grants nothing — the shared helper must fail closed for this function too",
  );
});
