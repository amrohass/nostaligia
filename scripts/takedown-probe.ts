/* §8, timed against the DEPLOYED system: "takedown removes bytes in < 1 min".
 *
 * WHY A SYNTHETIC POST. Takedown is irreversible — it deletes the archival master. Running
 * it against real content to time it would destroy the thing being audited, so this puts
 * throwaway bytes at throwaway keys behind a throwaway post, publishes it, and takes THAT
 * down. Everything measured is the real deployed path: the real Edge Function, a real
 * moderator's token, the real buckets, the real CDN, the real redactions.json.
 *
 * WHAT IT MEASURES, and why each half matters:
 *   · the objects are gone      — §8 step 1, the only step that actually protects anybody
 *   · the master is gone too    — a takedown that spares originals/ has removed nothing
 *   · the prerendered page      — §8's 21 Aug amendment: the one object with a human
 *                                 audience, and the reason takedown deletes rather than
 *                                 replaces it with a tombstone
 *   · redactions.json lists it  — §8 step 3, what the client filters against before the
 *                                 next publish rewrites the shards
 *   · elapsed wall clock        — the < 1 min budget
 *
 * The post row is deliberately left behind for the caller to clean up: there is no DELETE
 * policy on posts for anyone (by design), and a probe that quietly deletes rows as postgres
 * would be exercising a path the application does not have.
 *
 *   deno run --allow-read --allow-env --allow-net scripts/takedown-probe.ts <post-uuid>
 */

import { presignR2 } from '../supabase/functions/_shared/sigv4.ts';

const POST = Deno.args[0];
if (!POST) {
  console.error('usage: takedown-probe.ts <post-uuid>');
  Deno.exit(1);
}

const cfg = JSON.parse(Deno.readTextFileSync('config/site.json'));
const ANON = cfg.supabase.anon_key;
const SUPABASE = 'https://' + cfg.domains.supabase;
const CDN = 'https://' + cfg.domains.cdn;
const ORIGIN = 'https://nostaligia.pages.dev';

const MODERATOR = 'e2e-moderator-a4ef7ef7-3dfe-4c0b-a339-d37f3c2ee745@mail.example.com';
const PASSWORD = 'e2e-deployed-harness-password-1';

function readDevVars(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of Deno.readTextFileSync(path).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = readDevVars('supabase/functions/.dev.vars');

async function signed(bucket: string, key: string, method: 'GET' | 'PUT' | 'HEAD') {
  return await presignR2({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket, key, method, expiresIn: 300,
    bucketPrefix: env.R2_BUCKET_PREFIX ?? '',
  });
}

const OBJECTS: Array<[string, string]> = [
  ['originals', 'takedown-probe/master.bin'],
  ['public', `${POST}/display.webp`],
  ['public', `${POST}/thumb.webp`],
];

let bad = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? 'ok    ' : 'NOT OK'}  ${m}`); if (!c) bad++; };

// ── 1 · put throwaway bytes at the keys the database already names ──────────
const body = new TextEncoder().encode('takedown-01\n');
for (const [bucket, key] of OBJECTS) {
  const p = await signed(bucket, key, 'PUT');
  const r = await fetch(p.url, { method: 'PUT', body });
  if (!r.ok) { console.error(`could not seed ${bucket}/${key}: ${r.status}`); Deno.exit(1); }
}
console.log(`seeded ${OBJECTS.length} objects\n`);

// Confirm they are actually there before timing their removal — otherwise "gone in 2s" is
// a statement about objects that never existed.
for (const [bucket, key] of OBJECTS) {
  const r = await fetch((await signed(bucket, key, 'HEAD')).url, { method: 'HEAD' });
  ok(r.status === 200, `BEFORE: ${bucket}/${key.slice(0, 46)} exists (${r.status})`);
}

const pageUrl = `${CDN}/item/${POST}/index.html`;
const pageBefore = await fetch(pageUrl, { method: 'HEAD' });
console.log(`  --      BEFORE: prerendered page ${pageBefore.status}` +
  (pageBefore.status === 200 ? '' : ' (not published yet — the page assertion is skipped)'));

// ── 2 · take it down, as a real moderator ───────────────────────────────────
const auth = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: MODERATOR, password: PASSWORD }),
});
const session = await auth.json();
if (!session.access_token) { console.error('moderator sign-in failed'); Deno.exit(1); }

const t0 = Date.now();
const td = await fetch(`${SUPABASE}/functions/v1/takedown`, {
  method: 'POST',
  headers: {
    apikey: ANON,
    Authorization: `Bearer ${session.access_token}`,
    'Content-Type': 'application/json',
    Origin: ORIGIN,
  },
  body: JSON.stringify({ post_id: POST, reason: 'audit probe — 31 Aug 2026' }),
});
const result = await td.json();
const callMs = Date.now() - t0;

console.log(`\n  takedown responded ${td.status} in ${callMs} ms`);
console.log(`  ${JSON.stringify(result)}\n`);

/* 200/ok is the answer on a deployment with a purge token; 207 with reason
   `cdn_not_purged` is the answer without one, and it is the CORRECT answer — the function
   refusing to call a takedown complete when §8 step 2 did not happen. Both are accepted
   here; what is NOT accepted is `objects_remain`, which means bytes survived. */
ok((td.status === 200 && result.ok === true) ||
   (td.status === 207 && result.reason === 'cdn_not_purged'),
  `the deployed function accepted a moderator's takedown (${td.status} ${result.reason ?? 'ok'})`);
ok(Array.isArray(result.failed) && result.failed.length === 0,
  `no object was left behind — failed: ${JSON.stringify(result.failed)}`);

// ── 3 · the bytes ───────────────────────────────────────────────────────────
for (const [bucket, key] of OBJECTS) {
  const r = await fetch((await signed(bucket, key, 'HEAD')).url, { method: 'HEAD' });
  ok(r.status === 404, `AFTER: ${bucket}/${key.slice(0, 46)} is GONE (${r.status})`);
}
for (const [, key] of OBJECTS.filter(([b]) => b === 'public')) {
  const r = await fetch(`${CDN}/${key}`, { method: 'HEAD' });
  ok(r.status === 404, `AFTER: CDN 404 for ${key.slice(0, 46)}`);
}
if (pageBefore.status === 200) {
  const r = await fetch(pageUrl, { method: 'HEAD' });
  ok(r.status === 404, `AFTER: the prerendered item page is deleted (${r.status})`);
}

// ── 4 · redactions.json ─────────────────────────────────────────────────────
const red = await (await fetch(`${CDN}/redactions.json?cb=${Date.now()}`)).json();
ok(Array.isArray(red.ids) && red.ids.includes(POST),
  `redactions.json lists the post (${JSON.stringify(red).slice(0, 120)})`);

const totalMs = Date.now() - t0;
ok(totalMs < 60000, `everything above completed in ${(totalMs / 1000).toFixed(1)} s — §8's budget is 60 s`);

// ── 5 · the CDN purge, reported rather than assumed ─────────────────────────
console.log(`\n  cdn_purged=${result.cdn_purged}  cdn_reason=${result.cdn_reason}`);
if (result.cdn_purged !== true) {
  console.log('  ^ §8 step 2 is a no-op on this deployment. Harmless while the origin is');
  console.log('    r2.dev (no edge cache, and the 404s above were immediate); a real hole');
  console.log('    the day a cached custom domain goes in front of R2.');
}

console.log(`\n${bad === 0 ? 'takedown removes the bytes within budget' : bad + ' check(s) FAILED'}`);
Deno.exit(bad === 0 ? 0 : 1);
