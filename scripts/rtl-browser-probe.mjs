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

await browser.close();
server.close();

console.log(`\n1..${passed + failed}`);
if (failed) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log(`All ${passed} assertions passed.`);
