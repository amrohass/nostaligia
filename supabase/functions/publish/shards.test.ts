/* The shard builder, and the §7 gate on what it emits.
 *
 *     deno test supabase/functions/publish/
 *
 * ── The gate ─────────────────────────────────────────────────
 *
 * A shard is cached for a year, served to everyone, and copied onward by anyone who saves
 * the page. There is no taking one back. So the central test here is not "does the feed
 * paginate" — it is: given a row where EVERY field that must never be published carries a
 * recognisable sentinel, does any sentinel appear anywhere in the emitted bytes?
 *
 * Bytes, not object keys. `assertEquals(Object.keys(out), [...])` would pass a builder that
 * copied the raw location into a nested `details` blob, or interpolated the uploader's uuid
 * into a media path — which is a real thing that happened once already, in M1 piece 3, and
 * was caught the same way. Scanning the serialised output does not care how the leak got
 * there.
 *
 * And the gate is proved to work before it is trusted: the last test feeds the sentinels to
 * JSON.stringify directly and asserts the scan DOES find them. A scanner that returns
 * "clean" for everything is indistinguishable from a clean build, and it would stay that way
 * for years.
 */

import {
  buildShards,
  FEED_PAGE_SIZE,
  feedEntry,
  geohash,
  publicPost,
  type SourceAsset,
  type SourcePost,
  stableStringify,
} from "./shards.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

/* ── The sentinels ─────────────────────────────────────────── */
//
// Distinctive strings rather than realistic values, so a match is unambiguous and a
// substring collision is impossible.

const SECRET = {
  rawLat: 31.899612345,
  rawLon: 35.204298765,
  createdBy: "SENTINEL-AUTH-USER-ID-11111111",
  objectKey: "SENTINEL-UPLOADER-UUID/SENTINEL-OBJECT",
  createdAt: "SENTINEL-2026-08-19T04:17:33.918Z",
  consentNote: "SENTINEL-CONSENT-LEGAL-RECORD",
  contentHash: "SENTINEL-CONTENT-HASH",
  approvedBy: "SENTINEL-MODERATOR-ID",
  email: "SENTINEL-contributor@example.test",
  masterPath: "SENTINEL-UPLOADER-UUID/SENTINEL-MASTER",
};

const SENTINELS = [
  String(SECRET.rawLat),
  String(SECRET.rawLon),
  SECRET.createdBy,
  SECRET.objectKey,
  SECRET.createdAt,
  SECRET.consentNote,
  SECRET.contentHash,
  SECRET.approvedBy,
  SECRET.email,
  SECRET.masterPath,
];

/** Every sentinel found in a blob of text, by name. */
function leaks(text: string): string[] {
  return SENTINELS.filter((s) => text.includes(s));
}

function asset(over: Partial<SourceAsset> = {}): SourceAsset {
  return {
    role: "thumb",
    rendition: null,
    storage_path: "00000000-0000-0000-0000-0000000000b1/thumb.webp",
    bucket: "public",
    mime: "image/webp",
    width: 640,
    height: 480,
    duration_s: null,
    ...over,
  };
}

/** A row carrying everything a publisher could ever be handed, hostile fields included. */
function row(over: Partial<SourcePost> = {}): SourcePost {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    kind: "media",
    title_ar: "عنوان",
    title_en: "A title",
    body_ar: "وصف",
    body_en: "A description",
    date_earliest: "1963-01-01",
    date_latest: "1969-12-31",
    date_precision: "decade",
    decade: 1960,
    location_public: { lat: 31.899, lon: 35.204 },
    location_precision: "street",
    place_name_ar: "المنارة",
    place_name_en: "Al-Manara",
    event_starts_at: null,
    event_ends_at: null,
    venue_ar: null,
    venue_en: null,
    license: "CC-BY-SA-4.0",
    provenance: "family album",
    author_label: "member",
    author_handle: "abu_ramallah",
    author_display_name: "أبو رام الله",
    author_avatar_path: "avatars/gen-7.webp",
    like_count: 12,
    comment_count: 3,
    created_on: "2026-08-19",
    media: [
      asset(),
      asset({ role: "rendition", rendition: "1080p", storage_path: "00000000-0000-0000-0000-0000000000b1/1080p.mp4", mime: "video/mp4" }),
      // The master. §6: never through the public CDN path — so never in a shard, which is
      // a permanent world-readable index of exactly that.
      asset({ role: "master", storage_path: SECRET.masterPath, bucket: "originals", mime: "image/jpeg" }),
    ],

    // Present on the row, and forbidden in the output.
    location: { lat: SECRET.rawLat, lon: SECRET.rawLon },
    created_by: SECRET.createdBy,
    created_at: SECRET.createdAt,
    ingest_object_key: SECRET.objectKey,
    consent: { granted: true, note: SECRET.consentNote, email: SECRET.email },
    content_hash: SECRET.contentHash,
    approved_by: SECRET.approvedBy,
    approved_at: SECRET.createdAt,
    status: "approved",
    takedown: false,
    ...over,
  };
}

/* ── 1 · The gate ──────────────────────────────────────────── */

Deno.test("§7 — no forbidden field survives into any shard, at any nesting depth", () => {
  const all = buildShards([row(), row({ id: "00000000-0000-0000-0000-0000000000b2" })])
    .map((f) => `${f.path}\n${f.json}`)
    .join("\n");

  const found = leaks(all);
  assert(
    found.length === 0,
    `these reached a published shard:\n  ${found.join("\n  ")}`,
  );
});

Deno.test("...and not into a single item shard either", () => {
  const found = leaks(stableStringify(publicPost(row())));
  assert(found.length === 0, `item shard leaked: ${found.join(", ")}`);
});

Deno.test("...nor a feed entry", () => {
  const found = leaks(stableStringify(feedEntry(row())));
  assert(found.length === 0, `feed entry leaked: ${found.join(", ")}`);
});

// The check that makes the three above mean something. If leaks() cannot find a sentinel in
// a blob built to contain all of them, its silence everywhere else is silence about nothing.
Deno.test("the scan itself is not blind", () => {
  const everything = JSON.stringify(row());
  const found = leaks(everything);
  assertEquals(
    found.length,
    SENTINELS.length,
    `the scan found ${found.length} of ${SENTINELS.length} sentinels in a blob containing all of them`,
  );
});

// And the other half: the scan has to catch a leak that arrives through a BUILDER, not just
// one sitting in a raw row. This is the implementation shards.ts refuses to be — a spread
// with a couple of remembered omissions, which is what somebody reaches for when adding a
// field in a hurry. It leaks anyway, because a denylist only excludes what its author
// thought of, and that is the entire argument for the allowlist in shards.ts.
Deno.test("...and the naive builder this module refuses to be IS caught by it", () => {
  const naive = (r: SourcePost) => {
    const { consent: _c, content_hash: _h, ...rest } = r;
    return rest;
  };
  const found = leaks(stableStringify(naive(row())));
  assert(
    found.length >= 4,
    `a spread-with-omissions builder leaked only ${found.length} sentinels — the scan is ` +
      "not seeing builder output the way it sees raw rows",
  );
});

/* ── 2 · §6, restated where it can be broken again ─────────── */

Deno.test("an originals asset never appears in a shard", () => {
  const out = stableStringify(publicPost(row()));
  assert(!out.includes("originals"), "the bucket name reached the shard");
  assert(!out.includes(SECRET.masterPath), "the master's storage path reached the shard");
  assert(out.includes("1080p.mp4"), "...while the rendition, which IS servable, did not");
});

/* ── 3 · §7's location rules ───────────────────────────────── */

Deno.test("a hidden location publishes no coordinate at all", () => {
  const hidden = publicPost(row({ location_precision: "hidden" }));
  assertEquals(hidden.location, null, "a hidden post shipped a coordinate");
});

// Appearing in a geo shard is itself a disclosure: it says the item is somewhere in this
// square. A hidden post must not be in one, even with its coordinate stripped.
Deno.test("...and it appears in no geo shard", () => {
  const files = buildShards([row({ location_precision: "hidden" })]);
  const geo = files.filter((f) => f.path.startsWith("geo/"));
  assertEquals(geo.length, 0, "a hidden post was placed in a geo cell");
});

Deno.test("a post with a location does get a geo shard, keyed by geohash", () => {
  const files = buildShards([row()]);
  const geo = files.filter((f) => f.path.startsWith("geo/"));
  assertEquals(geo.length, 1, "expected exactly one cell");
  assertEquals(geo[0].path, `geo/${geohash(31.899, 35.204)}.json`, "wrong cell");
});

Deno.test("geohash encodes Ramallah to a known cell", () => {
  // sv9 is the 3-character cell covering the central West Bank; the full 5 is the
  // ~4.9 km square §2's shard key is tuned to.
  assertEquals(geohash(31.8996, 35.2042, 3), "sv9", "geohash disagrees with a known value");
  assertEquals(geohash(31.8996, 35.2042).length, 5, "default precision is not 5");
});

/* ── 4 · Determinism ───────────────────────────────────────── */

Deno.test("identical input produces identical bytes", () => {
  const a = buildShards([row(), row({ id: "00000000-0000-0000-0000-0000000000b2" })]);
  const b = buildShards([row({ id: "00000000-0000-0000-0000-0000000000b2" }), row()]);
  assertEquals(
    a.map((f) => f.path + f.json).join("|"),
    b.map((f) => f.path + f.json).join("|"),
    "row order changed the output — every shard would look changed on every publish",
  );
});

Deno.test("key order in the source object does not change the bytes", () => {
  const forwards = stableStringify({ b: 1, a: { d: 2, c: 3 } });
  const backwards = stableStringify({ a: { c: 3, d: 2 }, b: 1 });
  assertEquals(forwards, backwards, "stableStringify is not stable");
});

/* ── 5 · The shapes ────────────────────────────────────────── */

Deno.test("the feed paginates at the size §9's budget assumes", () => {
  const many = Array.from({ length: FEED_PAGE_SIZE + 1 }, (_, i) =>
    row({ id: `00000000-0000-0000-0000-0000000${String(i).padStart(5, "0")}` }));
  const pages = buildShards(many).filter((f) => f.path.startsWith("feed/"));
  assertEquals(pages.length, 2, "expected two pages");
  assertEquals(
    JSON.parse(pages[0].json).items.length,
    FEED_PAGE_SIZE,
    "the first page is not full",
  );
  assertEquals(JSON.parse(pages[1].json).items.length, 1, "the second page is wrong");
});

Deno.test("an empty archive still emits one feed page", () => {
  const files = buildShards([]);
  const feed = files.filter((f) => f.path.startsWith("feed/"));
  assertEquals(feed.length, 1, "no feed page for an empty archive");
  assertEquals(JSON.parse(feed[0].json).total, 0, "an empty page should say so");
});

// §7: the author is a handle, never the auth user id. Asserted positively as well as by the
// sentinel scan, because "the uuid is absent" and "the handle is present" are different
// claims and a builder that dropped the author entirely would pass only the first.
Deno.test("the author is named by handle", () => {
  const out = publicPost(row());
  assertEquals(out.author?.handle, "abu_ramallah", "the handle is missing");
  assert(!("id" in (out.author ?? {})), "the author carries an id");
});

Deno.test("a post with no profile row publishes no author rather than a broken one", () => {
  const out = publicPost(row({ author_handle: null }));
  assertEquals(out.author, null, "expected null");
});

Deno.test("counters are baked in, so a reader never queries for them", () => {
  const out = feedEntry(row());
  assertEquals(out.likes, 12, "like count not baked");
  assertEquals(out.comments, 3, "comment count not baked");
});

Deno.test("decade shards group by decade and skip rows without one", () => {
  const files = buildShards([
    row({ id: "00000000-0000-0000-0000-0000000000b1", decade: 1960 }),
    row({ id: "00000000-0000-0000-0000-0000000000b2", decade: 1960 }),
    row({ id: "00000000-0000-0000-0000-0000000000b3", decade: 1970 }),
    row({ id: "00000000-0000-0000-0000-0000000000b4", decade: null }),
  ]);
  const decades = files.filter((f) => f.path.startsWith("decade/")).map((f) => f.path);
  assertEquals(decades.join(","), "decade/1960.json,decade/1970.json", "wrong decade shards");
  assertEquals(JSON.parse(files.find((f) => f.path === "decade/1960.json")!.json).total, 2, "wrong count");
});
