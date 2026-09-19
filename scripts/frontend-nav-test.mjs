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
    // M6's baked category. Every card in a real release carries one, and displayKind()
    // reads it — so an entry without it here would render a video as a photograph and
    // nothing in this file would notice.
    category: 'image',
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

/* M6's three tabs, as a real release has them: the same entries the feed carries, filtered
   by category. `e1` is an event and is in NO category shard, which is the addendum's rule
   and the reason the image tab is one shorter than the feed. */
const IMAGES = FEED.filter((r) => r.category === 'image' && r.kind === 'media');
const VIDEOS = [entry('v1', { category: 'video' }), entry('v2', { category: 'video' })];
const VOICES = [entry('s1', { kind: 'voice', category: 'voice' })];

const SHARDS = {
  '/manifest.json': { release: RELEASE, generated_on: '2026-09-06' },
  '/redactions.json': { ids: [] },
  [RELEASE + 'content.json']: { blocks: { 'hero.line': { ar: 'ذاكرة', en: 'Memory' } } },
  [RELEASE + 'index.json']: {
    pages: 1, total: FEED.length, decades: [1960], cells: ['sv8w0'],
    categories: {
      image: { pages: 1, total: IMAGES.length },
      video: { pages: 1, total: VIDEOS.length },
      voice: { pages: 1, total: VOICES.length },
    },
    search: { total: FEED.length + VIDEOS.length + VOICES.length },
  },
  [RELEASE + 'feed/page-1.json']: { page: 1, pages: 1, total: FEED.length, items: FEED },
  [RELEASE + 'category/image/page-1.json']:
    { category: 'image', page: 1, pages: 1, total: IMAGES.length, items: IMAGES },
  [RELEASE + 'category/video/page-1.json']:
    { category: 'video', page: 1, pages: 1, total: VIDEOS.length, items: VIDEOS },
  [RELEASE + 'category/voice/page-1.json']:
    { category: 'voice', page: 1, pages: 1, total: VOICES.length, items: VOICES },
  [RELEASE + 'search-index.json']: {
    total: 3,
    items: [
      { id: 'a1', title_ar: 'ميدان المنارة', title_en: 'Al-Manara Square', category: 'image', decade: 1960 },
      { id: 'v1', title_ar: 'فيلم المنارة', title_en: 'Manara Film', category: 'video', decade: 1980 },
      { id: 's1', title_ar: 'تسجيل من رام الله', title_en: 'A Ramallah recording', category: 'voice', decade: 1970 },
    ],
  },
  [RELEASE + 'item/v1.json']: {
    ...entry('v1', { category: 'video' }), body_ar: '', body_en: '',
    media: [], comment_count: 0, comments: [],
  },
  [RELEASE + 'geo/sv8w0.json']: { cell: 'sv8w0', total: GEO.length, items: GEO },
  [RELEASE + 'places.json']: { places: [] },
  [RELEASE + 'item/a1.json']: {
    /* Two paragraphs, separated by a blank line, because the split into <p> is the half of
       the description that can be wrong without looking wrong: one paragraph renders
       identically either way. */
    ...entry('a1'),
    body_ar: 'كان الزفاف يمرّ من هنا كل خميس.\n\nوكنّا نقف على الدرج ننتظر.',
    body_en: 'The procession came through here every Thursday.\n\nWe waited on the steps.',
    media: [], comment_count: 0, comments: [],
  },
  [RELEASE + 'item/g1.json']: {
    ...entry('g1'), body_ar: '', body_en: '', media: [], comment_count: 0, comments: [],
  },
};

/** The shell's own script list, so a module added there is a module this test runs. */
const SHELL = [...read('site/index.html').matchAll(/<script src="(\/assets\/(?:v\/[0-9a-f]+\/)?js\/[^"]+)"/g)]
  .map((m) => `site${m[1]}`);

/**
 * Boot the public shell.
 *
 * `overrides` replaces a global AFTER the module that defines it has run and BEFORE
 * public.js binds it — which is the only seam that exists, and is enough for DB and AUTH.
 */
async function boot({ pathname = '/', innerWidth = 1200, overrides = {} } = {}) {
  const win = makeWindow({ pathname, innerWidth });

  /* Every request this boot makes, in order. §9's budget is about what a first paint
     TRANSFERS, and the only way to assert that a file is absent from it is to watch the
     requests — a scan of the source cannot tell a lazy fetch from an eager one. */
  win._requested = [];

  win.fetch = (url) => {
    const key = String(url);
    win._requested.push(key);
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

/* ═══ 6 · the handle can be CHANGED after signup ════════════════════════════
   Section 4 proves a NEW member's chosen handle survives signup. This is the other half,
   and it is the one the deployed database needed: claimHandle() runs only at signup, so
   every account created before 7 Sep 2026 — all sixteen on the live system, the
   maintainer's among them — holds 0057's `member_<12 hex>` placeholder, and the profile
   editor wrote display_name, bio and visibility and never `handle`. Nothing could repair
   them, while signup.err.handleTaken and handleKept both told members to "change it from
   your page".

   Asserted through the real form, because the interesting behaviour is in the submit
   handler: WHICH keys the PATCH carries, and which refusal the member is shown. */

console.log('# /me — renaming yourself');

{
  const account = { id: 'u-1', email: 'x@t.local', role: 'member' };
  const PLACEHOLDER = 'member_5f4d89d9f9bd';

  /** A /me boot whose profile row carries `handle`, and whose patch answers `answer`. */
  async function editorWin(handle, answer) {
    const calls = [];
    const DB = {
      select: () => Promise.resolve([{ handle, display_name: null }]),
      insert: () => Promise.resolve(null),
      patch: (table, filter, body) => {
        calls.push({ table, filter, body });
        return answer ? answer(body) : Promise.resolve([{ handle: body.handle || handle }]);
      },
      del: () => Promise.resolve(null),
      rpc: (name) => {
        if (name === 'profile_view') {
          return Promise.resolve([{
            id: account.id, handle, display_name: null, avatar_path: null,
            role_cache: 'member', bio: null,
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
      restore: () => Promise.resolve(account),
      onChange: () => {}, signOut: () => {},
      signIn: () => Promise.resolve(account),
      signUp: () => Promise.resolve({ confirmationRequired: false, user: account }),
      requestPasswordReset: () => Promise.resolve(true),
      beginRecovery: () => {}, adoptMailedLink: () => Promise.resolve(account),
    };
    const TURNSTILE = {
      mount: () => ({ token: () => Promise.resolve('c'), reset: () => {}, remove: () => {} }),
    };
    const win = await boot({ pathname: '/me', overrides: { DB, AUTH, TURNSTILE } });
    for (let i = 0; i < 14; i++) await settle();

    // Open the editor by its own toggle, not by reaching into state.
    const toggle = view(win).querySelectorAll('button')
      .find((b) => textOf(b) === win.I18N.t('profile.editTitle'));
    if (toggle) { toggle.fire('click'); for (let i = 0; i < 6; i++) await settle(); }
    return { win, calls, form: win.document.querySelector('form.profile__edit-form') };
  }

  const opened = await editorWin(PLACEHOLDER);
  ok(opened.form !== null, 'CONTROL: the profile editor opens from its own toggle');

  const field = opened.form && opened.form.querySelector('input[autocomplete=username]');
  ok(field !== null && field !== undefined,
     'the editor offers a handle field — the control signup.err.handleTaken already points at');
  ok(field && field.value === PLACEHOLDER,
     `...prefilled with the handle the member currently has (${field ? field.value : 'nothing'})`);

  /* A save that does NOT touch the handle must not send one. Sending an unchanged handle
     puts the reserved-handle trigger and both CHECK constraints in front of a save that
     was about a bio — so a member editing a bio could be refused over a name they never
     touched. */
  const untouched = await editorWin(PLACEHOLDER);
  untouched.form.querySelector('textarea').value = 'a new bio';
  untouched.form.fire('submit');
  for (let i = 0; i < 8; i++) await settle();
  ok(untouched.calls.length === 1, `CONTROL: an edit sends exactly one PATCH (${untouched.calls.length})`);
  ok(untouched.calls[0] && !('handle' in untouched.calls[0].body),
     `an unchanged handle is NOT sent (${untouched.calls[0] ? Object.keys(untouched.calls[0].body).join(', ') : 'no call'})`);
  ok(untouched.calls[0] && untouched.calls[0].body.bio === 'a new bio',
     '...while the field that did change is');

  // And the rename itself reaches the database.
  const renamed = await editorWin(PLACEHOLDER);
  renamed.form.querySelector('input[autocomplete=username]').value = 'ramallah_1967';
  renamed.form.fire('submit');
  for (let i = 0; i < 8; i++) await settle();
  ok(renamed.calls[0] && renamed.calls[0].body.handle === 'ramallah_1967',
     `a changed handle IS sent (${renamed.calls[0] ? JSON.stringify(renamed.calls[0].body.handle) : 'no call'})`);
  ok(renamed.calls[0] && /id=eq\.u-1/.test(renamed.calls[0].filter)
     && /select=/.test(renamed.calls[0].filter),
     `...onto their own row only, with the select= DB.patch requires (${renamed.calls[0] ? renamed.calls[0].filter : ''})`);

  /* ── The three refusals, told apart (13 Sep 2026) ──
     A handle can be turned away three ways and each asks the member for something
     different: fix the spelling, pick a different name because someone has it, pick a
     different name because the archive keeps it. The last two shared one sentence — "that
     handle is not allowed, pick another from your profile" — reached by an `else` rather
     than by a decision, and true of all three.

     The stubs carry the BODIES PostgREST actually returns, measured against the deployed
     project, because that body is the only thing that separates the two 400s: both are
     SQLSTATE 23514, and only the CHECK one names a constraint. A stub that rejected with a
     bare status could not tell them apart and neither could the code under test. */
  const REFUSALS = {
    taken: { status: 409, key: 'admin.err.conflict', detail: {
      code: '23505',
      message: 'duplicate key value violates unique constraint "profiles_handle_normalized_key"' } },
    reserved: { status: 400, key: 'admin.err.generic', detail: {
      code: '23514', message: 'handle "admin" is reserved' } },
    checkConstraint: { status: 400, key: 'admin.err.generic', detail: {
      code: '23514',
      message: 'new row for relation "profiles" violates check constraint "profiles_handle_allowed"' } },
  };
  const refusing = (which) => (body) => (body.handle
    ? Promise.reject(Object.assign(new Error(which), REFUSALS[which]))
    : Promise.resolve([{ handle: PLACEHOLDER }]));

  async function noteFor(which, typed) {
    const w = await editorWin(PLACEHOLDER, refusing(which));
    w.form.querySelector('input[autocomplete=username]').value = typed;
    w.form.fire('submit');
    for (let i = 0; i < 8; i++) await settle();
    return { note: textOf(w.form.querySelector('.form-error')), win: w.win };
  }

  const taken = await noteFor('taken', 'taken_name');
  ok(taken.note === taken.win.I18N.t('signup.err.handleTaken'),
     `409 says someone already has it ("${taken.note}")`);

  const reserved = await noteFor('reserved', 'admin');
  ok(reserved.note === reserved.win.I18N.t('signup.err.handleReserved'),
     `a reserved name says the archive keeps it ("${reserved.note}")`);
  ok(reserved.note !== taken.note,
     '...and it is NOT the "someone has it" message — nobody has it, and looking for who would waste the time of a member who cannot act on it');

  /* The generic that used to be behind both. Deleted from I18N, so `t()` now returns the
     key itself — which is exactly what this asserts neither message has become. */
  const GENERIC = 'signup.err.handleBad';
  ok(reserved.win.I18N.t(GENERIC) === GENERIC,
     'signup.err.handleBad is gone from the copy deck, not merely unreferenced');
  for (const [label, shown] of [['taken', taken.note], ['reserved', reserved.note]])  {
    ok(shown !== GENERIC && shown.length > 0 && !shown.startsWith('signup.err.'),
       `the ${label} message is real copy, not a key that leaked through ("${shown}")`);
  }

  /* And the branch that should now be unreachable: a CHECK constraint refusing a handle
     the form already validated. It must NOT be dressed as one of the three — the code
     cannot tell which rule, so it says only that the save did not go through. */
  const unexpected = await noteFor('checkConstraint', 'ramallah_1967');
  ok(unexpected.note === unexpected.win.I18N.t('admin.err.generic'),
     `a refusal the client cannot identify claims nothing about the name ("${unexpected.note}")`);
  ok(unexpected.note !== unexpected.win.I18N.t('signup.err.handleTaken')
     && unexpected.note !== unexpected.win.I18N.t('signup.err.handleReserved'),
     '...and specifically does not guess at one of the three');

  /* ── The rules, checked before the row is written (13 Sep 2026) ──
     The refusals above are the SERVER's, and they arrive after the fact. Both CHECK
     constraints are knowable from the browser, and until now nothing checked them or even
     named them, which is how `Masar` — a capital letter, nothing more — became
     member_<hex> for every member on the deployed system. The editor is the second surface
     that sends this column; scripts/signup-handle-e2e.mjs covers the first against the
     real database. */
  const capital = await editorWin(PLACEHOLDER);
  capital.form.querySelector('input[autocomplete=username]').value = 'Masar';
  capital.form.fire('submit');
  for (let i = 0; i < 8; i++) await settle();
  ok(capital.calls[0] && capital.calls[0].body.handle === 'masar',
     `a capital is lower-cased to match normalized_handle() rather than refused (${
       capital.calls[0] ? JSON.stringify(capital.calls[0].body.handle) : 'no call'})`);

  for (const [typed, key] of [
    ['abu ammar', 'signup.err.handleChars'],
    ['tala.jabi', 'signup.err.handleChars'],
    ['ab', 'signup.err.handleLength'],
    ['amro_رام', 'signup.err.handleScript'],
    ['amro__hass', 'signup.err.handleUnderscore'],
  ]) {
    const w = await editorWin(PLACEHOLDER);
    w.form.querySelector('input[autocomplete=username]').value = typed;
    w.form.fire('submit');
    for (let i = 0; i < 8; i++) await settle();
    const note = textOf(w.form.querySelector('.form-error'));
    ok(note === w.win.I18N.t(key), `"${typed}" is refused as ${key} ("${note}")`);
    ok(w.calls.length === 0,
       `...without a write, so the member is told which rule rather than "not allowed" (${w.calls.length} calls)`);
  }
}

/* ═══ 7 · the share sheet asks an event different questions ══════════════════
   Amro's decision, 7 Sep 2026, and migration 0062 is the database half. The sheet has
   offered an "event" button since M3 and pressing it changed three icons and nothing
   else: the form underneath stayed the photograph's, so it collected a licence and a map
   pin, sent no start date, and the row was refused by posts_event_needs_a_start — a 500
   out of a SECURITY DEFINER function, for every event anyone ever tried to submit.

   The assertions are on the DRAFT, not on the fields. A form that shows the right inputs
   and sends the wrong object is exactly the defect being fixed. */

console.log('# the share sheet — an event is not a photograph');

{
  const account = { id: 'u-1', email: 'x@t.local', role: 'member' };

  async function sheet() {
    const submitted = [];
    const DB = {
      select: () => Promise.resolve([{ handle: 'contributor', display_name: null }]),
      insert: () => Promise.resolve(null),
      patch: () => Promise.resolve([{ handle: 'contributor' }]),
      del: () => Promise.resolve(null),
      rpc: (name) => {
        if (name === 'email_confirmation_status') return Promise.resolve({ confirmed: true });
        if (name === 'search_places') return Promise.resolve([]);
        return Promise.resolve([]);
      },
      mediaUrl: () => null,
    };
    const AUTH = {
      user: () => account,
      accessToken: () => Promise.resolve('token'),
      restore: () => Promise.resolve(account),
      onChange: () => {}, signOut: () => {},
      signIn: () => Promise.resolve(account),
      signUp: () => Promise.resolve({ confirmationRequired: false, user: account }),
      requestPasswordReset: () => Promise.resolve(true),
      beginRecovery: () => {}, adoptMailedLink: () => Promise.resolve(account),
    };
    const TURNSTILE = {
      mount: () => ({ token: () => Promise.resolve('captcha'), reset: () => {}, remove: () => {} }),
    };
    /* The real UPLOAD would need a network and a File. This one records the draft and
       walks the same stages, which is what both halves of this section read. */
    const UPLOAD = {
      LICENSES: ['CC-BY-SA-4.0', 'CC0-1.0', 'rights-reserved'],
      _limits: { maxBytes: 200 * 1024 * 1024, maxDurationS: 180 },
      _refusals: {},
      submit: (file, draft, captcha, hooks) => {
        submitted.push(draft);
        ['probing', 'requesting', 'uploading', 'finishing', 'done'].forEach((s) => hooks.onStage(s));
        return Promise.resolve({ postId: 'p-1' });
      },
    };

    const win = await boot({ pathname: '/', overrides: { DB, AUTH, TURNSTILE, UPLOAD } });
    for (let i = 0; i < 12; i++) await settle();

    const shareButton = win.document.body.querySelectorAll('button')
      .find((b) => textOf(b).includes(win.I18N.t('action.share')));
    if (shareButton) { shareButton.fire('click'); for (let i = 0; i < 8; i++) await settle(); }
    const form = win.document.querySelector('form.dialog--sheet');
    return { win, form, submitted };
  }

  const s = await sheet();
  ok(s.form !== null, 'CONTROL: a signed-in member can open the share sheet');

  // The photograph's fields are what it opens on.
  ok(s.form && s.form.querySelectorAll('.field-group').filter((n) => !n.hidden).length >= 1,
     'CONTROL: it opens on the photograph form, with the rights fields shown');

  // Press "event", the way a contributor does.
  const eventButton = s.form.querySelectorAll('button.kind')
    .find((b) => textOf(b).includes(s.win.I18N.t('share.event')));
  ok(eventButton !== undefined, `CONTROL: the sheet offers an event kind ("${s.win.I18N.t('share.event')}")`);
  eventButton.fire('click');
  for (let i = 0; i < 4; i++) await settle();

  const start = s.form.querySelector('input[type=datetime-local]');
  ok(start !== null && start !== undefined,
     'choosing "event" reveals a start-date field — the column posts_event_needs_a_start requires');
  ok(start && start.required === true,
     '...and it is required, because an event without one is refused by the database');

  /* THE half that is easy to get wrong. A `required` input inside a hidden container is
     not skipped by the browser: it blocks the submit and reports "an invalid form control
     is not focusable", which is a form that cannot be sent and says nothing about why. */
  const license = s.form.querySelectorAll('select.input')
    .find((n) => n.querySelectorAll('option').some((o) => o.getAttribute('value') === 'CC0-1.0'));
  ok(license && license.required === false,
     'the licence select is no longer required — a hidden required field blocks the submit silently');

  const groups = s.form.querySelectorAll('.field-group');
  ok(groups.some((n) => n.hidden), 'the fields an event is not asked are hidden');

  // Fill it in and send it. The draft is what is asserted.
  s.form.querySelector('input[type=text]').value = 'مهرجان رام الله';
  s.form.querySelector('textarea.input').value = 'وصف الفعالية';
  start.value = '2026-10-01T18:00';
  /* By PLACEHOLDER, not by position. The first draft indexed from the end of the text
     inputs and picked up the place picker's own field, so the venue text landed in
     organizers and the two assertions below failed pointing at each other. The
     placeholder comes from I18N rather than a literal, so it cannot drift from the sheet. */
  const byPlaceholder = (key) => s.form.querySelectorAll('input')
    .find((n) => n.getAttribute('placeholder') === s.win.I18N.t(key));
  byPlaceholder('share.fVenuePh').value = 'قصر رام الله الثقافي';
  byPlaceholder('share.fOrganizersPh').value = 'بلدية رام الله، مركز خليل السكاكيني';

  // A file, because the upload path is the only way a post is created (§2's write path).
  s.form.querySelector('input[type=file]').files = [{ name: 'poster.jpg', size: 1024, type: 'image/jpeg' }];
  s.form.fire('submit');
  for (let i = 0; i < 12; i++) await settle();

  const draft = s.submitted[0];
  ok(draft !== undefined, `CONTROL: the sheet submitted a draft (${s.submitted.length})`);
  ok(draft && draft.kind === 'event', `...as kind=event (${draft ? draft.kind : 'none'})`);
  ok(draft && typeof draft.event_starts_at === 'string' && /Z$/.test(draft.event_starts_at),
     `the start is sent as a zoned instant, not the zone-less string the input holds (${draft ? draft.event_starts_at : ''})`);
  ok(draft && (draft.venue_ar === 'قصر رام الله الثقافي' || draft.venue_en === 'قصر رام الله الثقافي'),
     'the venue is sent as free text');
  ok(draft && Array.isArray(draft.organizers) && draft.organizers.length === 2,
     `organizers split on the ARABIC comma too (${draft ? JSON.stringify(draft.organizers) : ''})`);

  /* 0062 REFUSES these on an event rather than dropping them, so sending one would be a
     refused upload — the member's whole submission lost to a field they never filled. */
  ok(draft && draft.license === undefined && draft.provenance === undefined
     && draft.consent === undefined,
     'no licence, provenance or consent is sent for an event (§7 — no third-party rights)');
  ok(draft && draft.lat === undefined && draft.lon === undefined
     && draft.place_id === undefined && draft.location_precision === undefined,
     'and no coordinate of any kind — 0062 refuses one on an event');
}

/* ═══ 8 · the upload says that it worked ═════════════════════════════════════
   Part 3's UX gap. The sheet had no positive signal anywhere: choosing a file changed
   nothing on screen (the input is .sr-only inside the dropzone label), and success closed
   the dialog behind a toast. Everything in between was an absence of errors. */

console.log('# the share sheet — the file chip');

{
  const account = { id: 'u-1', email: 'x@t.local', role: 'member' };
  const stages = [];

  const DB = {
    select: () => Promise.resolve([{ handle: 'contributor', display_name: null }]),
    insert: () => Promise.resolve(null), patch: () => Promise.resolve([]), del: () => Promise.resolve(null),
    rpc: (name) => (name === 'email_confirmation_status'
      ? Promise.resolve({ confirmed: true }) : Promise.resolve([])),
    mediaUrl: () => null,
  };
  const AUTH = {
    user: () => account, accessToken: () => Promise.resolve('token'),
    restore: () => Promise.resolve(account), onChange: () => {}, signOut: () => {},
    signIn: () => Promise.resolve(account),
    signUp: () => Promise.resolve({ confirmationRequired: false, user: account }),
    requestPasswordReset: () => Promise.resolve(true),
    beginRecovery: () => {}, adoptMailedLink: () => Promise.resolve(account),
  };
  const TURNSTILE = { mount: () => ({ token: () => Promise.resolve('c'), reset: () => {}, remove: () => {} }) };

  /* Held open at `uploading`, so the chip's mid-flight state can be read. A submit that
     ran to completion in one tick would only ever show the last one. */
  let advance;
  const UPLOAD = {
    LICENSES: ['CC-BY-SA-4.0', 'CC0-1.0', 'rights-reserved'],
    _limits: { maxBytes: 200 * 1024 * 1024, maxDurationS: 180 }, _refusals: {},
    submit: (file, draft, captcha, hooks) => new Promise((resolve) => {
      ['probing', 'requesting', 'uploading'].forEach((s) => { stages.push(s); hooks.onStage(s); });
      advance = () => {
        ['finishing', 'done'].forEach((s) => hooks.onStage(s));
        resolve({ postId: 'p-1' });
      };
    }),
  };

  const win = await boot({ pathname: '/', overrides: { DB, AUTH, TURNSTILE, UPLOAD } });
  for (let i = 0; i < 12; i++) await settle();
  win.document.body.querySelectorAll('button')
    .find((b) => textOf(b).includes(win.I18N.t('action.share'))).fire('click');
  for (let i = 0; i < 8; i++) await settle();

  const form = win.document.querySelector('form.dialog--sheet');
  const chip = form.querySelector('.filechip');
  ok(chip !== null && chip !== undefined, 'CONTROL: the sheet has a file chip');
  ok(chip && chip.hidden === true, 'it is hidden before a file is chosen');

  const fileInput = form.querySelector('input[type=file]');
  fileInput.files = [{ name: 'رام الله ١٩٦٧.jpg', size: 2048, type: 'image/jpeg' }];
  fileInput.fire('change');
  await settle();

  ok(chip.hidden === false, 'choosing a file shows it — the sheet said NOTHING before this');
  ok(textOf(chip).includes('رام الله ١٩٦٧.jpg'),
     `...naming the file that was chosen ("${textOf(chip)}")`);
  ok(chip.querySelector('bdi') !== null,
     '...through <bdi>, because a filename is a user string in a mixed-direction line (§6)');
  ok(textOf(chip.querySelector('.filechip__mark')) === '',
     'and NO tick yet — the file is still on the member\'s own device');

  form.querySelector('input[type=text]').value = 'عنوان';
  form.querySelector('textarea.input').value = 'قصة';
  form.querySelector('input[type=text][required]');
  const prov = form.querySelectorAll('input[type=text]').filter((n) => n.required);
  prov.forEach((n) => { if (!n.value) n.value = 'ألبوم العائلة'; });
  form.querySelector('input[type=checkbox]').checked = true;
  form.fire('submit');
  for (let i = 0; i < 8; i++) await settle();

  ok(/filechip--sending/.test(chip.className),
     `mid-upload the chip says so (${chip.className})`);
  ok(textOf(chip.querySelector('.filechip__mark')) === '',
     '...still with no tick, because the bytes have not landed');

  advance();
  for (let i = 0; i < 8; i++) await settle();

  ok(/filechip--done/.test(chip.className),
     `once the bytes reach quarantine the chip changes state (${chip.className})`);
  ok(textOf(chip.querySelector('.filechip__mark')) === '✓',
     'THE signal Part 3 asked for: a tick, only once it is true');
  ok(textOf(chip).includes(win.I18N.t('share.fileDone')),
     `...and says what happened in words too ("${win.I18N.t('share.fileDone')}")`);
}

/* ═══ 6 · M6's tabs, search and description, RENDERED ════════════════════════
 *
 * The same argument this file's header makes about the back button: all four defects below
 * are values that do not exist until a render, and every one of them passes a source scan.
 * A tab bar that renders four anchors and always draws the feed behind them looks right.
 * A search box whose input is rebuilt on every keystroke loses focus and looks like a slow
 * phone. A description that is never mounted looks like an item with no description.
 */

console.log('# M6 — the tabs, the search box, and the description on an item');

{
  const win = await boot({ pathname: '/' });

  const tabs = view(win).querySelectorAll('a.tab');
  ok(tabs.length === 4, `CONTROL: the archive rendered ${tabs.length} tabs`);

  /* DOM ORDER, which is what carries the RTL behaviour. §9 forbids physical properties, so
     the row is a plain flex row and the browser lays it out from the reading edge — start
     to end in both languages. That means the ORDER in the markup is the order on screen in
     Arabic and in English, and a "fix" that reversed the array for one of them would be the
     regression. Asserted here, and the CSS half (nothing sets direction, nothing says left
     or right) is scripts/frontend-rtl-test.mjs's. */
  const order = Array.from(tabs).map((a) => a.getAttribute('href')).join(' ');
  ok(order === '/ /c/image /c/video /c/voice',
     `the tabs are in one order for both languages (${order})`);

  ok(tabs[0].getAttribute('aria-current') === 'page',
     'All is the active tab on / — the addendum\'s default');
  ok(tabs[1].getAttribute('aria-current') === null,
     '...and it is the only one, so a screen reader is told what the paint says');

  // The default tab is the CURRENT feed behaviour, unchanged: every published item,
  // event included, in the feed's own order.
  ok(view(win).querySelectorAll('a.memory').length === FEED.length,
     'the All tab draws the whole feed, exactly as before the addendum');

  /* THE budget assertion at shell level. §9 counts "HTML + CSS + JS + first feed page";
     the addendum requires search-index.json to be fetched on first interaction. A boot
     that pulled it would be inside the budget and outside the rule, and the only way to
     see the difference is the request log. */
  const early = win._requested.filter((u) => u.includes('search-index.json'));
  ok(early.length === 0,
     `booting the whole shell requests no search index (${win._requested.length} requests, none of them it)`);
  const catsEarly = win._requested.filter((u) => u.includes('/category/'));
  ok(catsEarly.length === 0,
     'and no category shard either — the All tab reads feed/page-N.json, as it always did');
}

{
  // Switching tabs, through public.js's own link delegation rather than by calling in.
  const win = await boot({ pathname: '/' });
  const videoTab = view(win).querySelectorAll('a.tab')[2];
  click(win, videoTab);
  for (let i = 0; i < 6; i++) await settle();

  ok(win.location.pathname === '/c/video',
     `a tab is a real URL and clicking it navigates (${win.location.pathname})`);
  ok(win._requested.some((u) => u.includes('category/video/page-1.json')),
     '...and the grid\'s data source becomes the category shard');

  const cards = view(win).querySelectorAll('a.memory');
  ok(cards.length === VIDEOS.length,
     `the Videos tab draws only its own ${cards.length} items, not the feed's ${FEED.length}`);
  ok(view(win).querySelectorAll('a.tab')[2].getAttribute('aria-current') === 'page',
     'the active tab moved with the route');

  /* The badge, which is the defect the baked category closes. displayKind() asked entries
     for `entry.video` — a key no shard has ever emitted — so every video in the archive
     wore a photograph's badge. Read off the rendered card rather than from the source,
     because the source looked correct for three milestones. */
  const badge = cards[0].querySelector('span.badge');
  ok(badge !== null && textOf(badge) === win.I18N.t('kind.video'),
     `a video card wears the video badge ("${badge && textOf(badge)}")`);

  // CONTROL for the assertion above: an image card must NOT wear it, or the badge would be
  // a constant rather than a reading of the data.
  const winAll = await boot({ pathname: '/' });
  const firstCard = winAll.document.querySelector('#view').querySelector('a.memory');
  const first = firstCard && firstCard.querySelector('span.badge');
  ok(first !== null && textOf(first) === winAll.I18N.t('kind.photo'),
     `CONTROL: an image card still wears the photo badge ("${textOf(first)}")`);
}

{
  // Landing on a tab directly — a link somebody sent, or a refresh. Nothing may depend on
  // having passed through the archive first.
  const win = await boot({ pathname: '/c/voice' });
  ok(view(win).querySelectorAll('a.tab')[3].getAttribute('aria-current') === 'page',
     'a deep link to /c/voice opens on that tab');
  ok(view(win).querySelectorAll('a.memory').length === VOICES.length,
     `...with its own items loaded (${VOICES.length})`);
  ok(!win._requested.some((u) => u.includes('feed/page-1.json')),
     'and WITHOUT also fetching the All feed — one place decides which page loads first');

  // An unknown category is a typo or a stale link, and the archive is the honest answer to
  // both. Rendering an empty "Audio" tab would invent a section of the archive.
  const bad = await boot({ pathname: '/c/audio' });
  ok(bad.document.querySelector('#view').querySelectorAll('a.tab')[0]
       .getAttribute('aria-current') === 'page',
     '/c/audio falls back to All rather than rendering a tab that does not exist');
}

{
  /* The live search, driven the way a reader drives it: type, wait for the debounce, look
     at what is on screen. */
  const win = await boot({ pathname: '/' });
  const input = view(win).querySelector('input.search__input');
  ok(input !== null, 'CONTROL: the archive rendered a search box');
  ok(input.getAttribute('type') === 'search', '...as a type=search input');

  /* §9's label rule, which axe found broken on three other controls on 5 Sep: a caption
     beside a control is not a label. UI.labelFor is what attaches it. */
  const label = view(win).querySelector('label.field__label');
  ok(label !== null && label.getAttribute('for') === input.id && input.id,
     `the box is named by a real <label for> (${label && label.getAttribute('for')})`);

  /* THE debounce, asserted so that removing it turns this red.
   *
   * The first version of this checked only that no request had been made SYNCHRONOUSLY
   * after a keystroke — which is true with the debounce and equally true without it, since
   * the fetch goes out on a microtask either way. It survived the mutation that replaced
   * `setTimeout(runSearch, 180)` with a bare `runSearch()`, which is the definition of an
   * assertion that cannot fail. What discriminates is that nothing happens on SCREEN until
   * the timer fires, however long the microtask queue is given to drain. */
  input.value = 'م';
  input.fire('input', {});
  input.value = 'من';
  input.fire('input', {});
  input.value = 'منارة';
  input.fire('input', {});

  ok(win._timers.filter((t) => t.fn).length === 1,
     `three keystrokes leave ONE live timer, not three — the debounce coalesces them ` +
     `(${win._timers.filter((t) => t.fn).length})`);

  for (let i = 0; i < 8; i++) await settle();
  ok(view(win).querySelectorAll('a.result').length === 0 &&
     view(win).querySelector('div.grid') !== null,
     'and with the microtask queue fully drained the grid is still the grid — a keystroke ' +
     'does not search, the timer does');
  ok(!win._requested.some((u) => u.includes('search-index.json')),
     '...nor has anything been fetched for it yet');

  win._flushTimers();
  for (let i = 0; i < 6; i++) await settle();

  ok(win._requested.filter((u) => u.includes('search-index.json')).length === 1,
     'the debounce fires once and fetches the index once');

  const results = view(win).querySelectorAll('a.result');
  ok(results.length === 2,
     `an Arabic query matches both titles that contain it (${results.length} rows)`);
  ok(view(win).querySelector('div.grid') === null,
     'the results REPLACE the grid rather than sitting under it');

  /* The input node survived. This is the assertion the whole in-place repaint exists for:
     a full re-render would build a new <input>, and on a phone that is the keyboard closing
     and the composition being lost mid-word. Identity, not equality. */
  ok(view(win).querySelector('input.search__input') === input,
     'the input the reader is typing into is the same node after the results repaint');

  // The per-tab counts, which are what make within-tab search legible: a reader on Videos
  // who searches for a photograph's title has to be able to see where it went.
  const counts = Array.from(view(win).querySelectorAll('span.tab__count')).map(textOf);
  ok(counts.join('|') === win.I18N.num(2) + '|' + win.I18N.num(1) + '|' + win.I18N.num(1) + '|' + win.I18N.num(0),
     `each tab reports its own share of the matches (${counts.join('|')})`);

  // Clearing the box brings the grid back rather than leaving the last results on screen.
  input.value = '';
  input.fire('input', {});
  win._flushTimers();
  for (let i = 0; i < 4; i++) await settle();
  ok(view(win).querySelectorAll('a.result').length === 0 &&
     view(win).querySelector('div.grid') !== null,
     'clearing the query restores the grid');
}

{
  /* Search is scoped to the ACTIVE tab — the addendum's §6 decision. Asserted from the
     Videos tab with a query that matches an image as well: the image must not appear here,
     and the tab counts must still say it exists. */
  const win = await boot({ pathname: '/c/video' });
  for (let i = 0; i < 4; i++) await settle();

  const input = view(win).querySelector('input.search__input');
  input.value = 'منارة';
  input.fire('input', {});
  win._flushTimers();
  for (let i = 0; i < 6; i++) await settle();

  const rows = view(win).querySelectorAll('a.result');
  ok(rows.length === 1, `the Videos tab shows only its own match (${rows.length})`);
  ok(textOf(rows[0]).includes('فيلم'), `...and it is the video ("${textOf(rows[0])}")`);

  // The discriminating half. Without this the assertion above would pass just as happily
  // against a search that matched nothing at all.
  const counts = Array.from(view(win).querySelectorAll('span.tab__count')).map(textOf);
  ok(counts[1] === win.I18N.num(1),
     `the Images tab still says it holds a match (${counts.join('|')}) — which is how a reader finds it`);
}

{
  /* One tab failing is not all of them failing.
   *
   * `state.error` is set only by the ALL feed's first page, and until 9 Sep 2026 render()
   * answered it by replacing the whole view with an error page — BEFORE renderArchive() and
   * before the current tab was given a chance to fetch anything. With four data sources
   * that turns one missing shard into three tabs the reader can never reach, and the screen
   * that says so offers no way out of itself.
   *
   * The feed shard is removed for this boot only; every other file in the release is where
   * it was, which is what makes the assertion about the FEED rather than about the CDN.
   */
  const key = RELEASE + 'feed/page-1.json';
  const saved = SHARDS[key];
  delete SHARDS[key];

  const win = await boot({ pathname: '/' });
  SHARDS[key] = saved;

  const tabs = view(win).querySelectorAll('a.tab');
  ok(tabs.length === 4,
     `a failed feed still renders the tab bar (${tabs.length} tabs) — the reader has somewhere to go`);
  ok(view(win).querySelectorAll('a.memory').length === 0,
     'CONTROL: and no cards, because the shard really did not load');
  ok(textOf(view(win)).includes(win.I18N.t('archive.err.missing')),
     'the failure is reported where the grid would be, rather than replacing the page');

  // THE assertion: the other three tabs still work.
  click(win, tabs[1]);
  for (let i = 0; i < 8; i++) await settle();
  ok(win.location.pathname === '/c/image', `the Images tab is still reachable (${win.location.pathname})`);
  ok(view(win).querySelectorAll('a.memory').length === IMAGES.length,
     `...and loads its own shard (${IMAGES.length} cards) despite the feed being gone`);
}

{
  /* The description. §9's prerendered page has carried body_ar/body_en since M3 and the
     hydrated viewer never did, so a reader arriving from a shared link watched the text
     disappear as the SPA rendered over it. */
  const win = await boot({ pathname: '/item/a1' });
  for (let i = 0; i < 8; i++) await settle();

  const slide = overlay(win) && overlay(win).querySelector('.viewer__slide');
  ok(slide !== null, 'CONTROL: the viewer opened on the deep-linked item');

  /* PREMISE for everything below, and it is not free: upgradeSlide() finds its slide with
     `.viewer__slide[data-id="…"]`, so a dataset that did not reflect to the attribute would
     make it return at its first line — and every assertion here would then be about a slide
     nothing had hydrated, passing for the wrong reason. scripts/lib/dom-stub.mjs reflects
     it, as a browser does; this is the check that it still does. */
  ok(slide.getAttribute('data-id') === 'a1',
     `PREMISE: the slide is findable by the id it was built with (${slide.getAttribute('data-id')})`);

  const paras = slide.querySelectorAll('p.viewer__para');
  ok(paras.length === 2,
     `the description renders, split on blank lines exactly as prerender.ts splits it (${paras.length} paragraphs)`);
  ok(textOf(paras[0]).includes('الزفاف'),
     `...with the Arabic side in an Arabic interface ("${textOf(paras[0])}")`);

  /* §6: it is a user string, so it is inside <bdi> and it is a text node. This is the
     longest user-authored string in the system and the one most likely to contain something
     that looks like markup. */
  ok(paras[0].querySelector('bdi') !== null,
     'each paragraph wraps its text in <bdi> (§6, the render half of the bidi rule)');

  // An item with no description must render nothing rather than an empty box — every event
  // listing is one, and 0063 makes that a large share of them.
  const win2 = await boot({ pathname: '/item/g1' });
  for (let i = 0; i < 8; i++) await settle();
  const empty = win2.document.querySelector('#viewer');
  ok(empty && empty.querySelectorAll('p.viewer__para').length === 0,
     'an item with no body renders no paragraphs at all');
}

{
  // The English side of the same item, because "renders the description" and "renders the
  // description the reader can read" are different claims and only one of them is useful.
  const win = await boot({ pathname: '/item/a1' });
  win.I18N.set('en');
  win._emit('langchange');
  for (let i = 0; i < 10; i++) await settle();

  const slide = overlay(win) && overlay(win).querySelector('.viewer__slide');
  const para = slide && slide.querySelector('p.viewer__para');
  ok(para !== null && textOf(para).includes('procession'),
     `the English interface shows the English body ("${para && textOf(para)}")`);

  // And the tab labels follow the language, which is the other half of §9's "every string
  // through I18N with ar and en keys" for the controls this addendum adds.
  const tabs = win.document.querySelector('#view').querySelectorAll('a.tab');
  ok(tabs.length === 4 && textOf(tabs[1]).includes('Images'),
     `the tab labels are translated ("${Array.from(tabs).map(textOf).join(' / ')}")`);
}

/* ═══ · /me — your own submissions: the reason, and withdraw (0064, 18 Sep 2026) ══════
   Two claims the database cannot make for the screen. The reason a moderator wrote has to
   reach the row it belongs to, and the withdraw button has to be absent exactly where it
   would be a workaround: an "Upload incomplete" row may still be mid-transfer, and the
   pipeline — 0065's reaper — is what ends it, after which it reads "Processing failed" and
   the button appears. An APPROVED post whose ingest reads failed is still approved, and
   goes through the removal request instead. */

console.log('# /me — a rejection says why, and withdraw is offered only where it is honest');

{
  const account = { id: 'u-mine', email: 'mine@t.local', role: 'member' };
  const post = (id, title_en, status, ingest_state, extra = {}) => ({
    id, title_en, title_ar: null, status, ingest_state, ingest_error: null,
    created_by: account.id, takedown: false, ...extra,
  });
  const ROWS = [
    post('p-review', 'in review', 'pending', 'ready'),
    post('p-rejected', 'turned down', 'rejected', 'ready'),
    post('p-incomplete', 'never arrived', 'pending', 'awaiting_bytes'),
    post('p-processing', 'being encoded', 'pending', 'processing'),
    post('p-failed', 'would not decode', 'pending', 'failed', { ingest_error: 'decode_failed' }),
    // What 0065's reaper leaves behind: an upload whose bytes never came, past its window.
    post('p-expired', 'never came back', 'pending', 'failed', { ingest_error: 'upload_expired' }),
    post('p-approved-failed', 'approved but broken', 'approved', 'failed'),
    post('p-withdrawn', 'already withdrawn', 'withdrawn', 'ready'),
    post('p-published', 'published', 'approved', 'ready'),
  ];
  const NOTE = 'The sign in the photograph is unreadable at this size.';
  const rpcNames = [];
  const patches = [];
  const patchAnswers = [[], null];   // refused first, then accepted (null = echo the row)
  const DB = {
    // The handle /me asks for before anything else — without it the page never loads (see
    // loadOwnHandle), and every "NOT offered" assertion below would pass over an empty list.
    select: () => Promise.resolve([{ handle: 'mine_owner', display_name: 'mine_owner' }]),
    insert: () => Promise.resolve(null),
    patch: (table, filter, body) => {
      patches.push({ table, filter, body });
      const next = patchAnswers.shift();
      const id = /id=eq\.([^&]+)/.exec(filter)[1];
      return Promise.resolve(next === null ? [{ id, status: body.status }] : next);
    },
    del: () => Promise.resolve(null),
    rpc: (name) => {
      rpcNames.push(name);
      if (name === 'profile_view') {
        return Promise.resolve([{
          id: account.id, handle: 'mine_owner', display_name: 'mine_owner', avatar_path: null,
          role_cache: 'member', bio: null, visibility: {}, member_since: 2026,
          is_own: true, is_deleted: false,
        }]);
      }
      if (name === 'posts_full') return Promise.resolve(ROWS);
      if (name === 'my_rejections') {
        return Promise.resolve([{ post_id: 'p-rejected', note: NOTE, rejected_on: '2026-09-17' }]);
      }
      if (name === 'email_confirmation_status') return Promise.resolve({ confirmed: true });
      return Promise.resolve([]);
    },
    mediaUrl: () => null,
  };
  const AUTH = {
    user: () => account, accessToken: () => Promise.resolve('token'),
    restore: () => Promise.resolve(account), onChange: () => {},
    signOut: () => {}, signIn: () => Promise.resolve(account),
    signUp: () => Promise.resolve({ confirmationRequired: false, user: account }),
    requestPasswordReset: () => Promise.resolve(true),
    beginRecovery: () => {}, adoptMailedLink: () => Promise.resolve(account),
  };
  const TURNSTILE = { mount: () => ({ token: () => Promise.resolve('c'), reset: () => {}, remove: () => {} }) };

  const win = await boot({ pathname: '/me', overrides: { DB, AUTH, TURNSTILE } });
  for (let i = 0; i < 16; i++) await settle();
  const t = win.I18N.t;
  const rows = () => view(win).querySelectorAll('li.mine__row');
  const rowOf = (title) => rows().find((r) => textOf(r.querySelector('.mine__title')) === title);
  const button = (row, key) => row && row.querySelectorAll('button').find((b) => textOf(b) === t(key));

  ok(rows().length === 7,
     `CONTROL: the list shows every open submission (${rows().map((r) => textOf(r.querySelector('.mine__title'))).join(' | ')})`);
  ok(rowOf('already withdrawn') === undefined,
     'a withdrawn submission has left the member\'s list');

  const offered = rows().filter((r) => button(r, 'mine.withdraw'))
    .map((r) => textOf(r.querySelector('.mine__title'))).sort();
  ok(JSON.stringify(offered) === JSON.stringify(['in review', 'never came back', 'turned down', 'would not decode']),
     `withdraw is offered on in-review, rejected and failed rows — reaped ones included — and nowhere else (${offered.join(', ')})`);
  const expired = rowOf('never came back');
  ok(expired && textOf(expired).includes(t('mine.err.upload_expired')) && t('mine.err.upload_expired') !== 'mine.err.upload_expired',
     `a reaped upload says the file never arrived, in words (${expired && textOf(expired.querySelector('.mine__error'))})`);
  ok(!button(rowOf('never arrived'), 'mine.withdraw'),
     'NOT on "Upload incomplete" — no remove button over a broken upload');
  ok(!button(rowOf('approved but broken'), 'mine.withdraw'),
     'NOT on an approved post whose ingest failed — approved items go through the removal request');

  const reason = rowOf('turned down') && rowOf('turned down').querySelector('.mine__reason');
  ok(rpcNames.includes('my_rejections') && reason && textOf(reason).includes(NOTE),
     'the moderator\'s note is under the rejected row');
  ok(reason && textOf(reason).includes(t('mine.reviewedOn', { d: win.I18N.day('2026-09-17') })),
     '...with the day of the decision');
  ok(!rowOf('in review').querySelector('.mine__reason'),
     'CONTROL: and no reason block on a row that was not rejected');

  // Two steps. The first click asks and moves focus to the answer; nothing is written.
  button(rowOf('in review'), 'mine.withdraw').fire('click');
  await settle();
  const yes = button(rowOf('in review'), 'mine.withdrawYes');
  ok(yes && patches.length === 0, 'the first click asks and writes nothing');
  ok(yes && win.document.activeElement === yes, '...and focus lands on the answer, not the top of the page');

  // Refused: an empty representation is RLS saying no. The row stays and the button returns.
  yes.fire('click');
  for (let i = 0; i < 6; i++) await settle();
  ok(patches.length === 1 && patches[0].table === 'posts'
       && JSON.stringify(Object.keys(patches[0].body)) === '["status"]'
       && patches[0].body.status === 'withdrawn'
       && /^id=eq\.p-review&select=id,status$/.test(patches[0].filter),
     `the write is {status:'withdrawn'} and nothing else, by id (${JSON.stringify(patches[0])})`);
  ok(rowOf('in review') && button(rowOf('in review'), 'mine.withdraw'),
     'a refused withdraw leaves the row where it was, with its button back');

  button(rowOf('in review'), 'mine.withdraw').fire('click');
  await settle();
  button(rowOf('in review'), 'mine.withdrawYes').fire('click');
  for (let i = 0; i < 6; i++) await settle();
  ok(patches.length === 2 && rowOf('in review') === undefined && rows().length === 6,
     'an accepted withdraw removes the row from the list');
}

console.log(`\n1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
