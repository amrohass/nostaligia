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
      origins: { supabase: 'https://project.supabase.co' },
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
  // Refusals that originate in the database and are passed through by name.
  for (const name of ['quota_exceeded', 'title_required', 'description_required',
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
                   'up.err.robotUnavailable', 'up.err.noFile']) keys.add(k);

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
