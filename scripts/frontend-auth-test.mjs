// Auth, Turnstile and the upload path — the parts that are checkable without a browser.
//
// Same technique as scripts/frontend-csp-test.mjs: the module is evaluated against a stub
// `window` and then poked. No jsdom, no test runner, no dependency — §9's no-build-step
// rule applies to the tests too, or the tests become the build step.
//
// ── What is worth asserting here ─────────────────────────────
//
// Not that sign-in works: that needs a real Supabase project and belongs in a manual pass.
// What belongs here are the invariants that fail SILENTLY and that a later refactor would
// happily undo:
//
//   · the access token is never written to storage. This is the §7 decision — it is one
//     `localStorage.setItem` away from being reversed by someone "fixing" the reload, and
//     nothing about the app would look different afterwards.
//   · every refusal the two Edge Functions can return has a message. An unmapped one
//     reaches the member as "something went wrong", which over a quota ceiling means they
//     retry the identical upload forever.
//   · a failed upload never reports success.
//   · the Turnstile token is reset after a failure, because it is single-use.
//
//     node scripts/frontend-auth-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertAnonKey } from './lib/anon-key.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}

// ── A stub window, built fresh per module ───────────────────────────────────
function makeWindow(overrides = {}) {
  const store = new Map();
  const localStore = new Map();
  const win = {
    CONFIG: {
      origins: { supabase: 'https://project.supabase.co', cdn: 'https://cdn.example' },
      supabase: { anonKey: 'stub-anon-key' },
      turnstile: { siteKey: '0xTEST' }
    },
    sessionStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    localStorage: {
      getItem: k => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => localStore.set(k, String(v)),
      removeItem: k => localStore.delete(k)
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    fetch: () => Promise.reject(new Error('no fetch stubbed')),
    _session: store,
    _local: localStore,
    ...overrides
  };
  return win;
}

function load(relPath, win) {
  const src = readFileSync(join(root, relPath), 'utf8');
  new Function('window', src)(win);
  return win;
}

/** A base64url JWT with the given payload. Signature is not checked by anything here. */
function jwt(payload) {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.c2ln`;
}

const okJson = body => Promise.resolve({
  ok: true, status: 200, json: () => Promise.resolve(body)
});
const errJson = (status, body) => Promise.resolve({
  ok: false, status, json: () => Promise.resolve(body)
});

const SESSION = {
  access_token: 'ACCESS-TOKEN-VALUE',
  refresh_token: 'REFRESH-TOKEN-VALUE',
  expires_in: 3600,
  user: { id: 'u1', email: 'a@b.test', app_metadata: { user_role: 'member' } }
};

console.log('# auth.js — where the session lives');

// ── 1 · the §7 decision, asserted rather than commented ─────────────────────
{
  const win = makeWindow({ fetch: () => okJson(SESSION) });
  load('site/assets/js/auth.js', win);
  await win.AUTH.signIn('a@b.test', 'pw');

  const everything = [...win._local.entries(), ...win._session.entries()]
    .map(([k, v]) => `${k}=${v}`).join('\n');

  ok(!everything.includes('ACCESS-TOKEN-VALUE'),
     'the access token is never written to any storage');
  ok(win._local.size === 0,
     'localStorage is untouched — nothing survives the browser closing');
  ok(everything.includes('REFRESH-TOKEN-VALUE'),
     'the refresh token IS persisted, so a reload does not sign the member out');
  ok(win._session.get('rma.refresh') === 'REFRESH-TOKEN-VALUE',
     '...in sessionStorage, so it dies with the tab');
  ok(win.AUTH._debug.hasAccessTokenInMemory(),
     'and the access token is held in memory, where it can still be used');
}

// ── 2 · sign-out really clears it ───────────────────────────────────────────
{
  const win = makeWindow({ fetch: () => okJson(SESSION) });
  load('site/assets/js/auth.js', win);
  await win.AUTH.signIn('a@b.test', 'pw');
  await win.AUTH.signOut();

  ok(win._session.get('rma.refresh') === null || win._session.get('rma.refresh') === undefined,
     'signing out removes the refresh token');
  ok(!win.AUTH._debug.hasAccessTokenInMemory(), '...and the in-memory access token');
  ok(win.AUTH.user() === null, '...and the user');
}

// ── 3 · refusals are mapped, never echoed ───────────────────────────────────
{
  const cases = [
    [400, { error_code: 'invalid_credentials' }, 'auth.err.credentials'],
    [422, { error_code: 'email_exists' }, 'auth.err.emailTaken'],
    [422, { error_code: 'weak_password' }, 'auth.err.weakPassword'],
    [429, { error_code: 'over_request_rate_limit' }, 'auth.err.rateLimit'],
    [400, { msg: 'Invalid login credentials' }, 'auth.err.credentials'],
    [429, {}, 'auth.err.rateLimit'],
    [500, { msg: 'internal database error: relation posts does not exist' }, 'auth.err.generic']
  ];
  let allMapped = true;
  let leaked = false;
  for (const [status, body, expected] of cases) {
    const win = makeWindow({ fetch: () => errJson(status, body) });
    load('site/assets/js/auth.js', win);
    const err = await win.AUTH.signIn('a@b.test', 'pw').then(() => null, e => e);
    if (!err || err.key !== expected) allMapped = false;
    if (err && /relation posts/.test(err.key)) leaked = true;
  }
  ok(allMapped, 'every Auth API refusal maps to a message key');
  ok(!leaked, "...and the server's own text never becomes the message");
}

// ── 4 · an unconfigured deployment says so ──────────────────────────────────
{
  const win = makeWindow({ fetch: () => okJson(SESSION) });
  win.CONFIG.supabase.anonKey = '';
  load('site/assets/js/auth.js', win);
  const err = await win.AUTH.signIn('a@b.test', 'pw').then(() => null, e => e);
  ok(err && err.key === 'auth.err.notConfigured',
     'a missing anon key is named, not left to look like a wrong password');
}

// ── 5 · concurrent refreshes are coalesced ──────────────────────────────────
// Supabase rotates the refresh token on use, so a second concurrent refresh replays a
// token that no longer exists — and signs the member out mid-session.
{
  let calls = 0;
  const win = makeWindow({
    fetch: () => { calls++; return okJson(SESSION); }
  });
  load('site/assets/js/auth.js', win);
  win.sessionStorage.setItem('rma.refresh', 'R1');
  await Promise.all([win.AUTH.accessToken(), win.AUTH.accessToken(), win.AUTH.accessToken()]);
  ok(calls === 1, 'three simultaneous token requests produce ONE refresh, not three');
}

console.log('# upload.js — the refusal map');

// ── 6 · exhaustive against what the functions actually emit ─────────────────
// Read from the Edge Function sources rather than listed here: a list maintained by hand
// goes stale the moment a refusal is added, and it goes stale in the silent direction.
{
  const win = makeWindow();
  load('site/assets/js/upload.js', win);

  const sources = [
    'supabase/functions/request-upload/handler.ts',
    'supabase/functions/complete-upload/handler.ts'
  ].map(p => readFileSync(join(root, p), 'utf8')).join('\n');

  const emitted = new Set();
  // fail("name", …), abandon("name", …) — the rollback path emits through its own helper,
  // which the first version of this regex missed, reporting three live refusals as stale.
  for (const m of sources.matchAll(/\b(?:fail|abandon)\(\s*"([a-z_]+)"/g)) emitted.add(m[1]);
  for (const m of sources.matchAll(/reason === "([a-z_]+)"/g)) emitted.add(m[1]);
  /* Refusals that originate in the DATABASE and are passed through by name.
   *
   * claim_upload_slot's are read out of the migration that currently defines it, for the
   * reason the comment above gives about hand-maintained lists — that function has been
   * redefined four times, each time adding refusals (rights in 0032, the decade in 0047,
   * the place in 0049), and each time this list would have gone quietly stale. Reading the
   * file means a fifth definition is covered before anyone remembers this test exists.
   *
   * The rest are still named here because they come from several functions across several
   * migrations, and a scan wide enough to find them would also collect the publish lease's
   * refusals — which no browser ever sees, and every one of which would be reported as an
   * unmapped message the upload path is missing. */
  const migrationText = readFileSync(
    join(root, 'supabase/migrations/20260821150000_upload_location.sql'), 'utf8');
  // Sliced to claim_upload_slot's own body. The same migration also defines
  // set_post_location, whose refusals are a moderator's and reach this map through nothing
  // — scanning the whole file reports them as messages the upload path forgot.
  const claimSlot = migrationText.slice(
    migrationText.indexOf('create or replace function public.claim_upload_slot'),
    migrationText.indexOf('comment on function public.claim_upload_slot'));
  const fromSlot = [...claimSlot.matchAll(/'reason',\s*'([a-z_]+)'/g)].map(m => m[1]);
  ok(fromSlot.length > 8,
     `CONTROL: claim_upload_slot's own refusals were found in its migration (${fromSlot.length})`);
  for (const name of fromSlot) emitted.add(name);

  for (const name of ['quota_exceeded',
                      'duplicate_object_key', 'invalid_object_key', 'unknown_object',
                      'terminal_state', 'too_many_attempts', 'unauthenticated']) {
    emitted.add(name);
  }

  const unmapped = [...emitted].filter(name => !(name in win.UPLOAD._refusals));
  ok(unmapped.length === 0,
     `every refusal the Edge Functions emit has a message${unmapped.length ? ' — unmapped: ' + unmapped.join(', ') : ''}`);

  const stale = Object.keys(win.UPLOAD._refusals).filter(name => !emitted.has(name));
  ok(stale.length === 0,
     `and no message maps to a refusal that no longer exists${stale.length ? ' — stale: ' + stale.join(', ') : ''}`);

  // ── The licence vocabulary, against the one that binds ──────────────────
  // upload.js carries a copy so the sheet can render a dropdown before it has been
  // refused. The DATABASE decides. If the two drift, a member picks an option they were
  // offered and gets invalid_license back — a refusal on a value the form handed them,
  // which is the least explicable failure the upload path can produce.
  const migration = readFileSync(
    join(root, 'supabase/migrations/20260819100000_upload_rights.sql'), 'utf8');
  const declared = /c_licenses\s+constant\s+text\[\]\s*:=\s*array\[([^\]]*)\]/.exec(migration);
  const fromDb = declared
    ? [...declared[1].matchAll(/'([^']+)'/g)].map(m => m[1])
    : [];
  ok(fromDb.length > 0 && fromDb.join('|') === win.UPLOAD.LICENSES.join('|'),
     `the licence vocabulary matches migration 0032 (db: ${fromDb.join(', ') || 'NOT FOUND'})`);
}

console.log('# db.js — the bucket rule');

// ── 6b · §6: no originals path may become a CDN URL ─────────────────────────
// The rule is enforced where it counts — originals/ is not CDN-fronted, assertManifest
// refuses a mis-bucketed manifest, and 0023 decides who may read the row. This is the
// client-side statement of it, and it exists because the previous version was a bare
// `cdn + storage_path` that would have handed back a URL for whatever it was passed.
{
  const win = makeWindow();
  load('site/assets/js/db.js', win);

  const publicAsset = { bucket: 'public', storage_path: 'post-id/thumb.webp' };
  ok(win.DB.mediaUrl(publicAsset) === 'https://cdn.example/post-id/thumb.webp',
     'a public asset gets its CDN URL');

  ok(win.DB.mediaUrl({ bucket: 'originals', storage_path: 'uploader/abc' }) === null,
     'an originals asset gets null, never a CDN URL (section 6)');

  // The shapes a refactor actually produces: a role with no asset, a row that arrived
  // without the column selected, a bucket added later.
  for (const [asset, why] of [
    [null, 'a missing asset'],
    [undefined, 'an undefined asset'],
    [{ storage_path: 'x' }, 'a row whose bucket was not selected'],
    [{ bucket: 'quarantine', storage_path: 'x' }, 'a quarantine path'],
    [{ bucket: 'public' }, 'a public row with no path'],
    [{ bucket: 'public', storage_path: '' }, 'a public row with an empty path']
  ]) {
    ok(win.DB.mediaUrl(asset) === null, `...and so does ${why}`);
  }
}

// ── 6c · a PATCH that asks for `*` is a 403, every time ─────────────────────
//
// `Prefer: return=representation` makes PostgREST select the row it just wrote. With no
// `select=` that is `*`, and migration 0015 revoked table-level SELECT on posts — so the
// UPDATE succeeds, the representation is refused, and the whole request rolls back with
//
//     403 42501  permission denied for table posts
//
// It shipped in M1 and every test in this repository was blind to it: pgTAP asserts the
// same approval in SQL, where there is no representation, and this file stubs fetch. The
// lifecycle harness found it the first time a real moderator token met a real PostgREST.
//
// Two assertions, and the second is what makes the first mean something: a guard that
// refuses everything would satisfy "the bad shape is refused" on its own.
{
  const win = makeWindow();
  let requested = null;
  win.AUTH = { accessToken: () => Promise.resolve('token') };
  // db.js reads res.text(), not res.json() — it has to distinguish an empty body from a
  // JSON null. The shared okJson stub above only provides json(), so this block brings its
  // own rather than widening a helper five other blocks depend on.
  const okText = (body) => Promise.resolve({
    ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body))
  });
  win.fetch = (url) => { requested = url; return okText([{ id: 'x', status: 'approved' }]); };
  load('site/assets/js/db.js', win);

  let refused = null;
  await win.DB.patch('posts', 'id=eq.abc', { status: 'approved' })
    .then(() => {}, (e) => { refused = e; });
  ok(refused !== null && requested === null,
     'a PATCH with no select= is refused before it reaches the network');

  requested = null;
  // Caught rather than awaited bare. A guard that refuses EVERYTHING would otherwise reject
  // here, take the whole file down with an unhandled rejection, and lose the TAP output and
  // the count along with it — a crash is a failure, but it is not a legible one.
  let rows = null;
  await win.DB.patch('posts', 'id=eq.abc&select=id,status', { status: 'approved' })
    .then((r) => { rows = r; }, () => { rows = null; });
  ok(Array.isArray(rows) && requested !== null && requested.includes('select=id,status'),
     '...and one that names its columns goes through unchanged');
}

// ── 7 · every message key exists in BOTH languages ──────────────────────────
{
  const winI = makeWindow({
    document: { documentElement: { setAttribute() {} }, title: '' },
    location: { search: '', hash: '' },
    dispatchEvent() {}, CustomEvent: class {}
  });
  load('site/assets/js/i18n.js', winI);

  const winU = makeWindow();
  load('site/assets/js/upload.js', winU);
  const winA = makeWindow();
  load('site/assets/js/auth.js', winA);

  const keys = new Set(Object.values(winU.UPLOAD._refusals));
  for (const stage of ['probing', 'requesting', 'uploading', 'finishing', 'done']) {
    keys.add('up.stage.' + stage);
  }
  for (const k of ['auth.err.credentials', 'auth.err.emailTaken', 'auth.err.weakPassword',
                   'auth.err.rateLimit', 'auth.err.unconfirmed', 'auth.err.invalidEmail',
                   'auth.err.generic', 'auth.err.offline', 'auth.err.notConfigured',
                   'auth.err.signedOut', 'auth.confirmSent', 'auth.working',
                   'up.err.robotUnavailable', 'up.err.noFile',
                   // §7's rights block in the share sheet.
                   'share.fLicense', 'share.fLicenseNote', 'share.fProvenance',
                   'share.fProvenancePh', 'share.consent']) keys.add(k);
  // One label per licence, from the vocabulary itself — a licence added without a
  // translation would otherwise render as its own identifier.
  for (const id of winU.UPLOAD.LICENSES) keys.add('license.' + id);

  // R1's strings, and the whole location_precision enum with them. The dashboard renders
  // `t('precision.' + row.location_precision)`, and I18N.t returns the KEY when it misses
  // — so a value with no translation reaches a moderator as the literal text
  // "precision.street" rather than as a visible failure. The four values are migration
  // 0006's enum; the database is the authority and this is the copy that must follow it.
  for (const k of ['q.exactFlag', 'q.exactWhy', 'q.precision']) keys.add(k);
  for (const p of ['exact', 'street', 'area', 'hidden']) keys.add('precision.' + p);

  const missing = [...keys].filter(k => {
    const ar = winI.I18N.t(k);
    return !ar || ar === k;
  });
  ok(missing.length === 0,
     `every message key resolves in Arabic${missing.length ? ' — missing: ' + missing.join(', ') : ''}`);

  winI.I18N.set('en');
  const missingEn = [...keys].filter(k => {
    const en = winI.I18N.t(k);
    return !en || en === k;
  });
  ok(missingEn.length === 0,
     `and in English${missingEn.length ? ' — missing: ' + missingEn.join(', ') : ''}`);
}

// ── 8 · the courtesy checks refuse before any network call ──────────────────
{
  let fetched = 0;
  const win = makeWindow({ fetch: () => { fetched++; return okJson({}); } });
  load('site/assets/js/upload.js', win);

  const file = (type, size) => ({ type, size, name: 'x' });
  const cases = [
    [file('image/svg+xml', 100), 'up.err.svg', 'SVG (§6 names it specifically)'],
    [file('application/pdf', 100), 'up.err.type', 'an unsupported type'],
    [file('image/jpeg', 0), 'up.err.empty', 'an empty file'],
    [file('image/jpeg', 300 * 1024 * 1024), 'up.err.tooBig', 'over the member size cap']
  ];
  let allRefused = true;
  for (const [f, expected] of cases) {
    const err = await win.UPLOAD.submit(f, { kind: 'media' }, 'captcha-token').then(() => null, e => e);
    if (!err || err.key !== expected) allRefused = false;
  }
  ok(allRefused, 'each obviously-bad file is refused with its own message');
  ok(fetched === 0, '...without a single request leaving the browser');

  const noCaptcha = await win.UPLOAD.submit(file('image/jpeg', 100), { kind: 'media' }, '')
    .then(() => null, e => e);
  ok(noCaptcha && noCaptcha.key === 'up.err.robot',
     'and a missing Turnstile token is refused before the upload starts (§6)');
}

console.log('# config — the one credential permitted in the client');

// ── 9 · the anon-key guard discriminates ────────────────────────────────────
// The gitleaks self-test makes the same argument about its rules: a guard that has never
// been shown to refuse anything is a guard nobody knows is wired up.
{
  const threw = t => { try { assertAnonKey(t); return false; } catch { return true; } };

  ok(!threw(jwt({ role: 'anon', iss: 'supabase' })), 'an anon key is accepted');
  ok(threw(jwt({ role: 'service_role', iss: 'supabase' })),
     'a service_role key is REFUSED — this is the §6 incident, caught at build time');
  ok(threw(jwt({ role: 'media_worker' })), 'and so is any other role');
  ok(threw(jwt({ iss: 'supabase' })), 'a token with no role claim is refused');
  ok(threw('not-a-jwt'), 'and something that is not a JWT at all');
}

console.log(`\n1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
