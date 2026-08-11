// Prove the headers in config/site.json are ACTUALLY SERVED by a deployment.
//
// The distinction this exists for: `_headers` being committed, and CI being green, say
// nothing about whether a browser ever receives a Content-Security-Policy. GitHub Pages
// ignores `_headers` completely -- the file is present, correct, tested, and inert. Only
// a response from the live origin settles it.
//
// The URL is an ARGUMENT, never a constant. CLAUDE.md section 2 keeps every origin in
// config/site.json, and a *.pages.dev preview host is not an origin this project commits
// to -- baking it into a script would be the same mistake as hardcoding it in the app.
//
//     node scripts/verify-deployed-headers.mjs https://<project>.pages.dev
//
// Exit 0 only if every header matches what the generator produces from config/site.json.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/verify-deployed-headers.mjs <url>');
  process.exit(2);
}

const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));

// Rebuild the expected policy from the SAME source the generator uses, rather than
// parsing _headers. If someone hand-edits _headers, this still compares against
// config/site.json and the drift shows up here too.
const resolve = (s) => (s.startsWith('@') ? `https://${cfg.domains[s.slice(1)]}` : s);
const expectedCsp = Object.entries(cfg.csp)
  .map(([d, srcs]) => [d, ...srcs.map(resolve)].join(' '))
  .join('; ');

let n = 0, bad = 0;
const ok = (cond, msg, detail) => {
  n++;
  console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${msg}`);
  if (!cond) { bad++; if (detail) console.log(`      ${detail}`); }
};

console.log(`\nGET ${target}\n`);
let res;
try {
  res = await fetch(target, { redirect: 'follow' });
} catch (e) {
  console.error(`request failed: ${e.message}`);
  process.exit(1);
}

console.log(`HTTP ${res.status} ${res.statusText}   (final URL: ${res.url})`);
console.log('--- response headers as served ---');
for (const [k, v] of [...res.headers].sort()) console.log(`${k}: ${v}`);
console.log('--- end ---\n');

const got = (name) => res.headers.get(name);

ok(res.ok, `the deployment responds 2xx`, `got ${res.status}`);

const csp = got('content-security-policy');
ok(csp !== null, 'a Content-Security-Policy header is present at all',
   'no CSP header — _headers is not being applied by this host');
if (csp !== null) {
  ok(csp === expectedCsp, 'the served CSP is byte-identical to the one config/site.json generates',
     `served:   ${csp}\n      expected: ${expectedCsp}`);
  ok(!/unsafe-inline|unsafe-eval/.test(csp),
     "the served CSP contains neither 'unsafe-inline' nor 'unsafe-eval' (section 6)");
}

const hsts = got('strict-transport-security');
ok(hsts !== null, 'Strict-Transport-Security is present', 'no HSTS header');
if (hsts !== null) {
  ok(hsts === cfg.headers['Strict-Transport-Security'],
     'HSTS matches config/site.json exactly',
     `served: ${hsts}\n      expected: ${cfg.headers['Strict-Transport-Security']}`);
}

// Everything else the config declares, compared verbatim.
for (const [name, value] of Object.entries(cfg.headers)) {
  if (name === 'Strict-Transport-Security') continue;
  const served = got(name.toLowerCase());
  ok(served === value, `${name} is served exactly as configured`,
     `served: ${served === null ? '(absent)' : served}\n      expected: ${value}`);
}

console.log(`\n1..${n}`);
if (bad) {
  console.error(`FAILED ${bad} of ${n} — the headers in this repository are NOT enforced at ${target}`);
  // process.exitCode, NOT process.exit(). Calling process.exit() here tore down the
  // event loop while the fetch's libuv handles were still closing, and Node on Windows
  // aborted with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` and exit code
  // 127 instead of 1. A CI step gating on `exit 1` would have read that as an
  // infrastructure error rather than a failed assertion — or, with a looser check, as
  // something other than the failure it is. Setting exitCode lets the loop drain.
  process.exitCode = 1;
} else {
  console.log(`All ${n} assertions passed — the policy is enforced at ${target}.`);
}
