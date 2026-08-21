// §9's performance budget, measured rather than asserted.
//
//   "Performance budget: < 150 KB brotli for HTML + CSS + JS + first feed page."
//
// M3's exit criterion says "budget met", so this is what says whether it is. It runs in CI
// on every push, because a budget checked once is a budget that was met once.
//
// ── What is counted, and why exactly this ────────────────────
//
// The four things §9 names, and nothing else: the shell, its stylesheets, the modules the
// shell loads, and one feed page. That is the transfer a visitor pays for before they see
// the archive — the second feed page, the item shards, the media and the fonts all arrive
// after first paint or on demand.
//
// admin.js is NOT counted, and its absence is the point of admin-boot.js: §5 has the
// dashboard "dynamically imported on moderator/admin login", so its bytes are never sent to
// a reader. Counting it here would make the budget describe a page nobody loads.
//
// FONTS are not counted either, and that one deserves saying out loud because it flatters
// the number. §9 lists four things in the budget and fonts are not among them — they get
// their own sentence in the same section ("Arabic font subset with unicode-range split,
// WOFF2, font-display: swap"), and the subsetting is M6's. Today the shell pulls two
// families from Google Fonts, which is a known_violations entry the CSP already blocks, so
// what a real visitor transfers is this figure plus whatever M6 ends up shipping. The
// headroom below is what M6 has to work with, not spare capacity.
//
// Brotli at quality 11, which is what a CDN serves from cache for a static asset. Not gzip:
// §9 says brotli, and the gap between them on this much Arabic text is around 15%, which is
// most of the headroom.
//
// ── The feed page is SYNTHESISED, and that is a real limit ───
//
// There is no published release to measure, so the 24 entries below are built to the shape
// shards.ts emits (FEED_PAGE_SIZE, feedEntry's exact keys) with field lengths taken from the
// seed copy: Arabic titles of 30–60 characters, an English gloss, a handle, a thumb path.
// A real archive's first page will differ, and the direction it differs in is the one that
// matters — longer titles cost more. So the figure this prints is an estimate for that one
// component and an exact measurement for the other three.
//
//     node scripts/frontend-budget.mjs
//     node scripts/frontend-budget.mjs --verbose

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const verbose = process.argv.includes('--verbose');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/** §9's ceiling, in bytes. One place, so a change to it is a change to the budget. */
const BUDGET = 150 * 1024;

const brotli = (text) =>
  brotliCompressSync(Buffer.from(text, 'utf8'), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length;

/* ── What the shell actually loads ───────────────────────────
 *
 * Parsed out of index.html rather than listed here. A module added to the shell and not to
 * this list would be bytes a visitor pays for and the budget does not see, which is the
 * one way a budget check can be worse than none.
 */
const shell = read('site/index.html');

const localScripts = [...shell.matchAll(/<script src="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((src) => src.startsWith('/'));

const localStyles = [...shell.matchAll(/<link\b[^>]*>/g)]
  .map((m) => m[0])
  .filter((tag) => /rel="stylesheet"/.test(tag))
  .map((tag) => /href="([^"]+)"/.exec(tag)?.[1] ?? '')
  .filter((href) => href.startsWith('/'));

if (localScripts.length === 0 || localStyles.length === 0) {
  console.error('::error::the shell parse found no local assets — the budget would be meaningless');
  process.exit(1);
}

/* ── A first feed page, to shards.ts's shape ─────────────────
 *
 * Keys and order come from feedEntry(); FEED_PAGE_SIZE from the same file, read rather than
 * copied, so the page this measures is the page that ships.
 */
const shardsSrc = read('supabase/functions/publish/shards.ts');
const pageSize = Number(/FEED_PAGE_SIZE = (\d+)/.exec(shardsSrc)?.[1] ?? 0);
if (!pageSize) {
  console.error('::error::could not read FEED_PAGE_SIZE from shards.ts');
  process.exit(1);
}

const TITLES_AR = [
  'زفّة في حواري البلدة القديمة، ١٩٦٧',
  'مبنى بلدية رام الله القديم، ١٩٥٨',
  'ميدان المنارة وأسوده، منتصف الستينيات',
  'درج حجريّ في البلدة القديمة، الثمانينيات',
  'طريق رام الله – بيرزيت، ١٩٩٤',
  'شارع ركب في ساعة الغروب، ١٩٧٢',
];
const TITLES_EN = [
  'A wedding procession in the Old City lanes, 1967',
  'The old Municipality building, 1958',
  'Al-Manara Square and its lions, mid-1960s',
  'A stone stairway in the Old City, 1980s',
  'The Ramallah–Birzeit road, 1994',
  'Rukab Street at sunset, 1972',
];

const feed = {
  page: 1,
  pages: 13,
  total: 300,
  items: Array.from({ length: pageSize }, (_, i) => ({
    id: `0000000${i.toString(16).padStart(4, '0')}-0000-4000-8000-00000000000${i % 10}`,
    kind: i % 7 === 0 ? 'voice' : 'media',
    title_ar: TITLES_AR[i % TITLES_AR.length],
    title_en: TITLES_EN[i % TITLES_EN.length],
    decade: 1950 + (i % 7) * 10,
    date_precision: 'decade',
    thumb: `0000000${i.toString(16).padStart(4, '0')}-0000-4000-8000-00000000000${i % 10}/thumb.webp`,
    author: {
      handle: `contributor_${i}`,
      display_name: 'أبو رام الله',
      avatar_path: null,
      label: 'member',
    },
    likes: 12 + i,
    comments: i % 5,
    day: '2026-08-19',
  })),
};

/* ── Measure ─────────────────────────────────────────────────
 *
 * Each file compressed on its own, because that is how they are transferred: separate
 * responses, each with its own brotli dictionary. Concatenating them first would measure a
 * bundle this project does not build (§9 forbids the build step) and would flatter the
 * total by letting one file's dictionary compress another's.
 */
const rows = [
  ['site/index.html', shell],
  ...localStyles.map((href) => [`site${href}`, read(`site${href}`)]),
  ...localScripts.map((src) => [`site${src}`, read(`site${src}`)]),
  ['feed/page-1.json (synthesised)', JSON.stringify(feed)],
];

let total = 0;
let raw = 0;
const measured = rows.map(([name, text]) => {
  const b = brotli(text);
  total += b;
  raw += Buffer.byteLength(text, 'utf8');
  return { name, raw: Buffer.byteLength(text, 'utf8'), br: b };
});

const kib = (n) => (n / 1024).toFixed(1).padStart(7) + ' KiB';

if (verbose || total > BUDGET) {
  measured.sort((a, b) => b.br - a.br);
  console.log('  brotli      raw   file');
  for (const m of measured) {
    console.log(`${kib(m.br)}  ${kib(m.raw)}   ${m.name}`);
  }
  console.log('');
}

console.log(`first paint, brotli:  ${(total / 1024).toFixed(1)} KiB  (raw ${(raw / 1024).toFixed(1)} KiB)`);
console.log(`§9's budget:          ${(BUDGET / 1024).toFixed(1)} KiB`);
console.log(`headroom:             ${((BUDGET - total) / 1024).toFixed(1)} KiB`);

if (total > BUDGET) {
  console.error(`::error::over §9's budget by ${((total - BUDGET) / 1024).toFixed(1)} KiB`);
  process.exit(1);
}

// A budget nobody watches until it breaks is a budget that breaks. 85% is where a single
// careless module still fits and the next one does not.
if (total > BUDGET * 0.85) {
  console.log(`::warning::within 15% of §9's budget — ${((BUDGET - total) / 1024).toFixed(1)} KiB left`);
}
