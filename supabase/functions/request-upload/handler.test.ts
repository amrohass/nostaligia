// Gate 1 of request-upload — the refusals that cost nothing.
//
// Everything asserted here happens before the handler touches the network, reads an
// environment variable, or learns who is asking. That is exactly why it is worth a unit
// test: these are the only refusals in the function that can be checked without a
// deployment, a JWT, a Turnstile token or an R2 credential, and a test with no
// prerequisites is a test that actually gets run.
//
//     deno test --allow-env supabase/functions/request-upload/
//
// No test framework and no assertion library, for the same reason ../\_shared/sigv4.ts
// has no dependency: this directory holds the code that guards the write path, and a
// registry fetch in its test run is a supply-chain edge nobody needs. The four helpers
// below are the whole harness.
//
// Requests here deliberately carry NO Authorization header and NO Turnstile token. That
// is the point of the file — if a gate-1 refusal ever regresses to running after gate 2
// or gate 3, these stop returning what they claim and start returning 401.

import { ABSOLUTE_MAX_BYTES, handleRequest } from "./handler.ts";

const GiB = 1024 * 1024 * 1024;

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

/** A bare POST with no credentials of any kind. */
function post(body: unknown): Request {
  return new Request("https://example.test/request-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function refusal(body: unknown): Promise<{ status: number; error: string; detail?: Record<string, unknown> }> {
  const res = await handleRequest(post(body));
  const parsed = await res.json();
  return { status: res.status, error: parsed.error, detail: parsed.detail };
}

// ── The absolute ceiling ─────────────────────────────────────

Deno.test("the absolute ceiling is 4 GiB, derived from the largest role cap in §6", () => {
  assertEquals(ABSOLUTE_MAX_BYTES, 4 * GiB, "§6 gives moderator/admin a 4 GB maximum");
});

Deno.test("a declaration above every role's cap is refused with no token and no auth", async () => {
  const r = await refusal({ mime: "video/mp4", bytes: 5 * GiB, duration_s: 60 });
  assertEquals(r.status, 413, "over the absolute ceiling is 413");
  assertEquals(r.error, "over_absolute_cap", "and says so distinctly from the role cap");
  assertEquals(r.detail?.max_bytes, ABSOLUTE_MAX_BYTES, "and reports the ceiling it applied");
});

// The boundary is the assertion that matters most: an off-by-one here refuses the
// largest file §6 explicitly permits, and it would do so for a moderator uploading the
// 4 GB master the archive exists to collect.
Deno.test("exactly 4 GiB is not refused by the absolute ceiling", async () => {
  const r = await refusal({ mime: "video/mp4", bytes: 4 * GiB, duration_s: 60 });
  assert(
    r.error !== "over_absolute_cap",
    `4 GiB is inside §6's cap and must reach the role gate, got ${r.error}`,
  );
  // It stops at the next gate instead, which proves it got past this one rather than
  // passing for some unrelated reason.
  assertEquals(r.error, "turnstile_required", "it falls through to the next gate-1 check");
});

// Ordering. A 5 GiB SVG is refused as an SVG, not as an oversized file: §6 names SVG
// specifically and that reason is the one worth having in the logs.
Deno.test("type refusals still win over the size ceiling", async () => {
  const svg = await refusal({ mime: "image/svg+xml", bytes: 5 * GiB });
  assertEquals(svg.status, 415, "SVG is refused on type");
  assertEquals(svg.error, "svg_rejected", "with §6's named reason, not over_absolute_cap");

  const junk = await refusal({ mime: "application/x-msdownload", bytes: 5 * GiB });
  assertEquals(junk.error, "unsupported_type", "an unlisted type is refused on type too");
});

Deno.test("a nonsense size is refused as a size, before the ceiling compares it", async () => {
  assertEquals((await refusal({ mime: "image/jpeg", bytes: 0 })).error, "invalid_bytes", "zero");
  assertEquals((await refusal({ mime: "image/jpeg", bytes: -1 })).error, "invalid_bytes", "negative");
  assertEquals((await refusal({ mime: "image/jpeg", bytes: 1.5 })).error, "invalid_bytes", "fractional");
  assertEquals((await refusal({ mime: "image/jpeg", bytes: "big" })).error, "invalid_bytes", "not a number");
  // Infinity is the interesting one: it is > ABSOLUTE_MAX_BYTES, so a ceiling check
  // placed before the integer check would answer over_absolute_cap and imply that a
  // smaller retry might work.
  assertEquals(
    (await refusal({ mime: "image/jpeg", bytes: Infinity })).error,
    "invalid_bytes",
    "Infinity is malformed, not merely too large",
  );
});

// ── The rest of gate 1 ───────────────────────────────────────

Deno.test("timed media must declare a duration — the §6 duration cap needs one", async () => {
  const r = await refusal({ mime: "video/mp4", bytes: 1024 });
  assertEquals(r.status, 400, "missing duration is a refusal");
  assertEquals(r.error, "duration_required", "and not a silent default");

  const image = await refusal({ mime: "image/jpeg", bytes: 1024 });
  assertEquals(image.error, "turnstile_required", "a still image is not asked for one");
});

Deno.test("a Turnstile token is required, and its absence is gate 1's last word", async () => {
  const r = await refusal({ mime: "image/jpeg", bytes: 1024 });
  assertEquals(r.status, 400, "no token is a 400");
  assertEquals(r.error, "turnstile_required", "named, so the client can prompt for one");
});

Deno.test("the post kind must be declared, and must be one the schema knows", async () => {
  // Declared here rather than inferred from the sniffed family after ingest, because that
  // would mean the worker mutating `kind` — and `kind` is inside the approval content
  // hash, so a worker write there could un-approve a post.
  const base = { mime: "image/jpeg", bytes: 1024, turnstile_token: "x" };
  assertEquals((await refusal(base)).error, "invalid_kind", "absent");
  assertEquals(
    (await refusal({ ...base, kind: "photo" })).error,
    "invalid_kind",
    "a plausible-sounding kind the enum does not have",
  );
  for (const kind of ["media", "voice", "event"]) {
    const r = await refusal({ ...base, kind });
    assert(r.error !== "invalid_kind", `${kind} is accepted (got ${r.error})`);
  }
});

Deno.test("a malformed body is refused before anything reads a field from it", async () => {
  const res = await handleRequest(
    new Request("https://example.test/request-upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400, "unparseable JSON is a 400");
  assertEquals((await res.json()).error, "invalid_json", "and says which problem it was");
});

Deno.test("only POST and OPTIONS are answered", async () => {
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const res = await handleRequest(
      new Request("https://example.test/request-upload", { method }),
    );
    assertEquals(res.status, 405, `${method} is refused`);
  }
});

// ── CORS fails closed ────────────────────────────────────────
// The allowlist itself is verified against the deployed function; what matters here is
// the default. An unset UPLOAD_ALLOWED_ORIGINS must yield no CORS headers rather than a
// permissive fallback, because that variable will be unset on the day someone stands up
// a new environment and forgets it.
Deno.test("an unlisted origin gets no CORS headers at all", async () => {
  Deno.env.delete("UPLOAD_ALLOWED_ORIGINS");
  const res = await handleRequest(
    new Request("https://example.test/request-upload", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    }),
  );
  assertEquals(res.status, 204, "the preflight is still answered");
  assertEquals(
    res.headers.get("Access-Control-Allow-Origin"),
    null,
    "but grants nothing — an unset allowlist must not fall back to permissive",
  );
});
