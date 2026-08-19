/* The publish sequence. §2, in order, with the order as the safety property.
 *
 *     lease → read → build → WRITE EVERYTHING → validate → record → flip → release lease
 *
 * ── Why the order is the whole design ────────────────────────
 *
 * §10's M2 exit criterion: "a killed build never becomes visible."
 *
 * Nothing a visitor can reach changes until the second-to-last step. Every shard is written
 * to `/v/{ISO-ts}/`, a path nothing points at, under keys nobody has ever requested. A
 * publisher killed at any point before the flip leaves an orphan directory and a `releases`
 * row marked inactive — which is litter, not an outage. The flip is one small object.
 *
 * That is also why validation sits between writing and flipping rather than before writing:
 * the thing worth validating is what actually landed in the bucket, not what we intended to
 * send. A publisher that checked its own in-memory plan and then half-uploaded it would pass
 * its own review and ship a broken release.
 *
 * ── Injected everything ──────────────────────────────────────
 *
 * Deps carries the database, the object store and the clock. Not for tidiness: the sequence
 * above has failure modes at every step — the lease is held, the hash check drops a row, an
 * upload fails halfway, the flip fails after a successful write — and every one of them
 * needs a test that says what the archive looks like afterwards. None of those are reachable
 * against real R2 without deliberately breaking real R2.
 */

import { buildShards, type ShardFile, type SourcePost, stableStringify } from "./shards.ts";
import type { ObjectSink } from "../_shared/r2.ts";

// Re-exported so this module's callers and tests keep one import for the whole sequence.
export type { ObjectSink };

/** The database, as this function uses it. Every call is one PostgREST RPC. */
export interface Db {
  publishablePosts(): Promise<Array<SourcePost & { hash_matches?: boolean }>>;
  redactedPostIds(): Promise<string[]>;
  claimLease(holder: string, ttlSeconds: number, note: string): Promise<{ acquired: boolean; reason: string }>;
  releaseLease(holder: string): Promise<void>;
  recordRelease(path: string): Promise<{ recorded: boolean; id?: string; reason?: string }>;
  activateRelease(id: string): Promise<{ activated: boolean; previous_path?: string | null }>;
}

export interface Deps {
  db: Db;
  sink: ObjectSink;
  /** The release timestamp and the lease holder. Injected so a test can assert exact keys. */
  now: () => Date;
  newHolder: () => string;
}

export interface PublishOutcome {
  published: boolean;
  reason: string;
  release?: string;
  previous?: string | null;
  files?: number;
  posts?: number;
  /** Rows §5 refused. Reported, never silently dropped — see below. */
  rejectedHashes?: string[];
  redacted?: number;
}

/** §2: "TTL 30–60 s" on the pointer, immutable for everything under /v/. */
const MANIFEST_CACHE = "public, max-age=45, must-revalidate";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/**
 * §8: "a short-TTL redactions.json that clients filter against". Shorter than the manifest,
 * because takedown latency must not be bounded by anything — including by the pointer's own
 * cache window. The bytes are already deleted by the time a client reads this; the file is
 * what stops a cached release from rendering a card for something that is gone.
 */
const REDACTIONS_CACHE = "public, max-age=20, must-revalidate";

const LEASE_TTL_SECONDS = 300;

/** `/v/2026-08-19T12:34:56Z/` — the shape releases_path_shape already enforces. */
export function releasePath(now: Date): string {
  return `/v/${now.toISOString().replace(/\.\d{3}Z$/, "Z")}/`;
}

/**
 * Everything a release contains, as keys relative to the bucket root.
 *
 * Split out from publish() so a test can assert the CONTENT of a release without a sink at
 * all, and so piece 5's diffing has one place to ask "what would this release be".
 */
export function releaseFiles(
  posts: SourcePost[],
  redacted: string[],
  path: string,
): ShardFile[] {
  const files = buildShards(posts);
  // Written INTO the release as well as at the root. A client that has a release cached for
  // a year and never re-reads the root would otherwise keep rendering a redacted item; this
  // copy is immutable and correct as of the build, and the root copy catches everything
  // after it.
  files.push({ path: "redactions.json", json: stableStringify({ ids: redacted }) });
  return files.map((f) => ({ path: `${path.slice(1)}${f.path}`, json: f.json }));
}

export async function publish(deps: Deps): Promise<PublishOutcome> {
  const holder = deps.newHolder();

  // ── 1 · the lease ──
  const lease = await deps.db.claimLease(holder, LEASE_TTL_SECONDS, "publish");
  if (!lease.acquired) {
    // Not an error. A cron every two minutes will find a publish in progress regularly,
    // and a publisher that logged a failure each time would teach its operator to stop
    // reading the log.
    return { published: false, reason: lease.reason };
  }

  try {
    // ── 2 · read ──
    const candidates = await deps.db.publishablePosts();
    const redacted = await deps.db.redactedPostIds();

    // §5: "the publisher refuses rows whose hash ≠ approved hash." Refused, and NAMED —
    // a row that silently vanished would look exactly like one that was never approved,
    // and the situation this detects is content altered after approval, which is the one
    // situation somebody needs to hear about rather than be quietly protected from.
    const rejectedHashes = candidates
      .filter((p) => p.hash_matches === false)
      .map((p) => p.id);
    const posts = candidates.filter((p) => p.hash_matches !== false);

    // ── 3 · build ──
    const path = releasePath(deps.now());
    const files = releaseFiles(posts, redacted, path);

    // ── 4 · write everything, while nothing points here ──
    for (const file of files) {
      await deps.sink.put(file.path, file.json, "application/json; charset=utf-8", IMMUTABLE_CACHE);
    }

    // ── 5 · validate what LANDED ──
    //
    // Every file is read back. The manifest is about to name this directory, and the cost
    // of naming a directory with a missing shard is a page that 404s for a year — the CDN
    // will cache the miss too.
    const missing: string[] = [];
    for (const file of files) {
      if (!(await deps.sink.exists(file.path))) missing.push(file.path);
    }
    if (missing.length > 0) {
      return {
        published: false,
        reason: "incomplete_release",
        release: path,
        files: files.length,
        rejectedHashes,
        posts: posts.length,
      };
    }

    // ── 6 · record, still inactive ──
    const recorded = await deps.db.recordRelease(path);
    if (!recorded.recorded || !recorded.id) {
      return { published: false, reason: recorded.reason ?? "record_failed", release: path };
    }

    // ── 7 · the pointer ──
    //
    // Written BEFORE activate_release, because the manifest object is what a browser
    // actually reads and the releases row is bookkeeping. If the row said active and the
    // object still named the old release, the archive would be correct and the ledger
    // would lie; the other way round, for the fraction of a second between these two
    // calls, the ledger lags and the archive is already right.
    await deps.sink.put(
      "manifest.json",
      stableStringify({ release: path, generated_on: deps.now().toISOString().slice(0, 10) }),
      "application/json; charset=utf-8",
      MANIFEST_CACHE,
    );

    // The root redaction list, at its own short TTL. Rewritten on every publish so it is
    // never staler than the last cron tick, and rewritten by takedown immediately (piece 4)
    // so it is usually much fresher than that.
    await deps.sink.put(
      "redactions.json",
      stableStringify({ ids: redacted }),
      "application/json; charset=utf-8",
      REDACTIONS_CACHE,
    );

    const flipped = await deps.db.activateRelease(recorded.id);

    return {
      published: true,
      reason: "published",
      release: path,
      previous: flipped.previous_path ?? null,
      files: files.length,
      posts: posts.length,
      rejectedHashes,
      redacted: redacted.length,
    };
  } finally {
    // Always. A publisher that threw while holding the lease would otherwise block every
    // subsequent run until the TTL expired — five minutes of a stale archive for what may
    // have been one bad row.
    await deps.db.releaseLease(holder).catch(() => {});
  }
}
