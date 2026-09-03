/* M6's shard and pagination judgments, measured at launch scale instead of at 22 items.
 *
 *     deno run --allow-read --allow-write --allow-env scripts/load-test-300.ts
 *     deno run ... scripts/load-test-300.ts --items 1000
 *     deno run ... scripts/load-test-300.ts --json
 *
 * ── What is provisional, and why ─────────────────────────────
 *
 * Two constants in supabase/functions/publish/shards.ts carry judgments, and both were
 * made against an archive of 22 items:
 *
 *   FEED_PAGE_SIZE = 24  — "§9's budget covers HTML + CSS + JS + first feed page, so the
 *                          first page has to be small." At 22 items there has never BEEN
 *                          a full page, so the budget has never once been measured against
 *                          the thing the constant is about.
 *
 *   GEO_PRECISION = 5    — "one cell covers Ramallah, which for an archive of one city
 *                          means the map fetches one file." True. The question that was
 *                          never asked is how big that one file gets when everything the
 *                          archive holds is inside it.
 *
 * §1 puts ~300 items at launch and low thousands within a year. This measures both
 * constants there.
 *
 * ── Why this touches no database ─────────────────────────────
 *
 * NOTHING here connects to Postgres, local or deployed, and that is a stronger guarantee
 * than "a throwaway database" rather than a shortcut around one. Every number below is a
 * pure function of the rows: buildShards() takes SourcePost[] and returns bytes, the
 * geohash is computed in TypeScript at shards.ts:573 rather than in SQL, and pagination is
 * one slice(). Feeding the same rows through a database first would exercise
 * publishable_posts() — worth doing, and a different question — while changing none of the
 * measurements this file exists to take.
 *
 * So it runs the REAL production shard builder, imported directly, over synthetic rows,
 * and writes nothing anywhere except a report on stdout.
 *
 * ── The synthetic archive ────────────────────────────────────
 *
 * Every row is marked SYNTHETIC in its title and its id is a `synthetic-` uuid, so a row
 * that ever escapes into a real system is obvious on sight rather than plausible. The
 * SHAPE is drawn from the deployed archive's real distribution — Arabic titles, real
 * Ramallah coordinates, the real decade spread, comment counts in the range real items
 * have — because a load test against uniformly tiny rows measures the loop and not the
 * archive.
 */

import {
  buildShards,
  FEED_PAGE_SIZE,
  GEO_PRECISION,
  geohash,
  type SourcePost,
} from "../supabase/functions/publish/shards.ts";

const argv = Deno.args;
const ITEMS = argv.includes("--items") ? Number(argv[argv.indexOf("--items") + 1]) : 300;
const JSON_OUT = argv.includes("--json");

/* ── The fixture ───────────────────────────────────────────── */

/* Ramallah's real extent, so the geohash distribution is the real one. Al-Manara is the
   centre; the spread is about the size of the built-up city. Public squares and streets,
   not anybody's home — the same choice exif-gate.ts makes for the same reason. */
const CENTRE = { lat: 31.9038, lon: 35.2034 };
const SPREAD = 0.035;

/* Deterministic, so two runs are comparable and a regression is a real change rather than
   a different random draw. A seeded LCG rather than Math.random for exactly that. */
let seed = 20260902;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x100000000);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

const TITLES_AR = [
  "سوق رام الله القديم", "شارع ركب في الستينيات", "عرس في البلدة القديمة",
  "مدرسة الفرندز", "دوار المنارة", "بيت العائلة في الطيرة",
  "حصاد الزيتون", "المسرح البلدي", "قهوة في شارع النهضة", "الثلج في كانون",
];
const KINDS = ["media", "media", "media", "media", "voice", "event"] as const;
const DECADES = [1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
const PRECISIONS = ["exact", "street", "area", "hidden"] as const;
const HANDLES = Array.from({ length: 40 }, (_, i) => `member_synthetic_${i.toString(16)}`);

function syntheticPost(i: number): SourcePost {
  const kind = pick(KINDS);
  const decade = pick(DECADES);
  const precision = pick(PRECISIONS);
  const handle = pick(HANDLES);

  /* Roughly the real comment distribution: most items have none, a few have a handful.
     A uniform count would either understate item/{id}.json or overstate every one. */
  const nComments = rnd() < 0.7 ? 0 : Math.floor(rnd() * 6) + 1;

  return {
    id: `synthetic-${String(i).padStart(4, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`,
    kind,
    title_ar: `SYNTHETIC ${pick(TITLES_AR)}`,
    title_en: rnd() < 0.4 ? `SYNTHETIC load-test item ${i}` : null,
    body_ar: `SYNTHETIC — وصف أرشيفي لغرض القياس. ${"ذاكرة ".repeat(Math.floor(rnd() * 12) + 4)}`,
    body_en: rnd() < 0.3 ? `SYNTHETIC archival description ${"memory ".repeat(8)}` : null,
    date_earliest: `${decade}-01-01`,
    date_latest: `${decade + 9}-12-31`,
    date_precision: "decade",
    decade,
    location_public: precision === "hidden" ? null : {
      /* Snapped the way fuzz_location snaps, so the geohash distribution matches what the
         database would really produce rather than being smeared by spurious precision. */
      lat: Number((CENTRE.lat + (rnd() - 0.5) * SPREAD).toFixed(3)),
      lon: Number((CENTRE.lon + (rnd() - 0.5) * SPREAD).toFixed(3)),
    },
    location_precision: precision,
    place_name_ar: rnd() < 0.3 ? "SYNTHETIC المنارة" : null,
    place_name_en: null,
    event_starts_at: kind === "event" ? `${decade}-06-01T18:00:00Z` : null,
    event_ends_at: kind === "event" ? `${decade}-06-01T21:00:00Z` : null,
    venue_ar: kind === "event" ? "SYNTHETIC قاعة البلدية" : null,
    venue_en: null,
    license: "CC-BY-SA-4.0",
    provenance: "SYNTHETIC fixture — scripts/load-test-300.ts",
    author_label: "member",
    author_handle: handle,
    author_display_name: `SYNTHETIC ${handle}`,
    author_avatar_path: null,
    like_count: Math.floor(rnd() * 40),
    comment_count: nComments,
    comments: Array.from({ length: nComments }, (_, c) => ({
      id: `synthetic-c-${i}-${c}`,
      body: `SYNTHETIC تعليق ${"كلمة ".repeat(Math.floor(rnd() * 10) + 3)}`,
      lang: "ar",
      day: `2026-0${(c % 8) + 1}-1${c % 9}`,
      author_handle: pick(HANDLES),
      author_display_name: null,
      author_avatar_path: null,
    })),
    created_on: `20${20 + (i % 6)}-0${(i % 9) + 1}-1${i % 9}`,
    media: [
      { role: "rendition", rendition: "1440p", path: `synthetic-${i}/display.webp`,
        mime: "image/webp", width: 1920, height: 1280, duration_s: null },
      { role: "thumb", rendition: null, path: `synthetic-${i}/thumb.webp`,
        mime: "image/webp", width: 400, height: 300, duration_s: null },
    ] as SourcePost["media"],
  };
}

/* ── Measure ───────────────────────────────────────────────── */

const rows = Array.from({ length: ITEMS }, (_, i) => syntheticPost(i));

/* WARM UP, THEN MEASURE, AND TAKE A MEDIAN.
 *
 * The first version of this timed a single cold call and reported 11,891 ms for 300 items,
 * which reads as an O(n^2) publisher and would have been a serious finding. It is not: a
 * scaling sweep came back 50->1881 ms, 100->658, 200->62, 400->1643 — non-monotonic, so
 * the number was never measuring the algorithm. It was measuring V8 deciding whether to
 * optimise stableStringify, on a run short enough for that decision to dominate.
 *
 * A cold number is still worth having — the Edge Function that runs this really is cold on
 * its first publish after an idle period, and its CPU budget is finite — so it is reported
 * BESIDE the warm median rather than instead of it. */
const cold0 = performance.now();
let shards = buildShards(rows);
const coldMs = performance.now() - cold0;

for (let i = 0; i < 3; i++) buildShards(rows);
const runs: number[] = [];
for (let i = 0; i < 7; i++) {
  const t = performance.now();
  shards = buildShards(rows);
  runs.push(performance.now() - t);
}
runs.sort((a, b) => a - b);
const buildMs = runs[Math.floor(runs.length / 2)];

const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const kib = (n: number) => (n / 1024).toFixed(1);

const byKind = (prefix: string) => shards.filter((s) => s.path.startsWith(prefix));
const feed = byKind("feed/");
const geo = byKind("geo/");
const decade = byKind("decade/");
const item = byKind("item/");

const total = shards.reduce((a, s) => a + bytes(s.json), 0);
const biggest = <T extends { path: string; json: string }>(xs: T[]) =>
  xs.map((s) => ({ path: s.path, b: bytes(s.json) })).sort((a, b) => b.b - a.b)[0];

/* §9's budget is HTML + CSS + JS + the FIRST FEED PAGE, brotli. The static half is
   measured by scripts/frontend-budget.mjs and does not change with archive size; what
   changes — and what has never been measured at a full page — is the feed page. Compressed
   here rather than raw: the budget is a brotli budget and JSON of repeated keys compresses
   hard, so a raw number would overstate it by several times. */
async function brotli(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const buf = await new Response(stream).arrayBuffer();
  return buf.byteLength;
}

const page1 = feed.find((f) => f.path === "feed/page-1.json");
const page1Raw = page1 ? bytes(page1.json) : 0;
const page1Comp = page1 ? await brotli(page1.json) : 0;

/* THE SYNTHETIC RATIO IS TOO GOOD, and saying so is the difference between a measurement
 * and a flattering one. This fixture draws titles from ten strings and bodies from one
 * repeated word, so a feed page is far more compressible than a real one — the first run
 * reported 9.3 KiB compressing to 1.0 KiB, a ratio real archival prose will not reach.
 *
 * So the live archive's own page is fetched and its ratio measured, and the synthetic page
 * is re-costed at THAT ratio. If the network is unavailable the run says so and reports
 * only the synthetic figure, marked as optimistic — never silently. */
let realRatio: number | null = null;
let realNote = "";
try {
  const cfg = JSON.parse(await Deno.readTextFile("config/site.json"));
  const cdn = `https://${cfg.domains.cdn}`;
  const manifest = await (await fetch(`${cdn}/manifest.json?cb=${Date.now()}`)).json();
  const live = await (await fetch(`${cdn}${manifest.release}feed/page-1.json`)).text();
  const liveComp = await brotli(live);
  realRatio = liveComp / bytes(live);
  realNote = `live page: ${kib(bytes(live))} KiB raw -> ${kib(liveComp)} KiB (${(realRatio * 100).toFixed(0)}%)`;
} catch (e) {
  realNote = `could not reach the live archive (${e instanceof Error ? e.message : e})`;
}
const page1Realistic = realRatio === null ? null : Math.round(page1Raw * realRatio);

/* Where the items landed. This is the GEO_PRECISION question, and the whole of it. */
const cellCounts = new Map<string, number>();
for (const r of rows) {
  if (!r.location_public) continue;
  const c = geohash(r.location_public.lat, r.location_public.lon, GEO_PRECISION);
  cellCounts.set(c, (cellCounts.get(c) ?? 0) + 1);
}
const cells = [...cellCounts.entries()].sort((a, b) => b[1] - a[1]);

/* And what precision 6 would do instead — the one-line change shards.ts already names as
   the alternative, costed rather than guessed at. */
const cells6 = new Map<string, number>();
for (const r of rows) {
  if (!r.location_public) continue;
  const c = geohash(r.location_public.lat, r.location_public.lon, 6);
  cells6.set(c, (cells6.get(c) ?? 0) + 1);
}

const report = {
  items: ITEMS,
  build_ms: Math.round(buildMs),
  build_ms_cold: Math.round(coldMs),
  shards: shards.length,
  total_bytes: total,
  feed: { pages: feed.length, page_size: FEED_PAGE_SIZE, page1_raw: page1Raw,
          page1_compressed_synthetic: page1Comp, page1_compressed_calibrated: page1Realistic },
  geo: {
    precision: GEO_PRECISION,
    cells: cells.length,
    largest_cell_items: cells[0]?.[1] ?? 0,
    largest_shard: biggest(geo),
    at_precision_6: { cells: cells6.size, largest: Math.max(...cells6.values(), 0) },
  },
  decade: { shards: decade.length, largest: biggest(decade) },
  item: { shards: item.length, largest: biggest(item) },
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
  Deno.exit(0);
}

console.log(`\nM6's provisional judgments at ${ITEMS} items (measured at 22)\n`);
console.log(`  synthetic rows built          ${ITEMS}`);
console.log(`  shards produced               ${shards.length}`);
console.log(`  buildShards() warm median     ${Math.round(buildMs)} ms  (${(buildMs / ITEMS).toFixed(2)} ms/item)`);
console.log(`  buildShards() first cold call ${Math.round(coldMs)} ms  — JIT, not algorithm; see the note in this file`);
console.log(`  total release bytes           ${kib(total)} KiB\n`);

console.log(`FEED_PAGE_SIZE = ${FEED_PAGE_SIZE}`);
console.log(`  pages                         ${feed.length}`);
console.log(`  feed/page-1.json raw          ${kib(page1Raw)} KiB`);
console.log(`  feed/page-1.json compressed   ${kib(page1Comp)} KiB  (synthetic text; optimistic)`);
console.log(`  calibrated against the real archive: ${realNote}`);
if (page1Realistic !== null) {
  console.log(`  at the REAL compression ratio ${kib(page1Realistic)} KiB  <- use this number`);
}
console.log(`  largest feed page             ${biggest(feed)?.path} at ${kib(biggest(feed)?.b ?? 0)} KiB`);

/* §9: "< 150 KB brotli for HTML + CSS + JS + first feed page." frontend-budget.mjs
   reported 91.8 KiB of static assets against the 150 KiB ceiling on 1 Sep, so the headroom
   the feed page has to fit inside is what is left of that. Deflate-raw is used above
   because Deno's CompressionStream has no brotli; it is a close and slightly PESSIMISTIC
   stand-in for brotli on JSON, which is the safe direction. */
const STATIC_KIB = 91.8;
const BUDGET_KIB = 150;
const headroom = BUDGET_KIB - STATIC_KIB;
/* Judged on the calibrated figure when there is one. The synthetic ratio flatters. */
const judged = page1Realistic ?? page1Comp;
const fits = judged / 1024 <= headroom;
console.log(`  §9 budget headroom            ${headroom.toFixed(1)} KiB after ${STATIC_KIB} KiB of static assets`);
console.log(`  ${fits ? "→ HOLDS" : "→ DOES NOT HOLD"}: a full page of ${FEED_PAGE_SIZE} costs ` +
  `${kib(judged)} KiB compressed, ${fits ? "inside" : "OVER"} the ${headroom.toFixed(1)} KiB left.\n`);

console.log(`GEO_PRECISION = ${GEO_PRECISION}`);
console.log(`  cells occupied                ${cells.length}`);
console.log(`  busiest cell                  ${cells[0]?.[0]} with ${cells[0]?.[1]} items`);
console.log(`  largest geo shard             ${biggest(geo)?.path} at ${kib(biggest(geo)?.b ?? 0)} KiB`);
console.log(`  at precision 6 instead        ${cells6.size} cells, busiest ${Math.max(...cells6.values(), 0)} items`);

/* The map fetches ONE cell for Ramallah and that is the design. The number that decides
   whether it stays right is what a phone downloads to draw the map once. */
const geoKiB = (biggest(geo)?.b ?? 0) / 1024;
console.log(`  ${geoKiB < 250 ? "→ HOLDS" : "→ REVIEW"}: one cell is the whole city, so the map fetches ` +
  `${kib(biggest(geo)?.b ?? 0)} KiB in one file.`);
if (geoKiB >= 250) {
  console.log(`    Precision 6 splits it into ${cells6.size} files, busiest ${Math.max(...cells6.values(), 0)} items —`);
  console.log(`    one extra request per pan, which shards.ts already names as the trade.`);
}

console.log(`\nOTHER SHARDS`);
console.log(`  decade/                       ${decade.length} shards, largest ${biggest(decade)?.path} at ${kib(biggest(decade)?.b ?? 0)} KiB`);
console.log(`  item/                         ${item.length} shards, largest ${kib(biggest(item)?.b ?? 0)} KiB`);

/* §2's amendment names the thresholds at which the incremental diff and release pruning
   become one piece of work. Every release rewrites every shard, so the object count is
   what that amendment is about. */
console.log(`\n§2's REBUILD THRESHOLDS`);
const objects = shards.length + ITEMS; // + one prerendered HTML page per publishable post
console.log(`  objects written per release   ~${objects}  (${shards.length} shards + ${ITEMS} prerendered pages)`);
console.log(`  §2 reinstates the incremental diff at 1,500 items / 100 releases a day / 5 GB in /v/.`);
console.log(`  At ${ITEMS} items a release moves ${kib(total)} KiB of shards; 100 releases a day is ` +
  `${(total * 100 / 1024 / 1024).toFixed(1)} MiB/day.\n`);

console.log(`Nothing was written and no database was touched. The synthetic rows exist only`);
console.log(`in this process's memory and are all titled SYNTHETIC.\n`);
