#!/usr/bin/env node
/* The URL this archive spreads on, opened the way a phone opens it.
 *
 *     PLAYWRIGHT_DIR=<node_modules> node scripts/e2e-deeplink.mjs            working tree
 *     PLAYWRIGHT_DIR=<node_modules> node scripts/e2e-deeplink.mjs --live     the deployed origin
 *         [--item <uuid>]   default: the SECOND memory in the live feed
 *         [--shots <dir>]   screenshots of every run, for a person to look at
 *
 *     needs:  npx playwright install webkit chromium
 *
 * ── Why this file exists beside e2e-browser.mjs ──────────────
 *
 * The comments panel on a phone was fixed and "verified" twice (0e82e30, 9164400) and was
 * still reported broken on an iPhone. Every earlier browser check had three properties
 * that made a deep-link defect invisible to it, and this file has none of them:
 *
 *   1. THE DOCUMENT. e2e-browser.mjs's local server answers /item/{id} with
 *      site/index.html. The deployed site does not: /item/{id} is the Pages Function
 *      (functions/item/[[path]].js) serving the publisher's prerendered page
 *      (prerender.ts), which is a different document with a different <head> and a
 *      different script list. This file imports the generated function and serves what IT
 *      returns, and it asserts the page it got carries the prerendered article — so a
 *      harness that quietly falls back to the shell fails here instead of passing.
 *   2. THE CAPTCHA. e2e-browser.mjs replaces window.TURNSTILE with a stub in every page,
 *      because Turnstile does not answer automation. That same stub hid the fact that the
 *      prerendered page never loaded Turnstile's API at all: "sign in to comment" opened a
 *      dialog with an empty gap where the challenge belongs, and every submit was refused
 *      six seconds later. No doubles here. What is asserted is the part automation CAN see
 *      — the API arrived and the widget was mounted — not that a token came back.
 *   3. THE ENGINE AND THE SLIDE. Chromium only, and always the FIRST card, whose slide has
 *      nothing above it. The report was iOS Safari on slide 2 of 3. This runs WebKit and
 *      Chromium with Playwright's iPhone descriptor, on the second memory by default.
 *
 * ── What this is NOT ──────────────────────────────────────────
 *
 * Playwright's WebKit is the WebKit engine built for automation. It is NOT iOS Safari: no
 * floating tab bar, no home indicator, no software keyboard, and a trunk build with
 * experimental features switched on (it reports `overflow-anchor` support, for one). A
 * green run here says the deep-link document works in WebKit at a phone's size. It does not
 * say an iPhone renders it identically, and nothing in this file may be quoted as if it
 * did. A real device is the only evidence for that.
 *
 * Signed OUT, deliberately: a shared link opens in a fresh tab, and auth.js keeps the
 * session in sessionStorage, which a fresh tab does not have. Nothing here writes.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const LIVE = argv.includes('--live');
const SHOTS = arg('--shots');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(root, 'site');
const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));
const SITE_ORIGIN = `https://${cfg.domains.site}`;
const ARCHIVE = `https://${cfg.domains.cdn}`;
const TURNSTILE_API = `https://${cfg.domains.turnstile}/turnstile/v0/api.js`;
const PORT = 3000;
const ORIGIN = LIVE ? SITE_ORIGIN : `http://localhost:${PORT}`;
/* Turnstile's own words when its script executes a second time in one document. */
const DOUBLE_LOAD = /Turnstile already has been loaded/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const dir = process.env.PLAYWRIGHT_DIR;
const pw = await (dir
  ? import(pathToFileURL(join(dir, 'playwright', 'index.js')).href)
  : import('playwright')).catch(() => {
  console.error('e2e-deeplink: playwright not found. Set PLAYWRIGHT_DIR to a node_modules');
  console.error('  directory that has it:  npm init -y && npm install playwright');
  console.error('                          npx playwright install webkit chromium');
  process.exit(2);
});
const { webkit, chromium, devices } = pw.default ?? pw;
const DEVICE = devices['iPhone 15'];

let executed = 0;
const failures = [];
function ck(cond, msg, detail) {
  executed++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures.push(msg);
}

/* ── The item: the SECOND memory in the live feed ───────────── */

const manifest = await (await fetch(`${ARCHIVE}/manifest.json?t=${Date.now()}`)).json();
const feed = await (await fetch(`${ARCHIVE}${manifest.release}feed/page-1.json`)).json();
const ITEM = arg('--item') ?? feed.items[1]?.id;
if (!ITEM || !UUID.test(ITEM)) {
  console.error(`e2e-deeplink: need an item id; the live feed has ${feed.items.length} item(s)`);
  process.exit(2);
}
const shard = await (await fetch(`${ARCHIVE}${manifest.release}item/${ITEM}.json`)).json();
const PUBLISHED = (shard.comments ?? []).length;

/* ── The local site: the working tree, with the REAL item route ─
 *
 * /item/{id} goes through the generated Pages Function, exactly as on Cloudflare; its
 * next() is site/_redirects in miniature. The function's security headers are dropped
 * here and only here: `upgrade-insecure-requests` rewrites every subresource of an
 * http://localhost page to https and nothing would load. --live serves them for real. */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
};
let server = null;
if (!LIVE) {
  const FN = join(root, 'functions', 'item', '[[path]].js');
  const { onRequest } = await import(pathToFileURL(FN).href);
  const staticFile = (path) => {
    let file = join(SITE, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(SITE, 'index.html');
    return new Response(readFileSync(file), {
      headers: { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' },
    });
  };
  server = createServer(async (req, res) => {
    const url = new URL(req.url, ORIGIN);
    const path = decodeURIComponent(url.pathname);
    const out = path.startsWith('/item/')
      ? await onRequest({ request: new Request(url, { method: req.method }), next: async () => staticFile(path) })
      : staticFile(path);
    res.writeHead(out.status, {
      'Content-Type': out.headers.get('Content-Type') ?? 'application/octet-stream',
    });
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(PORT, r));
}

console.log(`\nThe deep link, opened cold and signed out`);
console.log(`  site     ${ORIGIN}${LIVE ? '' : '  (working tree; /item/* through functions/item/[[path]].js)'}`);
console.log(`  item     /item/${ITEM}  (position ${feed.items.findIndex((i) => i.id === ITEM) + 1} of ${feed.total} in the feed, ${PUBLISHED} published comment(s))`);
console.log(`  engines  WebKit and Chromium, ${'iPhone 15'} descriptor — NOT iOS Safari (see the header)`);

/* What the reader is looking at, measured rather than queried. `reach` is 29 Aug's method:
   a box with area, inside the window, and hit-testing to itself at its centre. */
const GEOMETRY = () => {
  const reach = (n) => {
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const inside = r.width > 0 && r.height > 0 && r.top >= -0.5 && r.left >= -0.5
      && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
    const hit = inside ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
             inside, onTop: !!(hit && (hit === n || n.contains(hit))) };
  };
  const scroller = document.querySelector('.viewer__scroller');
  const slides = scroller ? [...scroller.children] : [];
  const probeY = scroller ? scroller.getBoundingClientRect().top + 60 : 0;
  const shown = slides.findIndex((s) => {
    const r = s.getBoundingClientRect();
    return r.top <= probeY && r.bottom > probeY;
  });
  const list = document.querySelector('.viewer__comments .comments__list');
  const prompt = document.querySelector('.viewer__comments .locked-prompt');
  return {
    overlays: document.querySelectorAll('.viewer').length,
    position: (document.querySelector('.viewer__position')?.textContent || '').trim(),
    path: location.pathname,
    shownIndex: shown,
    shownId: shown > -1 ? slides[shown].dataset.id : null,
    subject: (document.querySelector('.viewer__comments .comments__subject')?.textContent || '').trim(),
    shownTitle: shown > -1 ? (slides[shown].querySelector('.viewer__title')?.textContent || '').trim() : null,
    listDisplay: list ? getComputedStyle(list).display : 'absent',
    rows: document.querySelectorAll('.viewer__comments .comment').length,
    firstRow: reach(document.querySelector('.viewer__comments .comment')),
    prompt: reach(prompt),
    promptText: (prompt?.textContent || '').trim().length,
    hScroll: document.documentElement.scrollWidth > innerWidth,
  };
};

/* The position counter is rendered through I18N.num, so Arabic reads it in Arabic-Indic
   digits. Normalised before comparing, or this would pass only in English. */
const digits = (s) => s.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

const RUNS = [];
for (const [name, type] of [['webkit', webkit], ['chromium', chromium]]) {
  for (const lang of ['ar', 'en']) RUNS.push({ name, type, lang });
}

let browsers = {};
try {
  for (const { name, type, lang } of RUNS) {
    const tag = `${name} ${lang}`;
    console.log(`\n${tag}`);
    browsers[name] ??= await type.launch().catch((e) => {
      console.error(`e2e-deeplink: ${name} would not launch — npx playwright install ${name}\n${e.message}`);
      process.exit(2);
    });
    const opts = { ...DEVICE };
    delete opts.defaultBrowserType;
    const ctx = await browsers[name].newContext(opts);   // a new context is a cold cache
    await ctx.addInitScript((l) => { try { localStorage.setItem('rma.lang', l); } catch (e) { /* private */ } }, lang);
    const page = await ctx.newPage();
    const pageErrors = [];
    /* One exclusion, and only one: WebKit reports Turnstile's OWN frame trying to reach
       ours ("Blocked a frame with origin …challenges.cloudflare.com…") as an uncaught
       error. It is not this page's code, it happens on the shell too — measured 17 Sep,
       two runs of two, WebKit only, from the masthead's sign-in — and it arrives seconds
       after the widget mounts, so without this the check below would pass or fail on
       timing. Anything that does not name Turnstile's origin still fails the run. */
    page.on('pageerror', (e) => {
      const text = String(e);
      if (!text.includes(cfg.domains.turnstile)) pageErrors.push(text);
    });
    let apiRequests = 0;
    page.on('request', (r) => { if (r.url().startsWith(TURNSTILE_API)) apiRequests++; });
    const doubleLoad = [];
    page.on('console', (m) => { if (DOUBLE_LOAD.test(m.text())) doubleLoad.push(m.text()); });

    const res = await page.goto(`${ORIGIN}/item/${ITEM}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const html = await res.text();

    /* ── 1 · the document is the one a shared link really gets ── */
    ck(res.status() === 200, `${tag}: /item/{id} answers 200 (${res.status()})`);
    ck(html.includes('class="prerender"'),
       `${tag}: the page is the PRERENDERED document, not the SPA shell`,
       'the Pages Function fell through — this run is testing the wrong page');

    await page.waitForSelector('.viewer', { timeout: 30000 });
    // Settled: the item shard has landed (the counter carries its number) and the race
    // between the feed and the shard has had time to finish. Never networkidle.
    await page.waitForFunction(() => /\d|[٠-٩]/.test(document.querySelector('.comments__count')?.textContent || ''),
      null, { timeout: 30000 });
    await page.waitForTimeout(3000);
    const g = await page.evaluate(GEOMETRY);
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}-${lang}-viewer.png`) }); }

    /* ── 2 · the viewer shows the memory the link names ── */
    ck(g.overlays === 1, `${tag}: one viewer is mounted (${g.overlays})`);
    ck(g.path === `/item/${ITEM}` && g.shownId === ITEM,
       `${tag}: the slide on the screen is the memory the link names`,
       `url ${g.path}, on screen ${g.shownId}`);
    ck(digits(g.position).startsWith(`${g.shownIndex + 1} `),
       `${tag}: the counter names that slide ("${g.position}", slide ${g.shownIndex + 1})`);
    ck(g.subject === g.shownTitle,
       `${tag}: the comments panel is for the memory on the screen`,
       `panel "${g.subject}", slide "${g.shownTitle}"`);
    ck(!g.hScroll, `${tag}: the page does not scroll sideways`);

    /* ── 3 · the thread and the prompt are reachable, not merely present ── */
    ck(g.listDisplay !== 'none' && g.listDisplay !== 'absent', `${tag}: the comment list is displayed (${g.listDisplay})`);
    ck(g.rows === PUBLISHED, `${tag}: every published comment is in the thread (${g.rows} of ${PUBLISHED})`);
    if (PUBLISHED > 0) {
      ck(g.firstRow?.inside && g.firstRow?.onTop,
         `${tag}: the first comment is on screen and nothing covers it`, JSON.stringify(g.firstRow));
    }
    ck(g.prompt?.inside && g.prompt?.onTop,
       `${tag}: "sign in to comment" is on screen and nothing covers it`, JSON.stringify(g.prompt));
    ck(g.promptText > 0, `${tag}: the prompt carries words, not only a padlock`);

    /* ── 4 · and it leads somewhere: the captcha sign-in needs actually arrives ──
       The discriminating half of this file. Before 17 Sep the API script was never
       requested on this document, window.turnstile stayed undefined, and the slot the
       widget renders into stayed empty however long a reader waited. */
    await page.click('.viewer__comments .locked-prompt');
    await page.waitForSelector('.dialog--gate .btn--ghost', { timeout: 10000 });
    await page.click('.dialog--gate .btn--ghost');
    // ATTACHED, not visible: an empty slot is hidden by CSS, and empty is the failure this
    // section exists to report — waiting for it to become visible would crash instead.
    await page.waitForSelector('form.dialog--form .captcha', { state: 'attached', timeout: 10000 });
    const arrived = await page.waitForFunction(
      () => typeof window.turnstile === 'object' && window.turnstile !== null
        && typeof window.turnstile.render === 'function'
        && document.querySelector('form.dialog--form .captcha')?.childElementCount > 0,
      null, { timeout: 15000 }).then(() => true, () => false);
    const cap = await page.evaluate((api) => ({
      api: typeof window.turnstile,
      children: document.querySelector('form.dialog--form .captcha')?.childElementCount ?? -1,
      tags: document.querySelectorAll(`script[src^="${api}"]`).length,
      unavailable: [...document.querySelectorAll('form.dialog--form .form-error')]
        .some((n) => !n.hidden && n.textContent.trim()),
    }), TURNSTILE_API);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}-${lang}-signin.png`) });
    ck(apiRequests > 0, `${tag}: Turnstile's API is requested (${apiRequests})`,
       'never requested — the deep-link document has no way to load it');
    ck(cap.tags === 1 && doubleLoad.length === 0,
       `${tag}: and loaded ONCE (${cap.tags} tag(s), ${doubleLoad.length} double-load warning(s))`);
    ck(arrived, `${tag}: sign-in from the comment prompt mounts a Turnstile widget`,
       `window.turnstile: ${cap.api}, children in the captcha slot: ${cap.children}`);

    ck(pageErrors.length === 0, `${tag}: no uncaught page errors`, pageErrors.join('\n        '));
    await ctx.close();
  }

  /* ── 5 · the shell still loads the API once, not twice ──
     The shell has its own <script> tag and turnstile.js now brings the API itself when a
     document lacks one. Both firing is Turnstile executing twice on every page.
     Counted as TAGS, not requests: with the guard removed, the second tag is answered
     from the memory cache and the request count still reads 1 — measured, and that is
     how the first version of this check survived its mutant. Turnstile's own console
     warning is the second witness. */
  console.log(`\nthe shell`);
  for (const name of Object.keys(browsers)) {
    const opts = { ...DEVICE };
    delete opts.defaultBrowserType;
    const ctx = await browsers[name].newContext(opts);
    const page = await ctx.newPage();
    const doubleLoad = [];
    page.on('console', (m) => { if (DOUBLE_LOAD.test(m.text())) doubleLoad.push(m.text()); });
    await page.goto(`${ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => typeof window.turnstile === 'object' && window.turnstile !== null,
      null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const tags = await page.evaluate((api) => document.querySelectorAll(`script[src^="${api}"]`).length, TURNSTILE_API);
    ck(tags === 1 && doubleLoad.length === 0,
       `${name}: / loads Turnstile's API once (${tags} tag(s), ${doubleLoad.length} double-load warning(s))`);
    await ctx.close();
  }
} finally {
  for (const b of Object.values(browsers)) await b.close();
  if (server) server.close();
}

console.log(`\n${executed} checks, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('OK.\n');
