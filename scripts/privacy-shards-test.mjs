#!/usr/bin/env node
/* §7's boundary, asserted against what a visitor can actually download.
 *
 *     node scripts/privacy-shards-test.mjs
 *     node scripts/privacy-shards-test.mjs --release /v/2026-09-01T20:43:26Z/
 *
 * ── Why this is the highest-severity suite in the project ────
 *
 * §7: "The aggregate is more dangerous than any single item: one identity plus full
 * contribution history plus precise coordinates plus timestamps is a de-anonymisation
 * vector." Every other failure in this repository costs somebody an afternoon. A raw
 * coordinate in a published shard costs a contributor their home address, permanently,
 * to anyone who downloaded the file before it was noticed — and shards are immutable and
 * CDN-cached for a year.
 *
 * The properties below are all enforced somewhere in SQL or in the publisher, and every
 * one of them has a unit test. What nothing had was a test of the ARTEFACT: the bytes on
 * the CDN, fetched with no credential, checked against the database's own raw values. A
 * projection that is correct in `publishable_posts()` and a shard that is correct are
 * different facts, and the gap between them is one migration or one edit to shards.ts.
 *
 * ── Non-vacuity, which is the whole difficulty ───────────────
 *
 * "No raw coordinate appears in any shard" passes trivially against an archive that has no
 * coordinates. So the ground truth is read from the database FIRST, and the run REFUSES to
 * report a pass unless it found something to look for: at least one published post with a
 * raw location that differs from its published one, at least one 'hidden' post, and at
 * least one address to hunt. A suite that cannot fail is reported as red, not green.
 *
 * Section F does the same for visibility, which the live archive exercises not at all:
 * every profile on it is public. Those fixtures are built inside transactions that are
 * ROLLED BACK, and the rollback is itself asserted — a probe that turned a real
 * contributor private and then reported success would be the worst outcome this file
 * could have.
 *
 * Nothing here writes to the deployed system. Reads only, plus rolled-back transactions.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CDN, ROOT } from './lib/harness-auth.mjs';

const RELEASE_ARG = process.argv.includes('--release')
  ? process.argv[process.argv.indexOf('--release') + 1]
  : null;

let executed = 0;
const failures = [];
function ck(cond, msg, detail) {
  executed++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures.push(msg);
}
const section = (n, title) => console.log(`\n${n} · ${title}`);

/* ── Postgres, for the ground truth only ────────────────────── */

function sql(text) {
  const tmp = join(ROOT, `.privacy-probe-${process.pid}.sql`);
  writeFileSync(tmp, text, 'utf8');
  try {
    const out = execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32'
        ? ['/c', 'npx', 'supabase', 'db', 'query', '--linked', '-f', tmp]
        : ['-c', `npx supabase db query --linked -f ${JSON.stringify(tmp)}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 },
    );
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    if (first < 0) return [];
    return JSON.parse(out.slice(first, last + 1)).rows ?? [];
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/* ── The release, as a signed-out visitor downloads it ──────── */

const bust = () => `cb=${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Fetched with NO headers at all. §2 promises zero database reads for a public visitor,
    and the anon key is still a credential — a shard that needs one is already a defect. */
async function grab(url) {
  const res = await fetch(url.includes('?') ? `${url}&${bust()}` : `${url}?${bust()}`, { headers: {} });
  if (!res.ok) return null;
  return res.text();
}

console.log(`\n§7's boundary, against the published artefact`);
console.log(`  cdn ${CDN}`);

const manifest = JSON.parse(await grab(`${CDN}/manifest.json`) ?? '{}');
const RELEASE = (RELEASE_ARG ?? manifest.release ?? '').replace(/\/?$/, '/');
console.log(`  release ${RELEASE || 'NONE'}\n`);
if (!RELEASE) {
  console.error('no active release — nothing to check. Refusing to report a pass.');
  process.exit(1);
}

const base = `${CDN}${RELEASE}`;

/* ── Ground truth from the database ─────────────────────────── */

section('A', 'the ground truth, read before anything is checked');

const posts = sql(`
  select
    p.id::text as id,
    p.status::text as status,
    p.takedown,
    p.ingest_state::text as ingest_state,
    p.location_precision::text as precision,
    st_y(p.location::geometry)::text        as raw_lat,
    st_x(p.location::geometry)::text        as raw_lon,
    st_y(p.location_public::geometry)::text as pub_lat,
    st_x(p.location_public::geometry)::text as pub_lon,
    p.created_by::text as created_by,
    p.created_at::text as created_at
  from public.posts p order by p.created_at;
`);

const identities = sql(`
  select u.email, u.id::text as id, coalesce(pr.handle, '') as handle
  from auth.users u left join public.profiles pr on pr.id = u.id;
`);

const published = posts.filter((p) =>
  p.status === 'approved' && p.takedown === false && p.ingest_state === 'ready');

/** A raw coordinate is only interesting if publishing it would say something the fuzzed
    one does not. Equal values are not evidence of a leak and not evidence of safety. */
const leakable = published.filter((p) =>
  p.raw_lat && (p.raw_lat !== p.pub_lat || p.raw_lon !== p.pub_lon));
const hidden = published.filter((p) => p.precision === 'hidden');

ck(posts.length > 0, `${posts.length} posts in the database, ${published.length} publishable`);
ck(identities.length > 0, `${identities.length} identities, each with an email address to hunt for`);
ck(leakable.length > 0,
   `${leakable.length} published post(s) whose RAW location differs from the published one`,
   'without one of these, "no raw coordinate appears" is a vacuous pass and this run is not evidence');
ck(hidden.length > 0, `${hidden.length} published post(s) at location_precision='hidden'`);

/* ── Download the whole release ─────────────────────────────── */

section('B', 'the whole release, downloaded with no credential of any kind');

const index = JSON.parse(await grab(`${base}index.json`) ?? '{}');
ck(Array.isArray(index.decades) && Array.isArray(index.cells),
   `index.json lists ${index.decades?.length ?? 0} decade(s) and ${index.cells?.length ?? 0} geo cell(s)`);

/** path -> text. Every byte a visitor can reach, in one place, so a scan cannot miss a kind. */
const files = new Map();
const add = async (path) => {
  const body = await grab(`${base}${path}`);
  if (body !== null) files.set(path, body);
  return body;
};

for (let i = 1; i <= (index.pages ?? 1); i++) await add(`feed/page-${i}.json`);
for (const d of index.decades ?? []) await add(`decade/${d}.json`);
for (const c of index.cells ?? []) await add(`geo/${c}.json`);
await add('content.json');
await add('places.json');

const feedIds = new Set();
const handles = new Set();
for (const [path, text] of files) {
  if (!path.startsWith('feed/') && !path.startsWith('decade/') && !path.startsWith('geo/')) continue;
  for (const item of (JSON.parse(text).items ?? [])) {
    feedIds.add(item.id);
    if (item.author?.handle) handles.add(item.author.handle);
  }
}
for (const id of feedIds) await add(`item/${id}.json`);
for (const h of handles) await add(`profile/${h.toLowerCase()}.json`);

/* The prerendered pages live at the bucket ROOT, outside the release (§2's amendment),
   and they are HTML rather than JSON — a leak scan that only reads the release misses
   exactly the artefact people paste into group chats. */
const pages = new Map();
for (const id of feedIds) {
  const html = await grab(`${CDN}/item/${id}/index.html`);
  if (html !== null) pages.set(`item/${id}/index.html`, html);
}
const redactions = await grab(`${CDN}/redactions.json`);

ck(files.size > 0, `${files.size} shard(s) downloaded`);
ck(feedIds.size > 0, `${feedIds.size} item(s) in the feed`);
ck(pages.size === feedIds.size,
   `${pages.size} prerendered page(s) — one per published item`,
   pages.size < feedIds.size ? 'a published item with no page is a blank WhatsApp card (§9)' : '');
ck(redactions !== null, `redactions.json is served`);

/** Everything a visitor can read, as one corpus. */
const corpus = [...files, ...pages].map(([p, t]) => ({ path: p, text: t }))
  .concat(redactions === null ? [] : [{ path: 'redactions.json', text: redactions }]);

/* ── C · the coordinate boundary ────────────────────────────── */

section('C', '§7 — publish location_public, NEVER location');

{
  /* The full stored precision, and the shortened forms a naive rounding would produce.
     `31.90492` is the tell; `31.905` is the fuzzed value and must be allowed. */
  for (const p of leakable) {
    for (const [label, raw, pub] of [['latitude', p.raw_lat, p.pub_lat], ['longitude', p.raw_lon, p.pub_lon]]) {
      const hits = corpus.filter((f) => f.text.includes(raw));
      ck(hits.length === 0,
         `${p.id.slice(0, 8)} — the raw ${label} ${raw} appears in NO published file`,
         hits.length ? `FOUND IN: ${hits.map((h) => h.path).join(', ')}` : '');
      /* And the fuzzed one IS there, or the item is publishing no location at all and the
         check above passed for the wrong reason. */
      const pubHits = corpus.filter((f) => f.text.includes(pub));
      ck(pubHits.length > 0,
         `and the FUZZED ${label} ${pub} is what got published instead`,
         pubHits.length ? '' : 'neither value is in any shard — the assertion above proves nothing');
    }
  }
}

{
  /* location_precision='hidden' must publish no coordinates AT ALL — not a fuzzed point,
     not a null-valued key with a shape that invites one back. */
  for (const p of hidden) {
    const shard = files.get(`item/${p.id}.json`);
    if (!shard) { ck(false, `${p.id.slice(0, 8)} — hidden post has no item shard to check`); continue; }
    const obj = JSON.parse(shard);
    ck(obj.location === null || obj.location === undefined,
       `${p.id.slice(0, 8)} at precision='hidden' publishes NO coordinates`,
       `location = ${JSON.stringify(obj.location)}`);
  }
}

{
  /* Every coordinate that IS published must trace to a location_public in the database.
     This is the check that catches a NEW shard kind leaking what the old ones do not —
     a number nobody put there on purpose has no row to match. */
  const allowed = new Set();
  for (const p of posts) {
    if (p.pub_lat) { allowed.add(p.pub_lat); allowed.add(p.pub_lon); }
  }
  for (const pl of sql(`select st_y(location::geometry)::text as lat, st_x(location::geometry)::text as lon
                        from public.places where location is not null;`)) {
    /* Gazetteer points are public by construction — places.json exists to publish them
       (§2's M4 amendment), and §7 says a gazetteer point protects nobody by being fuzzed. */
    allowed.add(pl.lat); allowed.add(pl.lon);
  }

  const stray = [];
  for (const f of corpus) {
    if (f.path.endsWith('.html')) continue;   // OG tags carry no coordinates; checked below
    for (const m of f.text.matchAll(/"(?:lat|lon|latitude|longitude)"\s*:\s*(-?\d+\.?\d*)/g)) {
      if (!allowed.has(m[1])) stray.push(`${f.path}: ${m[0]}`);
    }
  }
  ck(stray.length === 0,
     `every coordinate in the release traces to a location_public or a gazetteer row`,
     stray.slice(0, 6).join('\n        '));
}

/* ── D · emails, ids and timestamps ─────────────────────────── */

section('D', '§7 — emails are never published, and public times are day-precision');

{
  const addresses = identities.map((i) => i.email).filter(Boolean);
  const found = [];
  for (const f of corpus) {
    for (const a of addresses) if (f.text.includes(a)) found.push(`${f.path}: ${a}`);
  }
  ck(found.length === 0,
     `none of the ${addresses.length} real addresses appears in any shard or prerendered page`,
     found.slice(0, 5).join('\n        '));

  /* And nothing else email-SHAPED either — an address belonging to somebody who is not in
     auth.users (typed into a bio, pasted into a comment) is the same disclosure. */
  const shaped = [];
  for (const f of corpus) {
    for (const m of f.text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
      /* schema.org and OG markup legitimately carry no addresses; a site contact address
         in content.json is an editorial decision an admin made and is allowed. */
      if (f.path === 'content.json') continue;
      shaped.push(`${f.path}: ${m[0]}`);
    }
  }
  ck(shaped.length === 0,
     `and nothing email-SHAPED appears anywhere outside content.json`,
     shaped.slice(0, 5).join('\n        '));
}

{
  /* §7: "Public timestamps are day-precision. Never expose exact submission times." A
     shard carrying `created_at` to the second re-introduces the correlation vector the
     `day` field exists to remove. */
  const stamped = [];
  for (const f of corpus) {
    if (f.path.endsWith('.html')) continue;
    for (const m of f.text.matchAll(/"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)) stamped.push(`${f.path}: ${m[0]}`);
  }
  ck(stamped.length === 0,
     `no shard carries a time-of-day timestamp — only day-precision dates`,
     stamped.slice(0, 5).join('\n        '));
}

{
  /* An auth user id is not secret the way an email is, but it is the join key between an
     archive identity and every other table, and §7's aggregate argument applies to it. */
  const ids = identities.map((i) => i.id);
  const found = [];
  for (const f of corpus) for (const id of ids) if (f.text.includes(id)) found.push(`${f.path}: ${id}`);
  ck(found.length === 0,
     `no auth user id appears in any published file — the archive names people by handle`,
     found.slice(0, 5).join('\n        '));
}

/* ── E · bidi, on the now-unmoderated comment path ──────────── */

section('E', '§6 — bidi controls, the only filter left in front of a comment');

{
  const BIDI = /[‪-‮⁦-⁩]/g;
  const found = [];
  for (const f of corpus) {
    for (const m of f.text.matchAll(BIDI)) {
      found.push(`${f.path}: U+${m[0].codePointAt(0).toString(16).toUpperCase()}`);
    }
  }
  ck(found.length === 0,
     `no bidi control character reaches any published file`,
     found.slice(0, 5).join('\n        '));

  /* Non-vacuity: the strip function must actually strip, proved against a string that
     carries every one of them. §1's amendment makes this the ONLY filter between a
     hostile string and a shard, so "it happens to be clean today" is not the claim. */
  const [probe] = sql(`
    select public.strip_bidi(
      'a' || chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238) ||
      chr(8294) || chr(8295) || chr(8296) || chr(8297) || 'b') as stripped;
  `);
  ck(probe?.stripped === 'ab',
     `strip_bidi() removes all nine controls (got ${JSON.stringify(probe?.stripped)})`);
}

/* ── F · profiles.visibility, from three vantage points ─────── */

section('F', '§7 — profiles.visibility, enforced rather than described');

/* Both probes below run inside ONE rolled-back transaction each, and simulate PostgREST
   exactly (`set local role` + `request.jwt.claims`) rather than going over HTTP. Two
   reasons, and the second is the important one:
     · the live archive has no private profile, and a test that needs one must not create
       one on a deployed system whose whole subject is contributor privacy;
     · a vantage point is a role plus a claim, and this is the only way to occupy three of
       them against the same row in the same instant. Over HTTP the row would have to be
       mutated between requests, which is the thing being avoided.
   `visibility` must carry EXACTLY the four keys is_valid_visibility() names — bio,
   personalInfo, contributions, comments — each 'public' or 'private'. An earlier draft
   sent three and was refused by the check constraint, which is the constraint doing its
   job and is why the shape is written out here rather than assumed. */

const PRIVATE = `'{"bio":"private","personalInfo":"private","contributions":"private","comments":"private"}'::jsonb`;

{
  /* F1 — a hidden list is an EMPTY list in the file, not the list with a flag beside it.
     §2's amendment says so explicitly, and the difference is whether the data left the
     building at all. */
  const rows = sql(`
    begin;
    update public.profiles
       set visibility = ${PRIVATE}, bio = 'A BIO THAT MUST NOT BE PUBLISHED'
     where id = (select created_by from public.posts
                  where status='approved' and not takedown and ingest_state='ready'
                  order by created_at limit 1);

    select
      pr.handle,
      (item ->> 'bio')                 as shard_bio,
      (item ->> 'show_contributions')  as show_contributions,
      (item ->> 'show_comments')       as show_comments,
      pr.bio                           as stored_bio
    from public.profiles pr
    cross join lateral (
      select value as item from jsonb_array_elements(public.publishable_profiles())
       where value ->> 'handle' = pr.handle
    ) s
    where pr.visibility ->> 'bio' = 'private';
  `);
  ck(rows.length > 0, `a fully private profile has a publishable projection to inspect`,
     rows.length ? '' : 'nothing to check — this section proves nothing without a row');
  for (const r of rows) {
    ck(r.stored_bio === 'A BIO THAT MUST NOT BE PUBLISHED',
       `${r.handle}: the fixture really does have a bio to leak`);
    ck(r.shard_bio === null,
       `${r.handle}: a private bio is NULL in the shard, not present-with-a-flag`,
       `stored ${JSON.stringify(r.stored_bio)}, shard says ${JSON.stringify(r.shard_bio)}`);
    ck(r.show_contributions === 'false', `${r.handle}: show_contributions is false`);
    ck(r.show_comments === 'false', `${r.handle}: show_comments is false`);
  }
}

{
  /* F2 — the three vantage points §7 distinguishes, each asked the way the front end
     really asks. 0057 added profile provisioning; the visibility half has never been
     tested from any vantage.

     THE SIGNED-OUT VISITOR DOES NOT CALL profile_view AT ALL, and finding that out is
     half of what this section is worth. 0058 revokes EXECUTE from `anon` on purpose, and
     public.js only calls it when `own || state.signedIn`; a stranger's browser reads
     profile/{handle}.json instead. §2's promise is zero database reads for a public
     visitor, so "anon gets null from the function" would be testing a path that does not
     exist. The assertion is the REFUSAL, plus what the shard gives them instead.

     The subject is resolved in a first query and its handle and uid become literals in
     the rest. Two earlier drafts carried them in temp tables and both died on scaffolding
     rather than on the thing under test — 42501 because a temp table is not readable by
     `anon`, then 42P01 after the role switches. When the work list can be a literal,
     make it one. */
  const [subject] = sql(`
    select pr.id::text as owner_id, pr.handle as handle
      from public.profiles pr
     where pr.handle is not null
     order by pr.created_at limit 1;
  `);
  ck(!!subject?.handle, `a profile to probe: ${subject?.handle}`);

  const H = String(subject.handle).replace(/'/g, "''");

  /** One vantage, one transaction. A role switch inside a longer batch is what the earlier
      drafts kept tripping over, and three small probes read more plainly than one clever
      one. Returns { bio } or { error } — the refusal is a result here, not a crash. */
  const vantage = (setup, visibility) => {
    try {
      const out = sql(`
        begin;
        update public.profiles
           set visibility = ${visibility}, bio = 'PRIVATE BIO FIXTURE'
         where id = '${subject.owner_id}';
        ${setup}
        select (public.profile_view('${H}')).bio as bio;
      `);
      return { bio: out[0]?.bio ?? null };
    } catch (e) {
      /* 200 chars truncated the function name out of the middle of the refusal and the
         regex below stopped matching — the check failed while the system was correct.
         Keep enough of it to read. */
      return { error: String(e.stdout ?? e.message).slice(0, 600) };
    }
  };

  const AS_ANON = `set local role anon;`;
  const AS_OTHER = `set local role authenticated;
     set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}';`;
  const AS_OWNER = `set local role authenticated;
     set local request.jwt.claims = '{"sub":"${subject.owner_id}","role":"authenticated"}';`;

  const anonRes = vantage(AS_ANON, PRIVATE);
  ck(/permission denied for function profile_view/.test(anonRes.error ?? ''),
     `a SIGNED-OUT visitor cannot call profile_view AT ALL — 0058 revokes it from anon`,
     `got ${JSON.stringify(anonRes)}`);

  const otherRes = vantage(AS_OTHER, PRIVATE);
  ck(otherRes.bio === null,
     `a DIFFERENT member calls it and gets NO bio when visibility is private`,
     `got ${JSON.stringify(otherRes)}`);

  const ownerRes = vantage(AS_OWNER, PRIVATE);
  ck(ownerRes.bio === 'PRIVATE BIO FIXTURE',
     `the OWNER sees their own — private means unpublished, not deleted (§7)`,
     `got ${JSON.stringify(ownerRes)}`);

  /* Non-vacuity for this section specifically: flip the same field to public and the same
     different-member call must now RETURN it. Without this, the refusal above could be a
     function that answers null to everyone and all three assertions would be worthless. */
  const PUBLIC_BIO = `'{"bio":"public","personalInfo":"private","contributions":"public","comments":"public"}'::jsonb`;
  const otherPublic = vantage(AS_OTHER, PUBLIC_BIO);
  ck(otherPublic.bio === 'PRIVATE BIO FIXTURE',
     `and with visibility PUBLIC the same member DOES get the bio — the switch is what governs`,
     `got ${JSON.stringify(otherPublic)}`);

  /* And what the signed-out visitor gets instead: the shard, with the bio already removed
     at publish time rather than present-with-a-flag. That is F1's assertion arriving from
     the other side, and it is the whole of anon's profile experience. */
  const anonShard = files.get(`profile/${String(subject.handle).toLowerCase()}.json`);
  if (anonShard) {
    const shard = JSON.parse(anonShard);
    ck(!('visibility' in shard),
       `the profile shard carries NO visibility map — the settings are applied, not shipped`,
       `keys: ${Object.keys(shard).join(', ')}`);
    ck(shard.bio === null || typeof shard.bio === 'string',
       `and its bio is a string or null, never an object with a flag beside it`);
  } else {
    ck(true, `(${subject.handle} has no published shard — it has contributed nothing yet)`);
  }
}

{
  /* The rollbacks actually happened. A probe that turned a real contributor's profile
     private and then reported success would be the worst outcome this file could have. */
  const after = sql(`select count(*) as n from public.profiles
                      where visibility ->> 'bio' = 'private'
                         or bio in ('PRIVATE BIO FIXTURE', 'A BIO THAT MUST NOT BE PUBLISHED');`);
  ck(Number(after[0]?.n ?? -1) === 0,
     `and both transactions rolled back — nothing on the deployed project was changed`,
     `${after[0]?.n} row(s) still carry a fixture value; if this is not 0 the probe MUTATED production`);
}

/* ── done ──────────────────────────────────────────────────── */

console.log(`\n${executed} checks, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('OK.\n');
