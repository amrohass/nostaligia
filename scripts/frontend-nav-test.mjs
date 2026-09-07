// public.js, rendered — the things that are true of NODES and not of source.
//
// Every other front-end test here reads the file or pokes one module. This one boots the
// whole public shell against scripts/lib/dom-stub.mjs and a stubbed release, then asks the
// rendered tree questions. It exists because the defects it covers all had the same shape:
// the code looked right, the source scan had nothing to catch, and the wrong thing was a
// value that only exists after a render.
//
// ── What is asserted, and why each one could not be asserted before ──
//
//   1 · THE BACK BUTTON'S TARGET. §9 asks the front end to return a reader where they were.
//     The viewer's own button was the literal `href: '/'` from M3 until 6 Sep 2026, so a
//     memory opened from /map, /events or a profile put the reader at the top of the
//     archive. The browser's Back worked, which is why nothing looked broken. A regex
//     asserting the literal is gone would pass the moment somebody moved '/' into a
//     variable, so this navigates for real and reads the href off the rendered anchor.
//     Escape is asserted with it, on the URL: it called closeViewer() directly, which
//     removed the overlay and left the address bar naming a memory nobody was looking at.
//
//   2 · THE MAP'S LIST IS A GRID. §1: "same grid language". /map built `.grid` around a
//     SINGLE `.grid__col`, which is a one-column flexbox — the archive's class names with
//     none of its layout, at every width. Only a count of the rendered columns can tell the
//     two apart; both produce `.grid`.
//
//   3 · IT SCALES, ABOVE 1040px. Four columns was the last stop at any width, so 1200 and
//     1920 rendered identically. Four widths rather than two, because a narrow-vs-wide pair
//     passes under that cap — that was the first version of this assertion and the mutation
//     below survived it.
//
//   4 · THE CHOSEN HANDLE IS SAVED. It was an INSERT into a row 0057's trigger had already
//     created, so it was a primary-key 409 reported to the member as "that handle is
//     taken". The database call is the assertion: an INSERT here is the bug returning.
//
//   5 · THE ACCOUNT PANEL'S THREE STATES. Both controls (§11 gate 5's neighbours: password
//     reset and the confirmation resend) are asserted present and asserted to open the
//     right dialog. The third state is the one deployed today — 0060 is not applied, so the
//     status RPC 404s and state.confirmed stays null — and the row must say it does not
//     know rather than announce that the address is confirmed.
//
// Every one of these was mutation-checked: putting each fix back the way it was turns this
// file red. Two of the assertions here exist in their current shape BECAUSE the first
// version survived that check.
//
//     node scripts/frontend-nav-test.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, textOf } from './lib/dom-stub.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/* ── A release, small enough to read and real enough to render ────────────── */

const RELEASE = '/v/2026-09-06T00:00:00Z/';

function entry(id, extra = {}) {
  return {
    id, kind: 'media', title_ar: 'ذكرى ' + id, title_en: 'memory ' + id,
    decade: 1960, date_precision: 'decade', thumb: null, thumb_w: null, thumb_h: null,
    author: { handle: 'someone', display_name: 'Someone', label: 'member' },
    likes: 0, comments: 0, day: '2026-09-01', ...extra,
  };
}

const FEED = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'].map((id) => entry(id))
  // One event, so /events — the third of §1's public surfaces — has something to open.
  .concat([entry('e1', { kind: 'event' })]);
const GEO = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'].map((id) =>
  entry(id, { lat: 31.9, lon: 35.2, precision: 'street' }));

const SHARDS = {
  '/manifest.json': { release: RELEASE, generated_on: '2026-09-06' },
  '/redactions.json': { ids: [] },
  [RELEASE + 'content.json']: { blocks: { 'hero.line': { ar: 'ذاكرة', en: 'Memory' } } },
  [RELEASE + 'index.json']: { pages: 1, total: FEED.length, decades: [1960], cells: ['sv8w0'] },
  [RELEASE + 'feed/page-1.json']: { page: 1, pages: 1, total: FEED.length, items: FEED },
  [RELEASE + 'geo/sv8w0.json']: { cell: 'sv8w0', total: GEO.length, items: GEO },
  [RELEASE + 'places.json']: { places: [] },
  [RELEASE + 'item/a1.json']: {
    ...entry('a1'), body_ar: '', body_en: '', media: [], comment_count: 0, comments: [],
  },
  [RELEASE + 'item/g1.json']: {
    ...entry('g1'), body_ar: '', body_en: '', media: [], comment_count: 0, comments: [],
  },
};

/** The shell's own script list, so a module added there is a module this test runs. */
const SHELL = [...read('site/index.html').matchAll(/<script src="(\/assets\/js\/[^"]+)"/g)]
  .map((m) => `site${m[1]}`);

/**
 * Boot the public shell.
 *
 * `overrides` replaces a global AFTER the module that defines it has run and BEFORE
 * public.js binds it — which is the only seam that exists, and is enough for DB and AUTH.
 */
async function boot({ pathname = '/', innerWidth = 1200, overrides = {} } = {}) {
  const win = makeWindow({ pathname, innerWidth });

  win.fetch = (url) => {
    const key = String(url);
    if (key in SHARDS) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SHARDS[key]) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
  };

  /* Every module the SHELL loads, in the shell's own order, each handed the globals the
     ones before it set — the technique frontend-view-test.mjs uses, and the reason it is
     bare parameters rather than properties on a stub window is that the browser's globals
     are bare identifiers and the difference is the whole point. */
  for (const rel of SHELL) {
    if (rel.endsWith('public.js')) Object.assign(win, overrides);
    const names = Object.keys(win).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    new Function('window', ...names, read(rel))(win, ...names.map((n) => win[n]));

    /* The REAL config, with two values moved. `archiveBase` becomes same-origin so the
       stubbed release above is what the read path finds, and `basemap.url` becomes empty
       so /map renders as the list — §10's own stated fallback, and the surface under test.
       CONFIG is frozen, so this replaces it rather than editing it; everything else in it,
       origins included, is the project's own. */
    if (rel.endsWith('config.js')) {
      win.CONFIG = { ...win.CONFIG, archiveBase: '', basemap: { url: '', attribution: '' } };
    }
  }

  // Manifest → content → feed page → index: four chained promises in public.js's boot.
  for (let i = 0; i < 12; i++) await settle();
  return win;
}

/** Follow an internal link the way a reader does — through public.js's own delegation. */
function click(win, node) {
  win._click(node);
}

const view = (win) => win.document.querySelector('#view');
const overlay = (win) => win.document.querySelector('#viewer');

/* ═══ 1 · the back button returns to where the reader was ════════════════════ */

console.log('# the viewer — §9\'s "the user returns exactly where they were"');

{
  const win = await boot({ pathname: '/' });

  // CONTROL, first. Everything below reads nodes out of a rendered archive, and an archive
  // that rendered nothing would make every assertion vacuous in the passing direction.
  const cards = view(win).querySelectorAll('a.memory');
  ok(cards.length === FEED.length,
     `CONTROL: the archive rendered ${cards.length} cards from the stubbed release`);

  click(win, cards[0]);
  await settle();
  ok(win.location.pathname === '/item/a1', `CONTROL: clicking a card routed to ${win.location.pathname}`);

  const fromArchive = overlay(win) && overlay(win).querySelector('a.viewer__close');
  ok(fromArchive !== null, 'CONTROL: the viewer opened and has a back button');
  ok(fromArchive.getAttribute('href') === '/',
     `a memory opened from the archive goes back to the archive (${fromArchive.getAttribute('href')})`);
}

{
  const win = await boot({ pathname: '/map' });
  for (let i = 0; i < 8; i++) await settle();

  const located = view(win).querySelectorAll('a.memory');
  ok(located.length === GEO.length,
     `CONTROL: /map rendered ${located.length} located memories`);

  click(win, located[0]);
  await settle();
  await settle();

  const back = overlay(win) && overlay(win).querySelector('a.viewer__close');
  ok(back !== null, 'CONTROL: the viewer opened over the map');
  // THE assertion. A hardcoded '/' — the shipped behaviour until 6 Sep 2026 — fails here
  // and passes every source scan.
  ok(back.getAttribute('href') === '/map',
     `a memory opened from /map goes back to /map, not to the archive (${back && back.getAttribute('href')})`);
  ok(/الخريطة|the map/.test(textOf(back)),
     `...and the button SAYS the map rather than the archive ("${textOf(back)}")`);

  /* Escape goes to the same place. It called closeViewer() directly until 6 Sep 2026,
     which removes the overlay and leaves the address bar on /item/{id} — so the reader was
     looking at the map at a URL naming a memory, a refresh reopened the viewer they had
     just dismissed, and the link they would have copied was not the page in front of them.
     Asserted on the URL rather than on the overlay, because removing the overlay is the
     half that already worked. */
  overlay(win).fire('keydown', { key: 'Escape' });
  await settle();
  ok(win.location.pathname === '/map',
     `Escape leaves the viewer AND the item URL (${win.location.pathname})`);
  ok(overlay(win) === null, '...and the overlay is gone with it');

  // And it is a target, not a constant: the same session, a different origin view.
  win.history.pushState(null, '', '/item/g1');
  win._emit('popstate');
  for (let i = 0; i < 4; i++) await settle();
  click(win, overlay(win).querySelector('a.viewer__close'));
  await settle();
  ok(win.location.pathname === '/map', 'pressing the button lands on /map');
}

{
  const win = await boot({ pathname: '/events' });
  const cards = view(win).querySelectorAll('a.event__plate');
  ok(cards.length === 1, `CONTROL: /events rendered ${cards.length} event card(s)`);

  click(win, cards[0]);
  for (let i = 0; i < 4; i++) await settle();
  const back = overlay(win) && overlay(win).querySelector('a.viewer__close');
  ok(back !== null && back.getAttribute('href') === '/events',
     `a memory opened from /events goes back to /events (${back && back.getAttribute('href')})`);
  ok(back !== null && textOf(back) === win.I18N.t('viewer.backTo.events'),
     `...and says so ("${textOf(back)}")`);
}

{
  // A profile. Not one of the three nav destinations, so a fix that special-cased the nav
  // would pass the two above and fail here.
  const win = await boot({ pathname: '/u/someone' });
  for (let i = 0; i < 6; i++) await settle();

  win.history.pushState(null, '', '/item/a1');
  win._emit('popstate');
  for (let i = 0; i < 4; i++) await settle();

  const back = overlay(win) && overlay(win).querySelector('a.viewer__close');
  ok(back !== null && back.getAttribute('href') === '/u/someone',
     `a memory opened from a profile goes back to that profile (${back && back.getAttribute('href')})`);
}

{
  // The deep link. Nothing was rendered before it, so there is nowhere to go back TO and
  // the archive is the only honest answer. A "remember everything" fix that reached for an
  // empty history and produced '' or 'undefined' fails here.
  const win = await boot({ pathname: '/item/a1' });
  for (let i = 0; i < 6; i++) await settle();
  const back = overlay(win) && overlay(win).querySelector('a.viewer__close');
  ok(back !== null && back.getAttribute('href') === '/',
     `a memory opened from a shared link falls back to the archive (${back && back.getAttribute('href')})`);
}

/* ═══ 2 · the under-map list is the archive's grid ═══════════════════════════ */

console.log('# /map — §1\'s "same grid language", counted rather than assumed');

{
  const win = await boot({ pathname: '/', innerWidth: 1200 });
  const archiveCols = view(win).querySelectorAll('.grid__col').length;

  const mapWin = await boot({ pathname: '/map', innerWidth: 1200 });
  for (let i = 0; i < 8; i++) await settle();
  const mapCols = view(mapWin).querySelectorAll('.grid__col').length;

  ok(archiveCols > 1, `CONTROL: the archive's own grid has ${archiveCols} columns at 1200px`);
  // The defect, exactly: one column is `.grid` wearing the archive's class names around a
  // plain list. Both render `.grid`, so only the count separates them.
  ok(mapCols === archiveCols,
     `the located list runs the same ${archiveCols} columns as the media grid (it had ${mapCols})`);

  const inColumns = view(mapWin).querySelectorAll('.grid__col')
    .reduce((n, col) => n + col.querySelectorAll('a.memory').length, 0);
  ok(inColumns === GEO.length,
     `...and all ${inColumns} cards are inside those columns rather than beside them`);
  const spread = view(mapWin).querySelectorAll('.grid__col')
    .map((col) => col.querySelectorAll('a.memory').length);
  ok(spread.every((n) => n > 0),
     `...spread across every column rather than stacked in one ([${spread.join(', ')}])`);
  ok(view(mapWin).querySelectorAll('.located__where').length === GEO.length,
     '...each still carrying §7\'s precision line, which is the one thing the map adds');
}

/* ═══ 3 · and it scales with the viewport ═══════════════════════════════════ */

console.log('# /map — the wide-viewport behaviour that was missing');

{
  /* Four widths, not two, and the top pair is the point. columnCount() stopped at four for
     everything from 1040px up, so 1200 and 1920 rendered identically and "not responsive on
     large screens" was literally true: a card on a 1920 screen was half again as wide as the
     same card at 1040. A two-point check at 800 vs 1920 passes under that cap — it was the
     first version of this assertion and it survived the mutation. */
  const widths = [800, 1040, 1200, 1920];
  const counts = [];
  for (const innerWidth of widths) {
    const w = await boot({ pathname: '/map', innerWidth });
    for (let i = 0; i < 8; i++) await settle();
    counts.push(view(w).querySelectorAll('.grid__col').length);
  }

  const pairs = widths.map((px, i) => `${px}px→${counts[i]}`).join(', ');
  ok(counts[0] >= 2 && counts.every((n, i) => i === 0 || n >= counts[i - 1]),
     `CONTROL: the located grid never narrows as the viewport widens (${pairs})`);
  ok(counts[counts.length - 1] > counts[0],
     `it widens with the viewport (${pairs})`);
  ok(counts[3] > counts[2],
     `...including ABOVE the old 1040px ceiling, which is where it had stopped (${widths[2]}px→${counts[2]}, ${widths[3]}px→${counts[3]})`);

  const wide = await boot({ pathname: '/map', innerWidth: 1920 });
  for (let i = 0; i < 8; i++) await settle();
  const w = view(wide).querySelectorAll('.grid__col').length;

  // A resize must reflow /map too. It only ever reflowed the archive, so the map kept
  // whatever width it was first rendered at for the life of the page.
  wide.innerWidth = 700;
  wide._emit('resize');
  wide._flushTimers();
  const after = view(wide).querySelectorAll('.grid__col').length;
  ok(after < w, `...and follows a resize while /map is open (${w} → ${after} columns)`);
}

/* ═══ 4 · the chosen handle survives signup ═════════════════════════════════ */

console.log('# signup — the handle a member typed, on the profile afterwards');

{
  /* A database that records what it was asked for. The assertion is the SHAPE of the call:
     0057 provisions the profile row, so an INSERT is a primary-key conflict — which is the
     defect, and which no amount of error handling turns into a saved handle. */
  const calls = [];
  const account = { id: 'u-1', email: 'x@t.local', role: 'member' };

  const DB = {
    calls,
    select: (table, query) => {
      calls.push(['select', table, query]);
      return Promise.resolve([{ handle: 'chosen_name', display_name: 'chosen_name' }]);
    },
    insert: (table, body) => {
      calls.push(['insert', table, body]);
      // What PostgREST answers for a row whose primary key is already there.
      const e = new Error('conflict');
      e.key = 'admin.err.conflict';
      e.status = 409;
      return Promise.reject(e);
    },
    patch: (table, filter, body) => {
      calls.push(['patch', table, filter, body]);
      return Promise.resolve([{ handle: body.handle }]);
    },
    del: () => Promise.resolve(null),
    rpc: (name) => {
      calls.push(['rpc', name]);
      if (name === 'profile_view') {
        return Promise.resolve([{
          id: account.id, handle: 'chosen_name', display_name: 'chosen_name',
          avatar_path: null, role_cache: 'member', bio: null,
          visibility: { bio: 'public', personalInfo: 'public', contributions: 'public', comments: 'public' },
          member_since: 2026, is_own: true, is_deleted: false,
        }]);
      }
      if (name === 'email_confirmation_status') return Promise.resolve({ confirmed: true });
      return Promise.resolve([]);
    },
    mediaUrl: () => null,
  };

  const AUTH = {
    user: () => account,
    accessToken: () => Promise.resolve('token'),
    restore: () => Promise.resolve(null),
    onChange: () => {},
    signUp: () => Promise.resolve({ confirmationRequired: false, user: account }),
    signIn: () => Promise.resolve(account),
    signOut: () => {},
    requestPasswordReset: () => Promise.resolve(true),
    beginRecovery: () => {},
    adoptMailedLink: () => Promise.resolve(account),
  };

  const TURNSTILE = {
    mount: () => ({ token: () => Promise.resolve('captcha'), reset: () => {}, remove: () => {} }),
  };

  const win = await boot({ pathname: '/', overrides: { DB, AUTH, TURNSTILE } });

  /* Open the signup dialog the way a visitor does — by pressing the masthead's own button,
     found by the string I18N gives it rather than by a literal repeated here. */
  const wanted = win.I18N.t('action.createAcct');
  const joinButton = win.document.body.querySelectorAll('button')
    .find((b) => textOf(b) === wanted);
  ok(joinButton !== undefined, `CONTROL: the masthead offers a way in ("${wanted}")`);
  joinButton.fire('click');
  await settle();

  const form = win.document.querySelector('form.dialog--form');
  ok(form !== null, 'CONTROL: the signup form mounted');

  const handleInput = form.querySelector('input[autocomplete=username]');
  ok(handleInput !== null, 'CONTROL: it asks for a handle (§3 — user-chosen, mandatory)');
  handleInput.value = 'chosen_name';
  form.querySelector('input[type=email]').value = 'x@t.local';
  form.querySelector('input[type=password]').value = 'a-long-passphrase';

  form.fire('submit');
  for (let i = 0; i < 10; i++) await settle();

  const writes = calls.filter((c) => c[0] === 'insert' || c[0] === 'patch');
  ok(writes.length === 1, `CONTROL: signup made exactly one profile write (${writes.map((w) => w[0]).join(', ') || 'none'})`);
  ok(writes[0] && writes[0][0] === 'patch' && writes[0][1] === 'profiles',
     `the chosen handle is written with an UPDATE, onto the row 0057 already provisioned (it used ${writes[0] ? writes[0][0] : 'nothing'})`);
  ok(writes[0] && writes[0][3] && writes[0][3].handle === 'chosen_name',
     `...carrying the handle the member typed (${writes[0] && writes[0][3] ? JSON.stringify(writes[0][3]) : 'nothing'})`);
  ok(writes[0] && /id=eq\.u-1/.test(writes[0][2]) && /select=/.test(writes[0][2]),
     `...filtered to their own row, with the select= DB.patch requires (${writes[0] ? writes[0][2] : ''})`);

  /* A signup ends on a panel, not on a closed dialog, and its button is what signs the new
     member in. Pressing it is the rest of the real path — including loadOwnHandle(), which
     is what puts a name in the masthead. */
    const done = win.document.querySelector('.dialog--gate');
  ok(done !== null, 'CONTROL: the signup ended on its confirmation panel');
  done.querySelectorAll('button')[0].fire('click');
  for (let i = 0; i < 10; i++) await settle();

  // And it reaches the screen. §7 makes the handle public and always shown, so this is the
  // symptom Amro reported, asserted at the far end of the same path.
  win.history.pushState(null, '', '/me');
  win._emit('popstate');
  for (let i = 0; i < 12; i++) await settle();

  const shown = textOf(view(win).querySelector('.profile__gloss'));
  ok(shown === '@chosen_name',
     `the profile shows the chosen handle rather than a generated one (${shown || 'nothing'})`);
  ok(!/^@member_[0-9a-f]{12}$/.test(shown),
     '...and specifically not the member_<hex> placeholder that was the reported symptom');
}

/* ═══ 5 · the account controls exist on the profile ═════════════════════════ */

console.log('# /me — the password-reset and confirmation controls');

{
  const account = { id: 'u-1', email: 'x@t.local', role: 'member' };
  const DB = {
    select: () => Promise.resolve([{ handle: 'chosen_name', display_name: 'chosen_name' }]),
    insert: () => Promise.resolve(null),
    patch: () => Promise.resolve([{ handle: 'chosen_name' }]),
    del: () => Promise.resolve(null),
    rpc: (name) => {
      if (name === 'profile_view') {
        return Promise.resolve([{
          id: account.id, handle: 'chosen_name', display_name: 'chosen_name',
          avatar_path: null, role_cache: 'member', bio: null,
          visibility: { bio: 'public', personalInfo: 'public', contributions: 'public', comments: 'public' },
          member_since: 2026, is_own: true, is_deleted: false,
        }]);
      }
      // The unconfirmed case: this is what makes the resend control appear at all.
      if (name === 'email_confirmation_status') return Promise.resolve({ confirmed: false });
      return Promise.resolve([]);
    },
    mediaUrl: () => null,
  };
  const AUTH = {
    user: () => account,
    accessToken: () => Promise.resolve('token'),
    restore: () => Promise.resolve(account),
    onChange: () => {},
    signOut: () => {}, signIn: () => Promise.resolve(account),
    signUp: () => Promise.resolve({ confirmationRequired: false, user: account }),
    requestPasswordReset: () => Promise.resolve(true),
    beginRecovery: () => {}, adoptMailedLink: () => Promise.resolve(account),
  };
  const TURNSTILE = {
    mount: () => ({ token: () => Promise.resolve('c'), reset: () => {}, remove: () => {} }),
  };

  const win = await boot({ pathname: '/me', overrides: { DB, AUTH, TURNSTILE } });
  for (let i = 0; i < 14; i++) await settle();

  const panel = view(win).querySelector('.account');
  ok(panel !== null, 'CONTROL: the owner sees their account panel on /me');

  /* Named by the I18N key each control must carry, not by a count. A count of two is also
     what two copies of the same button looks like, and both of these open a different
     dialog — which is the half worth asserting. */
  const labels = panel ? panel.querySelectorAll('button').map(textOf) : [];
  const resetButton = panel && panel.querySelectorAll('button')
    .find((b) => textOf(b) === win.I18N.t('reset.submit'));
  const confirmButton = panel && panel.querySelectorAll('button')
    .find((b) => textOf(b) === win.I18N.t('account.emailConfirm'));

  ok(resetButton !== undefined,
     `the password-reset control is on the profile ("${win.I18N.t('reset.submit')}" — found ${labels.join(' | ') || 'nothing'})`);
  ok(confirmButton !== undefined,
     `the resend-confirmation control is on the profile ("${win.I18N.t('account.emailConfirm')}")`);

  // Each opens its own screen. A control that says its own name back and does nothing is
  // this codebase's own recorded defect — "Forgot password?" was one from M1 until 3 Sep.
  resetButton.fire('click');
  await settle();
  const resetDialog = win.document.querySelector('form.dialog--form');
  ok(resetDialog !== null && textOf(resetDialog).includes(win.I18N.t('reset.title')),
     '...and it opens the password-reset dialog, prefilled from the session');
  ok(resetDialog !== null && resetDialog.querySelector('input[type=email]') !== null
     && resetDialog.querySelector('input[type=email]').value === account.email,
     '...with the address the member is signed in as');

  win.document.querySelector('#overlays').replaceChildren();
  confirmButton.fire('click');
  await settle();
  const confirmDialog = win.document.querySelector('.dialog--gate');
  ok(confirmDialog !== null && textOf(confirmDialog).includes(win.I18N.t('confirm.title')),
     '...and the other opens the confirmation dialog, which is where the resend lives');

  /* The THIRD state, which is the deployed one today: migration 0060 is not applied, so
     `email_confirmation_status` does not exist and the RPC 404s. state.confirmed stays
     null — deliberately, because a status we could not read must not lock a member out —
     and the row must not then announce that the address is confirmed. It did, until
     6 Sep 2026: the one row on the page whose job is to report a fact reported one nothing
     had checked. */
  const unknownWin = await boot({
    pathname: '/me',
    overrides: {
      AUTH,
      TURNSTILE,
      DB: {
        ...DB,
        rpc: (name, args) => (name === 'email_confirmation_status'
          ? Promise.reject(Object.assign(new Error('missing'), { key: 'admin.err.generic', status: 404 }))
          : DB.rpc(name, args)),
      },
    },
  });
  for (let i = 0; i < 14; i++) await settle();

  const unknownPanel = view(unknownWin).querySelector('.account');
  ok(unknownPanel !== null, 'CONTROL: the panel still renders when the status cannot be read');
  const hint = unknownPanel && textOf(unknownPanel.querySelector('.privacy-row__hint'));
  ok(hint === unknownWin.I18N.t('account.emailUnknown'),
     `a status that could not be read says so rather than claiming "confirmed" ("${hint}")`);
  ok(unknownPanel && unknownPanel.querySelectorAll('button')
       .find((b) => textOf(b) === unknownWin.I18N.t('account.emailConfirm')) === undefined,
     '...and offers no confirm button, because it does not know there is anything to do');
}

console.log(`\n1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
