// admin.js, rendered — what a moderator is actually shown before they approve something.
//
// THE DEFECT THIS EXISTS FOR, found by Amro on the live dashboard 7 Sep 2026.
//
// Reviewing a pending post showed a coloured gradient where the photograph should be.
// mapRow() had computed `thumbUrl` and `previewUrl` since M1 and NOTHING read them:
// queueDetail() rendered `.submitted-plate` — a tone block carrying the mime type and the
// pixel dimensions — and never built an <img> at all. Every approval this archive has ever
// recorded was made without the moderator seeing the image.
//
// It survived every test in this repository because nothing here rendered admin.js. The
// source scans read the file, frontend-view-test proves it EVALUATES, and neither can see
// that a value is computed and dropped. A dead assignment is not a syntax error and it is
// not a missing global; it is a node that is never created, which is only visible in a tree.
//
// So this boots the dashboard against scripts/lib/dom-stub.mjs — the same DOM
// frontend-nav-test.mjs uses on the public shell — and asks the rendered tree what a
// reviewer can see. It is not a browser: nothing here computes a style or lays anything
// out. What it faithfully has is the tree, the attributes and querySelector, which is all
// an assertion about "is there an image, and does it point at the right object" needs.
//
//     node scripts/frontend-admin-test.mjs

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

const CDN = 'https://cdn.test';
const POST = 'c51f77d2-a4a4-4f89-be6e-57d2e509b81c';

/* The shape QUEUE_QUERY actually asks PostgREST for, and the shape the deployed database
   actually answers with — a master in `originals`, a display rendition and a thumb in
   `public`. Taken from the one ready pending row on the live system rather than invented,
   because the bug was about which of these three the pane reaches for. */
function row(extra = {}) {
  return {
    id: POST,
    kind: 'media',
    title_ar: 'صورة',
    title_en: 'A photograph',
    body_ar: '', body_en: '',
    created_on: '2026-09-06',
    license: 'CC-BY-4.0',
    provenance: 'family album',
    decade: 1960,
    location_precision: 'street',
    place_id: null,
    place: null,
    media_assets: [
      { role: 'master', rendition: null, bucket: 'originals', mime: 'image/jpeg',
        width: 4032, height: 3024, bytes: 2400000, duration_s: null,
        storage_path: 'private/master.jpg' },
      { role: 'rendition', rendition: '1440p', bucket: 'public', mime: 'image/webp',
        width: 1440, height: 1920, bytes: 335374, duration_s: null,
        storage_path: POST + '/display.webp' },
      { role: 'thumb', rendition: null, bucket: 'public', mime: 'image/webp',
        width: 400, height: 534, bytes: 42628, duration_s: null,
        storage_path: POST + '/thumb.webp' },
    ],
    ...extra,
  };
}

const SHELL = [...read('site/admin.html').matchAll(/<script src="(\/assets\/js\/([^"]+))"/g)]
  .map((m) => `site/assets/js/${m[2]}`)
  // admin-boot.js is the role check and the loader; the dashboard itself is admin.js.
  .filter((rel) => !rel.endsWith('admin-boot.js'))
  .concat(['site/assets/js/admin.js']);

/**
 * Boot the dashboard on one section, with `rows` as the moderation queue.
 *
 * admin.js is an IIFE that calls render(), loadMe() and loadQueue() the moment it
 * evaluates, so every global it reads has to be in place before it is loaded — which is
 * the same seam frontend-nav-test.mjs uses, at the same point.
 */
async function boot({ rows = [row()], section = 'queue' } = {}) {
  const win = makeWindow({ pathname: '/admin.html', hash: '#/' + section });

  /* admin.html's own landmarks. dom-stub builds index.html's, and admin.js reaches for
     these two by id at boot — without them the first mount throws and the dashboard is a
     blank page, which is the failure this file's own subject looked like. */
  for (const [tag, id] of [['nav', 'rail'], ['main', 'main']]) {
    const n = win.document.createElement(tag);
    n.id = id;
    win.document.body.appendChild(n);
  }

  const account = { id: 'mod-1', email: 'mod@t.local', role: 'moderator' };
  const calls = [];
  const DB = {
    select: (table, query) => {
      calls.push({ table, query });
      if (table === 'posts') return Promise.resolve(rows);
      if (table === 'profiles') return Promise.resolve([{ handle: 'a_moderator' }]);
      return Promise.resolve([]);
    },
    insert: () => Promise.resolve(null),
    patch: () => Promise.resolve([]),
    del: () => Promise.resolve(null),
    rpc: (name) => (name === 'authz_role' ? Promise.resolve('moderator') : Promise.resolve([])),
    // The REAL rule, not a stub that always answers: §3 forbids an `originals` row ever
    // acquiring a public URL, and db.js expresses that as null. A test that stubbed this
    // could not tell a correct pane from one showing the archival master.
    mediaUrl: (asset) => (asset && asset.bucket === 'public' && asset.storage_path
      ? CDN + '/' + asset.storage_path
      : null),
  };
  const AUTH = {
    user: () => account,
    accessToken: () => Promise.resolve('token'),
    restore: () => Promise.resolve(account),
    onChange: () => {}, signOut: () => {},
    signIn: () => Promise.resolve(account),
  };

  win.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });

  for (const rel of SHELL) {
    if (rel.endsWith('admin.js')) Object.assign(win, { DB, AUTH });
    const names = Object.keys(win).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k));
    new Function('window', ...names, read(rel))(win, ...names.map((n) => win[n]));
    if (rel.endsWith('config.js')) win.CONFIG = { ...win.CONFIG, origins: { ...win.CONFIG.origins, cdn: CDN } };
  }

  for (let i = 0; i < 12; i++) await settle();
  return { win, calls };
}

const main = (win) => win.document.querySelector('#main');

/* ═══ 1 · the reviewer can see the thing they are approving ══════════════════ */

console.log('# the moderation queue — the image is on the screen');

{
  const { win, calls } = await boot();

  ok(calls.some((c) => c.table === 'posts'), 'CONTROL: the dashboard asked for the queue');

  const detail = main(win).querySelector('.pane-detail');
  ok(detail !== null, 'CONTROL: a pending post opens its review pane');

  /* THE assertion. Not "the pane rendered" — it always did — but that a picture is in it. */
  const img = detail && detail.querySelector('.submitted-plate__media');
  ok(img !== null && img !== undefined,
     'the review pane renders the media itself, not only a placeholder plate');
  ok(img && img.tagName === 'IMG',
     `...as an <img> for an image post (${img ? img.tagName : 'nothing'})`);
  ok(img && img.getAttribute('src') === CDN + '/' + POST + '/display.webp',
     `...pointing at the public DERIVATIVE (${img ? img.getAttribute('src') : 'no src'})`);

  /* §3, and the reason cdnUrl is not a string concatenation. The master is 4032×3024 in
     `originals`, it is in the row this pane was handed, and it must not be what a browser
     is asked to fetch. */
  const srcs = detail.querySelectorAll('img').map((n) => n.getAttribute('src') || '');
  ok(srcs.every((s) => !/private\/master\.jpg$/.test(s)),
     `the archival master is never the src (§3 — originals are not CDN-fronted) [${srcs.join(', ')}]`);

  // Every image needs a text alternative; the title is the only one this row has.
  ok(img && (img.getAttribute('alt') || '').length > 0,
     `...and it carries an alt (§9 accessibility) ("${img ? img.getAttribute('alt') : ''}")`);

  /* The metadata that WAS the whole pane is kept, as a caption. It is real information —
     a reviewer wants the mime and the dimensions — it just was not a substitute for the
     photograph. */
  const meta = detail.querySelector('.submitted-plate__meta');
  ok(meta !== null && /image\/jpeg/.test(textOf(meta)),
     `the mime and dimensions survive as a caption beside it ("${meta ? textOf(meta) : 'gone'}")`);
}

/* ═══ 2 · the other two kinds, and the honest empty ══════════════════════════ */

console.log('# the other media kinds');

{
  // A video's rendition is a video: it must get a <video> with the poster as its still,
  // not an <img> that a browser would fail to decode.
  const videoRow = row({
    media_assets: [
      { role: 'master', bucket: 'originals', mime: 'video/quicktime', storage_path: 'private/m.mov',
        width: 3840, height: 2160, bytes: 900000000, rendition: null, duration_s: 120 },
      { role: 'rendition', rendition: '1080p', bucket: 'public', mime: 'video/mp4',
        storage_path: POST + '/1080p.mp4', width: 1920, height: 1080, bytes: 50000000, duration_s: 120 },
      { role: 'poster', bucket: 'public', mime: 'image/webp', storage_path: POST + '/poster.webp',
        width: 1920, height: 1080, bytes: 60000, rendition: null, duration_s: null },
    ],
  });
  const { win } = await boot({ rows: [videoRow] });
  const node = main(win).querySelector('.submitted-plate__media');
  ok(node && node.tagName === 'VIDEO',
     `a video renders as <video> (${node ? node.tagName : 'nothing'})`);
  ok(node && node.getAttribute('poster') === CDN + '/' + POST + '/poster.webp',
     `...with the poster frame the worker made (${node ? node.getAttribute('poster') : 'none'})`);
  ok(node && node.getAttribute('src') === CDN + '/' + POST + '/1080p.mp4',
     '...playing the rendition, never the 4K master');
}

{
  // §7 calls a voice note the most identifying medium in the archive, so the one surface
  // that decides whether it is published must be able to play it.
  const voiceRow = row({
    kind: 'voice',
    media_assets: [
      { role: 'master', bucket: 'originals', mime: 'audio/wav', storage_path: 'private/m.wav',
        width: null, height: null, bytes: 40000000, rendition: null, duration_s: 300 },
      { role: 'rendition', rendition: null, bucket: 'public', mime: 'audio/mp4',
        storage_path: POST + '/audio.m4a', width: null, height: null, bytes: 2000000, duration_s: 300 },
    ],
  });
  const { win } = await boot({ rows: [voiceRow] });
  const audio = main(win).querySelector('.submitted-plate__audio-el');
  ok(audio && audio.tagName === 'AUDIO',
     `a voice note renders a player (${audio ? audio.tagName : 'nothing'})`);
  ok(audio && audio.getAttribute('src') === CDN + '/' + POST + '/audio.m4a',
     '...on the normalized derivative');
}

{
  /* A row whose only asset is the master. There is nothing publishable to show, and the
     pane must say so rather than appear to show an image that failed to load — the
     distinction the original plate could not make, because it looked identical either
     way. */
  const bareRow = row({
    media_assets: [
      { role: 'master', bucket: 'originals', mime: 'image/jpeg', storage_path: 'private/m.jpg',
        width: 4032, height: 3024, bytes: 2400000, rendition: null, duration_s: null },
    ],
  });
  const { win } = await boot({ rows: [bareRow] });
  const pane = main(win).querySelector('.pane-detail');
  ok(pane && pane.querySelector('.submitted-plate__media') === null,
     'a post with no public derivative shows no media element');
  ok(pane && textOf(pane).includes(win.I18N.t('feed.noPreview')),
     `...and says there is nothing to preview ("${win.I18N.t('feed.noPreview')}")`);
  const imgs = pane ? pane.querySelectorAll('img').map((n) => n.getAttribute('src') || '') : [];
  ok(imgs.every((s) => !/private\//.test(s)),
     'CONTROL: and it does not reach for the master to fill the gap');
}

console.log(`\n1..${passed + failed}`);
if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
