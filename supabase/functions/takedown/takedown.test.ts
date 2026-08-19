/* Takedown — the partial failures, which are the whole reason this is not one RPC.
 *
 *     deno test supabase/functions/takedown/
 *
 * §8 lists four steps. Three of them touch a system that can fail independently of the
 * others, so "a takedown happened" is not a boolean — and the difference between removed
 * and marked-as-removed-but-still-served is the entire feature. Most of this file is
 * therefore about telling a moderator the truth when something did not work.
 */

import { takeDown, type CdnPurger, type Deps, type TakedownDb, type TakedownObject } from "./takedown.ts";
import type { ObjectSink } from "../_shared/r2.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
}

const POST = "00000000-0000-0000-0000-0000000000b1";

const OBJECTS: TakedownObject[] = [
  { bucket: "public", path: `${POST}/thumb.webp`, role: "thumb" },
  { bucket: "public", path: `${POST}/1080p.mp4`, role: "rendition" },
  { bucket: "originals", path: "uploader-uuid/original", role: "master" },
];

class FakeSink implements ObjectSink {
  readonly removed: string[] = [];
  readonly written = new Map<string, { body: string; cacheControl: string }>();
  failRemove: string | null = null;
  failPut = false;

  put(key: string, body: string, _ct: string, cacheControl: string): Promise<void> {
    if (this.failPut) return Promise.reject(new Error("put failed"));
    this.written.set(key, { body, cacheControl });
    return Promise.resolve();
  }
  exists(key: string): Promise<boolean> { return Promise.resolve(this.written.has(key)); }
  remove(key: string): Promise<boolean> {
    if (this.failRemove && key.includes(this.failRemove)) return Promise.resolve(false);
    this.removed.push(key);
    return Promise.resolve(true);
  }
}

class FakeDb implements TakedownDb {
  markResult: { ok: boolean; reason: string; post_id?: string; objects?: TakedownObject[] } = {
    ok: true, reason: "taken_down", post_id: POST, objects: OBJECTS,
  };
  redacted: string[] = [POST];
  readonly calls: Array<{ postId: string; note: string | null }> = [];

  requestTakedown(postId: string, note: string | null) {
    this.calls.push({ postId, note });
    return Promise.resolve(this.markResult);
  }
  redactedPostIds() { return Promise.resolve(this.redacted); }
}

class FakePurger implements CdnPurger {
  purged: string[][] = [];
  result = { purged: true, reason: "purged" };
  purge(paths: string[]) {
    this.purged.push(paths);
    return Promise.resolve(this.result);
  }
}

function deps() {
  const pub = new FakeSink();
  const orig = new FakeSink();
  const db = new FakeDb();
  const cdn = new FakePurger();
  const d: Deps & { db: FakeDb; cdn: FakePurger; pub: FakeSink; orig: FakeSink } = {
    db, cdn, pub, orig,
    sinks: { public: pub, originals: orig },
    redactionSink: pub,
  };
  return d;
}

/* ── 1 · The whole thing ───────────────────────────────────── */

Deno.test("a takedown removes every object, purges, and rewrites the redaction list", async () => {
  const d = deps();
  const out = await takeDown(POST, "DMCA request", d);

  assertEquals(out.ok, true, out.reason);
  assertEquals(out.removed?.length, 3, "not everything was removed");
  assert(d.cdn.purged.length === 1, "the CDN was not purged");
  assert(d.pub.written.has("redactions.json"), "the redaction list was not rewritten");
});

// §6 calls originals/ the preservation copy — right up until someone asks for the material
// to be removed, at which point "we still hold it, just privately" is not what was agreed.
Deno.test("the archival master is deleted too, not just the derivatives", async () => {
  const d = deps();
  await takeDown(POST, null, d);
  assertEquals(d.orig.removed.length, 1, "the master survived the takedown");
  assertEquals(d.orig.removed[0], "uploader-uuid/original", "wrong object");
});

// Only the public bucket is CDN-fronted. Purging an originals path would be a request for
// a URL that has never existed — harmless, and a lie about the shape of the system.
Deno.test("only CDN-fronted paths are purged", async () => {
  const d = deps();
  await takeDown(POST, null, d);
  assertEquals(d.cdn.purged[0].length, 2, "the originals path was sent to the purge API");
  assert(!d.cdn.purged[0].some((p) => p.includes("uploader-uuid")), "an originals path was purged");
});

Deno.test("the note reaches the database, where the ledger records it", async () => {
  const d = deps();
  await takeDown(POST, "family requested removal", d);
  assertEquals(d.db.calls[0].note, "family requested removal", "the reason was dropped");
});

/* ── 2 · The database refuses ──────────────────────────────── */

Deno.test("a member gets forbidden, and nothing is deleted", async () => {
  const d = deps();
  d.db.markResult = { ok: false, reason: "forbidden" };
  const out = await takeDown(POST, null, d);

  assertEquals(out.ok, false, "a refused caller succeeded");
  assertEquals(out.reason, "forbidden", "wrong reason");
  assertEquals(d.pub.removed.length + d.orig.removed.length, 0, "a refused caller deleted bytes");
  assertEquals(d.cdn.purged.length, 0, "a refused caller purged the CDN");
});

Deno.test("an unknown post deletes nothing", async () => {
  const d = deps();
  d.db.markResult = { ok: false, reason: "unknown_post" };
  const out = await takeDown(POST, null, d);
  assertEquals(out.reason, "unknown_post", "wrong reason");
  assertEquals(d.pub.removed.length, 0, "objects were deleted for a post that does not exist");
});

/* ── 3 · Partial failure, reported ─────────────────────────── */

// The one that matters. A moderator told "done" while an object is still served has been
// given something strictly worse than an error: they will tell the contributor it is gone.
Deno.test("an object that will not delete makes the whole takedown NOT ok", async () => {
  const d = deps();
  d.pub.failRemove = "1080p";
  const out = await takeDown(POST, null, d);

  assertEquals(out.ok, false, "a takedown with a surviving object reported success");
  assertEquals(out.reason, "objects_remain", "wrong reason");
  assertEquals(out.failed?.length, 1, "the surviving object was not named");
  assert(out.failed![0].includes("1080p"), "the wrong object was named");
  assertEquals(out.removed?.length, 2, "the others should still have been removed");
});

// Deleting from R2 evicts nothing the CDN already holds, and derivatives carry a
// one-year immutable TTL. Without the purge the file stays retrievable at its original URL.
Deno.test("an unpurged CDN makes the takedown NOT ok, even with every byte deleted", async () => {
  const d = deps();
  d.cdn.result = { purged: false, reason: "not_configured" };
  const out = await takeDown(POST, null, d);

  assertEquals(out.ok, false, "a takedown with a live CDN copy reported success");
  assertEquals(out.reason, "cdn_not_purged", "wrong reason");
  assertEquals(out.cdn_reason, "not_configured", "the operator is not told why");
  assertEquals(out.removed?.length, 3, "the bytes should still be gone from the origin");
});

Deno.test("a redaction list that cannot be written makes the takedown NOT ok", async () => {
  const d = deps();
  d.pub.failPut = true;
  const out = await takeDown(POST, null, d);
  assertEquals(out.ok, false, "clients would still render the item");
  assertEquals(out.reason, "redactions_not_written", "wrong reason");
});

/* ── 4 · Retrying ──────────────────────────────────────────── */

// The documented recovery path for the half-done state 0036's ordering deliberately
// chooses. A second attempt has to be able to finish the job.
Deno.test("a retry after a partial failure still gets the object list", async () => {
  const d = deps();
  d.db.markResult = { ok: true, reason: "already_taken_down", post_id: POST, objects: OBJECTS };
  const out = await takeDown(POST, null, d);

  assertEquals(out.ok, true, out.reason);
  assertEquals(out.removed?.length, 3, "a retry could not reach the objects");
});

Deno.test("a post with no media still marks, purges nothing, and succeeds", async () => {
  const d = deps();
  d.db.markResult = { ok: true, reason: "taken_down", post_id: POST, objects: [] };
  const out = await takeDown(POST, null, d);

  assertEquals(out.ok, true, out.reason);
  assertEquals(d.cdn.purged.length, 0, "an empty purge was sent");
  assert(d.pub.written.has("redactions.json"), "the redaction list must still be rewritten");
});

/* ── 5 · The redaction list itself ─────────────────────────── */

// Rebuilt from the database rather than appended to. An append drifts the moment a takedown
// lands while a publish is mid-flight, and the file it drifts from is the one clients trust.
Deno.test("the redaction list is rebuilt from the database, not appended to", async () => {
  const d = deps();
  d.db.redacted = ["id-a", "id-b", POST];
  const out = await takeDown(POST, null, d);

  const written = JSON.parse(d.pub.written.get("redactions.json")!.body);
  assertEquals(written.ids.length, 3, "the list was not rebuilt from the database");
  assertEquals(out.redacted_total, 3, "the count was not reported");
});

Deno.test("...at a TTL short enough that takedown is not bounded by a cache", async () => {
  const d = deps();
  await takeDown(POST, null, d);
  const cache = d.pub.written.get("redactions.json")!.cacheControl;
  const maxAge = Number(/max-age=(\d+)/.exec(cache)?.[1] ?? "999999");
  assert(maxAge <= 60, `§8 wants this short; got ${cache}`);
  assert(!cache.includes("immutable"), "the redaction list is immutable, so it can never update");
});
