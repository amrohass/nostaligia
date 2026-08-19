/* The publisher's door — the refusals that need no deployment.
 *
 *     deno test --allow-env supabase/functions/publish/
 *
 * Only the refusals, deliberately. A request that PASSES the auth gate goes on to claim a
 * lease against a real database and write objects to real R2, so there is no version of a
 * "correct secret" test that does not need a deployment. release.test.ts covers everything
 * past this point by injection instead.
 *
 * This is the same split request-upload/handler.test.ts makes, and for the same reason: a
 * test with no prerequisites is a test that actually gets run.
 */

import { handleRequest } from "./handler.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
}

const SECRET = "publish-secret-for-tests-only";

function post(auth?: string): Request {
  return new Request("https://example.test/publish", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

Deno.test("GET is refused before anything else is considered", async () => {
  Deno.env.set("PUBLISH_SECRET", SECRET);
  const res = await handleRequest(new Request("https://example.test/publish"));
  assertEquals(res.status, 405, "a GET reached the publisher");
});

Deno.test("no Authorization header is 401", async () => {
  Deno.env.set("PUBLISH_SECRET", SECRET);
  const res = await handleRequest(post());
  assertEquals(res.status, 401, "an unauthenticated caller got past the door");
  assertEquals((await res.json()).error, "unauthorized", "wrong refusal");
});

Deno.test("a wrong secret is 401, and says nothing about why", async () => {
  Deno.env.set("PUBLISH_SECRET", SECRET);
  const res = await handleRequest(post(`Bearer ${SECRET}x`));
  assertEquals(res.status, 401, "a wrong secret was accepted");
  const body = await res.json();
  assertEquals(body.error, "unauthorized", "wrong refusal");
  assertEquals(
    JSON.stringify(body).includes(SECRET),
    false,
    "the expected secret appeared in the response",
  );
});

// A deployment with no secret set and a caller with the wrong secret both produce a 401
// otherwise, and the operator debugging it cannot tell which. Naming it tells an attacker
// nothing that a missing 200 does not already.
Deno.test("an unconfigured deployment says so instead of looking like a wrong secret", async () => {
  Deno.env.delete("PUBLISH_SECRET");
  const res = await handleRequest(post("Bearer anything"));
  assertEquals(res.status, 503, "expected 503");
  assertEquals((await res.json()).error, "publisher_not_configured", "wrong refusal");
});

// No browser calls this. An Access-Control-Allow-Origin here would advertise the endpoint
// to a page that has no business finding it, and a successful preflight is an invitation.
Deno.test("no CORS headers are offered", async () => {
  Deno.env.set("PUBLISH_SECRET", SECRET);
  const res = await handleRequest(post());
  assertEquals(res.headers.get("access-control-allow-origin"), null, "the publisher offers CORS");
});
