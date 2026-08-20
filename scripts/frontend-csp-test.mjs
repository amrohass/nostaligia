// Does the front end actually survive the CSP in config/site.json?
//
// Two things are checked, and neither can be established by reading the policy:
//
//   1. el()'s style handling goes through CSSOM, not the style attribute. `style-src
//      'self'` blocks setAttribute('style', …) — the attribute is an inline style
//      whether markup or script wrote it — while property writes are untouched. A
//      regression here is invisible until a page renders unstyled behind a header that
//      is not applied in local development.
//
//   2. The set of external origins the front end loads is EXACTLY the set recorded in
//      config/site.json as known_violations. A ratchet in both directions: a new
//      third-party origin fails the build, and removing one fails until the line is
//      deleted from the config, so the list cannot quietly describe the past.
//
//     node scripts/frontend-csp-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));

let n = 0, bad = 0;
const ok = (cond, msg) => {
  n++;
  console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${msg}`);
  if (!cond) bad++;
};

// ── 1 · el() writes styles through CSSOM ────────────────────────────────────
// ui.js is a browser IIFE ending in `})(window)`. Running it with `window` bound to a
// stub gives the real function under test rather than a reimplementation of it — a test
// that reimplements the parser proves only that two copies of a bug agree.
const recorded = [];
function stubNode() {
  return {
    className: '', dataset: {}, textContent: '', innerHTML: '',
    style: { setProperty: (p, v, prio) => recorded.push([p, v, prio || '']) },
    setAttribute: (k, v) => recorded.push(['ATTR:' + k, v, '']),
    addEventListener() {}, appendChild() {}, querySelector: () => null
  };
}
const stubWindow = {
  document: { createElement: stubNode, createTextNode: () => ({}) },
  DATA: { tone: () => ['#A98D66', '#8A9268'] }
};
new Function('window', readFileSync(join(root, 'site/assets/js/ui.js'), 'utf8'))(stubWindow);
const { el, toneStyle } = stubWindow.UI;

const run = (styleValue) => { recorded.length = 0; el('div', { style: styleValue }); return recorded; };

// CONTROL first. Assertion 2 below is `every(...)` over the recorded calls, and every()
// is true for an empty array — so before trusting it, prove the stub records a
// setAttribute at all. If this fails, the next assertion is vacuous and means nothing.
recorded.length = 0;
el('div', { 'aria-label': 'x' });
ok(recorded.some(([p]) => p === 'ATTR:aria-label'),
   'CONTROL: the stub records setAttribute — so the next assertion can actually fail');
ok(run('padding:20px').every(([p]) => !p.startsWith('ATTR:')),
   "el() never reaches setAttribute('style', …) — that is what style-src blocks");
ok(JSON.stringify(run('padding:20px')) === JSON.stringify([['padding', '20px', '']]),
   'a single declaration is applied through setProperty');
ok(run('display:flex;flex-direction:column;gap:18px').length === 3,
   'a multi-declaration string is split into three setProperty calls');
ok(JSON.stringify(run('background:var(--paper)')) === JSON.stringify([['background', 'var(--paper)', '']]),
   'a value containing a colon survives — split on the FIRST colon only');
ok(JSON.stringify(run('--p1:#A98D66')) === JSON.stringify([['--p1', '#A98D66', '']]),
   'a CUSTOM property is applied — node.style[prop] = v could not reach it');
ok(run(toneStyle('any')).length === 2 && run(toneStyle('any')).every(([p]) => p.startsWith('--')),
   'toneStyle() output lands as two custom properties');
ok(JSON.stringify(run('color:red !important')) === JSON.stringify([['color', 'red', 'important']]),
   '!important is passed as the priority argument, not glued onto the value');
ok(run('padding:20px;;').length === 1 && run(';').length === 0,
   'empty and malformed declarations are skipped rather than throwing');

// ── 2 · the external-origin ratchet ─────────────────────────────────────────
// Everything Cloudflare Pages actually serves, and nothing else — site/ IS the deployed
// tree (wrangler.toml). Scanning the repository root instead would sweep in scripts/ and
// supabase/, whose origins are never fetched by a browser, and the ratchet would start
// reporting on files no visitor can reach.
const files = [
  'site/index.html', 'site/admin.html',
  ...readdirSync(join(root, 'site/assets/js')).filter(f => f.endsWith('.js')).map(f => `site/assets/js/${f}`),
  ...readdirSync(join(root, 'site/assets/css')).filter(f => f.endsWith('.css')).map(f => `site/assets/css/${f}`),
  // Not in site/, and served to browsers anyway. The publisher writes prerender.ts's output
  // to item/{id}/index.html in the R2 bucket, which is the FIRST document anyone arriving
  // from a shared link ever loads (CLAUDE.md section 9). Scanning site/ alone would leave
  // the one page a stranger sees outside the ratchet, which is exactly backwards.
  'supabase/functions/publish/prerender.ts'
];

const own = new Set(Object.values(cfg.domains).map(d => `https://${d}`));
const found = new Set();
for (const rel of files) {
  const text = readFileSync(join(root, rel), 'utf8');
  for (const m of text.matchAll(/https?:\/\/[a-zA-Z0-9._-]+/g)) {
    const origin = m[0].replace(/^http:/, 'https:');
    // wa.me is a link target, not a subresource. CSP governs what the page FETCHES;
    // navigation is form-action/frame-src territory and neither applies to an <a href>.
    //
    // www.w3.org is the SVG namespace URI, which createElementNS takes and no browser has
    // ever fetched. It appears because ui.js builds real SVG nodes instead of assigning
    // strings to innerHTML (section 6) — so the ratchet would report the XSS fix as a new
    // third-party dependency. Matched on the exact namespace rather than the host, because
    // w3.org DOES serve fetchable things and a blanket exemption would hide one.
    if (origin === 'https://wa.me' || own.has(origin)) continue;
    if (/^https?:\/\/www\.w3\.org\/2000\/svg/.test(m.input.slice(m.index))) continue;
    found.add(origin);
  }
}

const declared = new Set(cfg.known_violations.map(v => v.origin));
const undeclared = [...found].filter(o => !declared.has(o));
const stale = [...declared].filter(o => !found.has(o));

ok(undeclared.length === 0,
   `no UNDECLARED third-party origin in the front end${undeclared.length ? ' — found ' + undeclared.join(', ') : ''}`);
ok(stale.length === 0,
   `every known_violation is still real${stale.length ? ' — gone from the code, delete from site.json: ' + stale.join(', ') : ''}`);

// ── 3 · the policy itself ───────────────────────────────────────────────────
const headers = readFileSync(join(root, 'site/_headers'), 'utf8');
ok(!/unsafe-inline|unsafe-eval/.test(headers),
   "the generated _headers contains neither 'unsafe-inline' nor 'unsafe-eval' (section 6)");
ok(/^\s+Strict-Transport-Security: max-age=\d+; includeSubDomains/m.test(headers),
   'HSTS is present with includeSubDomains');
ok(/default-src 'none'/.test(headers),
   "default-src is 'none' — a subresource type not listed is denied, not defaulted open");

console.log(`\n1..${n}`);
if (bad) { console.error(`FAILED ${bad} of ${n}`); process.exit(1); }
console.log(`All ${n} assertions passed.`);
