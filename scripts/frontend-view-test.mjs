// M3's front end — the read path, the XSS sweep, and the two lists that must not drift.
//
// Same technique as frontend-csp-test.mjs and frontend-auth-test.mjs: the modules are
// evaluated against a stub `window` and then poked. No jsdom, no test runner, no
// dependency — §9's no-build-step rule applies to the tests too, or the tests become the
// build step.
//
// ── What is worth asserting here ─────────────────────────────
//
// Not "does the archive render": that needs a browser and a published release, and it is
// what a manual pass is for. What belongs here are the things that fail SILENTLY:
//
//   · a message key that exists in one language and not the other. I18N.t returns the KEY
//     when it misses, so an Arabic reader gets the literal text "mine.state.failed" where a
//     sentence should be — visible, but only to someone reading in that language.
//   · innerHTML creeping back. §6 calls every one a defect; el() no longer offers the prop,
//     and this is what stops the next person adding it back one call site at a time.
//   · the SPA's script list drifting from the prerendered pages'. A module added to
//     index.html and forgotten in prerender.ts leaves every WhatsApp link hydrating into a
//     half-built page — which looks like a rendering bug and is a routing one.
//   · the redaction filter. §8 makes it the only thing standing between a year-cached
//     release and a card for content that has been removed, and it is one `.filter()` away
//     from being lost in a refactor with nothing looking different.
//
//     node scripts/frontend-view-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}

const read = (rel) => readFileSync(join(root, rel), 'utf8');
const jsFiles = readdirSync(join(root, 'site/assets/js'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `site/assets/js/${f}`);

/* ── 1 · every message key resolves, in both languages ────────────────────── */

console.log('# i18n — a key that misses renders as itself');

{
  const winI = {
    document: { documentElement: { setAttribute() {} }, title: '' },
    location: { search: '', hash: '' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    dispatchEvent() {}, CustomEvent: class {}
  };
  new Function('window', read('site/assets/js/i18n.js'))(winI);

  // Literal keys only: `t('kind.' + item.kind)` cannot be resolved statically, and a test
  // that guessed at the concatenations would assert its own guesses. The dynamic families
  // are enumerated below instead, from the vocabularies that bind them.
  const keys = new Set();
  for (const rel of jsFiles) {
    const src = read(rel);
    // The closing quote must be followed by `,` or `)`. Without that, `t('admin.' + name)`
    // contributes the literal prefix "admin." as a key and the assertion fails on strings
    // nobody ever asks for.
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9._]+)'\s*[,)]/g)) keys.add(m[1]);
    for (const m of src.matchAll(/I18N\.t\(\s*'([a-zA-Z0-9._]+)'\s*[,)]/g)) keys.add(m[1]);
  }

  // CONTROL. `keys` is built by regex and an expression that matched nothing would make
  // every assertion below vacuously true — the same argument the CSP test's stub control
  // makes. A key known to be in the source proves the scan found something real.
  ok(keys.has('nav.archive'), 'CONTROL: the scan found literal t() keys in the front end');
  ok(keys.size > 120, `...${keys.size} of them, so the sweep is not a handful`);

  // The dynamic families, each from the vocabulary that decides its values rather than from
  // a list written here. A list written here goes stale in the silent direction.
  for (const k of ['photo', 'voice', 'video', 'event']) keys.add('kind.' + k);
  for (const k of ['exact', 'street', 'area', 'hidden']) {
    keys.add('precision.' + k);
    keys.add('map.precision.' + k);
  }
  // §4's three roles, and the enum is public.app_role in migration 0003.
  const enums = read('supabase/migrations/20260811090300_enums.sql');
  const appRole = /create type public\.app_role as enum \(([^)]*)\)/.exec(enums);
  const roles = appRole ? [...appRole[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
  ok(roles.length === 3, `the role vocabulary comes from migration 0003 (${roles.join(', ') || 'NOT FOUND'})`);
  for (const r of roles) keys.add('role.' + r);
  // The states pendingPanel() derives, from the function itself.
  const pub = read('site/assets/js/public.js');
  for (const m of pub.matchAll(/return '([a-zA-Z]+)';/g)) { /* submissionState's returns */ }
  for (const s of ['processing', 'incomplete', 'failed', 'inReview', 'rejected', 'withdrawn']) {
    keys.add('mine.state.' + s);
  }
  /* M4's two refusal families. Both are rendered as `t('pl.err.' + out.reason)` and
     `t('q.locationErr.' + out.reason)`, so a reason the database can return and the table
     has no line for reaches a moderator as the literal string "pl.err.unknown_place" — in
     a dialog, at the moment they are trying to fix something.

     Derived from the migrations that emit them rather than listed, for the reason the
     roles above are: a list written here goes stale in the silent direction. The two
     functions live in different files and each is sliced to its own body, because a scan
     of either whole file collects the other function's vocabulary too. */
  const sliceOf = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to));
  const gazetteer = read('supabase/migrations/20260821140000_gazetteer.sql');
  const location = read('supabase/migrations/20260821150000_upload_location.sql');
  const reasonsIn = (text) => [...text.matchAll(/'reason',\s*'([a-z_]+)'/g)].map((m) => m[1]);

  const placeReasons = reasonsIn(sliceOf(gazetteer,
    'create or replace function public.save_place',
    'comment on function public.save_place'));
  const fixReasons = reasonsIn(sliceOf(location,
    'create or replace function public.set_post_location',
    'comment on function public.set_post_location'));
  ok(placeReasons.length >= 4 && fixReasons.length >= 3,
     `CONTROL: the two RPCs' refusals were found in their migrations (${placeReasons.length}, ${fixReasons.length})`);
  // 'generic' is the client's own fallback for a transport failure, which no migration
  // emits and every branch can reach.
  for (const r of placeReasons.concat(['generic'])) keys.add('pl.err.' + r);
  for (const r of fixReasons.concat(['generic'])) keys.add('q.locationErr.' + r);

  // The decades DATA offers in the share sheet — every one must have a label or a
  // contributor is offered an option spelled "decade.1940".
  const winD = {};
  new Function('window', read('site/assets/js/data.js'))(winD);
  for (const d of winD.DATA.DECADES) keys.add('decade.' + d);

  const missingAr = [...keys].filter((k) => { const v = winI.I18N.t(k); return !v || v === k; });
  ok(missingAr.length === 0,
     `every key the front end asks for resolves in Arabic${missingAr.length ? ' — missing: ' + missingAr.join(', ') : ''}`);

  winI.I18N.set('en');
  const missingEn = [...keys].filter((k) => { const v = winI.I18N.t(k); return !v || v === k; });
  ok(missingEn.length === 0,
     `and in English${missingEn.length ? ' — missing: ' + missingEn.join(', ') : ''}`);
}

/* ── 2 · the XSS sweep ────────────────────────────────────────────────────── */

console.log('# §6 — no string becomes markup');

{
  // Every way a string can be parsed as HTML, over the whole served tree. `.innerHTML` is
  // the obvious one; the others are the ones a refactor reaches for when the obvious one is
  // being watched.
  const banned = [
    ['innerHTML', /\.innerHTML\s*=/],
    ['outerHTML', /\.outerHTML\s*=/],
    ['insertAdjacentHTML', /insertAdjacentHTML\s*\(/],
    ['document.write', /document\s*\.\s*write(?:ln)?\s*\(/],
    ['Range.createContextualFragment', /createContextualFragment\s*\(/],
    // The `html:` prop el() used to accept. Named specifically because it is what the three
    // admin call sites and eleven public ones went through, and because re-adding it is a
    // two-line change in one file that would silently re-open all fourteen.
    ['an el() `html:` prop', /\bhtml\s*:\s*[^,}\s]/]
  ];

  /* Comments are removed first, and that is not leniency: ui.js and public.js both DISCUSS
     `html:` and innerHTML at length, in the comments explaining why they are gone, so a scan
     of raw text reports the explanation as the defect. This codebase's block comments have
     no leading `*` on continuation lines, so a per-line filter does not see them — the
     blocks have to be removed as blocks.

     Not a JavaScript parser, and it does not need to be: what would break it is a comment
     opener inside a string or a regex literal, and the check below asserts that no file in
     the served tree has one rather than assuming it. A trailing line comment on a code line
     is deliberately NOT stripped, so a commented-out innerHTML assignment still trips the
     scan. That is the safe direction to be wrong in. */
  const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

  // The premise of codeOnly, asserted rather than assumed: a block-comment opener inside a
  // string literal would make the stripper eat live code up to the next closer, blinding the
  // whole scan without failing anything.
  const risky = [...jsFiles, 'site/index.html', 'site/admin.html'].filter((rel) => {
    const stripped = read(rel).replace(/\/\*[\s\S]*?\*\//g, '');
    // An odd number of surviving `*/` means the stripper consumed something it should not.
    return /\*\//.test(stripped);
  });
  ok(risky.length === 0,
     `PREMISE: no served file confuses the comment stripper${risky.length ? ' — ' + risky.join(', ') : ''}`);

  const hits = [];
  for (const rel of [...jsFiles, 'site/index.html', 'site/admin.html']) {
    const src = codeOnly(read(rel));
    for (const [name, re] of banned) {
      if (re.test(src)) hits.push(`${rel}: ${name}`);
    }
  }
  ok(hits.length === 0, `nothing in site/ parses a string as HTML${hits.length ? ' — ' + hits.join('; ') : ''}`);

  // CONTROL for the assertion above, which is otherwise "a regex found nothing" and would
  // pass just as happily against an empty file list or a broken pattern.
  const probe = "node.innerHTML = x; el('div', { html: y });";
  const caught = banned.filter(([, re]) => re.test(probe)).map(([n]) => n);
  ok(caught.length === 2, `CONTROL: the patterns DO catch innerHTML and html: (caught ${caught.join(', ')})`);

  // §6's other half: user strings render inside <bdi>. Asserted as "the helper exists and is
  // used", not as "every string is wrapped" — the second needs a renderer to inspect. What
  // this catches is the helper being deleted or quietly stopping being called.
  const ui = read('site/assets/js/ui.js');
  ok(/function bdi\(/.test(ui) && /createElement\('bdi'\)/.test(ui),
     'ui.js builds a real <bdi> element (§6, the render half of the bidi rule)');
  /* A FLOOR on call sites, and it is a smell detector rather than a proof — said plainly,
     because an assertion that reads like a guarantee and is not one is worse than none.
     What it catches is wrapping removed wholesale in a refactor; what it cannot catch is
     one title that quietly stopped being wrapped.

     Proving the second needs a rendered DOM, and public.js is an IIFE with nothing
     exported to render from. Adding an export purely for a test would put a seam in the
     shipped file to make the test easier, which is the wrong trade. The behavioural half
     is the assertion above: bdi() really does build a <bdi> element. */
  const bdiUses = [...read('site/assets/js/public.js').matchAll(/\bbdi\(/g)].length;
  ok(bdiUses >= 15,
     `public.js routes user strings through bdi() in ${bdiUses} places (a floor, not a proof)`);
}

/* ── 3 · the shell and the prerendered page load the same modules ─────────── */

console.log('# prerender.ts — the duplicated list, pinned');

{
  const shell = read('site/index.html');
  const pre = read('supabase/functions/publish/prerender.ts');

  const shellScripts = [...shell.matchAll(/<script src="([^"]+)"/g)]
    .map((m) => m[1])
    // Turnstile is loaded by the shell and NOT by a prerendered page, deliberately: that
    // page renders one item and offers no control that writes, so the widget would be a
    // third-party script on a document a crawler fetches, for nothing.
    .filter((src) => src.startsWith('/'));
  const preScripts = (/export const SPA_SCRIPTS = \[([^\]]*)\]/.exec(pre)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

  ok(shellScripts.length > 5, `CONTROL: the shell loads ${shellScripts.length} local scripts`);
  ok(shellScripts.join('|') === preScripts.join('|'),
     `SPA_SCRIPTS matches site/index.html exactly, in order` +
     (shellScripts.join('|') === preScripts.join('|') ? '' :
      `\n    shell: ${shellScripts.join(', ')}\n    prerender: ${preScripts.join(', ')}`));

  // In document order, and both attribute orders: the Google Fonts link writes href first
  // and the local ones write rel first. Two separate passes concatenate them out of order,
  // and the comparison below would then be about attribute style rather than about content.
  const shellStyles = [...shell.matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /rel="stylesheet"/.test(tag))
    .map((tag) => /href="([^"]+)"/.exec(tag))
    .filter(Boolean)
    .map((m) => m[1]);
  const preStyles = (/export const SPA_STYLES = \[([^\]]*)\]/.exec(pre)?.[1] ?? '')
    .split(/",\s*/).map((s) => s.trim().replace(/^"|"$|,$/g, '')).filter(Boolean);
  ok(shellStyles.length > 0 && shellStyles.join('|') === preStyles.join('|'),
     `SPA_STYLES matches the shell's stylesheets exactly, in order` +
     (shellStyles.join('|') === preStyles.join('|') ? '' :
      `\n    shell: ${shellStyles.join(', ')}\n    prerender: ${preStyles.join(', ')}`));

  // Every path is absolute. A prerendered page is served at /item/{id}, so a relative
  // `assets/js/x.js` resolves under the route and 404s — for every module, on every shared
  // link, which is the population these pages exist for.
  ok(preScripts.every((s) => s.startsWith('/')) &&
     preStyles.every((s) => s.startsWith('/') || s.startsWith('https://')),
     'every prerendered asset path is absolute');
}

/* ── 4 · archive.js against a stubbed CDN ─────────────────────────────────── */

console.log('# archive.js — the read path and the redaction filter');

const RELEASE = '/v/2026-08-21T09:00:00Z/';

function archiveWindow(files, overrides = {}) {
  const requested = [];
  const win = {
    CONFIG: {
      archiveBase: 'https://cdn.test',
      origins: { cdn: 'https://cdn.test', supabase: 'https://p.supabase.co' },
      supabase: { anonKey: 'anon' }
    },
    fetch(url) {
      requested.push(url);
      const key = url.replace('https://cdn.test', '');
      if (!(key in files)) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(files[key]) });
    },
    _requested: requested,
    ...overrides
  };
  new Function('window', read('site/assets/js/archive.js'))(win);
  return win;
}

const FILES = {
  '/manifest.json': { release: RELEASE, generated_on: '2026-08-21' },
  '/redactions.json': { ids: ['gone-1'] },
  [`${RELEASE}feed/page-1.json`]: {
    page: 1, pages: 2, total: 3,
    items: [{ id: 'keep-1' }, { id: 'gone-1' }, { id: 'keep-2' }]
  },
  [`${RELEASE}item/keep-1.json`]: { id: 'keep-1', media: [] },
  [`${RELEASE}item/gone-1.json`]: { id: 'gone-1', media: [] },
  [`${RELEASE}content.json`]: { blocks: { 'page.order': { ar: 'about,donate', en: 'about,donate' },
                                          'page.about.title': { ar: 'من نحن', en: 'About' },
                                          'page.about.body': { ar: 'نصّ', en: 'text' },
                                          'page.donate.title': { ar: 'ادعم', en: 'Support' },
                                          'page.donate.body': { ar: 'نصّ', en: 'text' } } },
  [`${RELEASE}index.json`]: { pages: 2, total: 3, decades: [1960, 1990], cells: ['sv8yz'] },
  [`${RELEASE}profile/nour.json`]: {
    handle: 'nour', display_name: 'Nour', label: 'member', bio: null, member_since: 2025,
    contributions: [{ id: 'keep-1' }, { id: 'gone-1' }],
    comments: [{ id: 'c1', post_id: 'keep-1', body: 'x' }, { id: 'c2', post_id: 'gone-1', body: 'y' }]
  }
};

{
  const win = archiveWindow(FILES);
  const A = win.ARCHIVE;

  const ready = await A.ready();
  ok(ready.release === RELEASE, 'ready() resolves the pointer to the active release');
  ok(win._requested[0] === 'https://cdn.test/manifest.json',
     '...and the FIRST request of the whole read path is the manifest');

  const feed = await A.feedPage(1);
  ok(feed.items.length === 2 && !feed.items.some((i) => i.id === 'gone-1'),
     'a redacted id is filtered out of the feed (§8)');
  // The discriminating half: the filter must be a filter, not an empty list.
  ok(feed.items.map((i) => i.id).join(',') === 'keep-1,keep-2',
     '...and everything else survives it');
  ok(feed.total === 3,
     'the published total is NOT adjusted — a count that disagreed with the release would make a paging bug look like a takedown');

  const kept = await A.item('keep-1');
  ok(kept && kept.id === 'keep-1', 'item() returns a published item');
  const gone = await A.item('gone-1');
  ok(gone === null, 'item() returns null for a redacted id even though the shard is still there');

  const absent = await A.item('never-existed');
  ok(absent === null, '...and null for one the archive never had');

  const profile = await A.profile('nour');
  ok(profile.contributions.length === 1 && profile.comments.length === 1,
     'a profile page filters redacted contributions AND comments on redacted posts');

  await A.content();
  ok(A.block('page.about.title').ar === 'من نحن', 'content.json drives copy in both languages');
  const pages = A.pages();
  ok(pages.length === 2 && pages[0].slug === 'about' && pages[1].slug === 'donate',
     'the info page sections come from page.order, in that order');

  const idx = await A.index();
  ok(idx.decades.join(',') === '1960,1990' && idx.cells.join(',') === 'sv8yz',
     'index.json names the decades and geo cells this release actually has');
}

{
  // A shard fetched twice is fetched once. §9's budget counts the first feed page, and the
  // viewer asks for the same item shard every time a slide is focused.
  const win = archiveWindow(FILES);
  await win.ARCHIVE.ready();
  await win.ARCHIVE.item('keep-1');
  await win.ARCHIVE.item('keep-1');
  const itemFetches = win._requested.filter((u) => u.includes('item/keep-1')).length;
  ok(itemFetches === 1, 'a shard is fetched once per page load and then held');
}

{
  // Before the first publish there is no manifest. The archive must say so rather than
  // render an empty grid that looks like an archive with nothing in it.
  const win = archiveWindow({});
  const err = await win.ARCHIVE.ready().then(() => null, (e) => e);
  ok(err && err.key === 'archive.err.missing', 'no manifest is a named refusal, not a blank page');
}

{
  // A manifest that names something other than a release path. Everything in the read path
  // concatenates onto this value, so a hostile or corrupt one would point every subsequent
  // fetch somewhere else entirely.
  const win = archiveWindow({ '/manifest.json': { release: 'https://evil.test/' } });
  const err = await win.ARCHIVE.ready().then(() => null, (e) => e);
  ok(err && err.key === 'archive.err.unpublished',
     'a manifest naming an absolute URL is refused rather than followed');
}

{
  // §6: originals are never CDN-fronted. Shards contain no originals path at all — shards.ts
  // drops them — so this is about the URL builder not inventing one from a bad argument.
  const win = archiveWindow(FILES);
  ok(win.ARCHIVE.mediaUrl('post/thumb.webp') === 'https://cdn.test/post/thumb.webp',
     'mediaUrl builds a CDN URL for a shard path');
  ok(win.ARCHIVE.mediaUrl('') === null && win.ARCHIVE.mediaUrl(null) === null,
     '...and null for nothing at all, rather than the bare CDN origin');
}

{
  // §6's ladder: "default to 1080p on desktop, 720p on mobile … Never auto-serve the top
  // rung to a phone."
  const win = archiveWindow(FILES);
  const media = ['480p', '720p', '1080p', '1440p'].map((r) => ({ role: 'rendition', rendition: r, path: r }));
  ok(win.ARCHIVE.rendition(media, true).rendition === '1080p', 'desktop gets 1080p');
  ok(win.ARCHIVE.rendition(media, false).rendition === '720p', 'a phone gets 720p, not the top rung');

  // The step-down rule, which is the half that matters when a ladder is incomplete.
  const sparse = [{ role: 'rendition', rendition: '1440p', path: 'a' },
                  { role: 'rendition', rendition: '480p', path: 'b' }];
  ok(win.ARCHIVE.rendition(sparse, false).rendition === '480p',
     'with 720p missing it steps DOWN to 480p rather than up to 1440p (§6)');
  ok(win.ARCHIVE.rendition([], false) === null, 'and an empty ladder is null, not a guess');
}


/* ── 5 · the shells' modules actually evaluate ────────────────────────────── */

console.log('# the shells — every module loads against the globals before it');

{
  /* THE check a rewritten file needs and no unit test provides.
   *
   * public.js and admin.js are IIFEs that reach for bare globals — `UI`, `I18N`, `DATA`,
   * `DB`, `ARCHIVE` — set by the modules loaded before them. Delete a global that one of
   * them still names and nothing anywhere complains: `deno check` does not see these files,
   * `node --check` parses without resolving identifiers, and every other test here calls
   * exported functions rather than executing the file. The symptom is a blank page and one
   * ReferenceError in a console the visitor does not have open.
   *
   * M3 rewrote both files and deleted `Store`, most of `DATA`, and `ICONS`' string form, so
   * this is precisely the milestone in which that mistake was available.
   *
   * The globals are passed as PARAMETERS rather than assigned to a stub `window`, because
   * `new Function('window', src)` gives the module a `window` object whose properties are
   * not bare identifiers — the browser's are, and the difference is the whole point.
   */
  const noop = () => {};
  const el = () => ({
    className: '', dataset: {}, textContent: '', value: '', firstChild: null,
    style: { setProperty: noop, removeProperty: noop },
    setAttribute: noop, getAttribute: () => null, hasAttribute: () => false,
    addEventListener: noop, removeEventListener: noop,
    appendChild: noop, removeChild: noop, replaceChild: noop, replaceChildren: noop,
    querySelector: () => null, querySelectorAll: () => [], remove: noop, focus: noop,
    offsetParent: null,
  });

  function stubWindow(pathname, hash) {
    return {
      document: {
        createElement: el, createElementNS: el, createTextNode: () => ({}),
        querySelector: () => el(), querySelectorAll: () => [],
        body: el(), documentElement: { setAttribute: noop }, activeElement: null,
        addEventListener: noop, title: '',
      },
      location: { pathname, hash, search: '', href: 'https://x.test' + pathname },
      history: { pushState: noop, replaceState: noop },
      localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
      sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
      addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
      setTimeout: noop, clearTimeout: noop, setInterval: noop, clearInterval: noop,
      scrollTo: noop, innerWidth: 1200, pageYOffset: 0,
      CustomEvent: class {},
      // Never answers. Every module must survive its own first request failing, which is
      // also what a visitor in a tunnel gets.
      fetch: () => Promise.reject(new Error('no network in this probe')),
      CONFIG: {
        origins: { supabase: 'https://s.test', cdn: 'https://cdn.test', site: 'https://x.test' },
        supabase: { anonKey: 'anon' },
        turnstile: { siteKey: '0xTEST' },
        archiveBase: 'https://cdn.test',
        csp: '',
      },
    };
  }

  /** Loads one module the way its shell does, then hands the next its globals by name. */
  function loadInto(win, rel) {
    const names = Object.keys(win).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    const args = names.map((n) => win[n]);
    new Function('window', ...names, read(rel))(win, ...args);
    return win;
  }

  /* The order comes from the shell itself rather than from a list here — the same argument
     the budget script makes. A module the shell loads and this does not would be a module
     nobody ever executes in a test. */
  function shellScripts(file) {
    return [...read(file).matchAll(/<script src="(\/assets\/js\/[^"]+)"/g)].map((m) => `site${m[1]}`);
  }

  const publicOrder = shellScripts('site/index.html');
  ok(publicOrder.length >= 8 && publicOrder[publicOrder.length - 1].endsWith('public.js'),
     `CONTROL: index.html loads ${publicOrder.length} modules, ending with public.js`);

  let threw = null;
  try {
    const win = stubWindow('/', '');
    for (const rel of publicOrder) loadInto(win, rel);
  } catch (e) {
    threw = e;
  }
  ok(threw === null,
     `every module the public shell loads evaluates in order${threw ? ` — ${threw.message}` : ''}`);

  // The dashboard, which admin-boot.js injects after the role check. Its own shell loads
  // the modules before it; admin.js is the one that was rewritten.
  const adminOrder = shellScripts('site/admin.html')
    .filter((rel) => !rel.endsWith('admin-boot.js'))
    .concat(['site/assets/js/admin.js']);

  let adminThrew = null;
  try {
    const win = stubWindow('/admin.html', '#/overview');
    for (const rel of adminOrder) loadInto(win, rel);
  } catch (e) {
    adminThrew = e;
  }
  ok(adminThrew === null,
     `admin.js evaluates against the globals admin.html provides${adminThrew ? ` — ${adminThrew.message}` : ''}`);

  // CONTROL. The two assertions above are "nothing threw", which is exactly what a probe
  // that never executed anything would report. A module naming a global that does not
  // exist must actually throw here.
  let controlThrew = null;
  try {
    const win = stubWindow('/', '');
    new Function('window', 'MISSING_GLOBAL.doSomething();')(win);
  } catch (e) {
    controlThrew = e;
  }
  ok(controlThrew !== null && /is not defined/.test(controlThrew.message),
     'CONTROL: a module reaching for a global that is gone DOES throw here');
}

console.log(`\n1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
