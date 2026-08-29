/* The GoTrue half: clearing what auth.users knows about a person, without deleting the row.
 *
 * §3 makes the row undeletable for anyone who has ever acted (see deletion.ts). So this
 * empties it instead, through the admin API rather than by writing to the `auth` schema —
 * that schema is GoTrue's, it is unversioned, and it changes between releases. A migration
 * that UPDATEs auth.identities is a migration that breaks silently on a platform upgrade,
 * which for an erasure path means failing in the direction of keeping the data.
 *
 * ── What is cleared, and why each one ────────────────────────
 *
 *   email        the only directly identifying field this project ever collects. Replaced
 *                rather than nulled: GoTrue will not accept an empty email on a row that
 *                had one, and a UNIQUE index means the replacement has to be distinct per
 *                account. Derived from the account id under a .invalid domain — RFC 2606
 *                reserves that TLD precisely so it can never resolve or be delivered to.
 *   phone        never collected (§2 fixes auth at email + password), cleared anyway,
 *                because "we do not collect it" is a statement about today's signup form.
 *   metadata     both halves. user_metadata is client-writable at signup, so it is the one
 *                place a display name or a phone number can arrive without any schema
 *                saying so.
 *   password     rotated to random bytes nobody keeps. The account cannot be signed into
 *                afterwards even if a session token leaks later.
 *   ban          permanent, which is what actually revokes live sessions. Rotating the
 *                password alone leaves an issued refresh token working until it expires.
 *
 * ── The email is not `deleted@…` ─────────────────────────────
 *
 * A fixed address would collide on the second withdrawal, and the failure would land in the
 * middle of an erasure. It is `deleted-<sha256(id) truncated>@…` for the same two reasons
 * 0051's tombstone handle is a hash rather than a slice of the uuid: distinct per account,
 * and carrying no recoverable piece of the id. This one is far less exposed than the
 * handle — it takes the service-role key to read at all — but there is no reason to derive
 * it differently, and one derivation is one thing to reason about.
 */

import { env } from "../_shared/http.ts";
import type { AuthScrubber } from "./deletion.ts";

/** RFC 2606 §2: `.invalid` is reserved and guaranteed never to resolve. */
const SINK_DOMAIN = "deleted.invalid";

async function sinkEmail(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `deleted-${hex.slice(0, 24)}@${SINK_DOMAIN}`;
}

function randomPassword(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The real scrubber. Uses the SERVICE-ROLE key, which is the one credential that may reach
 * the admin API — and note this is `SUPABASE_SERVICE_ROLE_KEY` directly rather than
 * `serviceRoleJwt()`. That helper exists because PostgREST parses a JWT out of the bearer
 * and the platform now injects an opaque `sb_secret_…` there. GoTrue's admin API does not
 * parse a JWT; it accepts the service key in either format. Using the helper would be
 * harmless today and wrong in principle: the reason for the helper does not apply here, and
 * a deployment that sets only `SUPABASE_SERVICE_ROLE_KEY` must still be able to run this.
 */
export class GoTrueScrubber implements AuthScrubber {
  async scrub(userId: string): Promise<{ scrubbed: boolean; reason: string }> {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!key) return { scrubbed: false, reason: "no_service_key" };

    let res: Response;
    try {
      res = await fetch(`${env("SUPABASE_URL")}/auth/v1/admin/users/${userId}`, {
        method: "PUT",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: await sinkEmail(userId),
          phone: null,
          password: randomPassword(),
          user_metadata: {},
          app_metadata: {},
          // 100 years. GoTrue takes a duration string, not a date, and "none" would lift a
          // ban rather than set one.
          ban_duration: "876000h",
        }),
      });
    } catch (e) {
      return { scrubbed: false, reason: "unreachable:" + String(e) };
    }

    if (res.ok) return { scrubbed: true, reason: "scrubbed" };

    // The body is read and discarded rather than returned: it echoes the email that was
    // just set and, on some errors, the one that was there before. That is the single value
    // this whole path exists to destroy, and an error string is the least controlled place
    // in the system — it reaches a browser, a log, and a bug report.
    await res.text().catch(() => "");
    return { scrubbed: false, reason: "gotrue_" + res.status };
  }
}
