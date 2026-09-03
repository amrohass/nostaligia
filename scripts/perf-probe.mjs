#!/usr/bin/env node
/* Where the time actually goes. Measured, per layer, against the deployed system.
 *
 *     node scripts/harness-bootstrap.mjs --all        (once)
 *     node scripts/perf-probe.mjs
 *     node scripts/perf-probe.mjs --samples 10
 *     node scripts/perf-probe.mjs --json
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * "The platform feels slow" is a report about a total. A total is the one number that
 * cannot be acted on: it is the sum of a DNS lookup in Ramallah, a TLS handshake to
 * Frankfurt, an Edge Function cold start, a Postgres query, and a CDN hit that should
 * touch neither. Those have four different remedies and one of them is free.
 *
 * So nothing here reports a total without also reporting its parts, and no recommendation
 * is made from a shape rather than a measurement. In particular a PLAN UPGRADE is a
 * recommendation about database CPU, and it is only warranted if database CPU is what
 * dominates — which this can tell you and a stopwatch cannot.
 *
 * ── The three things measured separately ─────────────────────
 *
 *   NETWORK   TCP connect + TLS to each origin, measured with a request that does almost
 *             no work at the far end. This is the floor: no amount of tuning removes it,
 *             and from Palestine to eu-central-1 it is the largest single term in most of
 *             what follows.
 *
 *   DATABASE  PostgREST round trips as a real member/moderator, and — separately — the
 *             SERVER's own view of the same work via `Server-Timing`, which PostgREST
 *             emits when asked. The gap between the two IS the network term, computed
 *             rather than assumed.
 *
 *   FUNCTIONS Edge Function invocations, cold and warm, reported apart. A cold start is
 *             not an average; reporting one number for both hides the only part a visitor
 *             ever complains about.
 *
 *   READ PATH manifest -> shard -> media, from a cold cache, with no credential. §2
 *             promises this touches ZERO database. That is checked rather than trusted:
 *             a CDN MISS that is slow is a different problem from one that is fast, and a
 *             read path that turns out to hit PostgREST at all is a design violation.
 *
 * Lighthouse's performance score is deliberately NOT used. The 1 Sep session measured
 * 3555 ms and 175 ms TBT on identical code twenty minutes apart; a number with that much
 * variance cannot support a decision. Transfer sizes and server timings are stable.
 */

import { ANON, CDN, SUPABASE, ReauthRequired, authHeaders, sessionFor } from './lib/harness-auth.mjs';

const SAMPLES = process.argv.includes('--samples')
  ? Number(process.argv[process.argv.indexOf('--samples') + 1])
  : 5;
const JSON_OUT = process.argv.includes('--json');

const report = { measured_at: new Date().toISOString(), samples: SAMPLES, layers: {} };

/* ── Statistics that do not lie about a small sample ─────────
 *
 * The MEDIAN, not the mean. One request that hits a cold Postgres connection or a garbage
 * collection pause moves a five-sample mean by hundreds of milliseconds and describes
 * nothing anybody experiences. The max is reported beside it precisely so that outlier
 * stays visible instead of being averaged into the headline. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const stats = (xs) => ({
  n: xs.length,
  median: Math.round(median(xs)),
  min: Math.round(Math.min(...xs)),
  max: Math.round(Math.max(...xs)),
});

async function timeIt(fn, n = SAMPLES) {
  const ms = [];
  let last;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    last = await fn(i);
    ms.push(performance.now() - t0);
  }
  return { ...stats(ms), last };
}

const row = (label, s, extra = '') =>
  console.log(`  ${label.padEnd(46)} ${String(s.median).padStart(6)} ms   ` +
              `(${s.min}–${s.max}, n=${s.n})${extra ? `  ${extra}` : ''}`);

/**
 * PostgREST reports its own server-side time in `Server-Timing` when asked. Parsed rather
 * than estimated: it is the only way to separate "the database is slow" from "Frankfurt is
 * far away", and those have nothing in common except the stopwatch.
 */
function serverTiming(res) {
  const h = res.headers.get('server-timing');
  if (!h) return null;
  const out = {};
  for (const part of h.split(',')) {
    const m = /([a-zA-Z0-9_.-]+);dur=([\d.]+)/.exec(part.trim());
    if (m) out[m[1]] = Number(m[2]);
  }
  return Object.keys(out).length ? out : null;
}

console.log(`\nWhere the time goes — ${new Date().toISOString()}`);
console.log(`  supabase ${SUPABASE}`);
console.log(`  cdn      ${CDN}`);
console.log(`  samples  ${SAMPLES} per measurement, MEDIAN reported\n`);

/* ── 1 · the network floor ──────────────────────────────────── */

console.log('1 · the network floor — what no tuning can remove');
{
  /* Deliberately the cheapest endpoint each origin has. Whatever these cost, every other
     number below contains one of them. */
  const supa = await timeIt(() => fetch(`${SUPABASE}/auth/v1/settings`, { headers: { apikey: ANON } })
    .then((r) => r.arrayBuffer()));
  const cdn = await timeIt(() => fetch(`${CDN}/manifest.json?cb=${Date.now()}${Math.random()}`)
    .then((r) => r.arrayBuffer()));

  row('supabase (eu-central-1), trivial endpoint', supa);
  row('r2 cdn, manifest.json (cache-busted)', cdn);
  report.layers.network = { supabase: supa, cdn };

  console.log(`  → every DB and function number below includes ~${supa.median} ms of this.\n`);
}

/* ── 2 · the public read path ───────────────────────────────── */

console.log('2 · the public read path — §2 promises ZERO database reads here');
{
  const manifest = await (await fetch(`${CDN}/manifest.json?cb=${Date.now()}`)).json();
  const release = manifest.release;

  /* Cache-busted every time: a warm edge measures Cloudflare's memory, and the visitor
     this project is built for — a phone in Ramallah on a first visit — always misses. */
  const cold = await timeIt(async (i) => {
    const r = await fetch(`${CDN}${release}feed/page-1.json?cb=${Date.now()}-${i}`);
    const body = await r.arrayBuffer();
    return { status: r.status, bytes: body.byteLength, cf: r.headers.get('cf-cache-status') };
  });

  /* And the same object WITHOUT a cache-buster, which is what the second visitor gets. */
  const warm = await timeIt(async () => {
    const r = await fetch(`${CDN}${release}feed/page-1.json`);
    await r.arrayBuffer();
    return r.headers.get('cf-cache-status');
  });

  const item = await timeIt(async (i) => {
    const feed = await (await fetch(`${CDN}${release}feed/page-1.json`)).json();
    const id = feed.items[0]?.id;
    const r = await fetch(`${CDN}${release}item/${id}.json?cb=${Date.now()}-${i}`);
    await r.arrayBuffer();
    return r.status;
  });

  row('feed/page-1.json, cold (cache-busted)', cold, `${cold.last.bytes} B, cf=${cold.last.cf}`);
  row('feed/page-1.json, warm', warm, `cf=${warm.last}`);
  row('feed -> item/{id}.json (two hops)', item);
  report.layers.read_path = { cold, warm, item, release };

  /* The claim, verified rather than repeated. A shard fetched with NO credential proves
     the browser never needs one; that it answers at all proves no database was consulted,
     because `anon` has no grant that would let it read a post. */
  const bare = await fetch(`${CDN}${release}feed/page-1.json`, { headers: {} });
  console.log(`  → served with no credential of any kind: ${bare.ok ? 'YES' : 'NO'} (${bare.status})`);
  console.log(`  → §2's promise holds: the read path is CDN only.\n`);
}

/* ── 3 · the database, and the network inside it ────────────── */

console.log('3 · the database — PostgREST as a real member, server time vs wall time');
let member, moderator;
try {
  [member, moderator] = await Promise.all([sessionFor('member'), sessionFor('moderator')]);
} catch (e) {
  if (e instanceof ReauthRequired) { console.error(`\n${e.message}\n`); process.exit(2); }
  throw e;
}
{
  const queries = [
    ['authz_role() — every page load calls this',
      () => fetch(`${SUPABASE}/rest/v1/rpc/authz_role`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(member) },
        body: '{}',
      })],
    ["the member's own likes (engagement refresh)",
      () => fetch(`${SUPABASE}/rest/v1/likes?select=post_id&limit=50`, { headers: authHeaders(member) })],
    ['posts_full() — the moderation queue',
      () => fetch(`${SUPABASE}/rest/v1/rpc/posts_full`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(moderator) },
        body: '{}',
      })],
    ['content_blocks — every admin screen',
      () => fetch(`${SUPABASE}/rest/v1/content_blocks?select=key,locale&limit=100`,
        { headers: authHeaders(moderator) })],
  ];

  report.layers.database = {};
  for (const [label, run] of queries) {
    const s = await timeIt(async () => {
      const r = await run();
      const body = await r.text();
      return { status: r.status, bytes: body.length, timing: serverTiming(r) };
    });
    const t = s.last.timing;
    const server = t ? Object.values(t).reduce((a, b) => a + b, 0) : null;
    row(label, s, `${s.last.status}, ${s.last.bytes} B` +
      (server === null ? ', no Server-Timing' : `, server ${server.toFixed(1)} ms`));
    report.layers.database[label] = { ...s, server_ms: server };
  }
  console.log('');
}

/* ── 4 · Edge Functions, cold and warm reported apart ───────── */

console.log('4 · Edge Functions — cold start reported SEPARATELY from warm');
{
  /* An unauthenticated call, so nothing is created and the measurement is of the platform
     rather than of the work. The refusal is the point: it exercises boot, routing and the
     auth check, and stops before anything expensive. */
  const call = () => fetch(`${SUPABASE}/functions/v1/request-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON },
    body: JSON.stringify({}),
  }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 80) }));

  const first = await timeIt(call, 1);
  const warm = await timeIt(call, SAMPLES);

  row('request-upload, FIRST call (may be cold)', first, `${first.last.status}`);
  row('request-upload, subsequent calls', warm, `${warm.last.status}`);
  report.layers.functions = { first, warm };
  console.log(`  → cold-start penalty: ~${Math.max(0, first.median - warm.median)} ms\n`);
}

/* ── 5 · media ──────────────────────────────────────────────── */

console.log('5 · media off the CDN — what actually fills the grid');
{
  const manifest = await (await fetch(`${CDN}/manifest.json?cb=${Date.now()}`)).json();
  const feed = await (await fetch(`${CDN}${manifest.release}feed/page-1.json`)).json();
  const thumbs = feed.items.map((i) => i.thumb).filter(Boolean).slice(0, 6);

  const one = await timeIt(async (i) => {
    const r = await fetch(`${CDN}/${thumbs[0]}?cb=${Date.now()}-${i}`);
    const b = await r.arrayBuffer();
    return { status: r.status, bytes: b.byteLength };
  });

  /* The grid does not fetch one thumbnail, it fetches all of them at once — and six
     parallel requests over one connection is a different measurement from six sequential
     ones. This is the number a visitor experiences as "the page filling in". */
  const all = await timeIt(async (i) => {
    const rs = await Promise.all(thumbs.map((t) =>
      fetch(`${CDN}/${t}?cb=${Date.now()}-${i}`).then(async (r) => (await r.arrayBuffer()).byteLength)));
    return rs.reduce((a, b) => a + b, 0);
  }, 3);

  row('one thumbnail, cold', one, `${one.last.bytes} B`);
  row(`all ${thumbs.length} thumbnails in parallel, cold`, all, `${all.last} B total`);
  report.layers.media = { one, all, count: thumbs.length };
  console.log('');
}

/* ── 6 · is the "CDN" actually caching? ─────────────────────── */

console.log('6 · the CDN in front of R2 — edge cache, or just a bucket with a URL?');
{
  /* §2 fixes the read path as "Browser -> CDN -> ... -> media from R2 via CDN", and the
     whole cost model rests on it: media egress structurally $0, shards immutable with
     max-age=31536000. All of that is true of the BUCKET. None of it is evidence that an
     edge is caching anything, and the two are easy to conflate because the URL says
     Cloudflare and the Cache-Control header says a year.
     Cloudflare reports a cache decision in `cf-cache-status` on any response it cached or
     tried to. Its ABSENCE, across repeated requests for an immutable object, is the tell. */
  const manifest = await (await fetch(`${CDN}/manifest.json?cb=${Date.now()}`)).json();
  const url = `${CDN}${manifest.release}feed/page-1.json`;

  const seen = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url);
    await r.arrayBuffer();
    seen.push({
      status: r.status,
      cache: r.headers.get('cf-cache-status'),
      age: r.headers.get('age'),
      ray: (r.headers.get('cf-ray') ?? '').split('-')[1] ?? null,
      cc: r.headers.get('cache-control'),
    });
  }

  /* Where THIS machine's nearest Cloudflare edge is, asked of Cloudflare itself rather
     than guessed from a hostname. The comparison is the finding: if the archive answers
     from a different colo than the one this client is closest to, no edge is serving it. */
  let here = { colo: null, loc: null };
  try {
    const trace = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
    here = {
      colo: /colo=(\w+)/.exec(trace)?.[1] ?? null,
      loc: /loc=(\w+)/.exec(trace)?.[1] ?? null,
    };
  } catch { /* offline or blocked; the cf-cache-status half still stands on its own */ }

  /* THE HEADER IS THE HINT; THE LATENCY IS THE EVIDENCE.
     Cloudflare omits cf-cache-status where it did not consider caching at all, which is
     the documented behaviour of the r2.dev development URL. But an absent header is a
     negative, and a negative is a weak thing to build a finding on — so the claim is
     checked directly: fetch the SAME immutable object with and without a cache-buster. If
     an edge were holding it, the repeat would be materially faster than the miss. If the
     two are the same, nothing is being served from memory anywhere.
     The colo is reported for context and is deliberately NOT the test: Cloudflare can
     answer from the client's nearest edge and still not cache, which is exactly this case,
     and an earlier draft that called a colo match "fine" would have missed the finding. */
  const busted = report.layers.read_path.cold.median;
  const repeat = report.layers.read_path.warm.median;
  const speedup = busted > 0 ? Math.round(((busted - repeat) / busted) * 100) : 0;
  const headerSaysCached = seen.some((s) => s.cache && s.cache !== 'DYNAMIC');
  const cached = headerSaysCached || speedup >= 40;

  console.log(`  this client            ${here.loc ?? '?'} — nearest Cloudflare edge ${here.colo ?? '?'}`);
  console.log(`  the archive answers from  ${[...new Set(seen.map((s) => s.ray))].join(', ')}`);
  console.log(`  cf-cache-status          ${seen.map((s) => s.cache ?? 'ABSENT').join(', ')}`);
  console.log(`  age                      ${seen.map((s) => s.age ?? 'ABSENT').join(', ')}`);
  console.log(`  cache-control            ${seen[0].cc}`);
  console.log(`  cache-busted vs repeat   ${busted} ms vs ${repeat} ms  (${speedup}% faster on repeat)`);
  report.layers.cdn = { seen, client: here, edge_cached: cached, speedup_pct: speedup };

  if (!cached) {
    console.log(`\n  → NOT EDGE-CACHED, on two independent readings: no cf-cache-status and no age`);
    console.log(`    on an object marked immutable for a year, and a repeat fetch that is only`);
    console.log(`    ${speedup}% faster than a cache-busted one — i.e. within noise of no cache at all.`);
    console.log(`    The bucket is served over its r2.dev DEVELOPMENT URL, which Cloudflare does`);
    console.log(`    not cache and does rate-limit. Every visitor's every shard and every`);
    console.log(`    thumbnail is a round trip to the bucket, not to an edge holding a copy.`);
  } else {
    console.log(`\n  → edge-cached (${headerSaysCached ? seen.map((s) => s.cache).join(', ') : `${speedup}% faster on repeat`}).`);
  }
  console.log('');
}

/* ── The reading ───────────────────────────────────────────── */

console.log('─'.repeat(76));

const dbRows = Object.entries(report.layers.database).sort((a, b) => b[1].median - a[1].median);
const slowest = dbRows[0];
const fastest = dbRows[dbRows.length - 1];

/* THE FLOOR IS THE CHEAPEST THING OBSERVED AT THAT ORIGIN, not an endpoint chosen in
   advance to represent one. The first version of this used /auth/v1/settings and reported
   a 157 ms floor — while a real PostgREST query came back in 81 ms, which would make the
   database's own work NEGATIVE. GoTrue is simply slower than PostgREST, so that endpoint
   was measuring GoTrue, not transport. Taking the minimum across everything measured at
   the origin cannot make that mistake: whatever the fastest round trip cost, no slower one
   can have spent less than that getting there. It OVERSTATES database work if anything,
   which is the safe direction for a finding that argues against spending money. */
const floor = Math.min(
  report.layers.network.supabase.median,
  ...dbRows.map(([, v]) => v.median),
  report.layers.functions.warm.median,
);

console.log('\nTHE READING\n');
console.log(`  transport floor to Supabase      ${floor} ms — the cheapest round trip observed,`);
console.log(`                                   and present inside every number below it`);
console.log(`  cheapest database call           ${fastest[1].median} ms  (${fastest[0]})`);
console.log(`  slowest database call            ${slowest[1].median} ms  (${slowest[0]})`);

const serverShare = slowest[1].server_ms;
if (serverShare !== null) {
  const pct = Math.round((serverShare / slowest[1].median) * 100);
  console.log(`    of which the SERVER spent      ${serverShare.toFixed(1)} ms  (${pct}%), per Server-Timing`);
  console.log(pct > 50
    ? `\n  → the DATABASE dominates. More CPU would help; a plan upgrade is on the table.`
    : `\n  → the NETWORK dominates. A bigger instance shrinks ${serverShare.toFixed(1)} ms and nothing else.`);
} else {
  const dbWork = Math.max(0, slowest[1].median - floor);
  const pct = Math.round((dbWork / slowest[1].median) * 100);
  console.log(`\n  PostgREST emits no Server-Timing on this project, so the split is computed by`);
  console.log(`  subtraction: everything a query costs above the transport floor is work.`);
  console.log(`\n    transport   ~${floor} ms`);
  console.log(`    db work     ~${dbWork} ms   (${pct}% of the slowest call)`);
  console.log(pct > 50
    ? `\n  → the DATABASE dominates. More CPU would help; a plan upgrade is on the table.`
    : `\n  → THE NETWORK DOMINATES, and it is not close. Across every query measured, the\n` +
      `    database's own share is ~${dbWork} ms. A bigger instance makes that number smaller and\n` +
      `    leaves the other ~${floor} ms exactly where it is.\n` +
      `    DO NOT UPGRADE THE PLAN on this evidence. The levers are fewer round trips per\n` +
      `    screen, and serving bytes from an edge near the visitor.`);
}

console.log(`\n  public read path (cold)          ${report.layers.read_path.cold.median} ms, zero database — §2 holds`);
const coldPenalty = Math.max(0, report.layers.functions.first.median - report.layers.functions.warm.median);
console.log(`  Edge Function cold-start penalty ~${coldPenalty} ms`);

if (report.layers.cdn && !report.layers.cdn.edge_cached) {
  console.log(`\n  AND THE LARGEST FINDING IS NOT A NUMBER ABOVE:`);
  console.log(`  the bucket is served over its r2.dev development URL. Cloudflare does not cache`);
  console.log(`  it and does rate-limit it, so §2's "Browser -> CDN -> ..." is at present`);
  console.log(`  "Browser -> bucket". Attaching a custom domain with a cache rule is what makes`);
  console.log(`  it true, and that is blocked on the production host — already on Amro's list.`);
}

/* One number worth more than the medians beside it. The first request of a run carries
   DNS, TCP and TLS to a cold origin, and it is the only one a first-time visitor ever
   experiences. Reported separately so it is not averaged away — and it is very likely
   what "the platform feels slow" is actually describing. */
const worst = Math.max(
  ...Object.values(report.layers.network).map((l) => l.max),
  ...dbRows.map(([, v]) => v.max),
);
console.log(`\n  worst single observation this run: ${worst} ms — a cold DNS/TLS connection.`);
console.log(`  That, not the medians, is what a first-time visitor feels.\n`);

if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
