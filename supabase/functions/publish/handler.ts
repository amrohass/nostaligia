/* The HTTP door to the publisher.
 *
 * ── Who may open it ──────────────────────────────────────────
 *
 * A shared secret, not the service-role key, and the difference matters. This endpoint is
 * called by pg_cron through pg_net (piece 5), which means whatever authenticates it is
 * stored in a `cron.job` row — a third place a credential lives, after CI secrets and the
 * function environment §6 names. The service key opens the entire database; PUBLISH_SECRET
 * opens exactly one door, and behind that door is a lease that already refuses a second
 * concurrent publish. Someone holding it can make the archive rebuild itself, which the
 * cron does every two minutes anyway.
 *
 * Compared in constant time. The endpoint is public, callable at any rate a WAF permits,
 * and a `===` on a secret is recoverable byte by byte from timing given enough samples.
 *
 * ── Why there is no CORS ─────────────────────────────────────
 *
 * No browser calls this, ever. corsHeaders would advertise an origin that has no business
 * here, and an OPTIONS preflight that succeeds is an invitation to try the POST.
 */

import { env, fail, json } from "../_shared/http.ts";
import { timingSafeEqual } from "../_shared/secret.ts";
import { publish } from "./release.ts";
import { PostgrestDb } from "./db.ts";
import { R2Sink } from "../_shared/r2.ts";

/** §2: shards and the pointer both live in the CDN-fronted bucket. */
const PUBLIC_BUCKET = "public";

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method !== "POST") return fail("method_not_allowed", 405, req);

  const offered = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  let expected: string;
  try {
    expected = env("PUBLISH_SECRET");
  } catch {
    // Named rather than treated as a failed auth: an unconfigured deployment and a wrong
    // secret produce identical 401s otherwise, and the operator debugging it has no way to
    // tell which. This says nothing to an attacker that a missing 200 does not.
    return fail("publisher_not_configured", 503, req);
  }
  if (!offered || !timingSafeEqual(offered, expected)) {
    return fail("unauthorized", 401, req);
  }

  const outcome = await publish({
    db: new PostgrestDb(),
    sink: new R2Sink({
      accountId: env("R2_ACCOUNT_ID"),
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
      bucket: PUBLIC_BUCKET,
    }),
    now: () => new Date(),
    newHolder: () => crypto.randomUUID(),
  });

  // 200 for "somebody else is publishing" as well as for a publish. It is the expected
  // answer to a cron that fires every two minutes into a five-minute lease, and a 4xx there
  // would fill a dashboard with alerts for the system working correctly.
  //
  // 409 for a build that got far enough to write objects and then could not be trusted —
  // incomplete_release and a failed ledger write are real problems that left litter.
  const status = outcome.published || outcome.reason === "held" || outcome.reason === "contended"
    ? 200
    : 409;

  return json(outcome, status, req);
}
