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
  CATEGORIES,
  categoryOf,
  contentFile,
  FEED_PAGE_SIZE,
  feedEntry,
  geohash,
  placesFile,
  profileFile,
  publicPost,
  searchIndexFile,
  type SourceAsset,
  type SourcePlace,
  type SourcePost,
  type SourceProfile,
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
    // §9 puts comments in the shards, and §2 requires it — 0015 grants `anon` nothing, so a
    // comment a visitor cannot get from a shard is one they cannot read at all. The
    // commenter is named by handle for the same §7 reason the post's author is.
    comments: [{
      id: "00000000-0000-0000-0000-0000000000c1",
      body: "كنّا نقف في الطابور بعد المدرسة.",
      lang: "ar",
      day: "2026-08-20",
      author_handle: "salma",
      author_display_name: "سلمى",
      author_avatar_path: null,
    }],
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

/* ── M3: comments, profiles, copy and the index ────────────── */

Deno.test("the item shard carries the thread; the feed card carries only a number", () => {
  const item = publicPost(row());
  assertEquals(item.comments.length, 1, "the thread is missing from the item shard");
  assertEquals(item.comments[0].body, "كنّا نقف في الطابور بعد المدرسة.", "wrong body");
  assertEquals(item.comment_count, 3, "the count travels beside the thread");

  // The deliberate asymmetry, asserted so it cannot be "tidied" into agreement: a card has
  // room for a count and §9's budget counts the first feed page.
  const card = feedEntry(row());
  assertEquals(typeof card.comments, "number", "a feed card must carry a NUMBER, not a thread");
});

Deno.test("a commenter is named by handle and never by user id", () => {
  const item = publicPost(row());
  assertEquals(item.comments[0].author?.handle, "salma", "the commenter's handle is missing");
  assert(!("created_by" in item.comments[0]), "a comment carries created_by");
  assert(!("id" in (item.comments[0].author ?? {})), "the commenter carries an id");
  // §7's day-precision rule reaches comments too.
  assertEquals(item.comments[0].day, "2026-08-20", "the comment's date is missing");
  assert(!("created_at" in item.comments[0]), "a comment carries an exact timestamp");
});

Deno.test("a comment with no profile row publishes no byline rather than a broken one", () => {
  const item = publicPost(row({
    comments: [{
      id: "c9", body: "x", lang: null, day: "2026-08-20",
      author_handle: null, author_display_name: null, author_avatar_path: null,
    }],
  }));
  assertEquals(item.comments[0].author, null, "expected null");
});

Deno.test("the sentinel scan reaches comment bodies", () => {
  // The one case where a sentinel legitimately COULD appear: a member typed it into a
  // comment. This test is the inverse of the others — it proves the scan sees comment
  // bodies at all, so every §7 assertion above is not blind to the newest place text enters
  // a shard.
  const files = buildShards([row({
    comments: [{
      id: "c9", body: SECRET.createdBy, lang: null, day: "2026-08-20",
      author_handle: "x", author_display_name: null, author_avatar_path: null,
    }],
  })]);
  const found = leaks(files.map((f) => f.json).join(""));
  assertEquals(found.length, 1, "the comment body is not in the scanned bytes");
});

const profile = (over: Partial<SourceProfile> = {}): SourceProfile => ({
  handle: "abu_ramallah",
  display_name: "أبو رام الله",
  avatar_path: "avatars/gen-7.webp",
  label: "member",
  bio: "من حارة النصارى",
  member_since: 2025,
  show_contributions: true,
  show_comments: true,
  ...over,
});

Deno.test("a profile shard lists what its owner made public", () => {
  const file = profileFile(profile(), [row()]);
  assertEquals(file.path, "profile/abu_ramallah.json", "wrong path");

  const out = JSON.parse(file.json);
  assertEquals(out.contributions.length, 1, "the contribution is missing");
  assertEquals(out.bio, "من حارة النصارى", "the bio is missing");
  assert(!("id" in out), "the profile carries a user id");
  assert(!("visibility" in out), "the profile publishes the visibility map itself");
});

Deno.test("visibility=private publishes an EMPTY list, not a flagged one", () => {
  // §7's aggregate concern. A flag would put the data in the file and ask the client to be
  // discreet about it, which is the same mistake as hiding unapproved content in the
  // browser (§5).
  const out = JSON.parse(profileFile(profile({ show_contributions: false }), [row()]).json);
  assertEquals(out.contributions.length, 0, "a hidden contribution list is not empty");
  assert(!JSON.stringify(out).includes("A title"), "the hidden contribution is in the bytes");

  // The discriminating half: with it public the same call DOES list it. Without this, a
  // builder that always emitted [] would satisfy the assertions above.
  const shown = JSON.parse(profileFile(profile(), [row()]).json);
  assertEquals(shown.contributions.length, 1, "CONTROL: a public list is not published");
});

Deno.test("attribution is never gated, even when the contribution list is", () => {
  // A contributor who hides their contribution LIST still appears as the author on each
  // card — §7 makes handle and avatar public precisely so the archive keeps crediting
  // people. What visibility governs is the page that collects one person's whole history.
  const files = buildShards([row()]);
  const feed = JSON.parse(files.find((f) => f.path === "feed/page-1.json")!.json);
  assertEquals(feed.items[0].author.handle, "abu_ramallah", "the card lost its byline");
});

Deno.test("a profile's comment list names the post each remark is on", () => {
  const out = JSON.parse(profileFile(profile({ handle: "salma" }), [row()]).json);
  assertEquals(out.comments.length, 1, "the comment is missing");
  assertEquals(out.comments[0].post_id, row().id, "the comment does not name its post");
  assert(!("created_by" in out.comments[0]), "a profile comment carries created_by");
});

Deno.test("content.json carries the published copy and nothing else", () => {
  const file = contentFile({ "hero.line": { ar: "هنا", en: "Here" } });
  assertEquals(file.path, "content.json", "wrong path");
  const out = JSON.parse(file.json);
  assertEquals(out.blocks["hero.line"].ar, "هنا", "the Arabic side is missing");
  assertEquals(out.blocks["hero.line"].en, "Here", "the English side is missing");
});

Deno.test("index.json describes the release it was built from", () => {
  const files = buildShards([
    row({ id: "00000000-0000-0000-0000-0000000000b1", decade: 1960 }),
    row({ id: "00000000-0000-0000-0000-0000000000b2", decade: 1990 }),
    row({ id: "00000000-0000-0000-0000-0000000000b3", decade: 1960, location_precision: "hidden" }),
  ]);
  const idx = JSON.parse(files.find((f) => f.path === "index.json")!.json);

  assertEquals(idx.total, 3, "wrong total");
  assertEquals(idx.decades.join(","), "1960,1990", "wrong decades");

  // The cells it names must be the cells it BUILT. A front end that fetched a cell with no
  // shard behind it would 404 on every map load, and the CDN would cache the miss.
  const built = files.filter((f) => f.path.startsWith("geo/"))
    .map((f) => f.path.slice(4, -5)).sort();
  assertEquals(idx.cells.join(","), built.join(","), "index.json names cells the release does not have");
  // 'hidden' contributes to no cell, so the cell count differs from the item count — which
  // is what makes the assertion above non-trivial.
  assertEquals(idx.cells.length, 1, "hidden coordinates leaked into the cell list");
});

/* ── places.json ─────────────────────────────────────────────
 *
 * M4. The map's only text: the basemap is rendered from vector geometry with its label
 * layers deliberately not drawn, so every name on the screen comes from this file.
 */

function place(over: Partial<SourcePlace> = {}): SourcePlace {
  return {
    id: "00000000-0000-0000-0000-0000000000c1",
    name_ar: "المنارة",
    name_en: "Al-Manara",
    lat: 31.8996,
    lon: 35.2042,
    ...over,
  };
}

Deno.test("places.json carries both names and a point", () => {
  const file = placesFile([place()]);
  assertEquals(file.path, "places.json", "wrong path");
  const out = JSON.parse(file.json);
  assertEquals(out.total, 1, "wrong total");
  assertEquals(out.items[0].name_ar, "المنارة", "the Arabic name is missing");
  assertEquals(out.items[0].name_en, "Al-Manara", "the English name is missing");
  assertEquals(out.items[0].lat, 31.8996, "wrong latitude");
});

Deno.test("a place with no usable point is not drawn", () => {
  // 0050 already filters to confirmed entries WITH a location, so this is the second
  // layer — and it is the one that catches a null arriving as NaN through a JSON number.
  const out = JSON.parse(placesFile([
    place(),
    place({ id: "00000000-0000-0000-0000-0000000000c2", lat: NaN as unknown as number }),
    place({ id: "00000000-0000-0000-0000-0000000000c3", lon: null as unknown as number }),
  ]).json);
  assertEquals(out.total, 1, "a place with no coordinate reached the map");
});

Deno.test("an empty gazetteer still produces a file", () => {
  // A release with no places.json and one with an empty gazetteer look identical to a
  // browser — 404 either way — and only the first is a broken build.
  const out = JSON.parse(placesFile([]).json);
  assertEquals(out.total, 0, "wrong total");
  assertEquals(out.items.length, 0, "items should be empty");
});

Deno.test("the gazetteer shard carries no field the map was not given", () => {
  // The same allowlist rule as every other shape here. A place row gains `geohash` and
  // `unconfirmed` in the table and neither belongs in a file served to everyone forever.
  const json = placesFile([{
    ...place(),
    unconfirmed: false,
    geohash: "sv8yz",
    created_at: "2026-08-21T09:00:00Z",
  } as unknown as SourcePlace]).json;
  assert(!json.includes("geohash"), "the shard key leaked into the shard");
  assert(!json.includes("unconfirmed"), "an internal flag reached the published file");
  assert(!json.includes("created_at"), "a timestamp reached the published file");
});

/* ── M6 addendum: categories and the search index ───────────
 *
 * The bucketing is derived rather than stored, so nothing in the database can be consulted
 * to check it. What makes these assertions worth having is that every one of them fails in
 * a direction that still RENDERS: a video filed under Images shows a card, a tab that is
 * missing a post shows a grid, and a search index that quietly carries a withdrawn row
 * shows a result. None of them looks broken.
 */

/** A media row whose master says what it is. `over` still wins, so a test can drop it. */
function mediaRow(mime: string, over: Partial<SourcePost> = {}): SourcePost {
  return row({
    media: [
      asset({ role: "master", bucket: "originals", mime, storage_path: "orig/x" }),
      asset({ role: "thumb", mime: "image/webp" }),
    ],
    ...over,
  });
}

Deno.test("the category vocabulary is derived from the master's mime, not from kind", () => {
  assertEquals(categoryOf(mediaRow("image/jpeg")), "image", "a photograph is not an image");
  assertEquals(categoryOf(mediaRow("video/mp4")), "video", "a film is not a video");
  assertEquals(categoryOf(mediaRow("image/jpeg", { kind: "voice" })), "voice",
    "kind='voice' decides on its own — a voice note's thumb must not outvote it");
  assertEquals(categoryOf(mediaRow("image/jpeg", { kind: "event" })), null,
    "an event reached a category shard");
});

Deno.test("a video with no master is still a video", () => {
  /* §6 has the ~300 seed items transcoded OFFLINE and their derivatives uploaded directly,
     so a master row is not guaranteed. THE defect this guards: thumb and poster are both
     image/webp for a video, so a classifier that fell through to the next available asset
     would file the entire seed archive of film under Images — and every card would render
     correctly while it did. */
  const seeded = row({
    media: [
      asset({ role: "thumb", mime: "image/webp" }),
      asset({ role: "poster", mime: "image/webp" }),
      asset({ role: "rendition", rendition: "1080p", mime: "video/mp4" }),
    ],
  });
  assertEquals(categoryOf(seeded), "video", "an offline-transcoded video was filed as an image");

  /* CONTROL, and it is the discriminating half: the fallback is not "read whatever mime is
     nearest". With the rendition removed, the same row carries nothing but image/webp and
     the answer is NO CATEGORY rather than "image" — which is what proves thumb and poster
     are genuinely not consulted. A row like this cannot reach a release anyway
     (publishable_posts requires ingest_state = 'ready', and a ready post has a master), so
     the safe direction here is unfiltered rather than confidently wrong. */
  const thumbsOnly = row({ media: [asset({ role: "thumb", mime: "image/webp" })] });
  assertEquals(categoryOf(thumbsOnly), null, "a thumb was read as the item's own mime");
});

Deno.test("a media post with no classifiable asset lands in no tab and stays in the feed", () => {
  const bare = row({ id: "00000000-0000-0000-0000-0000000000d9", media: [] });
  assertEquals(categoryOf(bare), null, "expected no category");

  const files = buildShards([bare]);
  const feed = JSON.parse(files.find((f) => f.path === "feed/page-1.json")!.json);
  assertEquals(feed.items.length, 1, "an uncategorised post fell out of the feed as well");
  for (const cat of CATEGORIES) {
    const page = JSON.parse(files.find((f) => f.path === `category/${cat}/page-1.json`)!.json);
    assertEquals(page.total, 0, `it reached the ${cat} shard`);
  }
});

Deno.test("every feed item appears in exactly one category shard, or in none and is an event", () => {
  /* The bucketing assertion the addendum's verification step asks for, as a partition
     rather than as a spot check: every id in at most one tab, the three expected rows in
     the right ones, and the only row allowed to be in none is the event. */
  const rows = [
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000e1" }),
    mediaRow("video/mp4", { id: "00000000-0000-0000-0000-0000000000e2" }),
    mediaRow("image/png", { id: "00000000-0000-0000-0000-0000000000e3", kind: "voice" }),
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000e4", kind: "event" }),
  ];
  const files = buildShards(rows);
  const feed = JSON.parse(files.find((f) => f.path === "feed/page-1.json")!.json);
  assertEquals(feed.items.length, 4, "the feed lost a row");

  const seen = new Map<string, string[]>();
  for (const file of files.filter((f) => f.path.startsWith("category/"))) {
    const body = JSON.parse(file.json);
    for (const entry of body.items as Array<{ id: string; category: string }>) {
      assertEquals(entry.category, body.category,
        `${entry.id} carries ${entry.category} inside the ${body.category} shard`);
      seen.set(entry.id, (seen.get(entry.id) ?? []).concat(body.category));
    }
  }

  const doubled = [...seen].filter(([, cats]) => cats.length > 1);
  assertEquals(doubled.length, 0, `filed under two tabs: ${doubled.map(([id]) => id).join(", ")}`);
  assertEquals(seen.get("00000000-0000-0000-0000-0000000000e1")?.join(""), "image", "wrong tab");
  assertEquals(seen.get("00000000-0000-0000-0000-0000000000e2")?.join(""), "video", "wrong tab");
  assertEquals(seen.get("00000000-0000-0000-0000-0000000000e3")?.join(""), "voice", "wrong tab");

  const uncategorised = (feed.items as Array<{ id: string }>)
    .map((i) => i.id).filter((id) => !seen.has(id));
  assertEquals(uncategorised.join(","), "00000000-0000-0000-0000-0000000000e4",
    "something other than the event is missing from every tab");
});

Deno.test("a category shard paginates exactly like the feed does", () => {
  const many = Array.from({ length: FEED_PAGE_SIZE + 3 }, (_, i) =>
    mediaRow("image/jpeg", {
      id: `00000000-0000-0000-0000-00000000${(1000 + i).toString()}`,
      created_on: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}`,
    }));
  const files = buildShards(many);

  const feedPages = files.filter((f) => f.path.startsWith("feed/")).map((f) => f.path);
  const catPages = files.filter((f) => f.path.startsWith("category/image/")).map((f) => f.path);
  assertEquals(catPages.length, feedPages.length,
    "the same rows paginate differently under a tab than in the feed");
  assertEquals(catPages.join(","), "category/image/page-1.json,category/image/page-2.json",
    "wrong page paths");

  // The ORDER is the feed's, not a re-sort. A reader switching tabs must not see the
  // archive reshuffle.
  const feedIds = JSON.parse(files.find((f) => f.path === "feed/page-1.json")!.json)
    .items.map((i: { id: string }) => i.id).join(",");
  const catIds = JSON.parse(files.find((f) => f.path === "category/image/page-1.json")!.json)
    .items.map((i: { id: string }) => i.id).join(",");
  assertEquals(catIds, feedIds, "a tab orders its rows differently from the feed");
});

Deno.test("an empty category still publishes page 1", () => {
  // A 404 on the first tab click of a young archive, cached by the CDN, versus one small
  // object. Same argument as the empty feed page in release.test.ts.
  const files = buildShards([mediaRow("image/jpeg")]);
  const empty = files.find((f) => f.path === "category/video/page-1.json");
  assert(empty !== undefined, "the video tab has no page to fetch");
  assertEquals(JSON.parse(empty!.json).total, 0, "wrong total");
});

Deno.test("index.json names the page count of every tab, and it matches what was built", () => {
  const files = buildShards([
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000f1" }),
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000f2" }),
    mediaRow("video/mp4", { id: "00000000-0000-0000-0000-0000000000f3" }),
  ]);
  const idx = JSON.parse(files.find((f) => f.path === "index.json")!.json);

  assertEquals(idx.categories.image.total, 2, "wrong image total");
  assertEquals(idx.categories.video.total, 1, "wrong video total");
  assertEquals(idx.categories.voice.total, 0, "wrong voice total");

  // Derived from what was BUILT, like the cell list beside it: a tab bar that fetched a
  // page with no shard behind it would 404 for a year.
  for (const cat of CATEGORIES) {
    const built = files.filter((f) => f.path.startsWith(`category/${cat}/`)).length;
    assertEquals(idx.categories[cat].pages, built, `index.json miscounts the ${cat} pages`);
  }
  assertEquals(idx.search.total, 3, "index.json does not describe the search index");
});

Deno.test("search-index.json carries five fields and nothing that would make it big", () => {
  const files = buildShards([mediaRow("image/jpeg")]);
  const file = files.find((f) => f.path === "search-index.json")!;
  const out = JSON.parse(file.json);

  assertEquals(out.total, 1, "wrong total");
  assertEquals(
    Object.keys(out.items[0]).sort().join(","),
    "category,decade,id,title_ar,title_en",
    "the search index grew a field — it is unpaginated only because it is this narrow",
  );
  assertEquals(out.items[0].title_ar, "عنوان", "the Arabic title is missing");
  assertEquals(out.items[0].category, "image", "the category is missing");

  // The heavy fields, named rather than left implied by the key list above, so a future
  // reader sees WHY they are absent rather than only that they are.
  for (const heavy of ["thumb", "body_ar", "body_en", "author", "media", "comments"]) {
    assert(!file.json.includes(`"${heavy}"`), `${heavy} reached the search index`);
  }
});

Deno.test("the search index carries every publishable row, events included", () => {
  /* Events are excluded from the CATEGORY shards and present in the search index with a
     null category, because the All tab is the feed and the feed carries events. A reader
     searching from All must find one. */
  const files = buildShards([
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000a1" }),
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000a2", kind: "event" }),
  ]);
  const out = JSON.parse(files.find((f) => f.path === "search-index.json")!.json);
  assertEquals(out.items.length, 2, "the search index dropped a row");
  const ev = out.items.find((i: { id: string }) => i.id === "00000000-0000-0000-0000-0000000000a2");
  assertEquals(ev.category, null, "an event was given a category");
});

Deno.test("the search index holds exactly the ids the feed holds", () => {
  /* The addendum's second verification step, as an assertion rather than a manual
     spot-check. `buildShards` is handed rows the publisher has already filtered — approved,
     not taken down, ingest ready, hash intact — so the way a pending or withdrawn row could
     reach the index is by this function reading from somewhere other than the feed's own
     list. That is the thing being pinned. */
  const rows = [
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000c7" }),
    mediaRow("video/mp4", { id: "00000000-0000-0000-0000-0000000000c8", kind: "voice" }),
    mediaRow("image/jpeg", { id: "00000000-0000-0000-0000-0000000000c9", kind: "event" }),
  ];
  const files = buildShards(rows);
  const feedIds = JSON.parse(files.find((f) => f.path === "feed/page-1.json")!.json)
    .items.map((i: { id: string }) => i.id).sort().join(",");
  const searchIds = JSON.parse(files.find((f) => f.path === "search-index.json")!.json)
    .items.map((i: { id: string }) => i.id).sort().join(",");
  assertEquals(searchIds, feedIds, "the search index and the feed describe different archives");
});

Deno.test("§7 — the search index leaks nothing either", () => {
  const found = leaks(searchIndexFile([row()]).json);
  assert(found.length === 0, `the search index leaked: ${found.join(", ")}`);
});

Deno.test("a title is copied through, not re-stripped", () => {
  /* §6's bidi rule is enforced on INGEST (0045), and the addendum says to reuse the
     already-stripped strings rather than strip again. Two implementations of one rule fail
     by disagreeing quietly — the later one wins and nobody can say which produced a given
     string. So the assertion is the observable half: this function does not transform what
     it is handed.

     The fixture is written with escapes rather than literals. An invisible override
     character sitting in a source file is the exact thing §6 exists to keep out of strings,
     and a test for it should not smuggle one into the repository to make its point. */
  const odd = "\u202Ea title with an override\u2069 still in it";
  const out = JSON.parse(searchIndexFile([row({ title_ar: odd })]).json);
  assertEquals(out.items[0].title_ar, odd, "the publisher rewrote a title it was handed");
  assert(odd.charCodeAt(0) === 0x202E, "CONTROL: the fixture really does carry an override");
});

Deno.test("a feed card and an item shard agree about the category", () => {
  // Two call sites, one derivation. They are read by the same view — the viewer
  // reconstructs a card from an item shard for a deep link — so a disagreement would show
  // as a badge that changes when a reader arrives from a shared link.
  const r = mediaRow("video/mp4");
  assertEquals(feedEntry(r).category, publicPost(r).category, "the two shapes disagree");
  assertEquals(feedEntry(r).category, "video", "wrong category");
});
