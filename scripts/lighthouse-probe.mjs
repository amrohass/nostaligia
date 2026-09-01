#!/usr/bin/env node
/* §10's M6 exit criterion: "Lighthouse on throttled 3G / mid-tier Android".
 *
 *   PLAYWRIGHT_DIR=<node_modules> LIGHTHOUSE_DIR=<node_modules> \
 *     node scripts/lighthouse-probe.mjs [origin]
 *
 * Defaults to the deployed origin. Give it http://localhost:3000 to measure a working tree
 * (serve site/ there — scripts/rtl-browser-probe.mjs has the same server inline).
 *
 * ── Why the deployed origin by default ──────────────────────
 *
 * Because the thing being measured is what a person in Ramallah on a phone actually waits
 * for, and that includes the CDN, the compression a real server negotiates, and the
 * `_headers` cache policy. A localhost run measures the files; this measures the site.
 *
 * ── The throttling, stated rather than defaulted ────────────
 *
 * Lighthouse's own "mobile" preset is simulated SLOW 4G (150ms RTT, 1.6 Mbps down, 4x CPU).
 * §10 says 3G, which is slower on both axes and is the honest floor for a regional
 * connection, so the profile below is written out instead of inherited. Changing these
 * numbers changes what "the budget is met" means, so they live here, once, with a comment.
 *
 * ── The caveat that belongs on every number this prints ─────
 *
 * The archive currently holds a handful of items and `fottage/` has 22 files, not the ~300
 * of §3's seed import. The FIRST FEED PAGE is what a Lighthouse run loads, and §9's budget
 * is per-page, so the transfer figures hold. What does NOT hold is any judgement about feed
 * pagination, shard sizes, or how the grid behaves while scrolling — those are being
 * measured against a twentieth of the archive, and this script prints that line itself so a
 * number cannot be quoted without it.
 */

import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ORIGIN = process.argv.find((a) => /^https?:\/\//.test(a)) ?? 'https://nostaligia.pages.dev';

async function load(dir, spec, file) {
  const mod = dir ? await import(pathToFileURL(join(dir, ...file)).href) : await import(spec);
  return mod.default ?? mod;
}

const pw = await load(process.env.PLAYWRIGHT_DIR, 'playwright', ['playwright', 'index.js']);
const lighthouse = await load(process.env.LIGHTHOUSE_DIR, 'lighthouse', ['lighthouse', 'core', 'index.js']);

/* A mid-range Android on 3G. Every number is a decision:
     rttMs 300 / 700 kbps down   — a regional 3G link rather than Lighthouse's slow-4G default
     cpuSlowdownMultiplier 4     — Lighthouse's own mid-tier phone factor, kept
     screen 412x823 @ 1.75       — a Pixel-class viewport, which is what "mid-range" means now */
const THROTTLING = {
  rttMs: 300,
  throughputKbps: 700,
  requestLatencyMs: 300 * 3.75,
  downloadThroughputKbps: 700,
  uploadThroughputKbps: 700,
  cpuSlowdownMultiplier: 4,
};

const ROUTES = ['/', '/map', '/events'];

const browser = await pw.chromium.launch({
  args: ['--remote-debugging-port=9222', '--no-first-run'],
});

console.log(`\nLighthouse — ${ORIGIN}`);
console.log('mid-tier Android on 3G: 300ms RTT, 700 kbps, 4x CPU, 412x823 @1.75\n');

const rows = [];
for (const route of ROUTES) {
  const result = await lighthouse(
    ORIGIN + route,
    { port: 9222, output: 'json', logLevel: 'error' },
    {
      extends: 'lighthouse:default',
      settings: {
        formFactor: 'mobile',
        throttlingMethod: 'simulate',
        throttling: THROTTLING,
        screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
        emulatedUserAgentDetails: undefined,
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
    },
  );

  const lhr = result.lhr;
  const n = (id) => lhr.audits[id]?.numericValue;
  rows.push({
    route,
    performance: Math.round((lhr.categories.performance?.score ?? 0) * 100),
    accessibility: Math.round((lhr.categories.accessibility?.score ?? 0) * 100),
    bestPractices: Math.round((lhr.categories['best-practices']?.score ?? 0) * 100),
    seo: Math.round((lhr.categories.seo?.score ?? 0) * 100),
    fcpMs: Math.round(n('first-contentful-paint') ?? 0),
    lcpMs: Math.round(n('largest-contentful-paint') ?? 0),
    tbtMs: Math.round(n('total-blocking-time') ?? 0),
    cls: Number((n('cumulative-layout-shift') ?? 0).toFixed(3)),
    speedIndexMs: Math.round(n('speed-index') ?? 0),
    transferKiB: Math.round((n('total-byte-weight') ?? 0) / 1024),
    // The audits worth naming: a font swap and an unused byte are M6's own subject.
    failing: Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 0.9 && a.details?.overallSavingsMs > 100)
      .map((a) => `${a.id} (${Math.round(a.details.overallSavingsMs)}ms)`),
  });

  const r = rows[rows.length - 1];
  console.log(`  ${route.padEnd(9)} perf ${String(r.performance).padStart(3)}  a11y ${String(r.accessibility).padStart(3)}  `
    + `bp ${String(r.bestPractices).padStart(3)}  seo ${String(r.seo).padStart(3)}   `
    + `FCP ${String(r.fcpMs).padStart(5)}ms  LCP ${String(r.lcpMs).padStart(5)}ms  `
    + `TBT ${String(r.tbtMs).padStart(4)}ms  CLS ${r.cls}  ${r.transferKiB} KiB`);
  if (r.failing.length) console.log(`             ${r.failing.join(', ')}`);
}

await browser.close();

console.log('\nMeasured against the archive as it stands — a handful of published items, not');
console.log('§3\'s ~300. Per-page transfer holds; any judgement about feed pagination or shard');
console.log('size from these numbers is provisional until the seed import lands.\n');

console.log(JSON.stringify({ origin: ORIGIN, throttling: THROTTLING, routes: rows }, null, 2));
