// Generate `_headers` and `assets/js/config.js` from config/site.json.
//
// CLAUDE.md section 2 asks for every origin/CSP/CORS value in one config module so that
// pointing at a real domain is a one-file change. Two files have to carry those values at
// runtime -- a static `_headers` that Cloudflare Pages reads, and a JS module the browser
// reads -- and hand-keeping them in step with a third is how they drift.
//
// So neither is written by hand. CI runs this with --check and fails on any diff, which
// makes "one-file change" a property of the repository rather than a note in a README.
//
//     node scripts/build-site-config.mjs           # write
//     node scripts/build-site-config.mjs --check   # verify, exit 1 on drift (CI)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');
const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));

const GENERATED = 'GENERATED FROM config/site.json BY scripts/build-site-config.mjs -- DO NOT EDIT';

// @token -> https://<domain>. An unknown token is a hard error rather than a silently
// empty source: a CSP directive that quietly loses a source fails open at runtime and
// nowhere else.
function resolve(src) {
  if (!src.startsWith('@')) return src;
  const name = src.slice(1);
  const host = cfg.domains[name];
  if (!host) throw new Error(`csp references @${name}, which is not in domains`);
  return `https://${host}`;
}

const policy = Object.entries(cfg.csp)
  .map(([directive, sources]) => [directive, ...sources.map(resolve)].join(' '))
  .join('; ');

// Fail loudly rather than emit a policy that section 6 forbids. This is the assertion that
// survives someone "temporarily" loosening the config to get a page working.
for (const banned of ["'unsafe-inline'", "'unsafe-eval'"]) {
  if (policy.includes(banned)) throw new Error(`CSP contains ${banned} — forbidden by CLAUDE.md section 6`);
}

// ── _headers ────────────────────────────────────────────────────────────────
// Cloudflare Pages format: a path pattern, then indented `Name: value` lines. `/*` matches
// every route, which is what a security header set should do -- an exception carved out
// per-path is an exception someone forgets to close.
const headerLines = Object.entries(cfg.headers).map(([k, v]) => `  ${k}: ${v}`);
const headers = [
  `# ${GENERATED}`,
  '#',
  '# Cloudflare Pages reads this file. GitHub Pages IGNORES it completely, so none of these',
  '# headers apply while the site is served from GitHub Pages -- see the README.',
  '',
  '/*',
  `  Content-Security-Policy: ${policy}`,
  ...headerLines,
  '',
  '# Generated release shards and media are immutable and content-addressed by path (M2).',
  '/v/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
  '# The pointer the whole read path hangs off. Short TTL so a rollback is visible fast.',
  '/manifest.json',
  '  Cache-Control: public, max-age=30, must-revalidate',
  '',
  '# Takedown must never wait for a publish cycle (section 8).',
  '/redactions.json',
  '  Cache-Control: public, max-age=30, must-revalidate',
  ''
].join('\n');

// ── assets/js/config.js ─────────────────────────────────────────────────────
// Same IIFE-on-window shape as i18n.js / store.js / ui.js. No build step, no modules.
const js = `/* ${GENERATED}
   Edit config/site.json and re-run the generator. */

(function (global) {
  'use strict';

  global.CONFIG = Object.freeze({
    // PLACEHOLDER_* until the production host and domain are provisioned. Nothing else in
    // the repository may contain a hostname -- that is what makes this a one-file change.
    domains: Object.freeze(${JSON.stringify(cfg.domains, null, 6).replace(/\n/g, '\n    ')}),

    origins: Object.freeze({
${Object.entries(cfg.domains).map(([k, v]) => `      ${k}: 'https://${v}'`).join(',\n')}
    }),

    // The exact policy served by _headers. Exposed so a page can assert at runtime that the
    // policy it is running under is the one this repository generated, rather than assuming.
    csp: ${JSON.stringify(policy)}
  });
})(window);
`;

const outputs = [
  ['_headers', headers],
  ['assets/js/config.js', js]
];

let drifted = false;
for (const [rel, content] of outputs) {
  const path = join(root, rel);
  let current = null;
  try { current = readFileSync(path, 'utf8'); } catch { /* not yet generated */ }
  if (current === content) { console.log(`unchanged  ${rel}`); continue; }
  if (check) {
    console.error(`::error::${rel} is out of date — run: node scripts/build-site-config.mjs`);
    drifted = true;
    continue;
  }
  writeFileSync(path, content);
  console.log(`wrote      ${rel}`);
}

if (check && drifted) process.exit(1);
if (check) console.log('\nboth generated files match config/site.json');
