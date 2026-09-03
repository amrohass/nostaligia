#!/usr/bin/env node
/* The authenticated paths a REAL BROWSER takes, against the deployed backend.
 *
 *     node scripts/harness-bootstrap.mjs --all            (once)
 *     PLAYWRIGHT_DIR=<node_modules> node scripts/e2e-browser.mjs
 *     PLAYWRIGHT_DIR=… node scripts/e2e-browser.mjs --headed --slow
 *
 * ── Why a browser and not another fetch() ────────────────────
 *
 * Every defect this file is aimed at is invisible to curl, and several of them shipped:
 *
 *   · the admin dashboard stopped rendering for two days and nobody could tell, because
 *     "admin.js is fetched" and "the dashboard appears" are different facts;
 *   · a signup that needs an email confirmation closed the dialog and fired a 3-second
 *     toast, which a new member experienced as the button doing nothing;
 *   · the dashboard's sign-in form had no Turnstile widget at all while GoTrue's captcha
 *     was on, so every correct password was refused;
 *   · §9's "the sign-in gate always preserves intent" has never been tested by anything.
 *
 * curl cannot see any of that. Neither can a DOM snapshot: 29 Aug's audit found controls
 * that were present, zero-sized and unreachable, which a querySelector calls a pass.
 *
 * ── The two test doubles, named plainly ──────────────────────
 *
 * 1. `window.TURNSTILE` is replaced, in the page, with a stub that resolves a fixed
 *    string. Turnstile does not answer automation — measured 31 Aug: no iframe is created
 *    and no callback fires, for 45 seconds — so without this, every form in this file
 *    hangs forever on `widget.token()`.
 *
 * 2. For the two tests that must go THROUGH the form, the GoTrue call the form makes is
 *    intercepted and answered with a session minted out of band (admin API, no captcha,
 *    no mail). The form, its validation, its panel and its intent machinery are the
 *    things under test; the captcha is not.
 *
 * NEITHER touches the deployed project. The site key, the secret and the protection
 * setting are unchanged; a human still meets a challenge and the server still verifies
 * one. What the captcha is FOR is tested by scripts/captcha-probe.mjs, which asserts the
 * server refuses a bad token — and that file must keep passing for these doubles to be
 * honest. The admin-dashboard test below uses NO double of any kind.
 *
 * The R2 bucket's CORS allowlist names http://localhost:3000 exactly, so the page fetches
 * the LIVE shards and the LIVE basemap. site/_headers is deliberately not applied: the CSP
 * has its own test, and enforcing it here would conflate "the panel did not render" with
 * "the policy blocked something".
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { ANON, SUPABASE, decodeClaims, mintDisposable, serviceRoleKey } from './lib/harness-auth.mjs';

/* Only for the teardown in section 4 — nothing under test uses it. */
const SVC = serviceRoleKey();
const decodeSub = (jwt) => decodeClaims(jwt).sub;

const HEADED = process.argv.includes('--headed');
const SLOW = process.argv.includes('--slow');

const dir = process.env.PLAYWRIGHT_DIR;
const pw = await (dir
  ? import(pathToFileURL(join(dir, 'playwright', 'index.js')).href)
  : import('playwright')).catch(() => {
  console.error('e2e-browser: playwright not found. Set PLAYWRIGHT_DIR to a node_modules');
  console.error('  directory that has it:  npm init -y && npm install playwright');
  console.error('                          npx playwright install chromium');
  process.exit(2);
});
/* Playwright is CommonJS, so a dynamic import wraps it: named exports land on `default`. */
const { chromium } = pw.default ?? pw;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(root, 'site');
const PORT = 3000;
const ORIGIN = `http://localhost:${PORT}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* `site/_redirects` in miniature: a real file if there is one, else the SPA shell. */
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = join(SITE, path === '/' ? 'index.html' : path.replace(/^\/+/, ''));
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(SITE, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));

let executed = 0;
const failures = [];
function ck(cond, msg, detail) {
  executed++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures.push(msg);
}
const section = (n, title) => console.log(`\n${n} · ${title}`);

/* ── The Turnstile stub, injected before any page script runs ─ */

const TURNSTILE_STUB = `
  /* An ACCESSOR, not a value. turnstile.js ends with a plain assignment to
     window.TURNSTILE, so a non-writable data property makes that assignment throw in
     strict mode and the module never finishes — which surfaces as an uncaught page error
     and a site that only half-loaded. A getter with a swallowing setter lets the real
     module run to completion and still hands every caller the stub. */
  (function () {
    var stub = {
      mount: function () {
        return {
          token: function () { return Promise.resolve('harness-stub-token'); },
          reset: function () {},
          remove: function () {}
        };
      },
      whenReady: function () { return Promise.resolve(); }
    };
    Object.defineProperty(window, 'TURNSTILE', {
      configurable: true,
      get: function () { return stub; },
      set: function () { /* turnstile.js's own assignment, deliberately ignored */ }
    });
    window.__RMA_TEST_TURNSTILE = true;
  })();
`;

/* Playwright's route() matcher treats a STRING as a GLOB, and in a glob `?` is a
   single-character wildcard — so `.../token?grant_type=password` matches almost nothing
   and the form's real call goes to the network instead. That cost a debugging round: the
   dialog closed (GoTrue answered 400 captcha_failed, the promise rejected, the error
   branch ran) and the only symptom was AUTH.user() staying null. A RegExp has no such
   trap, and it is worth using one anywhere a URL under test carries a query string. */
const PASSWORD_GRANT = /\/auth\/v1\/token\?grant_type=password/;
const SIGNUP = /\/auth\/v1\/signup/;
const RECOVER = /\/auth\/v1\/recover/;
const USER = /\/auth\/v1\/user$/;

const browser = await chromium.launch({ headless: !HEADED, slowMo: SLOW ? 250 : 0 });

/**
 * A page with the stub installed, console and page errors captured. `withTurnstile: false`
 * gives a page with NO doubles at all — which is what the admin test uses.
 */
async function newPage({ withTurnstile = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.consoleErrors = [];
  page.pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') page.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => page.pageErrors.push(String(e)));
  if (withTurnstile) await page.addInitScript(TURNSTILE_STUB);
  return page;
}

/** Is this element actually REACHABLE — not merely present? (29 Aug's audit method.) */
const REACHABLE = (el) => {
  if (!el) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

const text = async (page, sel) => (await page.locator(sel).first().textContent().catch(() => '')) ?? '';

/* ── Selectors, deliberately language-independent ────────────
 *
 * The document is Arabic-first (`<html lang="ar" dir="rtl">`) and every visible string
 * comes from I18N, so matching on button TEXT ties this file to one locale and to the
 * exact wording of a copy deck an admin can edit from the dashboard. An earlier draft did
 * exactly that, matched nothing, and reported "no auth control exists in the masthead"
 * about a masthead that has two. Classes are what public.js actually builds with. */
const SEL = {
  mastheadSignIn: '#masthead .masthead__actions .btn--quiet',
  mastheadCreate: '#masthead .masthead__actions .btn--primary',
  gate: '.dialog--gate',
  gateCreate: '.dialog--gate .btn--primary',
  gateSignIn: '.dialog--gate .btn--ghost',
  form: 'form.dialog--form',
  email: 'form.dialog--form input[type="email"]',
  password: 'form.dialog--form input[type="password"]',
  handle: 'form.dialog--form input[autocomplete="username"]',
  submit: 'form.dialog--form button[type="submit"]',
  panel: '.dialog--gate .dialog__title',
};

/** The masthead is mounted by renderMasthead() after the first data load, not at DOMContentLoaded. */
async function ready(page) {
  await page.waitForFunction(() => window.AUTH && window.UI && window.I18N && window.DB, null, { timeout: 20000 });
  await page.waitForSelector('#masthead .masthead__actions button', { timeout: 20000 });
}

async function fillAuthForm(page, { email, password, handle }) {
  await page.waitForSelector(SEL.email, { timeout: 15000 });
  await page.fill(SEL.email, email);
  await page.fill(SEL.password, password);
  if (handle && await page.locator(SEL.handle).count()) await page.fill(SEL.handle, handle);
  await page.click(SEL.submit);
}

console.log(`\nThe browser's authenticated paths`);
console.log(`  site     ${ORIGIN}  (working tree, live shards)`);
console.log(`  supabase ${SUPABASE}\n`);

try {
  /* ── 1 · signup ends on a panel, and the panel PERSISTS ───── */

  section(1, 'signup → the confirmation panel appears, and stays until dismissed');
  {
    const page = await newPage();
    const PROBE_EMAIL = 'panel-probe@mail.example.com';

    /* Answered the way this project really answers: email confirmation is ON, so signup
       returns a user and NO session. That is the branch that shipped broken — it closed
       the dialog and fired a 3.2 s toast, which a new member experienced as the button
       doing nothing. Nothing is created on the project: the call never leaves the page. */
    await page.route(SIGNUP, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: crypto.randomUUID(), email: PROBE_EMAIL, user: null }),
      }));

    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await ready(page);

    await page.click(SEL.mastheadCreate);
    await page.waitForSelector(SEL.form, { timeout: 10000 });
    ck(await page.locator(SEL.handle).count() === 1,
       `the signup form asks for a HANDLE, not a legal name (§3, §7)`);

    await fillAuthForm(page, {
      email: PROBE_EMAIL, password: 'a-long-enough-probe-password-1', handle: 'panelprobe',
    });

    await page.waitForSelector(SEL.panel, { timeout: 15000 }).catch(() => {});
    const panelText = (await text(page, SEL.panel)).trim();
    ck(!!panelText, `a confirmation PANEL replaced the form — "${panelText}"`,
       'the 1 Sep fix; before it this branch closed the dialog and fired a toast');
    ck(await page.locator(SEL.form).count() === 0, `and the form is gone, not merely covered`);

    const echoed = await text(page, '.dialog--gate bdi');
    ck(echoed.includes(PROBE_EMAIL),
       `it echoes the address back inside a <bdi> (§6: user strings are isolated)`,
       `got ${JSON.stringify(echoed)}`);

    /* THE PART THAT MATTERS, and what a plain DOM check would have missed: it PERSISTS.
       A toast is gone in 3.2 s. */
    await page.waitForTimeout(6000);
    ck(await page.locator(SEL.panel).count() === 1,
       `still on screen 6 s later — it does not time out the way a toast does`);

    const dismiss = page.locator('.dialog--gate .btn').last();
    ck(await dismiss.evaluate(REACHABLE).catch(() => false),
       `its dismiss button is REACHABLE, not merely present in the DOM`);
    await dismiss.click();
    await page.waitForTimeout(400);
    ck(await page.locator('.dialog--gate').count() === 0, `and dismissing it closes the dialog`);

    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    await page.context().close();
  }

  /* ── 2 · a member signs in and LANDS ─────────────────────── */

  section(2, "member sign-in → the session is adopted and the masthead becomes a member's");
  {
    const page = await newPage();
    const session = await mintDisposable('member');

    /* The form's own call, answered with a REAL session. Everything after this line — the
       masthead, /me, the engagement refresh — talks to the real backend with a real token,
       so a policy or grant that refuses a signed-in member still fails here. */
    await page.route(PASSWORD_GRANT, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await ready(page);

    await page.click(SEL.mastheadSignIn);
    await page.waitForSelector(SEL.form, { timeout: 10000 });
    ck(await page.locator(SEL.handle).count() === 0, `the sign-in form asks for no handle`);
    ck(await page.locator('form.dialog--form .captcha').count() === 1,
       `a captcha slot is mounted on SIGN-IN too, not only on signup`,
       'the /admin form had none while GoTrue captcha was on, and every correct password was refused');

    await fillAuthForm(page, { email: session.email, password: 'intercepted-by-the-harness' });
    await page.waitForTimeout(3000);

    ck(await page.locator(SEL.form).count() === 0, `the dialog closed on a successful sign-in`);
    ck(await page.evaluate(() => !!(window.AUTH && window.AUTH.user())),
       `AUTH.user() is populated — the session was adopted, not merely received`);

    /* The masthead must actually BECOME a member's. This is what "lands correctly" means:
       a sign-in that leaves the page offering Sign in / Create account has not landed. */
    const masthead = await page.evaluate(() => ({
      signOut: !!document.querySelector('#masthead .masthead__signout'),
      avatar: !!document.querySelector('#masthead .avatar-btn'),
    }));
    ck(masthead.signOut, `the masthead now offers Sign out`);
    ck(masthead.avatar, `and an avatar linking to /me`);

    /* auth.js keeps the ACCESS token in a module variable and the REFRESH token in
       sessionStorage, on purpose: §7's contributors are sometimes on borrowed devices, and
       sessionStorage dies with the tab where localStorage sits on disk. */
    ck(!!(await page.evaluate(() => sessionStorage.getItem('rma.refresh'))),
       `the refresh token is in sessionStorage`);
    ck(!(await page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k) || '').join('|').includes('eyJ'))),
       `and nothing JWT-shaped was written to localStorage, which outlives the tab`);

    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    await page.context().close();
  }

  /* ── 3 · the admin dashboard. NO doubles at all. ─────────── */

  section(3, 'admin → admin.js is imported and the DASHBOARD RENDERS (the two-day regression)');
  {
    /* No Turnstile stub and no route interception. The page restores a real session from
       sessionStorage exactly as a returning moderator's browser does, calls the real
       authz_role(), fetches admin.js, and renders against the real database. This is the
       shape of test that would have caught the silent breakage. */
    const page = await newPage({ withTurnstile: false });
    const session = await mintDisposable('admin');

    const adminJs = [];
    page.on('response', (r) => {
      if (/admin\.js/.test(r.url())) adminJs.push({ status: r.status() });
    });

    await page.goto(`${ORIGIN}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => sessionStorage.setItem('rma.refresh', t), session.refresh_token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);

    ck(await page.evaluate(() => !!(window.AUTH && window.AUTH.user())),
       `the stored refresh token restored a real session on load, with no form and no captcha`);

    /* admin-boot.js gates on DB.rpc('authz_role') — the DATABASE, not the JWT claim — and
       that distinction is load-bearing on this project: the hosted instance does not run
       the access-token hook, so a gate reading the claim would refuse every admin. */
    const role = await page.evaluate(() => (window.DB ? window.DB.rpc('authz_role') : null));
    ck(role === 'admin', `authz_role() answers 'admin' from the page itself (got ${JSON.stringify(role)})`);

    ck(adminJs.length > 0, `admin.js was actually fetched (${JSON.stringify(adminJs)})`,
       '§5: dynamically imported after the role check — the bytes must not ship to a member');
    ck(adminJs.every((r) => r.status === 200), `and it answered 200`);
    /* admin.js is an IIFE that exports NOTHING — `(function (global) { ... })(window)` with
       no assignment out — so there is no global to look for, and an earlier draft asserting
       `window.ADMIN` was testing a module boundary this file does not have. What proves the
       script RAN rather than merely downloaded is the navigation it builds: #rail is empty
       markup in admin.html until admin.js mounts it. */
    const rail = await page.evaluate(() => Array.from(
      document.querySelectorAll('#rail a, #rail button'),
    ).map((x) => (x.textContent || '').trim()).filter(Boolean));
    ck(rail.length >= 8,
       `admin.js RAN — it mounted ${rail.length} navigation entries into #rail`,
       'downloading the file and running it are different facts; #rail is empty until it runs');

    /* "Rendered" means a dashboard a moderator can act on. A node with no layout is what
       29 Aug's audit found and what a querySelector calls a pass. */
    const shell = await page.evaluate(() => {
      const main = document.querySelector('#main');
      if (!main) return { found: false };
      const cs = getComputedStyle(main);
      const r = main.getBoundingClientRect();
      return {
        found: true,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        chars: (main.textContent || '').trim().length,
        buttons: main.querySelectorAll('button').length,
        gate: !!main.querySelector('.admin-gate'),
        text: (main.textContent || '').trim().slice(0, 160),
      };
    });
    ck(shell.found && shell.visible, `#main has real layout`);
    ck(shell.chars > 60, `the dashboard rendered content, not an empty shell (${shell.chars} chars)`,
       `text: ${JSON.stringify(shell.text)}`);
    ck(!shell.gate, `and it is NOT still sitting on the gate/refusal screen`,
       `text: ${JSON.stringify(shell.text)}`);
    /* The overview is numbers computed from the real archive, not a skeleton. Asserted as
       "it contains digits" rather than on a specific count, because the archive changes
       and a test pinned to today's six items is a test that fails on the seed import. */
    ck(/[0-9\u0660-\u0669]/.test(shell.text),
       `and it shows real figures from the live archive`, `text: ${JSON.stringify(shell.text)}`);

    const overview = await page.evaluate(() => {
      const r = document.querySelector('#rail');
      const cs = r ? getComputedStyle(r) : null;
      const box = r ? r.getBoundingClientRect() : null;
      return { present: !!r, visible: !!cs && cs.display !== 'none' && box.width > 0 && box.height > 0 };
    });
    ck(overview.present && overview.visible,
       `the moderator's navigation rail is REACHABLE, not merely in the DOM`);

    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    const real = page.consoleErrors.filter((e) => !/favicon|ERR_/.test(e));
    ck(real.length === 0, `no console errors`, real.slice(0, 3).join('\n        '));
    await page.context().close();
  }

  /* ── 4 · §9's gate preserves intent ──────────────────────── */

  section(4, '§9 — the sign-in gate preserves intent through the auth round-trip');
  {
    const page = await newPage();
    const session = await mintDisposable('member');
    await page.route(PASSWORD_GRANT, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }));

    /* The intent is watched at the NETWORK, not at the DOM. §9's promise is that the
       pending ACTION runs; a heart that fills in because the UI is optimistic would satisfy
       a DOM assertion while the like never reached the database. */
    const likeWrites = [];
    page.on('request', (r) => {
      if (/\/rest\/v1\/likes/.test(r.url()) && r.method() === 'POST') likeWrites.push(r.url());
    });

    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForSelector('.memory', { timeout: 20000 });

    ck(!(await page.evaluate(() => !!(window.AUTH && window.AUTH.user()))),
       `the visitor starts signed OUT`);

    /* The like control is `.rail-action`, and it exists only INSIDE the viewer — the feed
       grid has no engagement chrome at all. An earlier draft swept every button on the
       landing page, found none, and reported "no member-only control" about a site that
       has three per item. Open an item the way a visitor does. */
    ck(await page.locator('.rail-action').count() === 0,
       `the feed grid carries no engagement controls — they live in the viewer`);
    await page.locator('.memory').first().click();
    await page.waitForSelector('#viewer .rail-action', { timeout: 15000 });

    const label = await page.locator('.rail-action').first().getAttribute('aria-label');
    ck(/تسجيل الدخول|sign in/i.test(label ?? ''),
       `and while signed out the control announces the gate in its label — "${label}"`,
       'a padlock a screen reader cannot hear is not an affordance');

    await page.locator('.rail-action').first().click();
    ck(true, `the like control was pressed while signed out`);

    await page.waitForSelector(SEL.gate, { timeout: 10000 }).catch(() => {});
    ck(await page.locator(SEL.gate).count() > 0,
       `the GATE opened rather than a failed request (§9, guard())`);
    ck(likeWrites.length === 0, `and nothing was written while signed out`);

    await page.click(SEL.gateSignIn);
    await fillAuthForm(page, { email: session.email, password: 'intercepted-by-the-harness' });
    await page.waitForTimeout(5000);

    ck(await page.evaluate(() => !!(window.AUTH && window.AUTH.user())), `the member is signed in`);
    ck(likeWrites.length > 0,
       `THE PENDING ACTION RAN after the round-trip — ${likeWrites.length} like write(s) reached PostgREST`,
       "§9: 'the sign-in gate always preserves intent'. Nothing has ever tested this.");

    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    await page.context().close();

    /* The like was REAL — that is the whole point of watching the network rather than the
       DOM — so it is removed again. A like also bumps the counter revision, which §6
       throttles to one republish an hour; leaving harness likes on the archive would make
       the publish-age monitor answer for this file's fixtures. */
    const removed = await fetch(
      `${SUPABASE}/rest/v1/likes?user_id=eq.${session.user?.id ?? decodeSub(session.access_token)}`,
      { method: 'DELETE', headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } },
    );
    ck(removed.ok, `the harness member's likes were removed again (${removed.status})`);
  }

  /* ── 5 · the password reset, both halves ─────────────────── */

  section(5, 'password reset — the request, the landing, and the two dead ends');
  {
    /* Half one: the request.
     *
     * "Forgot password?" was a stub that toasted its own label from M1 until 3 Sep 2026,
     * so there is nothing here to regress against — this is the first run of the path.
     * The request is watched at the NETWORK: a dialog that changes into a confirmation
     * panel without POSTing anything would satisfy every DOM assertion below and send no
     * mail, which is precisely the failure mode the stub had. */
    const page = await newPage();
    const posted = [];
    await page.route(RECOVER, (route) => {
      posted.push(JSON.parse(route.request().postData() ?? '{}'));
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await ready(page);

    await page.click(SEL.mastheadSignIn);
    await page.waitForSelector(SEL.form, { timeout: 10000 });
    ck(await page.locator('form.dialog--form .field__hint').count() > 0,
       `the sign-in form carries the "forgot password" control`);

    await page.click('form.dialog--form .field__hint');
    await page.waitForSelector(SEL.email, { timeout: 10000 });
    ck(await page.locator(SEL.password).count() === 0,
       `it opens a form asking for an EMAIL and no password — a different mode, not the same dialog`);

    await page.fill(SEL.email, 'reset-probe@mail.example.com');
    await page.click(SEL.submit);
    await page.waitForSelector(SEL.panel, { timeout: 10000 }).catch(() => {});

    ck(posted.length === 1, `POST /auth/v1/recover actually happened (${posted.length})`);
    ck(posted[0]?.gotrue_meta_security?.captcha_token === 'harness-stub-token',
       `...carrying a Turnstile token — the widget was mounted and waited on, not skipped`);
    ck(posted[0]?.redirect_to === `${ORIGIN}/reset`,
       `...and redirect_to pointing at this origin's /reset (${posted[0]?.redirect_to})`);

    const panel = await text(page, SEL.panel);
    ck(!!panel, `a confirmation PANEL replaced the form — "${panel}"`);
    await page.waitForTimeout(6000);
    ck(await page.locator(SEL.panel).count() > 0,
       `and it is STILL there 6 s later — it persists until dismissed, like the signup panel`);
    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    await page.context().close();
  }

  {
    /* The mail cap gets its own sentence. Amro's project has no custom SMTP, so
       over_email_send_rate_limit is not a hypothetical here — it is the refusal a real
       member meets today, and telling them "too many attempts" for somebody else's
       cooldown is the defect this asserts against. */
    const page = await newPage();
    await page.route(RECOVER, (route) => route.fulfill({
      status: 429, contentType: 'application/json',
      body: JSON.stringify({ error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' }),
    }));

    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.click(SEL.mastheadSignIn);
    await page.waitForSelector(SEL.form, { timeout: 10000 });
    await page.click('form.dialog--form .field__hint');
    await page.waitForSelector(SEL.email, { timeout: 10000 });
    await page.fill(SEL.email, 'reset-probe@mail.example.com');
    await page.click(SEL.submit);
    await page.waitForSelector('form.dialog--form .form-error:not([hidden])', { timeout: 10000 }).catch(() => {});

    const msg = await text(page, 'form.dialog--form .form-error');
    /* Three assertions, not one, and the first exists because a single one SURVIVED its own
       mutation: "the limit is ours" is true of auth.err.mailLimit AND of the reset-specific
       string that replaced it, so an assertion on that clause tested the pre-existing
       signup wording and said nothing about this screen. What this screen has to get right
       is the NOUN — a member waiting for a reset link told "we could not send the
       confirmation email" reasonably concludes they are on the wrong screen. */
    ck(/رابط الاستعادة/.test(msg),
       `the mail cap names the RESET LINK, not a confirmation email — "${msg.slice(0, 46)}…"`,
       'reset.err.mailLimit vs auth.err.mailLimit: same 429, and the wrong noun on this screen');
    ck(/من جهتنا/.test(msg),
       `...and says the sending limit is OURS rather than blaming the member`,
       'auth.err.mailLimit vs auth.err.rateLimit: two different 429s, two different next actions');
    ck(!/محاولات كثيرة/.test(msg),
       `...and is NOT the "too many attempts" string`);
    ck(await page.locator(SEL.panel).count() === 0, `a refused request does not show the sent panel`);
    await page.context().close();
  }

  {
    /* Half two: the landing.
     *
     * GoTrue's /verify consumes the token server-side and 302s with the session in the URL
     * FRAGMENT. Nothing here fakes the app's own code — the fragment below is the exact
     * shape GoTrue emits, and the page is asked to do with it what it would do with a real
     * one. The only double is the PUT that would change a real password. */
    const page = await newPage();
    const puts = [];
    await page.route(USER, (route) => {
      puts.push({ method: route.request().method(), headers: route.request().headers(),
                  body: JSON.parse(route.request().postData() ?? '{}') });
      route.fulfill({ status: 200, contentType: 'application/json',
                      body: JSON.stringify({ id: 'u-recovered', email: 'recovered@mail.example.com',
                                             app_metadata: {} }) });
    });

    await page.goto(
      `${ORIGIN}/#access_token=HARNESS-RECOVERY-ACCESS&refresh_token=HARNESS-RECOVERY-REFRESH` +
      `&expires_in=3600&token_type=bearer&type=recovery`,
      { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForSelector('.authpage__form', { timeout: 15000 }).catch(() => {});

    ck(await page.locator('.authpage__form').count() > 0,
       `a recovery fragment at the SITE ROOT renders the set-a-password screen`,
       'this is the landing that happens when the Auth allowlist does not admit /reset');
    ck(new URL(page.url()).pathname === '/reset' && !page.url().includes('access_token'),
       `and the URL is now ${new URL(page.url()).pathname} with the session REPLACED out of it`,
       'a session in an address bar survives into history and into a screenshot');

    ck(await page.evaluate(() => !window.AUTH.isSignedIn() && window.AUTH.hasRecovery()),
       `the link is HELD and nobody is signed in yet — §7, shared and borrowed devices`);
    ck(await page.evaluate(() => { try { return window.sessionStorage.getItem('rma.refresh') === null; }
                                   catch (e) { return false; } }),
       `...and nothing was written to sessionStorage`);

    const boxes = page.locator('.authpage__form input[type="password"]');
    ck(await boxes.count() === 2, `two password boxes — the new one and its confirmation`);
    const labelled = await page.evaluate(() =>
      [...document.querySelectorAll('.authpage__form input')]
        .every((i) => !!document.querySelector(`label[for="${i.id}"]`)));
    ck(labelled, `both carry a real <label for>, not a placeholder standing in for one`);

    /* Local validation refuses BEFORE the network — a round-trip to be told "eight
       characters" is a round-trip the member does not need to make. */
    await boxes.nth(0).fill('short');
    await boxes.nth(1).fill('short');
    await page.click('.authpage__form button[type="submit"]');
    await page.waitForTimeout(400);
    ck(puts.length === 0 && await page.locator('.authpage__form .form-error:not([hidden])').count() > 0,
       `a too-short password is refused locally and sends nothing`);

    await boxes.nth(0).fill('a-long-enough-password');
    await boxes.nth(1).fill('a-different-password');
    await page.click('.authpage__form button[type="submit"]');
    await page.waitForTimeout(400);
    const mismatch = await text(page, '.authpage__form .form-error');
    ck(puts.length === 0 && /متطابق|match/i.test(mismatch),
       `a mismatch is its own message rather than the length one — "${mismatch}"`);

    await boxes.nth(1).fill('a-long-enough-password');
    await page.click('.authpage__form button[type="submit"]');
    await page.waitForTimeout(1500);

    ck(puts.length === 1 && puts[0].method === 'PUT',
       `a valid password PUTs /auth/v1/user (${puts.length} call(s))`);
    ck(puts[0]?.headers.authorization === 'Bearer HARNESS-RECOVERY-ACCESS',
       `...authenticated by the recovery session the link carried`);
    ck(puts[0]?.body.password === 'a-long-enough-password', `...and carries the new password`);
    ck(await page.evaluate(() => window.AUTH.isSignedIn()),
       `and only NOW is the member signed in — never a dead end, and never before the reset`);
    ck(await page.locator('#masthead .avatar-btn').count() > 0,
       `the masthead agrees without a reload — the avatar is there`);
    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    await page.context().close();
  }

  {
    /* The two ways there is no usable link, and neither may be a blank screen. */
    const page = await newPage();
    await page.goto(`${ORIGIN}/#error=access_denied&error_code=otp_expired` +
                    `&error_description=Email+link+is+invalid+or+has+expired`,
                    { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForSelector('.authpage__card', { timeout: 15000 }).catch(() => {});

    ck(await page.locator('.authpage__card').count() > 0,
       `an EXPIRED link renders a screen rather than dropping the visitor on the archive`);
    ck(new URL(page.url()).pathname === '/reset', `...at /reset`);
    ck(await page.locator('.authpage__card .btn--primary').count() > 0,
       `...with a way to ask for a new link on it (§9: never a dead end)`);
    ck(await page.locator('.authpage__form').count() === 0,
       `...and NOT a password form that could never work`);

    /* Direct navigation. This is the History API assertion the whole route depends on:
       /reset is not a file, so it only resolves because site/_redirects serves the SPA
       shell with a 200 for anything unmatched. The dev server above implements that same
       rule, so this proves the ROUTE — the deployed behaviour is the _redirects file, and
       frontend-csp-test already pins that. */
    const res = await page.goto(`${ORIGIN}/reset`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    ck(res?.status() === 200, `GET /reset answers 200 under History API routing (${res?.status()})`);
    ck(await page.locator('.authpage__card').count() > 0,
       `...and renders the reset screen, not a 404 and not the archive`);
    ck(await page.locator('.authpage__card .btn--primary').count() > 0,
       `...with the request-a-link action, so a bookmark or a reload is not a dead end either`);
    ck(page.pageErrors.length === 0, `no uncaught page errors`, page.pageErrors.join('\n        '));
    await page.context().close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${executed} checks, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('OK.\n');
