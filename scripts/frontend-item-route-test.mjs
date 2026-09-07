// The /item/* Pages Function — the route that makes a shared link carry OG tags.
//
//     node scripts/frontend-item-route-test.mjs
//
// ── Why this file exists ─────────────────────────────────────
//
// CLAUDE.md §9: "A diaspora archive spreads on WhatsApp — a blank preview card is a growth
// failure, not a polish issue." §2 recorded the missing route from 21 Aug and it stayed
// missing for eighteen days, because nothing anywhere could see it: the prerendered HTML was
// correct on R2 the whole time, the SPA rendered the item correctly for a person, and the
// only thing wrong was invisible unless you fetched the page as a crawler would.
//
// The failure mode this guards is worse than a broken route. A Pages Function that does not
// MATCH is silent: `/item/<id>` keeps serving the SPA shell exactly as it did before, with a
// 200 and a page that looks right. There is no error anywhere. So the assertions below are
// about what the function does with a path, and every "it serves the page" has a "and it
// does NOT touch this one" beside it.
//
// The function is GENERATED (scripts/build-site-config.mjs). This imports the generated
// artefact rather than a copy, so a generator change that breaks the route fails here.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FN = join(root, 'functions/item/[[path]].js');

let passed = 0;
let failed = 0;
const results = [];

function ok(cond, msg, detail) {
  if (cond) { passed++; results.push(`ok ${passed + failed} - ${msg}`); }
  else { failed++; results.push(`not ok ${passed + failed} - ${msg}${detail ? `\n#   ${detail}` : ''}`); }
}

const { onRequest } = await import(pathToFileURL(FN).href);
const source = readFileSync(FN, 'utf8');

const ID = '6deebace-9767-4919-866f-986b8b6a26a2';
const PAGE = '<!doctype html><meta property="og:title" content="x"><title>x</title>';

/**
 * Drive the function with a stubbed upstream.
 *
 * `next()` returns a sentinel so "fell through to the SPA" is distinguishable from "served
 * something" — the two are the same 200 in production, which is exactly what makes a
 * non-matching route invisible there.
 */
async function call(path, { method = 'GET', status = 200, body = PAGE, cache = 'public, max-age=300, must-revalidate', throws = false } = {}) {
  const fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetched.push(String(url));
    if (throws) throw new Error('unreachable');
    return new Response(status === 404 ? 'nope' : body, {
      status,
      headers: cache ? { 'Cache-Control': cache, 'Content-Type': 'text/html' } : {},
    });
  };
  try {
    const res = await onRequest({
      request: new Request(`https://ramallahnostalgia.org${path}`, { method }),
      next: async () => new Response('SPA_SHELL', { status: 200, headers: { 'X-Stub': 'spa' } }),
    });
    return { res, fetched, text: await res.clone().text() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── The route matches what it should ─────────────────────────

{
  const { res, fetched, text } = await call(`/item/${ID}`);
  ok(res.status === 200, 'an /item/<uuid> URL is answered 200');
  ok(text.includes('og:title'), '...with the PRERENDERED page, not the SPA shell', text.slice(0, 60));
  ok(fetched.length === 1 && fetched[0].endsWith(`/item/${ID}/index.html`),
     '...fetched from the archive origin at the documented key', fetched[0]);
}

{
  // The trailing slash is the shape the canonical link and every prerendered page use.
  const { res, text } = await call(`/item/${ID}/`);
  ok(res.status === 200 && text.includes('og:title'), 'a trailing slash is the same page');
}

{
  const { res } = await call(`/item/${ID.toUpperCase()}`);
  ok(res.status === 200, 'an uppercase uuid still resolves — a link is not case-normalised by the sender');
}

// ── ...and does not match what it should not ─────────────────
//
// Each of these is a path that must reach the SPA. A function that matched them would break
// routes that work today, and it would do it on the one page a stranger is most likely to
// open.

for (const [path, why] of [
  ['/', 'the root'],
  ['/map', 'another SPA route'],
  ['/items', 'a prefix that merely starts the same way'],
  ['/item', 'the bare segment with no id'],
  ['/item/', 'the bare segment with a slash'],
  ['/item/not-a-uuid', 'a non-uuid id'],
  ['/item/6deebace-9767-4919-866f-986b8b6a26a2/extra', 'a deeper path under a valid id'],
  ['/item/../assets/js/config.js', 'a traversal attempt'],
  [`/item/${ID}%2f..%2f..%2fsecret`, 'an encoded traversal attempt'],
]) {
  const { text, fetched } = await call(path);
  ok(text === 'SPA_SHELL', `${path} falls through to the SPA (${why})`, `got: ${text.slice(0, 40)}`);
  ok(fetched.length === 0, `...and fetches NOTHING upstream for it`, fetched.join(','));
}

// ── §2's takedown answer ─────────────────────────────────────
//
// "a link to an item the archive no longer has answers 404 from R2 rather than reaching the
// SPA — which is the correct answer for a takedown and is why the page is deleted rather
// than replaced with a tombstone." Falling through here would put a taken-down item back in
// front of whoever still holds the link.

{
  const { res, text } = await call(`/item/${ID}`, { status: 404 });
  ok(res.status === 404, 'a deleted page answers 404 — §8, and it must NOT fall through');
  ok(text !== 'SPA_SHELL', '...the SPA never sees a taken-down item through this route');
  ok(!!res.headers.get('Content-Security-Policy'), '...and the 404 still carries the policy');
}

// ── Degrading rather than failing ────────────────────────────

{
  const { text } = await call(`/item/${ID}`, { throws: true });
  ok(text === 'SPA_SHELL',
     'an unreachable archive degrades to the SPA — the item still renders for a person');
}

{
  const { text } = await call(`/item/${ID}`, { status: 500 });
  ok(text === 'SPA_SHELL', 'so does a 5xx from the archive');
}

// ── §6: the headers a Function must set itself ───────────────
//
// site/_headers is the static asset server's file and does NOT apply to a Function's
// response. Without the block the generator inlines, the single HTML page most likely to be
// opened from an untrusted link would be the one page served with no CSP.

{
  const { res } = await call(`/item/${ID}`);
  const csp = res.headers.get('Content-Security-Policy') || '';
  ok(csp.includes("default-src 'none'"), 'the served page carries the CSP');
  ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"),
     '...and it is the §6 policy, not a loosened one');
  ok(res.headers.get('Strict-Transport-Security')?.includes('max-age=31536000'), 'HSTS is set');
  ok(res.headers.get('X-Content-Type-Options') === 'nosniff', 'nosniff is set');
  ok(res.headers.get('Content-Type') === 'text/html; charset=utf-8', 'it is served as HTML');
  ok(res.headers.get('Cache-Control') === 'public, max-age=300, must-revalidate',
     "the publisher's short TTL is preserved — §2(a), these pages are rewritten every publish");
}

{
  const { res } = await call(`/item/${ID}`, { method: 'HEAD' });
  ok(res.status === 200 && (await res.text()) === '', 'HEAD is answered with headers and no body');
}

for (const method of ['POST', 'PUT', 'DELETE']) {
  const { text } = await call(`/item/${ID}`, { method });
  ok(text === 'SPA_SHELL', `${method} is not this route's business`);
}

// ── The generated artefact itself ────────────────────────────

ok(source.includes('DO NOT EDIT'), 'the function is generated, and says so');
ok(!/ARCHIVE = ""/.test(source),
   'the archive origin is not empty — an empty one makes every /item/ link fall through silently');
ok(!source.includes('unsafe-inline'), 'no forbidden CSP source reached the generated file');

// ── Output ───────────────────────────────────────────────────

console.log(results.join('\n'));
console.log(`1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${passed} assertions passed.`);
