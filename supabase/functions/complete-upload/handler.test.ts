// complete-upload, the gates that need no network.
//
// Everything past gate 2 talks to PostgREST, so what is unit-testable here is the shape
// and auth handling — plus one assertion that matters more than it looks: an
// unauthenticated caller must be refused BEFORE any database round trip, because that
// round trip is the expensive part of a request an attacker can send for free.
//
//     deno test --allow-env supabase/functions/complete-upload/

import { handleRequest } from "./handler.ts";

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
