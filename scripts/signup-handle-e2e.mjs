#!/usr/bin/env node
/* The handle a member types at signup, against the REAL deployed database.
 *
 *     node scripts/harness-bootstrap.mjs --all      (once, writes .harness.vars)
 *     node scripts/signup-handle-e2e.mjs
 *
 * ── Why this file exists, and what it is answering for ──────
 *
 * The handle has now failed to persist twice, and BOTH times the suite was green.
 *
 *   31 Aug  claimHandle() INSERTed a row 0057's trigger had already created, so every
 *           signup was a primary-key 409 reported to the member as "that handle is taken".
 *    7 Sep  fixed by making it a PATCH — correctly, and it deployed. Measured 13 Sep against
 *           the live database: all 22 profiles still carried 0057's `member_<12 hex>`
 *           placeholder, `profiles.updated_at` equalled `created_at` on every single row,
 *           and seven of those accounts were created AFTER the fix shipped.
 *
 * The reason the second one passed silently is in §4 of scripts/frontend-nav-test.mjs. It
 * drives the real form, and it asserts the shape of the call — a PATCH, on `profiles`,
 * carrying the typed handle, filtered to the member's own row. Every one of those was true
 * on the deployed site. What it could not see is that `DB` and `AUTH` are doubles: the PATCH
 * went to a stub that answered `[{ handle }]`, so the test asserted that the browser ASKS
 * and never that the database AGREES. The database did not agree —
 * `profiles_handle_allowed` and `profiles_handle_is_normalized` refuse a capital letter, a
 * space, a dot and a hyphen, and every name a person actually types has one of those in it.
 *
 * So this file removes exactly that double. The client is the real `auth.js`, `db.js` and
 * `public.js` from site/, loaded in the shell's own order; `window.fetch` is Node's, pointed
 * at the deployed project; and the row is read back from PostgREST afterwards as the member.
 * Nothing between the typed characters and the stored column is simulated.
 *
 * ── The one thing that is NOT real, named plainly ───────────
 *
 * `POST /auth/v1/signup`. GoTrue's captcha protection has been on since 31 Aug and Turnstile
 * does not answer automation — measured again here, as the first assertion, so this stays
 * honest rather than becoming a claim nobody rechecks. The account is therefore created
 * through the admin API, which is the same INSERT into `auth.users` that a real signup makes
 * and fires the same triggers (0057's profile row, 0060's confirmation row), and a real
 * session for it is minted with a magic link. That session's access token is what the form's
 * signup call is answered with, so everything downstream — the JWT, `auth.uid()`, RLS, the
 * column grants, the bidi trigger, both CHECK constraints — is the deployed article.
 *
 * ── Cleanup, which cannot be a delete ──────────────────────
 *
 * `DELETE /auth/v1/admin/users/{id}` answers 500 on this project and is MEANT to: migration
 * 0051 records it in full — `audit_log.actor` is ON DELETE SET NULL and the append-only
 * trigger refuses the UPDATE the cascade attempts, so §3's permanence rule makes a hard
 * delete impossible by design, and withdrawal anonymizes instead. This file therefore ends
 * by calling `request_account_deletion()` as the harness admin, which is the project's own
 * withdrawal path: the identity is scrubbed and the handle becomes a `deleted_user_<hex>`
 * tombstone, which also puts the name back in circulation for the next run.
 *
 * Belt and braces, because a cleanup that fails must not wedge the next run: every handle
 * carries a per-run suffix, so a leaked account can collide with nothing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, textOf } from './lib/dom-stub.mjs';
import { SUPABASE, ANON, serviceRoleKey, sessionFor } from './lib/harness-auth.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const settle = () => new Promise((resolve) => setImmediate(resolve));
/* The network here is REAL, so microtask flushes are not enough on their own: a shard or a
   PostgREST round trip needs wall-clock time before the next render can have happened. */
const tick = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, what, tries = 60) {
  for (let i = 0; i < tries; i++) {
    for (let j = 0; j < 6; j++) await settle();
    const v = fn();
    if (v) return v;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}`);
}

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}

const SVC = serviceRoleKey();
const created = [];
/* Per-run, so a cleanup that did not happen cannot make the next run look like a
   regression: the unique index on the normalized handle answers 409, claimHandle reports it
   as "taken", and the row keeps its placeholder — which is EXACTLY the symptom under test.
   DIGITS, not base36: is_allowed_handle puts 0-9 in the group shared by both scripts, so the
   same suffix is legal on a Latin handle and on an Arabic one. Letters would make the Arabic
   case mixed-script, which handleProblem() refuses — correctly, and confusingly. */
const RUN = Date.now().toString().slice(-6);

async function makeAccount() {
  const email = `rma-handle-e2e-${Date.now()}-${created.length}@mail.example.com`;
  const mk = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'a-long-harness-passphrase-1', email_confirm: true }),
  });
  const user = await mk.json();
  if (!user.id) throw new Error(`admin create ${mk.status}: ${JSON.stringify(user).slice(0, 200)}`);
  created.push(user.id);

  const gen = await fetch(`${SUPABASE}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const gb = await gen.json();
  if (!gb.hashed_token) throw new Error(`generate_link ${gen.status}`);
  const ver = await fetch(`${SUPABASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gb.hashed_token }),
  });
  const session = await ver.json();
  if (!session.access_token) throw new Error(`verify ${ver.status}`);
  return { email, id: user.id, session };
}

/** The profile row as the archive stores it, read with the service role so a policy cannot
 *  turn "the write was refused" into "the row is not visible" and look like the same thing. */
async function profileRow(id) {
  const res = await fetch(
    `${SUPABASE}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&select=handle,display_name`,
    { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } },
  );
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : null;
}

const SHELL = [...read('site/index.html').matchAll(/<script src="(\/assets\/(?:v\/[0-9a-f]+\/)?js\/[^"]+)"/g)]
  .map((m) => `site${m[1]}`);

/**
 * The public shell, with the real auth.js / db.js / public.js and a real network.
 *
 * `account` is the out-of-band session the captcha-gated /signup call is answered with, or
 * null to let the run see whatever the real endpoint says.
 */
function boot(account) {
  const win = makeWindow({ pathname: '/', innerWidth: 1200 });
  const calls = [];

  win.fetch = (url, options) => {
    const key = String(url);
    const opts = options || {};
    calls.push({ url: key, method: opts.method || 'GET', body: opts.body || null });

    if (account && /\/auth\/v1\/signup$/.test(key)) {
      const body = { ...account.session, user: account.session.user };
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    }
    return globalThis.fetch(key, opts);
  };

  const TURNSTILE = {
    mount: () => ({ token: () => Promise.resolve('harness'), reset: () => {}, remove: () => {} }),
    whenReady: () => Promise.resolve(true),
  };

  const toasts = [];
  for (const rel of SHELL) {
    if (rel.endsWith('public.js')) Object.assign(win, { TURNSTILE });
    const names = Object.keys(win).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    new Function('window', ...names, read(rel))(win, ...names.map((n) => win[n]));
    /* public.js binds UI as a bare parameter, but calls `UI.toast(...)` — a property read
       at call time — so wrapping the method on the same object is seen. claimHandle reports
       every refusal this way and nowhere else, which makes the toast the only place the
       member's actual sentence can be read. */
    if (rel.endsWith('ui.js')) {
      const real = win.UI.toast;
      win.UI.toast = function (message) { toasts.push(message); return real.apply(this, arguments); };
    }
  }
  return { win, calls, toasts };
}

/** Opens the signup dialog the way a visitor does and submits it with `handle`. */
async function openSignup(win) {
  const wanted = win.I18N.t('action.createAcct');
  const join = await waitFor(
    () => win.document.body.querySelectorAll('button').find((b) => textOf(b) === wanted),
    'the masthead create-account button',
  );
  join.fire('click');
  await settle();
  return waitFor(() => win.document.querySelector('form.dialog--form'), 'the signup form');
}

async function signUpWith(win, handle, email) {
  const form = await openSignup(win);
  form.querySelector('input[autocomplete=username]').value = handle;
  form.querySelector('input[type=email]').value = email;
  form.querySelector('input[type=password]').value = 'a-long-harness-passphrase-1';
  form.fire('submit');
  for (let i = 0; i < 6; i++) { for (let j = 0; j < 8; j++) await settle(); await tick(150); }
  return form;
}

const errorText = (win) => {
  const note = win.document.querySelector('.form-error');
  return note && !note.hidden ? (note.textContent || '').trim() : null;
};

try {
  /* ═══ 0 · the double is still necessary ═══════════════════════════════════
     If this ever goes green the captcha is off, and the substitution below has stopped
     being a test double and started being a description of the deployed system. */
  console.log('# the one call no script can make');
  {
    const res = await fetch(`${SUPABASE}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `rma-probe-${Date.now()}@mail.example.com`, password: 'a-long-harness-passphrase-1' }),
    });
    const body = await res.json().catch(() => ({}));
    ok(res.status === 400 && body.error_code === 'captcha_failed',
       `/auth/v1/signup is captcha-gated, so the session below is minted out of band (${res.status} ${body.error_code || ''})`);
  }

  /* ═══ 1 · a handle a person types, all the way to the column ══════════════
     Lower-case Latin, which is the one shape the old code could ever have stored. It is the
     control: if this fails, the PATCH itself is broken again. */
  console.log('# a plain handle reaches the database');
  {
    const account = await makeAccount();
    const before = await profileRow(account.id);
    ok(/^member_[0-9a-f]{12}$/.test(before.handle),
       `CONTROL: 0057 provisioned the placeholder the member has to be rid of (${before.handle})`);

    const { win, calls } = boot(account);
    await signUpWith(win, 'ramallah_1967_' + RUN, account.email);

    const patch = calls.find((c) => c.method === 'PATCH' && /\/rest\/v1\/profiles/.test(c.url));
    ok(!!patch, 'the browser sent a PATCH to profiles');
    const after = await profileRow(account.id);
    ok(after.handle === 'ramallah_1967_' + RUN,
       `THE ASSERTION: the row now holds the typed handle, read back from the deployed database (${after.handle})`);
    ok(after.display_name === 'ramallah_1967_' + RUN,
       `...and the display name with it (${after.display_name})`);
  }

  /* ═══ 2 · a capital letter is normalized, not lost ════════════════════════
     The exact defect. `normalized_handle()` lower-cases and `profiles_handle_is_normalized`
     then requires the stored value to equal it, so "Masar" was 23514 → 400 → a toast, and
     the member kept the placeholder. It has to arrive as `masar`. */
  console.log('# a capital letter — the handle every member actually types');
  {
    const account = await makeAccount();
    const { win } = boot(account);
    await signUpWith(win, 'Masar_' + RUN, account.email);

    const after = await profileRow(account.id);
    ok(after.handle === 'masar_' + RUN,
       `"Masar_${RUN}" is stored lower-cased rather than refused (${after.handle})`);
    ok(!/^member_/.test(after.handle),
       '...and specifically NOT the member_<hex> placeholder, which is the reported symptom');
  }

  /* ═══ 3 · an Arabic handle, which this archive exists for ═════════════ */
  console.log('# an Arabic handle');
  {
    const account = await makeAccount();
    const { win } = boot(account);
    await signUpWith(win, 'سعاد_حبيب_' + RUN, account.email);
    const after = await profileRow(account.id);
    ok(after.handle === 'سعاد_حبيب_' + RUN, `an Arabic handle is stored as typed (${after.handle})`);
  }

  /* ═══ 3b · what the browser CANNOT know stays the server's to refuse ══════
     `رام_الله` passes every rule in handleProblem() and is in `reserved_handles`, which is a
     fact about the whole table. It has to reach the database and be turned away there, or
     the client-side check has quietly become the authority — the §5 line this fix must not
     cross. The signup is deliberately not rolled back: claimHandle's contract is that a
     name is something the member fixes from their profile, not a reason to sign up again. */
  console.log('# a reserved handle is still the call of the database');
  {
    const account = await makeAccount();
    const { win, calls, toasts } = boot(account);
    await signUpWith(win, 'رام_الله', account.email);
    ok(calls.some((c) => c.method === 'PATCH' && /\/rest\/v1\/profiles/.test(c.url)),
       'a reserved handle is SENT — the client does not pre-empt the reserved list');
    const after = await profileRow(account.id);
    ok(/^member_[0-9a-f]{12}$/.test(after.handle),
       `...the database refused it and the placeholder stands (${after.handle})`);
    /* And WHICH refusal the member is told about, from the real 400. Both server-side
       verdicts are SQLSTATE 23514; only the body separates them, so this is the assertion
       that the separation works against the deployed PostgREST rather than against a stub
       carrying a body somebody typed. */
    ok(toasts.includes(win.I18N.t('signup.err.handleReserved')),
       `the member is told the archive keeps the name (${JSON.stringify(toasts)})`);
    ok(!toasts.includes(win.I18N.t('signup.err.handleTaken')),
       '...and NOT that someone else has it, which is a different thing to go and do');
  }

  /* ═══ 3c · a handle another member already holds ══════════════════════════
     The third outcome, and the only one of the three that needs two accounts. 409 / 23505
     on 0004's unique index over the NORMALIZED handle — so this also proves the normalized
     index is what collides, not the raw string: the second account types it capitalised. */
  console.log('# a handle somebody else already has');
  {
    const owner = await makeAccount();
    const wanted = 'manara_' + RUN;
    await signUpWith(boot(owner).win, wanted, owner.email);
    const ownerRow = await profileRow(owner.id);
    ok(ownerRow.handle === wanted, `CONTROL: the first member got the name (${ownerRow.handle})`);

    const second = await makeAccount();
    const { win, toasts } = boot(second);
    await signUpWith(win, 'Manara_' + RUN, second.email);
    const secondRow = await profileRow(second.id);
    ok(/^member_[0-9a-f]{12}$/.test(secondRow.handle),
       `the second member does not get it (${secondRow.handle})`);
    ok(toasts.includes(win.I18N.t('signup.err.handleTaken')),
       `...and is told somebody already has it (${JSON.stringify(toasts)})`);
    ok(!toasts.includes(win.I18N.t('signup.err.handleReserved')),
       '...not that the archive keeps it, which would send them looking for a rule');
    /* The string all three used to collapse into. t() returns the key when it is gone. */
    ok(!toasts.some((m) => m === 'signup.err.handleBad' || /غير مقبول|not allowed/.test(m)),
       'and no message on any of these paths is the generic "that handle is not allowed"');
  }

  /* ═══ 4 · what the database will not take is refused BEFORE the account ═══
     The other half of the fix, and the half the member feels. A space, a dot and a mixed
     script are 23514 in the database; if they reach it, the refusal arrives as a toast over
     a success panel and the member is stuck with the placeholder. They have to be stopped at
     the form, with a message naming the rule, and no account created. */
  console.log('# a handle the archive will not take, refused at the form');
  for (const [typed, key] of [
    ['abu ammar', 'signup.err.handleChars'],
    ['m.janim.07', 'signup.err.handleChars'],
    ['tala-jabi', 'signup.err.handleChars'],
    ['ab', 'signup.err.handleLength'],
    ['amro_رام', 'signup.err.handleScript'],
    ['_amro', 'signup.err.handleUnderscore'],
  ]) {
    const { win, calls } = boot(null);
    await signUpWith(win, typed, 'never-created@mail.example.com');
    const shown = errorText(win);
    ok(shown === win.I18N.t(key),
       `"${typed}" is refused with ${key} (${JSON.stringify(shown)})`);
    ok(!calls.some((c) => /\/auth\/v1\/signup$/.test(c.url)),
       `...and no account was created for it (${calls.filter((c) => /auth\/v1/.test(c.url)).length} auth calls)`);
  }

  /* ═══ 5 · the rules are ON THE SCREEN ═════════════════════════════════════
     Two CHECK constraints enforced them and nothing in the interface had ever said what
     they were, which is the whole reason a member typed a name that could not be stored. A
     validator that only speaks after a refusal is the same defect with better manners. */
  console.log('# the rules the member is held to are visible before they type');
  for (const lang of ['ar', 'en']) {
    const { win } = boot(null);
    win.I18N.set(lang);
    const form = await openSignup(win);
    const rules = win.I18N.t('field.handleRules');
    ok(rules.length > 10 && rules !== 'field.handleRules',
       `there is a ${lang} wording for the rules (${JSON.stringify(rules.slice(0, 40))})`);
    ok(textOf(form).replace(/\s+/g, ' ').includes(rules),
       `...and the ${lang} signup form states them, before anything is typed`);
  }
} finally {
  let scrubbed = 0;
  if (created.length) {
    try {
      const admin = await sessionFor('admin');
      for (const id of created) {
        const res = await fetch(`${SUPABASE}/rest/v1/rpc/request_account_deletion`, {
          method: 'POST',
          headers: { apikey: ANON, Authorization: `Bearer ${admin.accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_user_id: id, p_note: 'signup-handle-e2e cleanup' }),
        });
        if (res.ok) scrubbed++;
      }
    } catch (e) {
      console.log(`# cleanup could not run: ${e.message}`);
    }
  }
  /* Said out loud rather than swallowed. A silent cleanup failure leaves real accounts in a
     real project, and the next run would be reading its own litter. */
  console.log(`# anonymized ${scrubbed} of ${created.length} harness account(s)`);
  if (scrubbed !== created.length) {
    console.log('# NOT ALL CLEANED UP — see scripts/lib/harness-auth.mjs and 0051');
  }
}

console.log(`1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log(`\nall ${passed} green`);
