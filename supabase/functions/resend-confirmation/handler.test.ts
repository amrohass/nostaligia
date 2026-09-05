// resend-confirmation — the gates that can be checked without a deployment.
//
//     deno test --allow-env supabase/functions/resend-confirmation/
//
// No test framework and no assertion library, for the reason the rest of this directory
// gives: it holds the code that guards the write path, and a registry fetch in its test run
// is a supply-chain edge nobody needs.
//
// ── What is worth asserting here, and what is not ────────────
//
// Gates 1 and 2 reach no network and read no environment, so they are checkable with
// nothing at all. Gates 3 to 5 need PostgREST and GoTrue, and a test that mocked both would
// be asserting the mock. What IS checkable about gates 3–5, and matters more than either,
// is the ORDER — so the last two tests here drive the handler with a stub `fetch` and
// assert which host it talked to first.
//
// That order is the whole security argument of this function:
//
//   · the address is read from the caller's token AFTER PostgREST has verified that token,
//     never before. Reversed, a forged JWT would mail anybody.
//   · nothing is sent until OUR rate limit has been claimed. Reversed, the limit would be
//     a report of what already happened.
//
// Both are one edit away from being wrong and neither changes anything visible.

import { handleRequest } from "./handler.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

/** A base64url JWT. Nothing here verifies a signature; PostgREST is what does that. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

function post(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request("https://example.test/resend-confirmation", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function refusal(body: unknown, token?: string) {
  const res = await handleRequest(post(body, token));
  const parsed = await res.json();
  return { status: res.status, error: parsed.error, detail: parsed.detail };
}

// ── Gate 1 · shape ───────────────────────────────────────────

Deno.test("a GET is refused before anything else happens", async () => {
  const res = await handleRequest(new Request("https://example.test/x", { method: "GET" }));
  assertEquals(res.status, 405, "only POST sends mail");
});

Deno.test("an OPTIONS preflight is answered without a body", async () => {
  const res = await handleRequest(new Request("https://example.test/x", { method: "OPTIONS" }));
  assertEquals(res.status, 204, "CORS preflight");
});

Deno.test("a body that is not JSON is refused", async () => {
  const res = await handleRequest(
    new Request("https://example.test/x", { method: "POST", body: "{" }),
  );
  assertEquals((await res.json()).error, "invalid_json", "gate 1");
});

Deno.test("no Turnstile token is refused before the caller is even identified", async () => {
  const r = await refusal({});
  assertEquals(r.status, 400, "gate 1 runs before gate 2");
  assertEquals(r.error, "turnstile_required", "and says which field");
});

// ── Gate 2 · auth ────────────────────────────────────────────
//
// CONTROL for the test above: with a token present, the SAME request gets past gate 1 and
// stops somewhere else. Without this, "turnstile_required" would be indistinguishable from
// a handler that refuses everything.

Deno.test("with a Turnstile token and no bearer, the refusal moves to gate 2", async () => {
  const r = await refusal({ turnstile_token: "t" });
  assertEquals(r.status, 401, "no Authorization header");
  assertEquals(r.error, "unauthenticated", "gate 2, not gate 1");
});

Deno.test("an Authorization header that is not a bearer is no credential at all", async () => {
  const res = await handleRequest(
    new Request("https://example.test/x", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic aGk6" },
      body: JSON.stringify({ turnstile_token: "t" }),
    }),
  );
  assertEquals((await res.json()).error, "unauthenticated", "Basic is not Bearer");
});

// ── Gates 3–5 · the order, which is the security argument ────
//
// `fetch` is replaced with a recorder. Nothing is mocked beyond the two responses the
// handler reads, and the assertions are about the SEQUENCE rather than about the bodies.

type Call = { url: string; body: Record<string, unknown> };

async function withStubbedFetch(
  responses: (call: Call) => Response,
  run: () => Promise<Response>,
): Promise<{ res: Response; calls: Call[] }> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  const env = new Map<string, string | undefined>();
  for (const k of ["SUPABASE_URL", "SUPABASE_ANON_KEY"]) {
    env.set(k, Deno.env.get(k));
    Deno.env.set(k, k === "SUPABASE_URL" ? "https://db.test" : "anon-key");
  }
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call = { url, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    return Promise.resolve(responses(call));
  }) as typeof fetch;
  try {
    return { res: await run(), calls };
  } finally {
    globalThis.fetch = real;
    for (const [k, v] of env) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

Deno.test("OUR limit is claimed BEFORE anything is sent, and the mail is second", async () => {
  const token = jwt({ sub: "u1", email: "member@example.test" });
  const { res, calls } = await withStubbedFetch(
    (call) => call.url.includes("/rpc/") ? okJson({ allowed: true }) : okJson({}),
    () => handleRequest(post({ turnstile_token: "t" }, token)),
  );

  assertEquals(res.status, 200, "both gates passed");
  assertEquals(calls.length, 2, "exactly two calls, not three");
  assert(
    calls[0].url.endsWith("/rest/v1/rpc/claim_confirmation_send"),
    `the rate limit is claimed first — got ${calls[0].url}`,
  );
  assert(
    calls[1].url.endsWith("/auth/v1/magiclink"),
    `and only then is a link asked for — got ${calls[1].url}`,
  );
});

Deno.test("the address comes from the token, and the Turnstile token is FORWARDED not spent", async () => {
  const token = jwt({ sub: "u1", email: "from-the-token@example.test" });
  const { calls } = await withStubbedFetch(
    (call) => call.url.includes("/rpc/") ? okJson({ allowed: true }) : okJson({}),
    () => handleRequest(post({ turnstile_token: "single-use", email: "attacker@evil.test" }, token)),
  );

  const mail = calls[1].body;
  assertEquals(mail.email, "from-the-token@example.test",
    "the address is the token's, never the body's — otherwise this is an open relay");
  assertEquals(mail.create_user, false,
    "a resend must not create a second account for a typo'd address");
  assertEquals(
    (mail.gotrue_meta_security as Record<string, unknown>)?.captcha_token,
    "single-use",
    "the captcha token reaches Cloudflare exactly once, via GoTrue — verifying it here would spend it",
  );
  assert(
    !calls.some((c) => c.url.includes("siteverify")),
    "and this function never calls siteverify itself",
  );
});

Deno.test("a refused limit stops the flow — no mail is asked for at all", async () => {
  const token = jwt({ sub: "u1", email: "member@example.test" });
  const { res, calls } = await withStubbedFetch(
    () => okJson({ allowed: false, reason: "too_soon", retry_after_s: 42 }),
    () => handleRequest(post({ turnstile_token: "t" }, token)),
  );

  assertEquals(res.status, 429, "our own limit, not the provider's");
  const body = await res.json();
  assertEquals(body.error, "too_soon", "named, so the screen can say how long");
  assertEquals((body.detail as Record<string, unknown>).retry_after_s, 42,
    "'wait a little' without a number is a message nobody can act on");
  assertEquals(calls.length, 1, "the mailer was never reached");
});

Deno.test("an account with no address is refused rather than reported as sent", async () => {
  const token = jwt({ sub: "u1" });
  const { res, calls } = await withStubbedFetch(
    () => okJson({ allowed: true }),
    () => handleRequest(post({ turnstile_token: "t" }, token)),
  );

  assertEquals(res.status, 422, "nothing to send to");
  assertEquals((await res.json()).error, "no_address", "and it says so");
  assertEquals(calls.length, 1, "the mailer was never reached");
});

Deno.test("GoTrue's refusals keep their own names", async () => {
  const token = jwt({ sub: "u1", email: "member@example.test" });

  for (
    const [status, errorCode, expectStatus, expectKey] of [
      [400, "captcha_failed", 403, "captcha_failed"],
      [429, "over_email_send_rate_limit", 429, "over_email_send_rate_limit"],
      [500, "", 502, "send_failed"],
    ] as [number, string, number, string][]
  ) {
    const { res } = await withStubbedFetch(
      (call) =>
        call.url.includes("/rpc/")
          ? okJson({ allowed: true })
          : new Response(JSON.stringify({ error_code: errorCode }), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
      () => handleRequest(post({ turnstile_token: "t" }, token)),
    );
    assertEquals(res.status, expectStatus, `GoTrue ${status}/${errorCode}`);
    assertEquals((await res.json()).error, expectKey, `GoTrue ${status}/${errorCode}`);
  }
});
