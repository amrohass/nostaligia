// The role floor — CLAUDE.md §5 and §6.
//
// §6 says the caps come "from the JWT role claim — never from a client-declared value".
// A JWT claim is not client-declared in the sense §6 means, because the token is signed
// and the Edge gateway verifies it. But it IS a snapshot: a moderator demoted five
// minutes ago still carries `moderator` in an unexpired token, and would keep 4 GB caps
// until it expires. So the claim is floored by the role the DATABASE reports, and the
// effective role is whichever of the two grants less.
//
// This is the file that proves that floor holds. It belongs here rather than in a live
// probe against the deployed function, and the reason is worth stating: a forged claim
// CANNOT reach the handler through the gateway, because tampering with the payload
// breaks the signature and the request is refused with 401 before any of this code
// runs. That is a good property, but it means a live probe can only ever demonstrate
// the outer gate. The floor behind it — the part that matters if the gateway is ever
// misconfigured, or if verify_jwt is ever turned off — is only observable here.
//
//     deno test --allow-env supabase/functions/request-upload/

import { claimedRole, effectiveRole } from "./handler.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

/** An unsigned token with the given payload. The signature is never checked here. */
function tokenWith(payload: Record<string, unknown>): string {
  const b64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${b64}.signature`;
}

// ── The floor ────────────────────────────────────────────────

Deno.test("a claim can never raise the role above what the database says", () => {
  // The demotion window: the token still says moderator, user_roles no longer does.
  assertEquals(
    effectiveRole("moderator", "member"),
    "member",
    "a stale moderator claim must not outrank a member row",
  );
  assertEquals(
    effectiveRole("admin", "member"),
    "member",
    "nor a stale admin claim",
  );
  assertEquals(
    effectiveRole("admin", "moderator"),
    "moderator",
    "nor a stale admin claim over a moderator row",
  );
});

Deno.test("a claim CAN lower the role below what the database says", () => {
  // The promotion case resolves conservatively: caps stay at member until the token
  // refreshes. Under-granting is a mild inconvenience; over-granting is the incident.
  assertEquals(
    effectiveRole("member", "moderator"),
    "member",
    "a not-yet-refreshed member claim keeps member caps",
  );
  assertEquals(
    effectiveRole("member", "admin"),
    "member",
    "same for an admin whose token predates the grant",
  );
});

Deno.test("agreement between the two is a no-op", () => {
  assertEquals(effectiveRole("member", "member"), "member", "member");
  assertEquals(effectiveRole("moderator", "moderator"), "moderator", "moderator");
  assertEquals(effectiveRole("admin", "admin"), "admin", "admin");
});

Deno.test("an absent claim defers to the database, and cannot over-grant", () => {
  // This is the LIVE path today: the access-token hook is not enabled on the hosted
  // project, so no token carries app_metadata.user_role at all. Absence must therefore
  // be ordinary and safe, not an edge case.
  assertEquals(effectiveRole(null, "member"), "member", "no claim, member row");
  assertEquals(effectiveRole(null, "moderator"), "moderator", "no claim, moderator row");
  assertEquals(effectiveRole(null, "admin"), "admin", "no claim, admin row");
});

// ── Reading the claim out of an untrusted token ──────────────

Deno.test("a garbage claim is read as no claim, never as a role", () => {
  const cases: Array<[string, unknown]> = [
    ["a role that does not exist", "superuser"],
    ["an empty string", ""],
    ["a number", 3],
    ["an object", { role: "admin" }],
    ["null", null],
    ["a case variant", "Admin"],
  ];
  for (const [label, value] of cases) {
    assertEquals(
      claimedRole(tokenWith({ app_metadata: { user_role: value } })),
      null,
      `${label} must not parse as a role`,
    );
  }
});

Deno.test("a malformed token yields no claim rather than throwing", () => {
  // claimedRole runs on attacker-controlled input before anything has validated it. An
  // exception here would be a 500 on a request that should have been a clean refusal.
  for (const junk of ["", "not-a-jwt", "a.b", "a.!!!.c", "a..c", "....", "a.eyJ.c"]) {
    assertEquals(claimedRole(junk), null, `"${junk}" must return null, not throw`);
  }
});

Deno.test("a well-formed claim is read correctly — the floor is not just refusing everything", () => {
  // Without this, every assertion above would still pass if claimedRole always returned
  // null. It proves the parser works, so the floor is doing real comparisons.
  for (const role of ["member", "moderator", "admin"] as const) {
    assertEquals(
      claimedRole(tokenWith({ app_metadata: { user_role: role } })),
      role,
      `${role} parses`,
    );
  }
  assertEquals(
    claimedRole(tokenWith({ sub: "abc" })),
    null,
    "a token with no app_metadata at all is simply claimless",
  );
});
