/* §6's bucket invariants, checked against the REAL buckets rather than inferred from a 404.
 *
 * WHY THIS EXISTS. The 29 Aug closeout could only say this about M1's exit criterion:
 * "originals/* paths 404 through the public CDN origin, which is consistent with correct
 * bucket bindings and also consistent with the object simply not existing." That is the
 * whole problem — the reassuring measurement and the alarming one look identical from
 * outside. Proving the master is THERE and NOT PUBLIC needs a signed request to the
 * private bucket, which is what this does.
 *
 * For every media_assets row it checks, in both directions:
 *
 *   bucket='originals'  → signed HEAD says 200 and the byte count matches the database
 *                       → public CDN says 404
 *   bucket='public'     → public CDN says 200 and the byte count matches the database
 *
 * and it checks that the quarantine bucket holds no object for a post that finished
 * ingesting — §6 says the working copy is removed, and a quarantine that quietly
 * accumulates originals is an archive paying to store the same bytes three times.
 *
 * CREDENTIALS. Read from supabase/functions/.dev.vars into memory and never printed. The
 * pair there is object-scoped (it answers AccessDenied to GetBucketCors), which is correct
 * least privilege and is enough for a HEAD.
 *
 *   deno run --allow-read --allow-env --allow-net scripts/r2-invariants.ts
 *
 * Takes the asset list on stdin as JSON: [{post,bucket,role,storage_path,bytes}, ...]
 * so the database query stays in one place (scripts/lib has no database client and this
 * file deliberately does not become one).
 */

import { presignR2 } from '../supabase/functions/_shared/sigv4.ts';

const CDN = 'https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev';

/* Parsed rather than sourced: .dev.vars is a KEY=VALUE file, not a shell script, and
   `export`ing it would put live secrets in this process's environment for anything else to
   read. Values go into locals and are never logged. */
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
for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  if (!env[k]) {
    console.error(`${k} is not set in supabase/functions/.dev.vars — refusing to report an invariant it did not check`);
    Deno.exit(1);
  }
}

async function signedHead(bucket: string, key: string): Promise<Response> {
  const p = await presignR2({
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket,
    key,
    method: 'HEAD',
    expiresIn: 60,
    bucketPrefix: env.R2_BUCKET_PREFIX ?? '',
  });
  return await fetch(p.url, { method: 'HEAD' });
}

interface Asset {
  post: string;
  bucket: string;
  role: string;
  storage_path: string;
  bytes: number | null;
}

const assets: Asset[] = JSON.parse(new TextDecoder().decode(await new Response(Deno.stdin.readable).arrayBuffer()));
if (assets.length === 0) {
  console.error('no assets on stdin — refusing to report every invariant green over nothing');
  Deno.exit(1);
}

let bad = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`  ${cond ? 'ok    ' : 'NOT OK'}  ${msg}`);
  if (!cond) bad++;
};

console.log('§6 bucket invariants, against the real buckets\n');

for (const a of assets) {
  const label = `${a.post.slice(0, 8)} ${a.role.padEnd(9)}`;

  if (a.bucket === 'originals') {
    const r = await signedHead('originals', a.storage_path);
    const len = Number(r.headers.get('content-length') ?? -1);
    ok(r.status === 200, `${label} master EXISTS in originals/ (signed HEAD ${r.status})`);
    ok(a.bytes === null || len === a.bytes,
      `${label} master is byte-for-byte the upload (db ${a.bytes}, r2 ${len})`);

    const pub = await fetch(`${CDN}/${a.storage_path}`, { method: 'HEAD' });
    ok(pub.status === 404, `${label} master is NOT CDN-reachable (${pub.status})`);
  } else {
    const pub = await fetch(`${CDN}/${a.storage_path}`, { method: 'HEAD' });
    const len = Number(pub.headers.get('content-length') ?? -1);
    ok(pub.status === 200, `${label} derivative is CDN-reachable (${pub.status})`);
    ok(a.bytes === null || len === a.bytes,
      `${label} derivative byte count matches the database (db ${a.bytes}, cdn ${len})`);
  }
}

/* CONTROL. Every assertion above is a status code, and a signer that produced a URL R2
   rejects for an unrelated reason would report "master does not exist" for all of them at
   once — which reads as a catastrophic finding rather than a broken probe. A key that
   certainly does not exist must come back 404, not 401/403: that separates "the signature
   works and the object is absent" from "the signature does not work". */
const ctl = await signedHead('originals', 'this-key-does-not-exist-' + crypto.randomUUID());
ok(ctl.status === 404,
  `CONTROL: the signer reaches originals/ and a truly absent key is 404, not ${ctl.status} — so the 200s above mean the objects are there`);

/* Quarantine must not retain the working copy of anything that finished ingesting. */
for (const a of assets.filter((x) => x.bucket === 'originals')) {
  const q = await signedHead('quarantine', a.storage_path);
  ok(q.status === 404, `${a.post.slice(0, 8)} quarantine copy removed after processing (${q.status})`);
}

console.log(`\n${bad === 0 ? 'all invariants hold' : bad + ' invariant(s) FAILED'}`);
Deno.exit(bad === 0 ? 0 : 1);
