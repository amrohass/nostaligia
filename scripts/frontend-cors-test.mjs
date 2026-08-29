// Does the front end's request survive the Edge Functions' CORS preflight?
//
// This exists because of a failure that nothing in the repository could have caught on
// 29 Aug 2026: upload.js sent `apikey` on every functions/v1 fetch, and
// _shared/http.ts granted only `authorization, content-type`. The browser fails a
// preflight whose Access-Control-Allow-Headers does not cover every header the request
// carries, and it fails it BEFORE the request reaches the function — so `fetch()` rejects
// with a bare TypeError, upload.js maps every TypeError to `up.err.offline`, and the
// member is told "لا يوجد اتصال" — there is no connection. Uploading was impossible on
// the deployed site for as long as that mismatch stood.
//
// Nothing pointed at the header line. The ORIGIN allowlist was correct and answered
// correctly; `curl -X OPTIONS` returned 204 with the right Allow-Origin, because curl is
// told the rules and does not enforce them. Only a browser enforces this.
//
// So: a two-way ratchet between what the client SENDS and what the server GRANTS.
//   - a header the client sends that the server does not grant  → the bug above, failed
//   - a header the server grants that no client sends           → the allowlist is
//     drifting permissive and describing code that no longer exists
//
//     node scripts/frontend-cors-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let n = 0, bad = 0;
const ok = (cond, msg) => {
  n++;
  console.log(`${cond ? 'ok' : 'not ok'} ${n} - ${msg}`);
  if (!cond) bad++;
};

// ── Reading a balanced argument list ────────────────────────────────────────
// Regex cannot match nested braces, and the header block is nested two deep inside the
// fetch init object. This walks the source with just enough string awareness not to be
// fooled by a brace inside a quoted value.
function balanced(src, open) {
  const pairs = { '(': ')', '{': '}' };
  const close = pairs[src[open]];
  let depth = 0, quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === src[open]) depth++;
    else if (c === close && --depth === 0) return src.slice(open, i + 1);
  }
  return '';
}

// ── What the front end sends to functions/v1 ────────────────────────────────
const sends = new Map();   // header (lowercase) → files that send it

for (const file of readdirSync(join(root, 'site/assets/js')).filter((f) => f.endsWith('.js'))) {
  const src = readFileSync(join(root, 'site/assets/js', file), 'utf8');
  if (!src.includes('functions/v1')) continue;

  // A functions/v1 URL is sometimes built into a variable first (admin.js does), so the
  // fetch argument names an identifier rather than the path. Collect those names.
  const vars = new Set();
  for (const m of src.matchAll(/\b(?:var|let|const)\s+(\w+)\s*=\s*([^;\n]*functions\/v1[^;\n]*)/g)) {
    vars.add(m[1]);
  }

  for (const m of [...src.matchAll(/\bfetch\s*\(/g)]) {
    const args = balanced(src, m.index + m[0].length - 1);
    const urlArg = args.slice(1, args.indexOf(',') === -1 ? args.length : args.indexOf(','));
    const targetsFunctions = urlArg.includes('functions/v1') ||
      [...vars].some((v) => new RegExp(`\\b${v}\\b`).test(urlArg));
    if (!targetsFunctions) continue;

    const h = args.indexOf('headers');
    if (h === -1) continue;
    const block = balanced(args, args.indexOf('{', h));
    for (const k of block.matchAll(/(?:^|[{,])\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z][\w-]*))\s*:/g)) {
      const name = (k[1] || k[2] || k[3]).toLowerCase();
      if (!sends.has(name)) sends.set(name, new Set());
      sends.get(name).add(file);
    }
  }
}

// CONTROL first. Every assertion below compares two sets, and comparing two EMPTY sets
// succeeds — so before trusting any of them, prove the extractor above actually found the
// call sites. If this fails, nothing after it means anything.
ok(sends.has('apikey') && sends.get('apikey').has('upload.js'),
   'CONTROL: the extractor finds upload.js sending `apikey` — so the ratchet can fail');
ok(sends.size >= 3,
   `CONTROL: at least three request headers found across the front end (found ${sends.size}: ${[...sends.keys()].join(', ')})`);

// ── What the Edge Functions grant ───────────────────────────────────────────
// Read from the exported constant rather than the response string: the point is that the
// two cannot drift, and parsing the value the header is built FROM is what makes this
// test fail when someone edits the list rather than when someone edits the formatting.
const httpTs = readFileSync(join(root, 'supabase/functions/_shared/http.ts'), 'utf8');
const decl = httpTs.match(/export const ALLOWED_REQUEST_HEADERS\s*=\s*(\[[^\]]*\])/);
ok(!!decl, 'CONTROL: ALLOWED_REQUEST_HEADERS is exported from _shared/http.ts and parseable');

const grants = new Set(
  decl ? [...decl[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1].toLowerCase()) : []
);

ok(grants.has('authorization') && grants.has('content-type'),
   'CONTROL: the parsed allowlist contains the headers it has always contained');

// ── The ratchet ─────────────────────────────────────────────────────────────
const ungranted = [...sends.keys()].filter((h) => !grants.has(h));
const unsent = [...grants].filter((h) => !sends.has(h));

ok(ungranted.length === 0,
   ungranted.length
     ? `a header the front end SENDS is not in Access-Control-Allow-Headers — the browser ` +
       `will fail the preflight and the member will be told "no connection": ` +
       ungranted.map((h) => `${h} (from ${[...sends.get(h)].join(', ')})`).join(', ')
     : 'every header the front end sends to functions/v1 is granted by the preflight');

ok(unsent.length === 0,
   unsent.length
     ? `Access-Control-Allow-Headers grants a header nothing sends — delete it from ` +
       `ALLOWED_REQUEST_HEADERS rather than leaving the allowlist describing the past: ` +
       unsent.join(', ')
     : 'the preflight grants nothing the front end does not send');

console.log(`\n1..${n}`);
if (bad) { console.error(`FAILED ${bad} of ${n}`); process.exit(1); }
console.log(`All ${n} assertions passed.`);
