/* Rollback — and specifically, what a rollback that only flips the ledger fails to do.
 *
 *     deno test supabase/functions/publish/
 *
 * §2 says "Rollback = flip back", and the tempting implementation is one line:
 * activate_release, pointed at the previous id. Every test below that mentions manifest.json
 * fails against that version and passes against this one, because the ledger is not what
 * anybody reads — §2's read path is "Zero database reads for public visitors", so the
 * archive follows manifest.json on the CDN and nothing else.
 *
 * The fakes are the same shape as release.test.ts's, kept separate rather than shared: this
 * file needs a sink that can be told the target's shards are gone, which the publish tests
 * have no use for.
 */

import { rollback, type CdnPurger, type RollbackDb, type RollbackDeps } from "./rollback.ts";
import type { ObjectSink } from "../_shared/r2.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
}

const NOW = new Date("2026-08-20T09:00:00.000Z");
const TARGET = "/v/2026-08-19T12:00:00Z/";
const LIVE = "/v/2026-08-19T13:00:00Z/";

class FakeSink implements ObjectSink {
  readonly written = new Map<string, { body: string; cacheControl: string }>();
  /** Keys to report as absent — simulates a release whose shards were pruned. */
  missing = new Set<string>();

  put(key: string, body: string, _ct: string, cacheControl: string): Promise<void> {
    this.written.set(key, { body, cacheControl });
    return Promise.resolve();
  }
  exists(key: string): Promise<boolean> {
    return Promise.resolve(!this.missing.has(key));
  }
  remove(key: string): Promise<boolean> {
    this.written.delete(key);
    return Promise.resolve(true);
  }
}

class FakeDb implements RollbackDb {
  leaseGranted = true;
  leaseReason = "granted";
  rollbackOk = true;
  rollbackReason = "lease_expired";
  released: string[] = [];
  /** Every rollback_release call, so a test can assert the reason really reached the ledger. */
  calls: Array<{ path: string; holder: string; reason: string }> = [];

  claimLease(_h: string, _t: number, _n: string) {
    return Promise.resolve({ acquired: this.leaseGranted, reason: this.leaseReason });
  }
  releaseLease(holder: string) {
    this.released.push(holder);
    return Promise.resolve();
  }
  rollbackRelease(path: string, holder: string, reason: string) {
    this.calls.push({ path, holder, reason });
    return Promise.resolve(
      this.rollbackOk
        ? { rolled_back: true, previous_path: LIVE, held: true }
        : { rolled_back: false, reason: this.rollbackReason },
    );
  }
}

class FakePurger implements CdnPurger {
  purged = true;
  calls: string[][] = [];
  purge(paths: string[]) {
    this.calls.push(paths);
    return Promise.resolve({ purged: this.purged, reason: "ok" });
  }
}

function deps(): RollbackDeps & { db: FakeDb; sink: FakeSink; cdn: FakePurger } {
  const db = new FakeDb();
  const sink = new FakeSink();
  const cdn = new FakePurger();
  return { db, sink, cdn, now: () => NOW, newHolder: () => "holder-r1" };
}

/* ── 1 · The assertion a ledger-only rollback fails ─────────── */

// THE discriminator. activate_release alone leaves this object naming the bad release, and
// the archive keeps serving it — for a year, since the CDN caches the shards it points at.
Deno.test("a rollback rewrites manifest.json to name the target release", async () => {
  const d = deps();
  const out = await rollback(d, TARGET, "bad shard build");

  assertEquals(out.rolledBack, true, out.reason);
  const manifest = d.sink.written.get("manifest.json");
  assert(manifest !== undefined, "manifest.json was never written — the ledger moved alone");
  assertEquals(JSON.parse(manifest!.body).release, TARGET, "the pointer still names the wrong release");
});

// The pointer must stay revalidatable. Writing it immutable would make the rollback
// permanent in every cache that saw it, including the next roll-forward.
Deno.test("...at the same short TTL the publisher uses for the pointer", async () => {
  const d = deps();
  await rollback(d, TARGET, "bad shard build");
  const cc = d.sink.written.get("manifest.json")!.cacheControl;
  assert(!cc.includes("immutable"), "the pointer was written immutable");
  assert(/max-age=(3\d|4\d|5\d|60)\b/.test(cc), `§2 wants 30–60s on the pointer, got ${cc}`);
});

Deno.test("the ledger is told the same path the object was given", async () => {
  const d = deps();
  const out = await rollback(d, TARGET, "bad shard build");
  assertEquals(d.db.calls.length, 1, "rollback_release was not called exactly once");
  assertEquals(d.db.calls[0].path, TARGET, "object and ledger were pointed at different releases");
  assertEquals(out.previous, LIVE, "the outcome does not say what was live before");
});

/* ── 2 · The hold, without which the cron reverts this in 120s ── */

Deno.test("a successful rollback reports the pipeline held", async () => {
  const d = deps();
  const out = await rollback(d, TARGET, "bad shard build");
  assertEquals(out.held, true, "rolled back without holding — the next tick will undo it");
});

/* ── 3 · Attribution (§11 gate 5's cheapest failure) ────────── */

// Refused before the lease is even claimed. The database constraint is the guarantee; this
// is so the operator is told before anything moves rather than after the pointer has.
Deno.test("a rollback with no reason is refused before anything is touched", async () => {
  const d = deps();
  const out = await rollback(d, TARGET, "   ");

  assertEquals(out.rolledBack, false, "an unattributed hold was accepted");
  assertEquals(out.reason, "reason_required", "wrong refusal");
  assertEquals(d.sink.written.size, 0, "the pointer was rewritten for a refused rollback");
  assertEquals(d.db.calls.length, 0, "the ledger was called for a refused rollback");
});

Deno.test("...and the reason reaches the ledger trimmed, not as given", async () => {
  const d = deps();
  await rollback(d, TARGET, "  shard builder regression  ");
  assertEquals(d.db.calls[0].reason, "shard builder regression", "reason not normalised");
});

/* ── 4 · Rolling onto a release whose bytes are gone ────────── */

// No pruner exists yet, which is exactly why this is here: §2 defers release pruning, and
// the first thing it will do is make some release directories stop existing. Pointing the
// manifest at one would 404 the whole site, and the CDN would cache the misses.
Deno.test("a target whose shards are gone is refused, and the pointer is NOT moved", async () => {
  const d = deps();
  d.sink.missing.add("v/2026-08-19T12:00:00Z/feed/page-1.json");

  const out = await rollback(d, TARGET, "bad shard build");
  assertEquals(out.rolledBack, false, "rolled onto a release with no shards");
  assertEquals(out.reason, "target_missing", "wrong refusal");
  assertEquals(d.sink.written.size, 0, "manifest.json was rewritten onto a pruned release");
});

/* ── 5 · The lease, as 0038 requires ───────────────────────── */

Deno.test("a rollback that cannot take the lease writes nothing", async () => {
  const d = deps();
  d.db.leaseGranted = false;
  d.db.leaseReason = "held";

  const out = await rollback(d, TARGET, "bad shard build");
  assertEquals(out.rolledBack, false, "rolled back while a publisher held the lease");
  assertEquals(out.reason, "held", "the refusal reason was lost");
  assertEquals(d.sink.written.size, 0, "the pointer moved without the lease");
});

// The window this design accepts and reports: the object leads the ledger, so a refusal here
// leaves the archive already correct and the ledger behind. Never reported as success.
Deno.test("a ledger refusal after the pointer moved is reported, not swallowed", async () => {
  const d = deps();
  d.db.rollbackOk = false;

  const out = await rollback(d, TARGET, "bad shard build");
  assertEquals(out.rolledBack, false, "reported success while the ledger refused");
  assertEquals(out.reason, "lease_expired", "the refusal reason was lost");
  assert(d.sink.written.has("manifest.json"), "test setup wrong — the pointer should have moved first");
});

Deno.test("the lease is always given back, refused or not", async () => {
  const d = deps();
  d.db.rollbackOk = false;
  await rollback(d, TARGET, "bad shard build");
  assertEquals(d.db.released.join(","), "holder-r1", "a failed rollback kept the lease");
});

/* ── 6 · The purge, and why it is not fatal ─────────────────── */

// §8 makes the same argument about takedown: max-age on a CDN object is a floor on how fast
// a decision takes effect, and somebody has already decided this archive is wrong.
Deno.test("the pointer is purged so the rollback is not bounded by a 45s cache", async () => {
  const d = deps();
  await rollback(d, TARGET, "bad shard build");
  assertEquals(d.cdn.calls.length, 1, "the CDN was never purged");
  assertEquals(d.cdn.calls[0].join(","), "/manifest.json", "purged the wrong path");
});

Deno.test("...but an unconfigured purger does not block the rollback", async () => {
  const d = deps();
  d.cdn.purged = false;

  const out = await rollback(d, TARGET, "bad shard build");
  assertEquals(out.rolledBack, true, "a missing purge token blocked a rollback");
  assertEquals(out.purged, false, "the unpurged state is not visible in the outcome");
});

/* ── 7 · Shape ─────────────────────────────────────────────── */

Deno.test("a path that is not a release path is refused without a lease", async () => {
  const d = deps();
  const out = await rollback(d, "https://elsewhere.test/evil", "bad shard build");
  assertEquals(out.reason, "invalid_path", "an arbitrary path was accepted as a release");
  assertEquals(d.db.released.length, 0, "a lease was taken for a malformed path");
});
