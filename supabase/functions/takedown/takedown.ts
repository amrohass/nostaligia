/* Takedown, in §8's order, with every step reported.
 *
 *     mark → delete the bytes → purge the CDN → rewrite redactions.json
 *
 * §8: "Takedown latency must NEVER be bounded by the publish cycle." Nothing here waits for
 * a release. The next scheduled publish drops the item from the shards as a formality; by
 * then the bytes have been gone for minutes.
 *
 * ── Why the CDN purge is not optional ────────────────────────
 *
 * Derivatives are served with `max-age=31536000, immutable`. Deleting an object from R2
 * does not evict the copy the CDN is already holding, so without step 2 a taken-down photo
 * stays retrievable at its original URL for up to a YEAR by anyone who has the link — which
 * is exactly the population a takedown is usually about.
 *
 * This is worth stating because "the file is deleted" feels like it should be the end of it,
 * and on an origin-only setup it would be. Behind a CDN it is half the job, and the half
 * that is invisible from the dashboard.
 *
 * ── Reported, never swallowed ────────────────────────────────
 *
 * Every step returns its own result. A partial takedown is a real state — R2 can fail, the
 * purge token can be missing, the credentials can be wrong — and the difference between
 * "removed" and "marked as removed, bytes still out there" is the entire point of the
 * feature. A moderator who is told "done" when three objects failed to delete has been
 * given something worse than an error.
 */

import type { ObjectSink } from "../_shared/r2.ts";

export interface TakedownObject {
  bucket: "public" | "originals";
  path: string;
  role: string;
}

export interface TakedownDb {
  /** Marks the post and returns what must be deleted. Runs as the CALLER (0036). */
  requestTakedown(postId: string, note: string | null): Promise<{
    ok: boolean;
    reason: string;
    post_id?: string;
    objects?: TakedownObject[];
  }>;
  /** Every taken-down id, for the redaction list. Runs as the service role. */
  redactedPostIds(): Promise<string[]>;
}

/** Cloudflare cache purge, or a stand-in that says it is not configured. */
export interface CdnPurger {
  purge(paths: string[]): Promise<{ purged: boolean; reason: string }>;
}

export interface Deps {
  db: TakedownDb;
  /** One sink per bucket. §6 keeps them distinct; so does this. */
  sinks: Record<"public" | "originals", ObjectSink>;
  cdn: CdnPurger;
  /** The root object clients filter against. Separate from the sinks so it is explicit. */
  redactionSink: ObjectSink;
}

export interface TakedownOutcome {
  ok: boolean;
  reason: string;
  post_id?: string;
  /** Objects that are confirmed gone. */
  removed?: string[];
  /** Objects that are NOT gone. A non-empty list here means the takedown is incomplete. */
  failed?: string[];
  cdn_purged?: boolean;
  cdn_reason?: string;
  redactions_written?: boolean;
  redacted_total?: number;
}

const REDACTIONS_CACHE = "public, max-age=20, must-revalidate";

export async function takeDown(
  postId: string,
  note: string | null,
  deps: Deps,
): Promise<TakedownOutcome> {
  // ── 1 · mark, under the role check, with an audit row ──
  //
  // First, deliberately. 0036's header sets out the two half-done states and why this one
  // is the survivable one: marked-but-not-deleted hides the item and leaves bytes at an
  // unguessable path; deleted-but-not-marked leaves the archive publicly serving broken
  // cards until somebody notices.
  const marked = await deps.db.requestTakedown(postId, note);
  if (!marked.ok) return { ok: false, reason: marked.reason };

  const objects = marked.objects ?? [];

  // ── 2 · the bytes ──
  const removed: string[] = [];
  const failed: string[] = [];
  for (const obj of objects) {
    const sink = deps.sinks[obj.bucket];
    if (!sink) {
      // A bucket this function was not built to address. Recorded as failed rather than
      // skipped: an object nobody deleted is an object that is still there.
      failed.push(`${obj.bucket}/${obj.path}`);
      continue;
    }
    try {
      const gone = await sink.remove(obj.path);
      (gone ? removed : failed).push(`${obj.bucket}/${obj.path}`);
    } catch {
      failed.push(`${obj.bucket}/${obj.path}`);
    }
  }

  // ── 3 · the CDN ──
  //
  // Only the public bucket is CDN-fronted, so only those paths are purged. Purging an
  // originals path would be a request for a URL that has never existed, which is harmless
  // and also a lie about the system's shape.
  const publicPaths = objects.filter((o) => o.bucket === "public").map((o) => o.path);
  const purge = publicPaths.length > 0
    ? await deps.cdn.purge(publicPaths)
    : { purged: true, reason: "nothing_cdn_fronted" };

  // ── 4 · the redaction list ──
  //
  // Rewritten from the DATABASE rather than by appending this id to whatever was there.
  // An append would drift the moment a takedown happened while a publish was mid-flight,
  // and the file it drifted from is the one clients trust to hide things.
  let redactionsWritten = false;
  let redactedTotal = 0;
  try {
    const ids = await deps.db.redactedPostIds();
    redactedTotal = ids.length;
    await deps.redactionSink.put(
      "redactions.json",
      JSON.stringify({ ids }),
      "application/json; charset=utf-8",
      REDACTIONS_CACHE,
    );
    redactionsWritten = true;
  } catch {
    redactionsWritten = false;
  }

  return {
    // Only when every part actually happened. A moderator told "done" while three objects
    // are still served has been given something worse than an error.
    ok: failed.length === 0 && purge.purged && redactionsWritten,
    reason: failed.length > 0
      ? "objects_remain"
      : !purge.purged
      ? "cdn_not_purged"
      : !redactionsWritten
      ? "redactions_not_written"
      : marked.reason,
    post_id: marked.post_id,
    removed,
    failed,
    cdn_purged: purge.purged,
    cdn_reason: purge.reason,
    redactions_written: redactionsWritten,
    redacted_total: redactedTotal,
  };
}
