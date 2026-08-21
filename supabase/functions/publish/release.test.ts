/* The publish sequence — every failure mode, and what the archive looks like afterwards.
 *
 *     deno test supabase/functions/publish/
 *
 * The happy path is one test here. The other twelve are what happens when something stops
 * halfway, because §10's M2 criterion is not "publishing works" — it is "a killed build
 * never becomes visible" and "two concurrent approvals produce one consistent release".
 * Those are statements about failure, and a suite that only exercises success has nothing
 * to say about either.
 *
 * The sink and the database are fakes with switches, so a test can kill the publisher at a
 * named step and then inspect what a VISITOR would see: the manifest, and only the manifest.
 */

import { publish, releaseFiles, releasePath, type Db, type Deps, type ObjectSink } from "./release.ts";
import type { ContentBlocks, SourcePost, SourceProfile } from "./shards.ts";
import { itemPageKey } from "./prerender.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
}

const NOW = new Date("2026-08-19T12:34:56.789Z");

function post(over: Partial<SourcePost> = {}): SourcePost & { hash_matches?: boolean } {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    kind: "media",
    title_ar: "عنوان", title_en: "A title",
    body_ar: "وصف", body_en: "A description",
    date_earliest: "1963-01-01", date_latest: "1969-12-31",
    date_precision: "decade", decade: 1960,
    location_public: { lat: 31.899, lon: 35.204 },
    location_precision: "street",
    place_name_ar: null, place_name_en: null,
    event_starts_at: null, event_ends_at: null, venue_ar: null, venue_en: null,
    license: "CC-BY-SA-4.0", provenance: "family album",
    author_label: "member", author_handle: "abu_ramallah",
    author_display_name: null, author_avatar_path: null,
    like_count: 0, comment_count: 0, comments: [],
    created_on: "2026-08-19",
    media: [],
    ...over,
  };
}

const SITE = "https://atlas.test";
const CDN = "https://cdn.test";

/** A sink that records everything, and can be told to break at a given key. */
class FakeSink implements ObjectSink {
  readonly written = new Map<string, { body: string; cacheControl: string }>();
  failOn: string | null = null;
  /** Keys to lie about in exists() — simulates an upload that reported success and did not land. */
  vanish = new Set<string>();

  put(key: string, body: string, _ct: string, cacheControl: string): Promise<void> {
    if (this.failOn && key.includes(this.failOn)) {
      return Promise.reject(new Error(`sink refused ${key}`));
    }
    this.written.set(key, { body, cacheControl });
    return Promise.resolve();
  }
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.written.has(key) && !this.vanish.has(key));
  }
  remove(key: string): Promise<boolean> {
    this.written.delete(key);
    return Promise.resolve(true);
  }
}

class FakeDb implements Db {
  posts: Array<SourcePost & { hash_matches?: boolean }> = [post()];
  redacted: string[] = [];
  leaseGranted = true;
  leaseReason = "granted";
  recordOk = true;
  released: string[] = [];
  /** The claim-time revision handed back with each release. undefined means none was. */
  releasedWith: Array<number | undefined> = [];
  activated: string[] = [];
  previousPath: string | null = null;

  /** What the lease reports at claim time. */
  contentRevision = 7;
  counterRevision = 3;
  /** What record_release was actually given — the assertion target for the watermark. */
  recorded: Array<{ path: string; content: number; counter: number; holder: string }> = [];
  /** 0038: the ledger refuses a publisher whose lease lapsed. Both halves are switchable. */
  recordReason = "duplicate_path";
  activateOk = true;
  activateHolder: string | null = null;

  /** M3's three additions to the publisher's read side. */
  blocks: ContentBlocks = {};
  profiles: SourceProfile[] = [];
  unpublishable: string[] = [];

  publishablePosts() {
    // Read AFTER the claim, so this is where a mid-build approval would land. Bumping the
    // revision here reproduces exactly that: the archive moved on between the two calls.
    this.contentRevision += 1;
    return Promise.resolve(this.posts);
  }
  redactedPostIds() { return Promise.resolve(this.redacted); }
  contentBlocks() { return Promise.resolve(this.blocks); }
  publishableProfiles() { return Promise.resolve(this.profiles); }
  unpublishablePostIds() { return Promise.resolve(this.unpublishable); }
  claimLease(_h: string, _t: number, _n: string) {
    return Promise.resolve({
      acquired: this.leaseGranted,
      reason: this.leaseReason,
      content_revision: this.contentRevision,
      counter_revision: this.counterRevision,
    });
  }
  /** Both arguments, because the second is what 0042's follow-up is decided from. */
  releaseLease(holder: string, claimedContentRevision?: number) {
    this.released.push(holder);
    this.releasedWith.push(claimedContentRevision);
    return Promise.resolve();
  }
  recordRelease(path: string, content: number, counter: number, holder: string) {
    this.recorded.push({ path, content, counter, holder });
    return Promise.resolve(
      this.recordOk
        ? { recorded: true, id: "rel-1", path }
        : { recorded: false, reason: this.recordReason },
    );
  }
  activateRelease(id: string, holder: string) {
    this.activated.push(id);
    this.activateHolder = holder;
    return Promise.resolve(
      this.activateOk
        ? { activated: true, previous_path: this.previousPath }
        : { activated: false, reason: "lease_expired" },
    );
  }
}

function deps(db = new FakeDb(), sink = new FakeSink()): Deps & { db: FakeDb; sink: FakeSink } {
  return { db, sink, now: () => NOW, newHolder: () => "holder-1", siteOrigin: SITE, cdnOrigin: CDN };
}

/* ── 1 · The happy path ────────────────────────────────────── */

Deno.test("a publish writes the shards, then the pointer, and flips", async () => {
  const d = deps();
  const out = await publish(d);

  assertEquals(out.published, true, out.reason);
  assertEquals(out.release, "/v/2026-08-19T12:34:56Z/", "wrong release path");
  assert(d.sink.written.has("v/2026-08-19T12:34:56Z/feed/page-1.json"), "no feed page");
  assert(d.sink.written.has("v/2026-08-19T12:34:56Z/item/00000000-0000-0000-0000-0000000000b1.json"), "no item shard");
  assert(d.sink.written.has("manifest.json"), "no manifest");
  assertEquals(d.db.activated.length, 1, "the release was not activated");
});

Deno.test("the manifest names the release, and only that", async () => {
  const d = deps();
  await publish(d);
  const manifest = JSON.parse(d.sink.written.get("manifest.json")!.body);
  assertEquals(manifest.release, "/v/2026-08-19T12:34:56Z/", "manifest points elsewhere");
  // §7: even the publisher's own timestamp is day precision. An exact build time on a
  // world-readable file is a record of when the maintainer was at their desk.
  assertEquals(manifest.generated_on, "2026-08-19", "the manifest carries a precise timestamp");
});

Deno.test("shards are immutable and the pointer is not", async () => {
  const d = deps();
  await publish(d);
  assert(
    d.sink.written.get("v/2026-08-19T12:34:56Z/feed/page-1.json")!.cacheControl.includes("immutable"),
    "a shard under /v/ is not immutable — the whole point of the versioned path",
  );
  const manifestCache = d.sink.written.get("manifest.json")!.cacheControl;
  assert(!manifestCache.includes("immutable"), "the POINTER is immutable, so a flip would never be seen");
  assert(/max-age=(3\d|4\d|5\d|60)\b/.test(manifestCache), `§2 wants 30–60s on the pointer, got ${manifestCache}`);
});

// §8: takedown latency must never be bounded by the publish cycle, and the redaction list
// is the mechanism. A TTL as long as the manifest's would bound it by exactly that.
Deno.test("redactions.json is shorter-lived than the manifest", async () => {
  const d = deps();
  d.db.redacted = ["00000000-0000-0000-0000-0000000000ff"];
  await publish(d);
  const red = d.sink.written.get("redactions.json")!;
  const man = d.sink.written.get("manifest.json")!;
  const age = (s: string) => Number(/max-age=(\d+)/.exec(s)?.[1] ?? "0");
  assert(age(red.cacheControl) < age(man.cacheControl), "redactions outlive the pointer");
  assertEquals(JSON.parse(red.body).ids.length, 1, "the redacted id is missing");
});

Deno.test("...and is copied inside the release too, for a client holding a year-old cache", async () => {
  const d = deps();
  d.db.redacted = ["00000000-0000-0000-0000-0000000000ff"];
  await publish(d);
  assert(
    d.sink.written.has("v/2026-08-19T12:34:56Z/redactions.json"),
    "a client that never re-reads the root would render a taken-down item forever",
  );
});

/* ── 2 · The lease ─────────────────────────────────────────── */

Deno.test("a publisher that cannot take the lease writes NOTHING", async () => {
  const d = deps();
  d.db.leaseGranted = false;
  d.db.leaseReason = "held";
  const out = await publish(d);

  assertEquals(out.published, false, "it published anyway");
  assertEquals(out.reason, "held", "wrong reason");
  assertEquals(d.sink.written.size, 0, "a refused publisher touched the bucket");
  assertEquals(d.db.activated.length, 0, "a refused publisher flipped the pointer");
});

Deno.test("...and does not release a lease it never held", async () => {
  const d = deps();
  d.db.leaseGranted = false;
  await publish(d);
  assertEquals(d.db.released.length, 0, "it released somebody else's lease");
});

Deno.test("the lease is released even when the publish throws", async () => {
  const d = deps();
  d.sink.failOn = "feed/page-1.json";
  await publish(d).catch(() => {});
  assertEquals(d.db.released.length, 1, "a crashed publisher kept the lease for the full TTL");
});

/* ── 3 · A killed build is never visible ───────────────────── */

Deno.test("a build that dies mid-upload never writes the pointer", async () => {
  const d = deps();
  d.sink.failOn = "item/";
  const threw = await publish(d).then(() => false, () => true);

  assert(threw, "a failed upload was swallowed");
  assert(!d.sink.written.has("manifest.json"), "the pointer was written for a half-built release");
  assertEquals(d.db.activated.length, 0, "a half-built release was activated");
});

// The subtler one: every upload REPORTED success and one object is not actually there.
// This is why validation reads the bucket back instead of checking the plan it just sent.
Deno.test("a release with a missing object is refused before the flip", async () => {
  const d = deps();
  const out = await publish(d);
  assertEquals(out.published, true, "setup");

  const d2 = deps();
  d2.sink.vanish.add("v/2026-08-19T12:34:56Z/item/00000000-0000-0000-0000-0000000000b1.json");
  const out2 = await publish(d2);

  assertEquals(out2.published, false, "an incomplete release was published");
  assertEquals(out2.reason, "incomplete_release", "wrong reason");
  assert(!d2.sink.written.has("manifest.json"), "the pointer named an incomplete release");
  assertEquals(d2.db.activated.length, 0, "an incomplete release was activated");
});

Deno.test("a release that cannot be recorded is not flipped onto", async () => {
  const d = deps();
  d.db.recordOk = false;
  const out = await publish(d);
  assertEquals(out.published, false, "it published without a ledger row");
  assert(!d.sink.written.has("manifest.json"), "the pointer moved without a releases row");
});

/* ── 4 · §5, the content hash ──────────────────────────────── */

Deno.test("a row whose hash no longer matches its approval is refused", async () => {
  const d = deps();
  d.db.posts = [
    post({ id: "00000000-0000-0000-0000-00000000aaaa" }),
    { ...post({ id: "00000000-0000-0000-0000-00000000bbbb" }), hash_matches: false },
  ];
  const out = await publish(d);

  assertEquals(out.published, true, "the whole publish was abandoned over one bad row");
  assertEquals(out.posts, 1, "the altered row was published");
  assert(!d.sink.written.has("v/2026-08-19T12:34:56Z/item/00000000-0000-0000-0000-00000000bbbb.json"),
    "the altered row got an item shard");
});

// Refused AND named. A row that silently vanished is indistinguishable from one that was
// never approved, and content altered after approval is the case somebody must hear about.
Deno.test("...and is named in the outcome rather than silently dropped", async () => {
  const d = deps();
  d.db.posts = [{ ...post({ id: "00000000-0000-0000-0000-00000000bbbb" }), hash_matches: false }];
  const out = await publish(d);
  assertEquals(out.rejectedHashes?.join(","), "00000000-0000-0000-0000-00000000bbbb", "not reported");
});

/* ── 5 · Shapes ────────────────────────────────────────────── */

Deno.test("the release path matches what releases_path_shape accepts", () => {
  const path = releasePath(NOW);
  assert(/^\/v\/[0-9TZ:.-]+\/$/.test(path), `${path} would be refused by record_release`);
});

Deno.test("every file in a release sits under the versioned prefix", () => {
  const files = releaseFiles([post()], [], "/v/2026-08-19T12:34:56Z/");
  const stray = files.filter((f) => !f.path.startsWith("v/2026-08-19T12:34:56Z/"));
  assertEquals(stray.length, 0, `these would overwrite a live path: ${stray.map((f) => f.path).join(", ")}`);
});

Deno.test("an empty archive still publishes — a first run has nothing approved yet", async () => {
  const d = deps();
  d.db.posts = [];
  const out = await publish(d);
  assertEquals(out.published, true, out.reason);
  assert(d.sink.written.has("v/2026-08-19T12:34:56Z/feed/page-1.json"), "no empty feed page");
});

/* ── 6 · The debounce watermark (M2 piece 5) ───────────────── */

// The whole reason claimLease reports a revision. FakeDb bumps contentRevision inside
// publishablePosts(), which is the mid-build approval: the archive changed between the
// claim and the read. The release is stamped with the number from BEFORE the read, so the
// next tick still sees that approval as pending.
Deno.test("a release is stamped with the revision the LEASE was claimed at", async () => {
  const d = deps();
  d.db.contentRevision = 7;
  d.db.counterRevision = 3;

  const out = await publish(d);
  assertEquals(out.published, true, out.reason);
  assertEquals(d.db.recorded.length, 1, "record_release was not called exactly once");
  assertEquals(d.db.recorded[0].content, 7, "stamped the post-read revision — a mid-build approval is now lost");
  assertEquals(d.db.recorded[0].counter, 3, "counter revision not carried from the claim");

  // And the counter-test for the assertion above: the value it must NOT be. If publish()
  // ever reads the revision after publishablePosts() this is what it would record, and the
  // approval that arrived during the build would be marked published without being in it.
  assertEquals(d.db.contentRevision, 8, "FakeDb did not simulate a mid-build change");
});

// A refused lease carries no revision, and nothing downstream should invent one — there is
// no build to stamp because there is no build.
Deno.test("a refused lease records nothing at all", async () => {
  const d = deps();
  d.db.leaseGranted = false;
  d.db.leaseReason = "held";

  const out = await publish(d);
  assertEquals(out.published, false, "published while another writer held the lease");
  assertEquals(d.db.recorded.length, 0, "recorded a release without holding the lease");
});

/* ── 7 · The lease covers the WRITES, not just the start (0038) ── */

// The holder reaches both ledger calls. Without it the database cannot tell a publisher
// that still holds its lease from one whose TTL lapsed forty seconds ago.
Deno.test("the lease holder is carried into record and activate, not just the claim", async () => {
  const d = deps();
  await publish(d);
  assertEquals(d.db.recorded[0].holder, "holder-1", "record_release was not told who is publishing");
  assertEquals(d.db.activateHolder, "holder-1", "activate_release was not told who is publishing");
});

// The window 0038 leaves open, reported rather than hidden. The manifest object is written
// before activate_release — deliberately, so the ledger can never claim a release the
// archive is not serving — which means a refusal here leaves the object ahead of the row.
// An operator has to be told; a `published: true` would be a lie about which release is live.
Deno.test("a flip refused for a lapsed lease is reported, not swallowed", async () => {
  const d = deps();
  d.db.activateOk = false;

  const out = await publish(d);
  assertEquals(out.published, false, "reported success while the ledger refused the flip");
  assertEquals(out.reason, "lease_expired", "the refusal reason was lost");
});

// Constraint: a refusal must leave the next tick able to retry. Nothing was activated, so
// the ACTIVE release keeps its old watermark and publish_pending still says pending —
// 20_publish_cron test 28 asserts that half against a real database.
Deno.test("...and the lease is still released, so the next tick is not locked out", async () => {
  const d = deps();
  d.db.activateOk = false;
  await publish(d);
  assertEquals(d.db.released.join(","), "holder-1", "a refused flip left the lease held");
});

/* ── 8 · The follow-up, which is what the cron used to be (0042) ── */

// With the cron unscheduled, an approval that commits between claimLease() and
// publishablePosts() has nobody left to notice it: it is not in this release, and its own
// dispatch was answered `held` by the lease it collided with. 0042 compares the claim-time
// revision against the revision at release time and asks for one more publish if it moved —
// so this number has to actually arrive there.
//
// FakeDb bumps contentRevision inside publishablePosts(), which is that exact window.

Deno.test("the lease goes back with the revision it was claimed at, not the current one", async () => {
  const d = deps();
  d.db.contentRevision = 7;

  await publish(d);

  assertEquals(d.db.releasedWith.length, 1, "released once");
  assertEquals(
    d.db.releasedWith[0],
    7,
    "sent the post-read revision — a mid-build approval would then never be followed up",
  );
  // The counter-test for the line above: 8 is what the database holds by now, and sending
  // it would make the comparison 8 > 8, false, and the follow-up silently never fire.
  assertEquals(d.db.contentRevision, 8, "FakeDb did not simulate a mid-build change");
});

// Every exit, not just the happy one. A build that fails validation is exactly when a
// mid-build approval most needs the follow-up, because no release was recorded and the
// watermark did not move.
Deno.test("...on the failure paths too, since those are where the lease is released early", async () => {
  for (
    const [label, brk] of [
      ["a flip refused for a lapsed lease", (d: ReturnType<typeof deps>) => { d.db.activateOk = false; }],
      // The full key, prefix included — the same one test "a shard that did not land is
      // caught before the pointer moves" uses. A bare "feed/page-1.json" matches nothing and
      // would make this loop assert a SUCCESSFUL publish, which is not the path under test.
      [
        "a release that did not fully land",
        (d: ReturnType<typeof deps>) => {
          d.sink.vanish.add("v/2026-08-19T12:34:56Z/feed/page-1.json");
        },
      ],
    ] as const
  ) {
    const d = deps();
    d.db.contentRevision = 7;
    brk(d);
    const out = await publish(d);
    assertEquals(out.published, false, `${label}: expected a failure to test`);
    assertEquals(d.db.releasedWith[0], 7, `${label}: no revision went back with the lease`);
  }
});

/* ── M3: the prerendered item pages ────────────────────────── */

Deno.test("item pages are written at the ROOT, outside the release directory", async () => {
  const d = deps();
  const out = await publish(d);

  const key = itemPageKey(d.db.posts[0].id);
  assert(d.sink.written.has(key), `no page at ${key}`);
  assertEquals(out.pages, 1, "the outcome does not report the page");

  // The structural decision, asserted rather than commented: a permalink cannot live under
  // /v/{ts}/ because resolving it would need the manifest read first — a request in front
  // of every link anyone has ever shared, and a redirect a crawler may not follow.
  assert(!key.startsWith("v/"), "an item page is inside a release directory");
  for (const written of d.sink.written.keys()) {
    if (written.endsWith("/index.html")) {
      assert(!written.startsWith("v/"), `a page was written under a release: ${written}`);
    }
  }
});

Deno.test("an item page is HTML with a short TTL, not an immutable shard", async () => {
  const d = deps();
  await publish(d);
  const entry = d.sink.written.get(itemPageKey(d.db.posts[0].id))!;

  assert(entry.body.startsWith("<!DOCTYPE html>"), "the page is not a document");
  assert(entry.body.includes('property="og:url" content="https://atlas.test/item/'),
    "the page does not carry an absolute og:url");

  // It is rewritten in place on every publish, so it CANNOT be immutable — a year-cached
  // page would keep a corrected title out of every preview card forever.
  assert(!entry.cacheControl.includes("immutable"),
    `an item page must not be immutable: ${entry.cacheControl}`);
  assert(/max-age=\d+/.test(entry.cacheControl) && entry.cacheControl.includes("must-revalidate"),
    `unexpected cache header: ${entry.cacheControl}`);
});

Deno.test("the pages are written AFTER the flip, so a killed build leaves the old ones", async () => {
  const d = deps();
  // The flip fails: the lease lapsed between recording and activating.
  d.db.activateOk = false;
  const out = await publish(d);

  assertEquals(out.published, false, "a failed flip must not report a publish");
  assert(!d.sink.written.has(itemPageKey(d.db.posts[0].id)),
    "an item page was written for a release that never went live");
});

Deno.test("a post that stopped being publishable loses its page", async () => {
  const d = deps();
  // Withdrawn, rejected after approval, edited past its approval hash — the quiet exits.
  // Takedown does not use this path; §8 deletes the page in the same request as the bytes.
  d.db.unpublishable = ["00000000-0000-0000-0000-00000000dead"];
  const removed: string[] = [];
  const realRemove = d.sink.remove.bind(d.sink);
  d.sink.remove = (key: string) => { removed.push(key); return realRemove(key); };

  await publish(d);
  assertEquals(removed.join(","), itemPageKey("00000000-0000-0000-0000-00000000dead"),
    "the withdrawn post's page was not deleted");
});

Deno.test("a page that cannot be written does NOT fail the release", async () => {
  // The archive is correct without a prerendered page — the SPA renders the same item from
  // the same shard. Holding the pointer hostage to a preview card would be the wrong thing
  // to be strict about, and it would mean one bad object blocks every approval.
  const d = deps();
  const realPut = d.sink.put.bind(d.sink);
  d.sink.put = (key: string, body: string, ct: string, cc: string) =>
    key.endsWith("/index.html")
      ? Promise.reject(new Error("R2 said no"))
      : realPut(key, body, ct, cc);

  const out = await publish(d);
  assertEquals(out.published, true, "a failed page must not fail the release");
  assertEquals(out.pages, 0, "no page was written");
  assertEquals((out.pagesFailed ?? []).length, 1, "the failure is not reported");
  // ...and the archive itself is intact and pointed at.
  assert(d.sink.written.has("manifest.json"), "the pointer is missing");
});

/* ── M3: content, profiles and the index in a release ───────── */

Deno.test("a release carries the copy, the profiles and its own index", async () => {
  const d = deps();
  d.db.blocks = { "hero.line": { ar: "هنا", en: "Here" } };
  d.db.profiles = [{
    handle: "abu_ramallah", display_name: null, avatar_path: null, label: "member",
    bio: null, member_since: 2025, show_contributions: true, show_comments: true,
  }];

  const out = await publish(d);
  const prefix = out.release!.slice(1);

  assert(d.sink.written.has(`${prefix}content.json`), "content.json is missing");
  assert(d.sink.written.has(`${prefix}profile/abu_ramallah.json`), "the profile shard is missing");
  assert(d.sink.written.has(`${prefix}index.json`), "index.json is missing");

  // Inside the release, so they are immutable with it — unlike the item pages above. A
  // profile shard that outlived its release would describe a different archive.
  assertEquals(d.sink.written.get(`${prefix}content.json`)!.cacheControl,
    "public, max-age=31536000, immutable", "content.json is not immutable");
});

Deno.test("the copy that ships is the published half, verbatim", async () => {
  const d = deps();
  d.db.blocks = { "page.about.body": { ar: "نصّ عربي", en: "English text" } };
  const out = await publish(d);
  const body = JSON.parse(d.sink.written.get(`${out.release!.slice(1)}content.json`)!.body);
  assertEquals(body.blocks["page.about.body"].ar, "نصّ عربي", "the Arabic side did not survive");
  assertEquals(body.blocks["page.about.body"].en, "English text", "the English side did not survive");
});
