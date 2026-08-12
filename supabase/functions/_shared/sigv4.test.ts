// The R2 presigner.
//
// ── Why there are no hardcoded signature vectors in this file ─
//
// The obvious test is AWS's canonical example: a fixed key, a fixed date, a documented
// expected signature. That was the intent here, and it did not survive contact with the
// sources. The AWS pages carrying complete worked examples render their content client
// side and serve placeholders (`Signature={{calculated-signature}}`) to a plain fetch,
// and a signature constant recalled from memory rather than read from a source is worse
// than no constant at all: if it is wrong the test fails forever, and the natural way to
// "fix" a failing expected-hash is to paste in whatever the code produced, at which
// point the test asserts only that the code agrees with itself.
//
// So correctness against a real verifier is established where it actually means
// something — by presigning against a live S3-compatible endpoint and uploading, in
// scripts/sigv4-roundtrip.mjs. That test answers the question this file cannot: does an
// independent implementation accept what we produce.
//
// What is left here is everything checkable without a network or a credential, and it is
// not filler. These are the properties the security argument in sigv4.ts rests on, and
// each one fails loudly under a plausible edit.
//
//     deno test supabase/functions/_shared/

import { presignR2Put } from "./sigv4.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const BASE = {
  accountId: "acct",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  bucket: "quarantine",
  key: "user/object",
  contentType: "image/jpeg",
  contentLength: 1024,
  expiresIn: 300,
  now: new Date("2026-08-12T10:00:00.000Z"),
};

function sigOf(url: string): string {
  return new URL(url).searchParams.get("X-Amz-Signature") ?? "";
}

// ── Determinism ──────────────────────────────────────────────
// Everything below compares two signatures. If signing were not deterministic, every
// one of those comparisons would pass for the wrong reason.

Deno.test("signing is deterministic for identical input", async () => {
  const a = await presignR2Put(BASE);
  const b = await presignR2Put(BASE);
  assertEquals(a.url, b.url, "same input must yield a byte-identical URL");
  assert(sigOf(a.url).length === 64, "a SHA-256 HMAC is 64 hex characters");
  assert(/^[0-9a-f]{64}$/.test(sigOf(a.url)), "lowercase hex, as SigV4 requires");
});

// ── The binding that the whole design rests on ───────────────
//
// sigv4.ts claims that signing content-length binds the URL to the size the quota was
// charged for, so that `bytes: 1` plus a 5 GB body fails. That claim is only true if the
// signature actually varies with the length. If a refactor ever drops content-length
// from the canonical headers, the presigner keeps working, R2 keeps accepting uploads,
// nothing looks broken -- and the daily quota silently becomes a suggestion.

Deno.test("the signature is bound to the declared content-length", async () => {
  const a = await presignR2Put(BASE);
  const b = await presignR2Put({ ...BASE, contentLength: 1025 });
  assert(
    sigOf(a.url) !== sigOf(b.url),
    "one byte of difference must change the signature, or the size is not bound",
  );
});

Deno.test("the signature is bound to the declared content-type", async () => {
  const a = await presignR2Put(BASE);
  const b = await presignR2Put({ ...BASE, contentType: "video/mp4" });
  assert(sigOf(a.url) !== sigOf(b.url), "content-type must be part of the signature");
});

Deno.test("both bound headers are declared, and nothing else is", async () => {
  const { url, headers } = await presignR2Put(BASE);
  assertEquals(
    new URL(url).searchParams.get("X-Amz-SignedHeaders"),
    "content-length;content-type;host",
    "sorted, semicolon-separated, and exactly these three",
  );
  // The caller must be told precisely what to send: a header they omit or alter
  // invalidates the signature, so an incomplete list here is a 403 at upload time.
  assertEquals(headers["Content-Length"], "1024", "the length to send");
  assertEquals(headers["Content-Type"], "image/jpeg", "the type to send");
  assertEquals(Object.keys(headers).length, 2, "and no others");
});

// ── Scope ────────────────────────────────────────────────────

Deno.test("credential scope is the R2 shape: date/auto/s3/aws4_request", async () => {
  const { url } = await presignR2Put(BASE);
  assertEquals(
    new URL(url).searchParams.get("X-Amz-Credential"),
    "AKIDEXAMPLE/20260812/auto/s3/aws4_request",
    "R2 has one region and calls it auto",
  );
  assertEquals(
    new URL(url).searchParams.get("X-Amz-Date"),
    "20260812T100000Z",
    "basic-format ISO 8601, no separators, no milliseconds",
  );
  assertEquals(
    new URL(url).searchParams.get("X-Amz-Algorithm"),
    "AWS4-HMAC-SHA256",
    "algorithm",
  );
});

Deno.test("a different key, bucket or secret changes the signature", async () => {
  const base = sigOf((await presignR2Put(BASE)).url);
  const variants: Array<[string, Record<string, unknown>]> = [
    ["key", { key: "user/other" }],
    ["bucket", { bucket: "originals" }],
    ["secret", { secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEZ" }],
    ["accountId", { accountId: "other" }],
    ["date", { now: new Date("2026-08-13T10:00:00.000Z") }],
    ["expiry", { expiresIn: 600 }],
  ];
  for (const [label, patch] of variants) {
    const v = sigOf((await presignR2Put({ ...BASE, ...patch })).url);
    assert(v !== base, `changing the ${label} must change the signature`);
  }
});

// ── Path encoding ────────────────────────────────────────────
// SigV4 canonicalisation is byte-exact. encodeURIComponent leaves !'()* alone and
// RFC 3986 does not, so an unescaped apostrophe in a key produces a 403 that reads like
// a credentials problem and is not. Object keys are UUIDs today, which is exactly why
// this is worth pinning: nothing in normal operation would ever reveal the bug.

Deno.test("path segments are RFC 3986 encoded, and separators survive", async () => {
  const { url } = await presignR2Put({ ...BASE, key: "a'b(c)d!e*f/g" });
  const path = new URL(url).pathname;
  assertEquals(
    path,
    "/quarantine/a%27b%28c%29d%21e%2Af/g",
    "!'()* escaped with uppercase hex; the slash between segments left intact",
  );
  for (const ch of ["'", "(", ")", "!", "*"]) {
    assert(!path.includes(ch), `${ch} must not survive unescaped`);
  }
});

Deno.test("a space in a key becomes %20, never +", async () => {
  const { url } = await presignR2Put({ ...BASE, key: "two words" });
  const path = new URL(url).pathname;
  assert(path.includes("two%20words"), `expected %20 encoding, got ${path}`);
  assert(!path.includes("+"), "+ is a form encoding and is wrong here");
});

// ── Expiry ───────────────────────────────────────────────────

Deno.test("expiry is reported as an absolute instant matching X-Amz-Expires", async () => {
  const r = await presignR2Put(BASE);
  assertEquals(
    new URL(r.url).searchParams.get("X-Amz-Expires"),
    "300",
    "the relative window R2 enforces",
  );
  assertEquals(
    r.expiresAt,
    "2026-08-12T10:05:00.000Z",
    "and the absolute instant the client can compare a clock against",
  );
  assertEquals(r.method, "PUT", "presigned for PUT and nothing else");
});

// ── The payload is deliberately not signed ───────────────────

Deno.test("UNSIGNED-PAYLOAD is used, and never leaks into the URL", async () => {
  const { url } = await presignR2Put(BASE);
  assert(
    !url.includes("UNSIGNED-PAYLOAD"),
    "it belongs in the canonical request, not the query string",
  );
  assertEquals(
    new URL(url).searchParams.get("X-Amz-Content-Sha256"),
    null,
    "and not as a hoisted parameter either",
  );
});
