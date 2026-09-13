// §9: "The decade slider must run right-to-left in Arabic." Measured, in a real browser.
//
//   PLAYWRIGHT_DIR=<a node_modules with playwright> node scripts/rtl-browser-probe.mjs
//
// ── Why this is not in frontend-rtl-test.mjs ────────────────
//
// Because it is not a fact about this repository. A range input's direction comes from the
// browser, and the only thing this codebase can do is fail to override it — which is what
// frontend-rtl-test.mjs checks, from source, in CI, with no dependency. Asserting the
// browser's own behaviour from source would be asserting a belief about Chromium.
//
// So this file goes and looks. It is not in CI: it needs Playwright, a Chromium download
// and the live CDN for the shards, none of which belong in the pipeline. It is run by hand
// when the slider or its stylesheet changes, and the M6 report cites it.
//
// ── What is measured, and why it is the keyboard ─────────────
//
// Not pixels. A range input does not expose its thumb, and a screenshot comparison would be
// measuring the accent colour rather than the control. What IS observable, and is the thing
// that actually matters, is that the ARROW KEYS mirror: in a left-to-right slider ArrowRight
// increases the value, and in a right-to-left one it decreases it, because the visual right
// is the low end. A slider that renders mirrored but keeps LTR key behaviour is broken for
// anyone not using a mouse — which is precisely what `transform: scaleX(-1)` produces, and
// why frontend-rtl-test.mjs bans it by name.
//
// The document direction is asserted first, and separately. Without that, "the keys behave
// differently in the two languages" could be true for some other reason.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';

/* Playwright is NOT a dependency of this repository -- §9 forbids a build step and this
   project has no package.json on purpose. Install it into a scratch directory
   (`npm init -y && npm install playwright && npx playwright install chromium`) and point
   PLAYWRIGHT_DIR at that directory's node_modules. NODE_PATH does not work here: it is
   honoured by CommonJS resolution and ignored by ESM, which is a half-hour nobody needs to
   spend twice. */
const dir = process.env.PLAYWRIGHT_DIR;
const pw = await (dir
  ? import(pathToFileURL(join(dir, 'playwright', 'index.js')).href)
  : import('playwright')).catch(() => {
  console.error('rtl-browser-probe: playwright not found. Set PLAYWRIGHT_DIR to a');
  console.error('  node_modules directory that has it. See the comment at the top.');
  process.exit(2);
});
// Playwright is CommonJS, so a dynamic import wraps it: the named exports are on `default`.
const { chromium } = pw.default ?? pw;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(root, 'site');
const PORT = 3000;   // exactly this port: the R2 bucket's CORS allowlist names it

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* `site/_redirects` in miniature: a real file if there is one, else the SPA shell.
   Deliberately WITHOUT site/_headers — enforcing the CSP here would conflate "the slider
   is wrong" with "the policy blocked something", and the CSP has its own test. */
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(SITE, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(SITE, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

let passed = 0, failed = 0;
const ok = (cond, name) => {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
};

const browser = await chromium.launch();

/** Drive the slider in one language and report what the browser did. */
async function measure(lang) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${PORT}/map?lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.decade-slider__input', { timeout: 20000 });

  const shape = await page.evaluate(() => {
    const i = document.querySelector('.decade-slider__input');
    return {
      docDir: document.documentElement.dir,
      inputDir: getComputedStyle(i).direction,
      min: Number(i.min), max: Number(i.max), value: Number(i.value),
      transform: getComputedStyle(i).transform,
    };
  });

  // Park it in the middle so both arrow keys have room, then press one.
  await page.evaluate(() => {
    const i = document.querySelector('.decade-slider__input');
    i.value = String(Math.floor((Number(i.min) + Number(i.max)) / 2));
    i.focus();
  });
  const before = await page.evaluate(() => Number(document.querySelector('.decade-slider__input').value));
  await page.keyboard.press('ArrowRight');
  const after = await page.evaluate(() => Number(document.querySelector('.decade-slider__input').value));

  await page.close();
  return { ...shape, arrowRight: after - before };
}

const ar = await measure('ar');
const en = await measure('en');

console.log(`\n# ar: ${JSON.stringify(ar)}`);
console.log(`# en: ${JSON.stringify(en)}\n`);

ok(ar.docDir === 'rtl', `the Arabic document is dir=rtl (${ar.docDir})`);
ok(en.docDir === 'ltr', `the English document is dir=ltr (${en.docDir})`);
ok(ar.inputDir === 'rtl', `the slider INHERITS rtl in Arabic (computed direction: ${ar.inputDir})`);
ok(en.inputDir === 'ltr', `and ltr in English (computed direction: ${en.inputDir})`);
ok(ar.transform === 'none' && en.transform === 'none',
   'no transform is mirroring the control — the direction is real, not painted on');
ok(ar.max > ar.min, `CONTROL: the slider has ${ar.max - ar.min + 1} stops, so an arrow key has somewhere to go`);

ok(en.arrowRight === 1, `ArrowRight INCREASES the value in English (${en.arrowRight >= 0 ? '+' : ''}${en.arrowRight})`);
ok(ar.arrowRight === -1,
   `ArrowRight DECREASES it in Arabic (${ar.arrowRight >= 0 ? '+' : ''}${ar.arrowRight}) — the track runs right-to-left, so the right end is the earliest decade`);
ok(ar.arrowRight === -en.arrowRight, 'the two are exact mirrors of each other');

/* ── M6 addendum · the tabs, the search box and the count badges ─────────────
 *
 * Same argument as the slider above, one level out. §9 says "CSS logical properties only —
 * never left/right", and `scripts/frontend-rtl-test.mjs` asserts the half this repository
 * owns: that no stylesheet says `left`, `right`, `direction` or `transform` on these
 * controls. What it cannot assert is that logical properties then DO the thing they are
 * used for, because that is the browser resolving `inline-start` against the document's
 * direction — a belief about Chromium, not a fact about this codebase.
 *
 * So this measures the geometry. The DOM order of the four tabs is fixed and identical in
 * both languages (frontend-nav-test.mjs pins it: `/ /c/image /c/video /c/voice`). If
 * logical properties are working, that ONE source order must paint left-to-right in English
 * and right-to-left in Arabic. If somebody ever "fixes" the tab bar with
 * `flex-direction: row-reverse` or a physical margin, the DOM order stays right, the CI scan
 * stays green, and this is what goes red.
 *
 * ── The archive is STUBBED, and that is deliberate ───────────
 *
 * The slider measurement above renders against whatever the live CDN is serving, and can:
 * it needs no items, because `decadeStops()` falls back to DATA.DECADES. These assertions
 * need search RESULTS, and the deployed release has no `search-index.json` until the
 * addendum ships — so measured against production this section would report "no result row
 * rendered", which is a fact about the deployment and not about the layout.
 *
 * So the archive origin is intercepted per-page and served a five-item release from here.
 * The stub is deliberately lopsided across the three categories, so a count badge that
 * printed a constant would be caught rather than agreed with.
 */

const STUB_RELEASE = '/v/2026-09-09T00:00:00Z/';

/* Every title carries المنارة, which is what the probe types. Two images, one video, one
   voice and one event — five matches from All, and four different per-tab counts. */
const STUB_SEARCH = [
  { id: 'p1', title_ar: 'ميدان المنارة', title_en: 'Al-Manara Square', category: 'image', decade: 1960 },
  { id: 'p2', title_ar: 'المنارة في الشتاء', title_en: 'Al-Manara in winter', category: 'image', decade: 1970 },
  { id: 'p3', title_ar: 'فيلم المنارة', title_en: 'Manara film', category: 'video', decade: 1980 },
  { id: 'p4', title_ar: 'تسجيل من المنارة', title_en: 'A Manara recording', category: 'voice', decade: 1990 },
  { id: 'p5', title_ar: 'مهرجان المنارة', title_en: 'Manara festival', category: null, decade: 2000 },
];

const card = (id, category) => ({
  id, kind: category === 'voice' ? 'voice' : 'media', category,
  title_ar: 'ميدان المنارة', title_en: 'Al-Manara Square',
  decade: 1960, date_precision: 'decade', thumb: null, thumb_w: null, thumb_h: null,
  author: { handle: 'someone', display_name: null, avatar_path: null, label: 'member' },
  likes: 0, comments: 0, day: '2026-09-01',
});

const STUB = {
  '/manifest.json': { release: STUB_RELEASE, generated_on: '2026-09-09' },
  '/redactions.json': { ids: [] },
  [`${STUB_RELEASE}content.json`]: { blocks: {} },
  [`${STUB_RELEASE}index.json`]: {
    pages: 1, total: 5, decades: [1960], cells: [],
    categories: { image: { pages: 1, total: 2 }, video: { pages: 1, total: 1 }, voice: { pages: 1, total: 1 } },
    search: { total: 5 },
  },
  [`${STUB_RELEASE}feed/page-1.json`]: {
    page: 1, pages: 1, total: 5,
    items: [card('p1', 'image'), card('p2', 'image'), card('p3', 'video'), card('p4', 'voice'), card('p5', null)],
  },
  [`${STUB_RELEASE}category/image/page-1.json`]: {
    category: 'image', page: 1, pages: 1, total: 2, items: [card('p1', 'image'), card('p2', 'image')],
  },
  [`${STUB_RELEASE}category/video/page-1.json`]: {
    category: 'video', page: 1, pages: 1, total: 1, items: [card('p3', 'video')],
  },
  [`${STUB_RELEASE}category/voice/page-1.json`]: {
    category: 'voice', page: 1, pages: 1, total: 1, items: [card('p4', 'voice')],
  },
  [`${STUB_RELEASE}search-index.json`]: { total: STUB_SEARCH.length, items: STUB_SEARCH },
  [`${STUB_RELEASE}places.json`]: { total: 0, items: [] },
};

/** Where every piece of the archive's control row actually painted, in one language. */
async function measureControls(lang) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  /* The archive origin, answered from STUB. Anything it does not name 404s, exactly as the
     real CDN would — so a shard this probe forgot shows up as a missing shard rather than
     as a silent fall-through to production. */
  await page.route('**/*.r2.dev/**', async (route) => {
    const key = new URL(route.request().url()).pathname;
    if (key in STUB) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(STUB[key]),
      });
    } else {
      await route.fulfill({ status: 404, contentType: 'application/json', body: 'null' });
    }
  });

  await page.goto(`http://localhost:${PORT}/?lang=${lang}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.tab', { timeout: 20000 });
  await page.waitForSelector('.search__input', { timeout: 20000 });

  /* Type, so the count badges exist at all. They are `:empty` until a query is live —
     deliberately, so the row does not reflow when a search starts — which means a probe that
     never typed would measure four boxes that are `display: none` and report that they are
     all in the same place. */
  await page.fill('.search__input', 'المنارة');
  await page.waitForSelector('.result', { timeout: 20000 });

  const out = await page.evaluate(() => {
    const mid = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    const tabs = [...document.querySelectorAll('.tab')];
    const input = document.querySelector('.search__input');
    const firstTab = tabs[0];
    const result = document.querySelector('.result');

    return {
      docDir: document.documentElement.dir,

      // Painted centres, in DOM order. Increasing = the row runs left to right.
      tabCentres: tabs.map(mid),
      tabHrefs: tabs.map((t) => t.getAttribute('href')),
      // All on one line: the comparison below is about horizontal order, and a wrapped row
      // would make "further along" mean "further down" for some of them.
      tabTops: tabs.map((t) => Math.round(t.getBoundingClientRect().top)),
      counts: tabs.map((t) => t.querySelector('.tab__count').textContent.trim()),

      // Inside ONE tab: the label and its count.
      labelCentre: mid(firstTab.querySelector('.tab__label')),
      countCentre: mid(firstTab.querySelector('.tab__count')),
      countFont: getComputedStyle(firstTab.querySelector('.tab__count')).fontFamily,
      labelFont: getComputedStyle(firstTab.querySelector('.tab__label')).fontFamily,

      inputDir: getComputedStyle(input).direction,
      inputAlign: getComputedStyle(input).textAlign,
      inputTransform: getComputedStyle(input).transform,
      tabsTransform: getComputedStyle(document.querySelector('.tabs')).transform,

      // A result row: title at the reading start, badge and decade at the reading end.
      resultText: mid(result.querySelector('.result__text')),
      resultMeta: mid(result.querySelector('.result__meta')),
      resultWidth: result.getBoundingClientRect().width,
      resultCount: document.querySelectorAll('.result').length,
    };
  });

  await page.close();
  return out;
}

const arC = await measureControls('ar');
const enC = await measureControls('en');

console.log(`\n# ar controls: ${JSON.stringify(arC)}`);
console.log(`# en controls: ${JSON.stringify(enC)}\n`);

/* PREMISES first. Every assertion below compares painted positions, and positions that were
   all zero — an unstyled page, a control that never rendered — would compare equal and pass
   in the "no difference" direction for several of them. */
ok(arC.tabHrefs.join(' ') === enC.tabHrefs.join(' ') && arC.tabHrefs.length === 4,
   `PREMISE: both languages render the SAME four tabs in the same DOM order (${arC.tabHrefs.join(' ')})`);
ok(new Set(arC.tabTops).size === 1 && new Set(enC.tabTops).size === 1,
   'PREMISE: the tab row is one line in both languages, so "further along" means horizontally');
ok(arC.docDir === 'rtl' && enC.docDir === 'ltr',
   `PREMISE: the documents are rtl and ltr (${arC.docDir}, ${enC.docDir})`);
ok(arC.resultCount === 5 && enC.resultCount === 5,
   `PREMISE: the stubbed archive produced ${arC.resultCount} result rows to measure`);

const ascending = (xs) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
const descending = (xs) => xs.every((x, i) => i === 0 || x < xs[i - 1]);

ok(ascending(enC.tabCentres),
   `English paints All → Images → Videos → Voices left to right (${enC.tabCentres.map(Math.round).join(' < ')})`);
ok(descending(arC.tabCentres),
   `Arabic paints the SAME source order right to left (${arC.tabCentres.map(Math.round).join(' > ')}) — ` +
   'one DOM order, two layouts, no mirroring rule');
ok(arC.tabsTransform === 'none' && enC.tabsTransform === 'none',
   'and no transform is doing it — the direction is real, not painted on');

ok(enC.countCentre > enC.labelCentre,
   `the count sits after its label in English (label ${Math.round(enC.labelCentre)}, count ${Math.round(enC.countCentre)})`);
ok(arC.countCentre < arC.labelCentre,
   `and before it in Arabic (label ${Math.round(arC.labelCentre)}, count ${Math.round(arC.countCentre)}) — ` +
   'the flex gap is logical, so the badge follows the reading direction inside the chip too');

ok(arC.inputDir === 'rtl' && enC.inputDir === 'ltr',
   `the search box INHERITS the document's direction (${arC.inputDir}, ${enC.inputDir})`);
ok(arC.inputAlign === 'start' || arC.inputAlign === 'right',
   `...and its text starts at the reading edge in Arabic (text-align: ${arC.inputAlign})`);
ok(arC.inputTransform === 'none' && enC.inputTransform === 'none',
   'nothing mirrors the search box either');

ok(enC.resultMeta > enC.resultText,
   `a search result puts its badge after the title in English (${Math.round(enC.resultText)} → ${Math.round(enC.resultMeta)})`);
ok(arC.resultMeta < arC.resultText,
   `and before it in Arabic (${Math.round(arC.resultText)} → ${Math.round(arC.resultMeta)}) — ` +
   'the row follows the document direction');

/* And the badge is at the row's far EDGE, not merely after the title.
 *
 * The two assertions above measure reading ORDER, which `justify-content: flex-start`
 * preserves — so on their own they would agree with a row whose badge sits tucked against
 * the title with the rest of the width empty. That mutation survived them on 9 Sep 2026,
 * which is how this assertion came to exist. `space-between` is what pushes the meta out,
 * and the distance is what proves it did. 40% of the row is well clear of both cases: it
 * measured 89% with space-between and would be a fraction of that without. */
for (const [lang, m] of [['English', enC], ['Arabic', arC]]) {
  const spread = Math.abs(m.resultMeta - m.resultText) / m.resultWidth;
  ok(spread > 0.4,
     `and it is pushed to the far edge of the row in ${lang}, not tucked against the title ` +
     `(${Math.round(spread * 100)}% of the row's width apart)`);
}

/* THE COUNT BADGES, both what they say and what they are set in.
 *
 * The stub is lopsided on purpose: 5 / 2 / 1 / 1. A badge that printed a constant, or that
 * showed the All total on every tab, passes an "is it non-empty" check and fails this. */
ok(enC.counts.join(' ') === '5 2 1 1',
   `each tab reports its own share of the matches in English (${enC.counts.join(' ')})`);
ok(arC.counts.join(' ') === '٥ ٢ ١ ١',
   `and the same four numbers in Arabic-Indic digits (${arC.counts.join(' ')})`);

/* The font on that badge, which is the defect this probe found on 9 Sep 2026.
 *
 * I18N.num() renders Arabic-Indic digits in Arabic (٢, U+0662). Inter's unicode-range in
 * fonts.css stops at U+00FF, so `font-family: Inter` on the badge fell through to
 * `system-ui` for every count — beside a label set in IBM Plex Sans Arabic. Invisible to
 * frontend-fonts-test.mjs, which checks the interface's STATIC strings and cannot see a
 * digit generated at runtime. */
ok(/Plex/i.test(arC.countFont),
   `the Arabic count is set in the Arabic family, like the label beside it ` +
   `(count: ${arC.countFont} / label: ${arC.labelFont})`);
ok(/Inter/i.test(enC.countFont),
   `and in Inter under an English document (${enC.countFont})`);

await browser.close();
server.close();

console.log(`\n1..${passed + failed}`);
if (failed) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log(`All ${passed} assertions passed.`);
