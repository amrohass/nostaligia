/* Comparing a secret without leaking it one byte at a time.
 *
 * `a === b` on strings short-circuits at the first differing character, and the time that
 * takes is measurable over a network given enough samples. An attacker who can call an
 * endpoint repeatedly can recover a shared secret byte by byte from the timing alone —
 * slowly, and entirely without needing to be clever.
 *
 * The media worker already had this logic for its job signatures (worker/src/job.ts). This
 * is the same property for the Edge Function side, kept in _shared rather than copied so
 * there is one implementation to reason about.
 */

/**
 * Constant-time comparison of two strings.
 *
 * Length is checked first and returns early, which DOES leak the length — deliberately, and
 * harmlessly: the secrets this compares are fixed-length configuration values whose length
 * is not the part worth protecting. Reading the whole of both strings to hide a length that
 * is already implied by the deployment would be theatre.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
