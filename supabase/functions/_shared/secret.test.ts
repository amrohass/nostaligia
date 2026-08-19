// timingSafeEqual — the property, and the one it deliberately does not have.
//
//     deno test supabase/functions/_shared/
//
// Timing itself is not asserted. A wall-clock assertion on a JIT-compiled comparison of
// short strings is a flaky test that fails on a loaded CI runner and teaches everyone to
// re-run it, which is worse than no test: the code becomes untrustworthy AND the suite
// becomes untrustworthy. What is asserted is correctness, so a "fix" that broke the
// comparison while keeping the loop shape is caught.

import { timingSafeEqual } from "./secret.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("identical strings match", () => {
  assert(timingSafeEqual("s3cret-value", "s3cret-value"), "equal strings did not match");
  assert(timingSafeEqual("", ""), "two empty strings did not match");
});

Deno.test("a difference anywhere is caught, including the last byte", () => {
  assert(!timingSafeEqual("s3cret-value", "S3cret-value"), "first byte");
  assert(!timingSafeEqual("s3cret-value", "s3cret-valuE"), "last byte — the one an early return would reach");
  assert(!timingSafeEqual("s3cret-value", "s3cret-vamue"), "middle");
});

Deno.test("different lengths do not match", () => {
  assert(!timingSafeEqual("s3cret", "s3cret-value"), "a prefix matched the whole");
  assert(!timingSafeEqual("s3cret-value", "s3cret"), "and the other way round");
  assert(!timingSafeEqual("", "x"), "empty matched non-empty");
});

// XOR-and-OR accumulates differences; a `diff = a ^ b` written by mistake would report only
// the LAST byte's difference and pass every test above except this one.
Deno.test("differences accumulate rather than overwrite", () => {
  assert(!timingSafeEqual("ab", "ba"), "two differing bytes cancelled each other out");
});
