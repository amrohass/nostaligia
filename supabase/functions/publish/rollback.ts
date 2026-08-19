/* Rollback. §2's "Rollback = flip back", with the half that sentence leaves out.
 *
 *     lease → verify the target still exists → WRITE THE POINTER → purge → flip + hold
 *
 * ── Why this is not just activate_release backwards ──────────
 *
 * The ledger is not what anybody reads. §2's read path is "Zero database reads for public
 * visitors": a browser learns which release is live from manifest.json on the CDN, and
 * nothing else. Flipping the `releases` row without rewriting that object leaves the archive
 * serving the bad release while every query says otherwise — the exact inversion the publish
 * sequence orders itself to avoid.
 *
 * So the pointer object is written BEFORE the ledger moves, for the same reason publish()
 * does it in that order: if the two ever disagree, the archive must be the one that is
 * already right.
 *
 * ── Why the target is verified first ─────────────────────────
 *
 * Everything under /v/ is immutable and nothing prunes it today, so a recorded release's
 * shards are still there. "Today" is doing real work in that sentence — release pruning is
 * named in CLAUDE.md §2 as deferred work, and the first thing it will do is make some
 * release directories stop existing. Rolling the pointer onto a pruned release would 404
 * the entire site, and the CDN would cache the 404s.
 *
 * feed/page-1.json is the sentinel because every release has one, including a release built
 * from an empty archive — release.test.ts pins that case specifically.
 *
 * ── Why the hold is not optional ─────────────────────────────
 *
 * publish_pending() compares the live revision against the ACTIVE release's stamped one. A
 * rolled-back release carries an OLDER watermark, so the predicate goes true and the next
 * two-minute tick republishes exactly what was just rolled away from. The database sets the
 * hold in the same transaction as the flip; this module's job is to refuse to report success
 * when that did not happen.
 */

import { stableStringify } from "./shards.ts";
import type { ObjectSink } from "../_shared/r2.ts";

/** The database, as rollback uses it. Every call is one PostgREST RPC. */
export interface RollbackDb {
  claimLease(holder: string, ttlSeconds: number, note: string): Promise<{
    acquired: boolean;
    reason: string;
  }>;
  releaseLease(holder: string): Promise<void>;
  rollbackRelease(path: string, holder: string, reason: string): Promise<{
    rolled_back: boolean;
    reason?: string;
    previous_path?: string | null;
    held?: boolean;
  }>;
}

/** Purging is optional infrastructure; a missing token must not fail a rollback. */
export interface CdnPurger {
  purge(paths: string[]): Promise<{ purged: boolean; reason?: string }>;
}

export interface RollbackDeps {
  db: RollbackDb;
  sink: ObjectSink;
  cdn: CdnPurger;
  now: () => Date;
  newHolder: () => string;
}

export interface RollbackOutcome {
  rolledBack: boolean;
  reason: string;
  release?: string;
  previous?: string | null;
  held?: boolean;
  purged?: boolean;
}

/** §2: "TTL 30–60 s" on the pointer. Identical to publish(), because it is the same object. */
const MANIFEST_CACHE = "public, max-age=45, must-revalidate";
const LEASE_TTL_SECONDS = 300;

/** `/v/2026-08-19T12:34:56Z/` → `v/2026-08-19T12:34:56Z/`, the bucket-relative form. */
function keyPrefix(releasePath: string): string {
  return releasePath.startsWith("/") ? releasePath.slice(1) : releasePath;
}

export async function rollback(
  deps: RollbackDeps,
  targetPath: string,
  why: string,
): Promise<RollbackOutcome> {
  // Refused here as well as in SQL. The database constraint is the guarantee; this is so an
  // operator who forgot the reason is told before anything is touched, rather than after the
  // pointer has already moved.
  if (!why || !why.trim()) return { rolledBack: false, reason: "reason_required" };
  if (!/^\/v\/[0-9TZ:.-]+\/$/.test(targetPath)) {
    return { rolledBack: false, reason: "invalid_path" };
  }

  const holder = deps.newHolder();

  // The lease covers the WHOLE sequence, which is what makes the ordering below safe: no
  // publisher can be mid-build and no cron tick can interleave between the object write and
  // the ledger move.
  const lease = await deps.db.claimLease(holder, LEASE_TTL_SECONDS, "rollback");
  if (!lease.acquired) return { rolledBack: false, reason: lease.reason };

  try {
    // ── 1 · the target is still really there ──
    if (!(await deps.sink.exists(`${keyPrefix(targetPath)}feed/page-1.json`))) {
      return { rolledBack: false, reason: "target_missing", release: targetPath };
    }

    // ── 2 · the pointer, before the ledger ──
    await deps.sink.put(
      "manifest.json",
      stableStringify({
        release: targetPath,
        generated_on: deps.now().toISOString().slice(0, 10),
      }),
      "application/json; charset=utf-8",
      MANIFEST_CACHE,
    );

    // ── 3 · purge, so the rollback is not bounded by a cache ──
    //
    // max-age=45 means up to forty-five seconds of continued bad archive otherwise. Takedown
    // makes the same argument in §8 and this is the same kind of moment: somebody has already
    // decided what is being served is wrong. Reported, never fatal — an unconfigured purge
    // token must not block a rollback, it must be visible in the outcome.
    const purge = await deps.cdn.purge(["/manifest.json"]);

    // ── 4 · flip and hold, one transaction ──
    const moved = await deps.db.rollbackRelease(targetPath, holder, why.trim());
    if (!moved.rolled_back) {
      // The object now names the target and the ledger does not. That is the safe side of
      // the disagreement — the archive is already serving the good release — but it is still
      // a disagreement, and an operator has to be told which way round it is.
      return {
        rolledBack: false,
        reason: moved.reason ?? "rollback_failed",
        release: targetPath,
        purged: purge.purged,
      };
    }

    return {
      rolledBack: true,
      reason: "rolled_back",
      release: targetPath,
      previous: moved.previous_path ?? null,
      held: moved.held === true,
      purged: purge.purged,
    };
  } finally {
    // Always. A rollback that threw while holding the lease would block every publish until
    // the TTL expired — five minutes of a pipeline that is already in trouble.
    await deps.db.releaseLease(holder).catch(() => {});
  }
}
