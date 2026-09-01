#!/usr/bin/env node
/* Do the copies of each shared secret still agree with each other?
 *
 *   node scripts/secret-consistency.mjs             # the pre-flight (needs project credentials)
 *   node scripts/secret-consistency.mjs --selftest  # CI-safe; proves the comparison discriminates
 *   node scripts/secret-consistency.mjs --no-db     # skip the vault read (one fewer CLI round-trip)
 *
 * WHY THIS EXISTS. Three times now a secret has existed in two places, the two have drifted,
 * and the drift surfaced as a live outage rather than as a caught bug:
 *
 *   30 Aug  PUBLISH_SECRET      vault vs Edge Function env — the publisher stopped publishing
 *   31 Aug  the Turnstile secret in GoTrue — nobody could sign in, sign up or reset a password
 *    1 Sep  TURNSTILE_SECRET_KEY  .dev.vars vs the deployed function env — still divergent
 *
 * Each was found by a human noticing something was broken and then going to look. The
 * standing rule in this repository is to fix the reporting mechanism rather than the
 * symptom, and the mechanism that was missing is this one: something that can be RUN, before
 * anything breaks, and that answers per secret whether its copies agree.
 *
 * ── What it will not do ──────────────────────────────────────
 *
 * It never prints a secret, and it never prints anything DERIVED from one either. Comparison
 * is by sha256, but the digests are not shown: locations that hold the same value are
 * printed as the same GROUP LETTER (A, B, C…), which says everything the reader needs —
 * which copies agree — and leaks nothing at all, not even a fingerprint that could confirm a
 * guess at a low-entropy value. `--selftest` asserts that property against known inputs
 * rather than trusting the author of this file to have held to it.
 *
 * ── The three readback kinds, and why the distinction is the whole point ──
 *
 *   digest      the location hands back a sha256 and never the value: `supabase secrets list`
 *               for Edge Function env, and `extensions.digest()` computed INSIDE the database
 *               for Vault. Comparable, and nothing sensitive crosses the wire.
 *   plaintext   we can read it here — `.dev.vars`, which is local-dev-only config. Hashed
 *               locally, then treated exactly like a digest location.
 *   write-only  no readback exists at any price: GoTrue's captcha secret (dashboard-only) and
 *               Scaleway `secret-environment-variables` on the media worker. These CANNOT be
 *               compared, and reporting them as MATCH would be a lie. They are reported
 *               UNVERIFIABLE, and where a provider offers a behavioural check instead, that
 *               check is run and reported as what it is.
 *
 * A secret whose copies are all write-only gets NO structural verdict. That is the honest
 * answer and this file prints it rather than a green one.
 *
 * ── Behavioural checks, where structure runs out ─────────────
 *
 * Cloudflare's siteverify is an ORACLE for the Turnstile secret: asked with a secret and a
 * deliberately invalid token it answers `invalid-input-response` when it recognises the
 * secret and `invalid-input-secret` when it does not. So for any Turnstile copy we can read,
 * we learn not merely whether it matches its siblings but whether it is the REAL one — which
 * is the question a digest comparison cannot answer, because three copies of a stale value
 * agree with each other perfectly.
 *
 * That oracle also reaches one write-only location transitively: GoTrue forwards the
 * verifier's own error code in its refusal, so `scripts/captcha-probe.mjs` reads the
 * dashboard secret's standing without anybody being able to read the secret. This file runs
 * the same request.
 *
 * ── Why it is NOT in CI ──────────────────────────────────────
 *
 * Every reading it takes needs a credential CI must not hold: `supabase secrets list` and
 * `supabase db query --linked` need the project access token, `.dev.vars` is gitignored and
 * has no business in a runner, and the Cloudflare oracle is only meaningful when asked about
 * the real secret. Putting those in CI would create the fourth copy of every secret — a new
 * drift surface, to detect drift. So this is a MANUAL PRE-FLIGHT, listed at the top of
 * NEXT-SESSION.md, and what CI runs is `--selftest`: no credential, no network, and it holds
 * the comparison itself to the discrimination this repository keeps finding its own tests
 * lacking.
 */

import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEV_VARS = join(ROOT, 'supabase/functions/.dev.vars');
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/* ── Reading the three locations ───────────────────────────────────────────── */

/* .dev.vars is `KEY=value` with optional surrounding quotes. Deliberately not a dotenv
   dependency: this file must not acquire one, and the format it has to read is this one. */
function readDevVars() {
  if (!existsSync(DEV_VARS)) return null;
  const out = {};
  for (const line of readFileSync(DEV_VARS, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

/* The Management API returns each Edge Function secret as {name, value} where `value` is the
   sha256 hex of the secret. That is asserted rather than assumed: the caller cross-checks a
   secret it can also read locally, so a platform that ever changed the algorithm turns every
   comparison MISMATCH instead of silently turning them all MATCH. See crossCheckAlgorithm(). */
function readFunctionSecrets() {
  let raw;
  try {
    raw = execSync('supabase secrets list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
  /* The CLI's shape depends on how it decides to format output, so find the JSON rather than
     depending on it being the whole of stdout, and fall back to the table form. */
  const start = raw.indexOf('{"secrets"');
  if (start >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
      const out = {};
      for (const s of parsed.secrets ?? []) out[s.name] = { digest: s.value, updated: s.updated_at };
      return Object.keys(out).length ? out : null;
    } catch { /* fall through to the table parse */ }
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*\|\s*([0-9a-f]{64})\s*$/.exec(line);
    if (m) out[m[1]] = { digest: m[2], updated: null };
  }
  return Object.keys(out).length ? out : null;
}

/* The digest is computed INSIDE the database. The decrypted secret never leaves Postgres,
   never enters this process, and never reaches a terminal — which is the only way to compare
   a Vault secret without handling it. */
function readVaultDigests(names) {
  const sql = `select s.name,
                      encode(extensions.digest(s.decrypted_secret, 'sha256'), 'hex') as sha256,
                      s.updated_at
                 from vault.decrypted_secrets s
                where s.name in (${names.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ')})`;
  const tmp = join(tmpdir(), `rma-vault-digest-${process.pid}.sql`);
  let raw;
  try {
    writeFileSync(tmp, sql);
    raw = execSync(`supabase db query --linked -f "${tmp}"`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* the temp file holds only the QUERY, never a value */ }
  }
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, raw.lastIndexOf('}') + 1));
    const out = {};
    for (const r of parsed.rows ?? []) out[r.name] = { digest: r.sha256, updated: r.updated_at };
    return out;
  } catch {
    return null;
  }
}

/* ── The oracle ────────────────────────────────────────────────────────────── */

/* Asked with a deliberately invalid token, Cloudflare distinguishes the two failures that
   matter. `invalid-input-response` means it got as far as JUDGING the token, which it can
   only do with a secret it recognises. `invalid-input-secret` means it never did. */
async function askCloudflare(secret) {
  try {
    const r = await fetch(SITEVERIFY, {
      method: 'POST',
      body: new URLSearchParams({ secret, response: 'deliberately-invalid-token' }),
    });
    const codes = (await r.json())['error-codes'] ?? [];
    if (codes.includes('invalid-input-response')) return 'recognised';
    if (codes.includes('invalid-input-secret')) return 'not-recognised';
    return 'inconclusive';
  } catch {
    return 'unreachable';
  }
}

/* GoTrue's captcha secret is dashboard-only and cannot be read back. It CAN be interrogated:
   GoTrue forwards the verifier's own error code inside its 400, so the same two codes carry
   the same two meanings, about a value nobody can see. */
async function askGoTrue() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'config/site.json'), 'utf8'));
  } catch {
    return { state: 'unreachable', detail: 'config/site.json unreadable' };
  }
  const base = `https://${cfg.domains.supabase}`;
  const anon = cfg.supabase.anon_key;
  try {
    const r = await fetch(`${base}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anon, Authorization: `Bearer ${anon}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'secret-consistency-probe@mail.example.com',
        password: 'not-a-real-password-and-never-used',
        gotrue_meta_security: { captcha_token: 'deliberately-invalid-token' },
      }),
    });
    const body = await r.json().catch(() => ({}));
    const msg = `${body.error_code ?? ''} ${body.msg ?? body.error_description ?? body.error ?? ''}`;
    if (/invalid-input-secret/.test(msg)) return { state: 'not-recognised', detail: 'invalid-input-secret' };
    if (/invalid-input-response/.test(msg)) return { state: 'recognised', detail: 'invalid-input-response' };
    if (/captcha/i.test(msg)) return { state: 'inconclusive', detail: msg.trim().slice(0, 80) };
    return { state: 'not-enforcing', detail: msg.trim().slice(0, 80) || `HTTP ${r.status}` };
  } catch (e) {
    return { state: 'unreachable', detail: String(e.message ?? e).slice(0, 60) };
  }
}

/* ── The registry ──────────────────────────────────────────────────────────── */

/* Each entry names the places one secret lives and which of them are REQUIRED to hold the
   same value. `mustAgree` is the load-bearing field: a location listed outside it may
   legitimately differ (local dev pointing somewhere else), and calling that drift would
   train the reader to ignore this script — which is how a check stops working. */
const REGISTRY = [
  {
    name: 'PUBLISH_SECRET',
    why: 'the database calls the publisher with it; a mismatch stops the archive publishing.',
    locations: [
      { id: 'vault (rma_publish_secret)', kind: 'digest', from: 'vault', key: 'rma_publish_secret' },
      { id: 'edge function env', kind: 'digest', from: 'functions', key: 'PUBLISH_SECRET' },
      { id: '.dev.vars', kind: 'plaintext', from: 'devvars', key: 'PUBLISH_SECRET' },
    ],
    mustAgree: ['vault (rma_publish_secret)', 'edge function env', '.dev.vars'],
  },
  {
    name: 'TURNSTILE_SECRET_KEY',
    why: 'signup, sign-in, password reset and every upload are gated on it.',
    locations: [
      { id: 'edge function env', kind: 'digest', from: 'functions', key: 'TURNSTILE_SECRET_KEY' },
      { id: '.dev.vars', kind: 'plaintext', from: 'devvars', key: 'TURNSTILE_SECRET_KEY' },
      { id: 'GoTrue captcha config', kind: 'write-only', behavioural: 'gotrue' },
    ],
    mustAgree: ['edge function env', '.dev.vars'],
    oracle: 'cloudflare',
  },
  {
    name: 'MEDIA_WORKER_SECRET',
    why: 'complete-upload authenticates to the media worker with it; a mismatch wedges ingest.',
    locations: [
      { id: 'edge function env', kind: 'digest', from: 'functions', key: 'MEDIA_WORKER_SECRET' },
      { id: '.dev.vars', kind: 'plaintext', from: 'devvars', key: 'MEDIA_WORKER_SECRET' },
      { id: 'worker container env', kind: 'write-only' },
    ],
    mustAgree: ['edge function env', '.dev.vars'],
  },
];

/* Read but never graded. They are printed because a divergence here has never been written
   down as deliberate, and an unexplained difference the maintainer can see is worth more
   than a silent one — but grading them would produce a MISMATCH on every run for what may be
   an intended local-dev value, and a check that always fails is a check nobody reads. */
const OBSERVED = ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'R2_BUCKET_PREFIX', 'UPLOAD_ALLOWED_ORIGINS'];

/* ── Comparison ────────────────────────────────────────────────────────────── */

/* Digests in, group letters out. Two locations share a letter exactly when they hold the
   same value; nothing derived from the value itself is returned. */
export function groupLetters(digestByLocation) {
  const seen = new Map();
  const out = {};
  for (const [loc, digest] of Object.entries(digestByLocation)) {
    if (digest === null || digest === undefined) { out[loc] = null; continue; }
    if (!seen.has(digest)) seen.set(digest, String.fromCharCode(65 + seen.size));
    out[loc] = seen.get(digest);
  }
  return out;
}

/* The verdict for one secret. Returns `comparable` — how many locations actually yielded a
   value — because a verdict computed over fewer than two of them is not a verdict, and the
   05_matrix lesson is that two empty sets compare equal. */
export function verdict(entry, digestByLocation) {
  const required = entry.mustAgree ?? [];
  const present = required.filter((l) => digestByLocation[l] !== null && digestByLocation[l] !== undefined);
  const missing = required.filter((l) => !present.includes(l));
  if (present.length < 2) {
    return { state: 'UNVERIFIABLE', comparable: present.length, missing };
  }
  const values = new Set(present.map((l) => digestByLocation[l]));
  return {
    state: values.size === 1 ? (missing.length ? 'MATCH (partial)' : 'MATCH') : 'MISMATCH',
    comparable: present.length,
    missing,
  };
}

/* ── The self-test ─────────────────────────────────────────────────────────── */

function selftest() {
  let failures = 0;
  const check = (name, cond, detail = '') => {
    if (cond) { console.log(`  ok    ${name}`); } else { console.log(`  FAIL  ${name}  ${detail}`); failures++; }
  };
  console.log('\n== scripts/secret-consistency.mjs --selftest ==\n');

  const e = { name: 'X', mustAgree: ['a', 'b', 'c'] };

  /* 1 · agreement is reported as agreement. */
  check('three identical copies → MATCH',
    verdict(e, { a: 'd1', b: 'd1', c: 'd1' }).state === 'MATCH');

  /* 2 · and disagreement as disagreement. The failure that matters is the reverse of the one
     people test for: a comparator that says MATCH for everything passes test 1 and is
     useless, so this is the assertion doing the work. */
  check('one copy differing → MISMATCH',
    verdict(e, { a: 'd1', b: 'd1', c: 'd2' }).state === 'MISMATCH');

  /* 3 · a location that could not be read is never counted as agreeing. */
  const partial = verdict(e, { a: 'd1', b: 'd1', c: null });
  check('an unreadable copy → MATCH (partial), and it is named',
    partial.state === 'MATCH (partial)' && partial.missing.length === 1 && partial.missing[0] === 'c',
    JSON.stringify(partial));

  /* 4 · THE ANTI-VACUITY CONTROL. 05_matrix shipped without one of these and would have
     reported the database secure while probing no policy at all: two empty sets are equal.
     One readable location out of three is not a comparison, and must not read as one. */
  check('one readable copy → UNVERIFIABLE, not MATCH',
    verdict(e, { a: 'd1', b: null, c: null }).state === 'UNVERIFIABLE');
  check('NO readable copy → UNVERIFIABLE, not MATCH',
    verdict(e, { a: null, b: null, c: null }).state === 'UNVERIFIABLE');

  /* 5 · group letters carry which-copies-agree and nothing else. */
  const g = groupLetters({ a: 'dead', b: 'dead', c: 'beef', d: null });
  check('locations sharing a value share a letter', g.a === 'A' && g.b === 'A');
  check('a differing location gets its own letter', g.c === 'B');
  check('an unreadable location gets no letter', g.d === null);

  /* 6 · THE NON-DISCLOSURE PROPERTY, asserted rather than promised. Everything this file
     prints about a secret is derived here; if a digest or a value could reach the output,
     it would have to come through one of these two functions.

     The stand-in is generated rather than written down, for two reasons. A literal that
     looks like a secret is one gitleaks flags -- this file tripped its own pre-commit hook
     on the first draft, which is the hook working. And a fresh value every run cannot be
     the one case somebody special-cased into passing. */
  const secretValue = randomBytes(24).toString('hex');
  const digest = sha256(secretValue);
  const rendered = JSON.stringify([groupLetters({ a: digest, b: digest }), verdict(e, { a: digest, b: digest, c: digest })]);
  check('no plaintext secret in the rendered output', !rendered.includes(secretValue));
  check('no digest in the rendered output', !rendered.includes(digest));
  check('not even a digest prefix in the rendered output', !rendered.includes(digest.slice(0, 8)));

  console.log(`\n  ${failures === 0 ? 'PASS' : `FAIL — ${failures} assertion(s)`}\n`);
  return failures === 0 ? 0 : 1;
}

/* ── The pre-flight ────────────────────────────────────────────────────────── */

async function preflight({ withDb }) {
  console.log('\n== secret consistency ==');
  console.log('   Locations holding the same value share a group letter. No digest, prefix or');
  console.log('   value is printed. A location with no readback is UNVERIFIABLE, never MATCH.\n');

  const devvars = readDevVars();
  const functions = readFunctionSecrets();
  const vault = withDb ? readVaultDigests(['rma_publish_secret']) : null;

  const sourceLine = (label, ok, note) => console.log(`   ${ok ? 'read ' : 'MISS '} ${label.padEnd(26)} ${note}`);
  sourceLine('.dev.vars', !!devvars, devvars ? `${Object.keys(devvars).length} keys` : 'not present (local-dev file; fine on a machine that does not run functions locally)');
  sourceLine('edge function env', !!functions, functions ? `${Object.keys(functions).length} secrets` : '`supabase secrets list` failed — logged in? linked?');
  sourceLine('vault', !!vault, vault ? `${Object.keys(vault).length} secrets` : (withDb ? '`supabase db query --linked` failed' : 'skipped (--no-db)'));

  /* Prove the platform's digest is the sha256 we think it is, using a secret we can read
     both ways. Without this, a platform that changed its hashing would turn every comparison
     below into a MISMATCH that looks like drift — or, far worse, a future platform quirk
     could make unrelated values collide into a false MATCH. */
  const cross = crossCheckAlgorithm(devvars, functions);
  console.log(`   ${cross.ok ? 'ok   ' : 'WARN '} digest algorithm             ${cross.note}\n`);

  let bad = 0;
  for (const entry of REGISTRY) {
    const digests = {};
    for (const loc of entry.locations) {
      if (loc.kind === 'write-only') { digests[loc.id] = null; continue; }
      if (loc.from === 'devvars') digests[loc.id] = devvars && devvars[loc.key] !== undefined ? sha256(devvars[loc.key]) : null;
      if (loc.from === 'functions') digests[loc.id] = functions && functions[loc.key] ? functions[loc.key].digest : null;
      if (loc.from === 'vault') digests[loc.id] = vault && vault[loc.key] ? vault[loc.key].digest : null;
    }
    const letters = groupLetters(digests);
    const v = verdict(entry, digests);
    if (v.state === 'MISMATCH' || v.state === 'UNVERIFIABLE') bad++;

    console.log(`── ${entry.name}  →  ${v.state}`);
    console.log(`   ${entry.why}`);
    for (const loc of entry.locations) {
      const graded = (entry.mustAgree ?? []).includes(loc.id);
      const cell = loc.kind === 'write-only'
        ? 'write-only — no readback exists'
        : letters[loc.id] === null ? 'not readable here' : `group ${letters[loc.id]}`;
      const when = loc.from === 'functions' && functions && functions[loc.key]
        ? `   set ${functions[loc.key].updated}`
        : loc.from === 'vault' && vault && vault[loc.key] ? `   set ${vault[loc.key].updated}` : '';
      console.log(`     ${graded ? '·' : ' '} ${loc.id.padEnd(28)} ${cell}${when}`);
    }

    /* The oracle, where one exists. A digest comparison cannot tell three copies of a stale
       value from three copies of the right one — this can. */
    if (entry.oracle === 'cloudflare' && devvars && devvars.TURNSTILE_SECRET_KEY) {
      const answer = await askCloudflare(devvars.TURNSTILE_SECRET_KEY);
      const gloss = {
        recognised: 'Cloudflare RECOGNISES the value in .dev.vars.',
        'not-recognised': 'Cloudflare DOES NOT RECOGNISE the value in .dev.vars — it is stale or wrong.',
        inconclusive: 'Cloudflare answered neither error code.',
        unreachable: 'Cloudflare could not be reached.',
      }[answer];
      console.log(`     ? Cloudflare siteverify      ${gloss}`);
      if (answer !== 'recognised') bad++;
      /* The transitive step, and the only claim available about a value nobody can read. */
      if (answer === 'recognised' && v.state.startsWith('MATCH')) {
        console.log('     → the deployed function env holds the same value, so it is good too.');
      } else if (v.state === 'MISMATCH') {
        console.log('     → the deployed function env holds a DIFFERENT value, and nothing here can');
        console.log('       say whether that one is the real secret. It has no readback.');
      }
    }

    for (const loc of entry.locations) {
      if (loc.behavioural !== 'gotrue') continue;
      const g = await askGoTrue();
      const gloss = {
        recognised: 'GoTrue\'s captcha secret IS recognised by the verifier. Sign-in works.',
        'not-recognised': 'GoTrue\'s captcha secret is NOT recognised. Nobody can sign in, sign up or reset.',
        'not-enforcing': 'GoTrue did not refuse on the captcha at all — it may not be enforcing.',
        inconclusive: 'GoTrue refused on the captcha without naming a verifier code.',
        unreachable: 'GoTrue could not be reached.',
      }[g.state];
      console.log(`     ? GoTrue behavioural check   ${gloss}`);
      console.log(`       (${g.detail})`);
      if (g.state !== 'recognised') bad++;
    }
    console.log('');
  }

  console.log('── observed, not graded');
  console.log('   No decision has been written down about whether local dev is meant to share');
  console.log('   these with the deployed functions, so a difference is shown and not judged.');
  for (const key of OBSERVED) {
    const d = devvars && devvars[key] !== undefined ? sha256(devvars[key]) : null;
    const f = functions && functions[key] ? functions[key].digest : null;
    const state = d === null || f === null ? 'one side not readable' : d === f ? 'same value' : 'DIFFERENT values';
    console.log(`     ${key.padEnd(24)} ${state}`);
  }

  console.log(`\n${bad === 0 ? 'ALL GRADED SECRETS AGREE AND VERIFY.' : `${bad} finding(s) above.`}\n`);
  return bad === 0 ? 0 : 1;
}

/* Confirms `supabase secrets list` hashes with plain sha256, by comparing a secret readable
   from both sides. If no secret is readable from both, it says so — it does not assume. */
function crossCheckAlgorithm(devvars, functions) {
  if (!devvars || !functions) return { ok: false, note: 'not checked — one side unreadable' };
  const agreeing = Object.keys(devvars).filter((k) => functions[k] && functions[k].digest === sha256(devvars[k]));
  if (agreeing.length) return { ok: true, note: `sha256 confirmed against ${agreeing.length} secret(s) readable from both sides` };
  return { ok: false, note: 'NOT confirmed — no secret matched from both sides, so either every copy has drifted or the platform no longer hashes with sha256. Resolve this before reading anything below.' };
}

/* ── main ──────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) {
  process.exit(selftest());
} else {
  process.exit(await preflight({ withDb: !argv.includes('--no-db') }));
}
