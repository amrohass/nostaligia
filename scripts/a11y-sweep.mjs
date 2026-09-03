#!/usr/bin/env node
/* §9's accessibility requirements, exercised rather than located.
 *
 *     PLAYWRIGHT_DIR=<node_modules> AXE_DIR=<node_modules> node scripts/a11y-sweep.mjs
 *     ... node scripts/a11y-sweep.mjs --headed
 *
 * ── What §9 actually asks for ────────────────────────────────
 *
 *   "Accessibility: viewer needs focus trap, aria-modal, Escape, focus restore. Required
 *    description field on upload (frame it as archival metadata). Respect
 *    prefers-reduced-motion."
 *
 * Six named things. All six are implemented; none had ever been verified. And every one of
 * them is the kind of requirement that a grep satisfies and a keyboard does not:
 * `UI.trapFocus` exists and is called, `aria-modal` is in the markup, `tokens.css` has a
 * `prefers-reduced-motion` block. That is what the code CONTAINS. Whether Tab actually
 * stays inside the dialog, whether focus comes back to the control that opened it, and
 * whether the animation actually stops are different questions, and only a browser can
 * answer them.
 *
 * So this file presses keys. axe-core runs alongside it for the whole class of things
 * nobody thought to require — contrast, names, landmarks, duplicate ids — across the
 * public surfaces and the admin dashboard.
 *
 * ── Scope, stated plainly ────────────────────────────────────
 *
 * axe catches roughly a third of real accessibility defects and cannot judge whether a
 * label makes sense in Arabic, whether the reading order matches the visual one, or
 * whether a screen reader announces the decade slider usefully. A clean run here is a
 * floor, not a certificate. Findings outside §9's six are REPORTED and not fixed —
 * they are new scope, and §12 says the smallest change that satisfies the task.
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { mintDisposable } from './lib/harness-auth.mjs';

const HEADED = process.argv.includes('--headed');

const pwDir = process.env.PLAYWRIGHT_DIR;
const pw = await (pwDir
  ? import(pathToFileURL(join(pwDir, 'playwright', 'index.js')).href)
  : import('playwright')).catch(() => {
  console.error('a11y-sweep: playwright not found. Set PLAYWRIGHT_DIR.');
  process.exit(2);
});
const { chromium } = pw.default ?? pw;

const axeDir = process.env.AXE_DIR ?? pwDir;
const AXE_SOURCE = readFileSync(join(axeDir, 'axe-core', 'axe.min.js'), 'utf8');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = join(root, 'site');
const PORT = 3000;
const ORIGIN = `http://localhost:${PORT}`;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png',
};
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let f = join(SITE, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
  if (!existsSync(f) || statSync(f).isDirectory()) f = join(SITE, 'index.html');
  res.writeHead(200, { 'Content-Type': TYPES[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(PORT, r));

const STRICT = process.argv.includes('--strict');

/* TWO LISTS, and the split is the point rather than bookkeeping.
 *
 * §9 names six things. Those are requirements this project wrote down, and a run that
 * finds one broken must go red — they are the gate.
 *
 * axe finds everything else: contrast, missing names, landmarks. Those are real and some
 * are severe, but they are NEW SCOPE — §12 says the smallest change that satisfies the
 * task, and repainting a colour system or relabelling a form is a design decision with an
 * owner who is not this session. They are reported in full, loudly, and do not fail the
 * run. `--strict` makes them fail too, which is what a later session should turn on once
 * somebody has decided what the palette is.
 */
let executed = 0;
const failures = [];
const findings = [];
function ck(cond, msg, detail) {
  executed++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures.push(msg);
}

/** An axe result: printed like a check, counted as a finding, fatal only under --strict. */
function found(clean, msg, detail) {
  executed++;
  console.log(`  ${clean ? '✓' : '!'} ${msg}${clean || !detail ? '' : `\n        ${detail}`}`);
  if (!clean) {
    findings.push(msg);
    if (STRICT) failures.push(msg);
  }
}
const section = (n, title) => console.log(`\n${n} · ${title}`);

const browser = await chromium.launch({ headless: !HEADED });

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  const page = await ctx.newPage();
  /* Turnstile does not answer automation, so any surface behind the auth dialog needs the
     same accessor stub e2e-browser.mjs uses. Nothing else about the page changes. */
  await page.addInitScript(`
    (function () {
      var stub = { mount: function () { return { token: function () { return Promise.resolve('stub'); },
        reset: function () {}, remove: function () {} }; }, whenReady: function () { return Promise.resolve(); } };
      Object.defineProperty(window, 'TURNSTILE', {
        configurable: true, get: function () { return stub; }, set: function () {} });
    })();
  `);
  return page;
}

const ready = async (page) => {
  await page.waitForFunction(() => window.AUTH && window.UI && window.I18N, null, { timeout: 20000 });
  await page.waitForSelector('#masthead .masthead__actions button', { timeout: 20000 });
};

/* ── axe, run the same way everywhere ───────────────────────── */

async function axe(page, label) {
  await page.addScriptTag({ content: AXE_SOURCE });
  const results = await page.evaluate(async () => {
    /* wcag2a/wcag2aa only. axe's "best-practice" rules include opinions (a single main
       landmark, heading-order) that are worth reading and are not conformance failures,
       and mixing them into a pass/fail number makes the number mean nothing. */
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return r.violations.map((v) => ({
      id: v.id, impact: v.impact, help: v.help, n: v.nodes.length,
      sample: v.nodes.slice(0, 2).map((n) => n.target.join(' ')),
    }));
  });
  const serious = results.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  found(serious.length === 0, `${label}: no critical or serious axe violations`,
     serious.map((v) => `${v.impact} · ${v.id} (${v.n}×) — ${v.help}\n          ${v.sample.join('\n          ')}`).join('\n        '));
  for (const v of results.filter((x) => !serious.includes(x))) {
    findings.push(`${label}: ${v.impact} · ${v.id} (${v.n}×) — ${v.help}`);
  }
  return results;
}

console.log(`\n§9's accessibility requirements, exercised`);
console.log(`  site ${ORIGIN}\n`);

try {
  /* ── 1 · axe across the public surfaces ─────────────────── */

  section(1, 'axe-core — WCAG 2.1 A/AA across every public surface');
  {
    for (const route of ['/', '/map', '/events']) {
      const page = await newPage();
      await page.goto(`${ORIGIN}${route}`, { waitUntil: 'domcontentloaded' });
      await ready(page);
      await page.waitForTimeout(3500);
      await axe(page, `route ${route}`);
      await page.context().close();
    }
  }

  /* ── 2 · the viewer modal, §9's four named requirements ─── */

  section(2, '§9 — the viewer: focus trap, aria-modal, Escape, focus restore');
  {
    const page = await newPage();
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForSelector('.memory', { timeout: 20000 });

    /* Focus the card the way a keyboard user reaches it, so "restore" has somewhere real
       to go back to.

       Recorded by HREF, not by node identity. The first version of this check stamped the
       element with an attribute and asserted the same element came back — which no correct
       implementation can satisfy: the archive re-renders on the route change to
       /item/{id}, so every card is a new element by the time the viewer closes. §9's
       requirement is that the keyboard user is returned to WHERE THEY WERE, and an
       equal-looking card for the same item is exactly where they were. Asserting node
       identity would have failed the fix that makes the requirement true. */
    const opener = await page.evaluate(() => {
      const card = document.querySelector('.memory');
      const target = card.matches('a,button') ? card : (card.querySelector('a,button') ?? card);
      target.focus();
      return document.activeElement === target ? target.getAttribute('href') : null;
    });
    ck(!!opener, `a feed card is focusable from the keyboard (${opener})`);

    await page.keyboard.press('Enter');
    await page.waitForSelector('#viewer', { timeout: 15000 });
    ck(true, `Enter on the card opens the viewer`);

    const modal = await page.evaluate(() => {
      const v = document.querySelector('#viewer');
      return { role: v?.getAttribute('role'), modal: v?.getAttribute('aria-modal'),
               label: v?.getAttribute('aria-label') };
    });
    ck(modal.modal === 'true', `#viewer carries aria-modal="true" (§9)`, JSON.stringify(modal));
    ck(modal.role === 'dialog', `and role="dialog"`, JSON.stringify(modal));
    ck(!!modal.label, `and an accessible name — "${modal.label}"`);

    /* THE FOCUS TRAP, pressed rather than located. Tab far more times than the dialog has
       controls: a trap that holds for one cycle and leaks on the next is the common bug,
       and a single Tab would not find it. */
    const inside = await page.evaluate(async () => {
      const v = document.querySelector('#viewer');
      const seen = [];
      for (let i = 0; i < 30; i++) {
        const el = document.activeElement;
        seen.push({ inside: !!el && v.contains(el), tag: el?.tagName, cls: el?.className });
        /* Dispatched rather than driven from the harness so the loop stays inside one
           evaluate; the listener under test is a keydown handler either way. */
        el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      }
      return seen;
    });
    const escaped = inside.filter((s) => !s.inside);
    ck(escaped.length === 0, `focus never leaves the viewer across 30 Tab presses`,
       escaped.length ? `escaped to: ${escaped.slice(0, 3).map((e) => `${e.tag}.${e.cls}`).join(', ')}` : '');

    /* And with real key events through the browser, which exercise the browser's own
       sequential-focus-navigation rather than only the page's handler. The difference
       matters: a handler that only rewrites focus on the FIRST and LAST element still lets
       the browser walk out of a container it does not know about. */
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(() =>
      !!document.activeElement && document.querySelector('#viewer')?.contains(document.activeElement));
    ck(stillInside, `and after 25 REAL Tab presses focus is still inside the viewer`,
       'a keydown handler that only wraps at the ends does not stop the browser walking past them');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    ck(await page.locator('#viewer').count() === 0, `Escape closes the viewer (§9)`);

    const landed = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, href: el?.getAttribute?.('href') ?? null,
               cls: el?.className ?? null, isBody: el === document.body };
    });
    ck(!landed.isBody, `focus is NOT left on <body> after the viewer closes`,
       'that strands a keyboard user at the top of the page with the whole feed to tab through again');
    ck(landed.href === opener,
       `and it is RESTORED to the card the viewer was opened on (§9) — ${landed.href}`,
       `expected href ${opener}, landed on ${landed.tag}.${landed.cls} href=${landed.href}`);

    await page.context().close();
  }

  /* ── 3 · prefers-reduced-motion ─────────────────────────── */

  section(3, '§9 — prefers-reduced-motion is respected, not merely declared');
  {
    /* The CSS block exists. What matters is whether the durations actually collapse, so
       both states are measured and COMPARED — a media query that matches and changes
       nothing looks identical to one that is absent. */
    const measure = async (motion) => {
      const page = await newPage({ reducedMotion: motion });
      await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
      await ready(page);
      await page.waitForSelector('.memory', { timeout: 20000 });
      const out = await page.evaluate(() => {
        const durations = [];
        for (const el of document.querySelectorAll('.memory, .btn, .masthead, .navlink, body, #main')) {
          const cs = getComputedStyle(el);
          for (const v of [cs.transitionDuration, cs.animationDuration]) {
            for (const part of String(v).split(',')) {
              const n = parseFloat(part);
              if (!Number.isNaN(n)) durations.push(part.includes('ms') ? n : n * 1000);
            }
          }
        }
        return { total: durations.reduce((a, b) => a + b, 0), n: durations.length,
                 matches: matchMedia('(prefers-reduced-motion: reduce)').matches };
      });
      await page.context().close();
      return out;
    };

    const normal = await measure('no-preference');
    const reduced = await measure('reduce');
    ck(reduced.matches && !normal.matches, `the media query is seen by the page in both states`);
    ck(normal.total > 0, `with motion allowed the page declares ${normal.total.toFixed(0)} ms of animation`,
       'if this is 0 the comparison below is vacuous — there was nothing to reduce');
    ck(reduced.total < normal.total,
       `and with reduce set it drops to ${reduced.total.toFixed(0)} ms`,
       `normal ${normal.total.toFixed(0)} ms vs reduced ${reduced.total.toFixed(0)} ms across ${normal.n} declarations`);
  }

  /* ── 4 · the upload form's required description ─────────── */

  section(4, '§9 — the description field on upload is REQUIRED (archival metadata)');
  {
    const page = await newPage();
    const session = await mintDisposable('member');
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => sessionStorage.setItem('rma.refresh', t), session.refresh_token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready(page);
    await page.waitForTimeout(2500);

    const opened = await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('#masthead button, #masthead a'))
        .find((x) => /share|plus/i.test(x.className) || x.querySelector('.plus'));
      if (b) { b.click(); return true; }
      return false;
    });
    ck(opened, `the share/upload control is reachable when signed in`);
    await page.waitForSelector('form, .dialog', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const fields = await page.evaluate(() => Array.from(
      document.querySelectorAll('.scrim textarea, .scrim input[type="text"], .scrim input:not([type])'),
    ).map((el) => ({
      tag: el.tagName, required: el.required, name: el.getAttribute('aria-label') ?? el.placeholder ?? '',
      id: el.id, labelled: !!(el.getAttribute('aria-label') || el.labels?.length),
    })));

    const description = fields.find((f) => f.tag === 'TEXTAREA');
    ck(!!description, `the form has a description field`, JSON.stringify(fields).slice(0, 300));
    if (description) {
      ck(description.required, `and it is marked required (§9)`, JSON.stringify(description));
      ck(description.labelled, `and it has an accessible name — "${description.name}"`);
    }
    /* Not one of §9's six, so reported rather than gated — but it is on the upload form,
       which is the one screen in the archive a contributor MUST complete, so it is the
       finding on this page most worth somebody's attention. */
    const unlabelled = fields.filter((f) => !f.labelled);
    found(unlabelled.length === 0, `every field on the upload form has an accessible name`,
       unlabelled.map((f) => `${f.tag} ${f.id || '(no id)'}`).join(', '));

    await axe(page, 'the upload dialog');
    await page.context().close();
  }

  /* ── 5 · the admin dashboard ────────────────────────────── */

  section(5, 'the admin dashboard — the surface a moderator uses every day');
  {
    const page = await newPage();
    const session = await mintDisposable('admin');
    await page.goto(`${ORIGIN}/admin.html`, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => sessionStorage.setItem('rma.refresh', t), session.refresh_token);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(9000);
    await axe(page, 'the admin dashboard');
    await page.context().close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${executed} checks · ${failures.length} FAILED · ${findings.length} finding(s)`);

if (failures.length) {
  console.log(`\n§9 CONFORMANCE FAILURES — these are requirements this project wrote down:`);
  for (const f of failures) console.log(`  ✗ ${f}`);
}

if (findings.length) {
  console.log(`\nFINDINGS — real accessibility defects OUTSIDE §9's six named requirements.`);
  console.log(`Reported for a decision, not fixed here: repainting a colour system or`);
  console.log(`relabelling a form is a design change with an owner. Run with --strict to`);
  console.log(`gate on them once that decision exists.\n`);
  for (const f of [...new Set(findings)]) console.log(`  ! ${f}`);
}

if (!failures.length && !findings.length) console.log('\nOK.');
console.log('');
process.exit(failures.length ? 1 : 0);
