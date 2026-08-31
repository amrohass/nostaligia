// Is GoTrue actually verifying the captcha token?
//
//     node scripts/captcha-probe.mjs <email-of-a-harness-account>
//
// with SUPABASE_URL and the anon key taken from config/site.json. §6 requires Turnstile on
// signup, and §5 says a client-side check is not a guard — so the only question that matters
// is whether the token the browser sends is verified by the SERVER.
//
// ── Why it signs in with a CORRECT password ──────────────────
//
// The 31 Aug audit probed with credentials that fail anyway, so both arms answered
// `invalid_credentials` and the only available reading was "the captcha changed nothing".
// That is suggestive rather than conclusive: an endpoint that refuses everything refuses a
// bad captcha too.
//
// With a REAL account and its REAL password the two states cannot be confused:
//
//   captcha OFF  → a garbage token is ignored and the grant SUCCEEDS, 200 with a session;
//   captcha ON   → refused before the password is considered, and the refusal names it.
//
// **A success here is the failure.** That is the whole design of this file, and it is why it
// needs a working account rather than a fabricated one.
//
// ── Reading the refusal ──────────────────────────────────────
//
// `captcha_failed` alone does not mean the captcha is configured correctly — it means the
// request was stopped. The detail in parentheses is the verifier's own error code, and the
// two that matter are opposites:
//
//   invalid-input-response → the SECRET is recognised and the TOKEN was rejected. Correct.
//   invalid-input-secret   → the SECRET is not recognised. Nobody can ever sign in, because
//                            a real token from a real person gets the same answer.
//
// --semantics asks Cloudflare's siteverify directly, with its published test secrets, so
// that reading is a measurement rather than something recalled from documentation.
//
// The password is a literal in scripts/e2e-deployed.ts, is a staging-only harness credential,
// and is not printed here. No mail is sent by a password grant and nothing is created.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));
const SUPABASE = `https://${cfg.domains.supabase}`;
const ANON = cfg.supabase.anon_key;
const PASSWORD = 'e2e-deployed-harness-password-1';

const VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/* ── What the verifier's error codes actually mean ─────────────────────────── */

async function semantics() {
  const ask = async (label, secret) => {
    const r = await fetch(VERIFY, { method: 'POST', body: new URLSearchParams({ secret, response: 'garbage-token' }) });
    const j = await r.json();
    console.log(`  ${label.padEnd(52)} success=${j.success}  ${JSON.stringify(j['error-codes'])}`);
  };
  console.log('\n== Turnstile siteverify, asked directly (all values below are public test keys) ==');
  // Cloudflare's published test secrets. Nothing of ours is sent.
  await ask('a recognised secret that always passes', '1x0000000000000000000000000000000AA');
  await ask('a recognised secret that always fails', '2x0000000000000000000000000000000AA');
  await ask('a secret the verifier does not recognise', 'not-a-real-secret-at-all');
  console.log('  → invalid-input-response means the TOKEN was judged; invalid-input-secret means it never was.');
}

/* ── The probe ────────────────────────────────────────────────────────────── */

const post = (path, body) => fetch(`${SUPABASE}/auth/v1/${path}`, {
  method: 'POST',
  headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

async function read(res) {
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return {
    status: res.status,
    sbCode: res.headers.get('x-sb-error-code'),
    errorCode: json && (json.error_code || json.code),
    msg: json && (json.msg || json.error_description || json.error),
    session: !!(json && json.access_token)
  };
}

function show(label, r) {
  console.log(`  ${label}`);
  console.log(`      HTTP ${r.status}  x-sb-error-code=${r.sbCode ?? '-'}`);
  console.log(`      msg: ${r.msg ?? '-'}`);
  console.log(`      session issued: ${r.session ? 'YES' : 'no'}`);
}

const email = process.argv.find((a) => a.includes('@'));
if (process.argv.includes('--semantics')) await semantics();

if (!email) {
  console.error('\nusage: node scripts/captcha-probe.mjs <harness-account-email> [--semantics]');
  console.error('  list them with:  select email from auth.users where email like \'e2e-%\';');
  process.exit(2);
}

const settings = await (await fetch(`${SUPABASE}/auth/v1/settings`, { headers: { apikey: ANON } })).json();
console.log(`\n== GoTrue ==\n  disable_signup=${settings.disable_signup}  mailer_autoconfirm=${settings.mailer_autoconfirm}`);

console.log('\n== A REAL account and its REAL password ==');
const noToken = await read(await post('token?grant_type=password', { email, password: PASSWORD }));
show('A · no captcha token at all', noToken);

const badToken = await read(await post('token?grant_type=password', {
  email, password: PASSWORD,
  gotrue_meta_security: { captcha_token: 'this-is-not-a-turnstile-token' }
}));
show('B · a deliberately INVALID captcha token', badToken);

console.log('\n== Controls ==');
const wrongPw = await read(await post('token?grant_type=password', {
  email, password: 'definitely-not-the-password',
  gotrue_meta_security: { captcha_token: 'this-is-not-a-turnstile-token' }
}));
show('C · wrong password AND an invalid token — which gate answers first?', wrongPw);

const signup = await read(await post('signup', {
  email: `probe-captcha-${Date.now()}@mail.example.com`, password: 'aVeryLongProbePassword1!'
}));
show('D · /signup — the endpoint §6 actually names', signup);

console.log('\n== Reading ==');
const detail = `${badToken.errorCode ?? ''} ${badToken.sbCode ?? ''} ${badToken.msg ?? ''}`;
if (badToken.session) {
  console.log('  NOT VERIFIED. An invalid token was accepted and a session was issued.');
  process.exitCode = 1;
} else if (/invalid-input-secret/.test(detail)) {
  console.log('  ENFORCING, WITH A SECRET THE VERIFIER DOES NOT RECOGNISE.');
  console.log('  Nobody can sign in, sign up or reset a password — a real token gets this too.');
  console.log('  First thing to check: Supabase\'s captcha PROVIDER dropdown defaults to hCaptcha,');
  console.log('  and a Turnstile secret pasted under it produces exactly this.');
  process.exitCode = 1;
} else if (/captcha/i.test(detail)) {
  console.log('  VERIFIED, and the token is being judged. This is the state to want.');
} else {
  console.log('  INCONCLUSIVE. No session, and the refusal does not name the captcha.');
  console.log('  Compare A and B: if they differ, something is inspecting the token.');
  process.exitCode = 1;
}
