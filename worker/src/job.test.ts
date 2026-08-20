// The worker's front door.
//
// This is the only thing standing between a public Cloud Run URL and a process that spawns
// ffmpeg, so the assertions here are about what must NOT get through. A happy-path test
// that passes while every refusal is broken is the failure mode worth designing against —
// so the valid case is asserted once and the refusals eleven times.
//
//     deno test worker/

import { REPLAY_WINDOW_MS, signBody, timingSafeEqual, verifyJob } from "./job.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const SECRET = "a-shared-secret-that-is-not-a-real-one";
const NOW = new Date("2026-08-19T12:00:00.000Z");

/**
 * Built exactly as complete-upload builds it.
 *
 * That is the point of this helper rather than a hand-written literal: the two sides sign
 * the same bytes or nothing works, and the shape — object_key, post_id, issued_at, in that
 * order — is the contract between them.
 */
function jobBody(issuedAt = NOW.toISOString()): string {
  return JSON.stringify({
    object_key: "00000000-0000-0000-0000-0000000000a1/abcd",
    post_id: "00000000-0000-0000-0000-00000000bb01",
    issued_at: issuedAt,
  });
}

Deno.test("a correctly signed, fresh job is accepted", async () => {
  const body = jobBody();
  const v = await verifyJob(body, await signBody(body, SECRET), SECRET, NOW);
  assert(v.ok, "a valid job must be accepted");
  if (v.ok) {
    assertEquals(v.job.object_key, "00000000-0000-0000-0000-0000000000a1/abcd", "key survives");
    assertEquals(v.job.post_id, "00000000-0000-0000-0000-00000000bb01", "post id survives");
  }
});

Deno.test("no signature header is a refusal, not a default", async () => {
  const v = await verifyJob(jobBody(), null, SECRET, NOW);
  assertEquals(v.ok, false, "unsigned must never pass");
  assertEquals(v.ok === false && v.reason, "missing_signature", "named");
});

Deno.test("a signature from a different secret is refused", async () => {
  const body = jobBody();
  const v = await verifyJob(body, await signBody(body, "some-other-secret"), SECRET, NOW);
  assertEquals(v.ok === false && v.reason, "bad_signature", "only our secret signs jobs");
});

// The one that matters most. If the body could be edited after signing, an attacker with
// one observed job could point this worker at any object key in the bucket.
Deno.test("the signature covers the body — a tampered key is refused", async () => {
  const original = jobBody();
  const signature = await signBody(original, SECRET);
  const tampered = original.replace("abcd", "efgh");
  const v = await verifyJob(tampered, signature, SECRET, NOW);
  assertEquals(v.ok === false && v.reason, "bad_signature", "one character is enough");
});

Deno.test("a truncated or padded signature is refused", async () => {
  const body = jobBody();
  const good = await signBody(body, SECRET);
  for (const bad of [good.slice(0, 63), good + "0", "", "not-hex-at-all"]) {
    const v = await verifyJob(body, bad, SECRET, NOW);
    assert(!v.ok, `"${bad.slice(0, 12)}..." must not pass`);
  }
});

Deno.test("hex case and surrounding whitespace do not decide authenticity", async () => {
  const body = jobBody();
  const good = await signBody(body, SECRET);
  const v = await verifyJob(body, `  ${good.toUpperCase()}  `, SECRET, NOW);
  assert(v.ok, "a valid signature is valid however it was transcribed");
});

// ── The replay window ────────────────────────────────────────
//
// The timestamp is inside the signed payload, so it cannot be edited without invalidating
// the signature. These assert that it is then actually USED — a signed timestamp nobody
// checks is a signature that is valid forever.

// The three below are written against REPLAY_WINDOW_MS rather than against a literal, so
// that they stay boundary tests if the window ever legitimately moves. That is right for
// them and it leaves exactly one hole: the window's VALUE. Widened to an hour, all three
// still pass — measured by mutation, and the whole worker suite with them — while a
// captured job body stays replayable twelve times longer.
//
// So the value is pinned once, here, in the same shape as DURATION_CEILING_S and
// JOB_DEADLINE_MS. Five minutes is chosen against the only legitimate delay in this path:
// complete-upload signs the job and POSTs it immediately, so the gap is one HTTP hop plus
// a Cloud Run cold start. Minutes of slack, not tens of minutes.
Deno.test("the replay window is five minutes, not whatever the boundary tests follow", () => {
  assertEquals(REPLAY_WINDOW_MS, 5 * 60 * 1000, "a signed job is not a long-lived token");
});

Deno.test("a job older than the window is refused", async () => {
  const stale = new Date(NOW.getTime() - REPLAY_WINDOW_MS - 1000).toISOString();
  const body = jobBody(stale);
  const v = await verifyJob(body, await signBody(body, SECRET), SECRET, NOW);
  assertEquals(v.ok === false && v.reason, "stale_job", "an observed job is not a forever token");
});

Deno.test("a job stamped in the future is refused too", async () => {
  const ahead = new Date(NOW.getTime() + REPLAY_WINDOW_MS + 1000).toISOString();
  const body = jobBody(ahead);
  const v = await verifyJob(body, await signBody(body, SECRET), SECRET, NOW);
  assertEquals(
    v.ok === false && v.reason,
    "stale_job",
    "a one-sided check leaves the future open, and the future is a longer window",
  );
});

Deno.test("a job just inside the window is still accepted", async () => {
  const edge = new Date(NOW.getTime() - REPLAY_WINDOW_MS + 1000).toISOString();
  const body = jobBody(edge);
  const v = await verifyJob(body, await signBody(body, SECRET), SECRET, NOW);
  assert(v.ok, "a slow retry is not an attack");
});

// ── Shape, checked only after authenticity ───────────────────

Deno.test("a signed body that is not a job is refused as malformed", async () => {
  for (
    const body of [
      "{not json",
      JSON.stringify([1, 2, 3]),
      JSON.stringify(null),
      JSON.stringify({ post_id: "x", issued_at: NOW.toISOString() }), // no object_key
      JSON.stringify({ object_key: "  ", post_id: "x", issued_at: NOW.toISOString() }),
      JSON.stringify({ object_key: "a/b", post_id: "x", issued_at: "not a date" }),
    ]
  ) {
    const v = await verifyJob(body, await signBody(body, SECRET), SECRET, NOW);
    assertEquals(v.ok, false, `${body.slice(0, 40)} must not be treated as a job`);
    assert(
      v.ok === false && (v.reason === "malformed_job" || v.reason === "stale_job"),
      "and is refused on its shape, not silently defaulted",
    );
  }
});

Deno.test("timingSafeEqual agrees with equality on the cases that matter", () => {
  assert(timingSafeEqual("abc", "abc"), "equal strings are equal");
  assert(!timingSafeEqual("abc", "abd"), "a trailing difference is caught");
  assert(!timingSafeEqual("abc", "bbc"), "a leading difference is caught");
  assert(!timingSafeEqual("abc", "abcd"), "different lengths are not equal");
  assert(!timingSafeEqual("", "a"), "empty is not a wildcard");
});
