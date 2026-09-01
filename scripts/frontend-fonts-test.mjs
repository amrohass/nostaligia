// §9's font rules, checked against the COMMITTED output, from the repository alone.
//
//   "Arabic font subset with unicode-range split, WOFF2, font-display: swap — and verify
//    shaping after subsetting."
//
// ── The division of labour, and why it is this way ───────────
//
// `scripts/subset-fonts.py` verifies SHAPING, because that needs HarfBuzz, fontTools and
// the unsubsetted originals — none of which are in this repository and none of which
// belong in CI. It refuses to write a face whose Arabic stops shaping, so a bad subset
// never reaches a commit.
//
// This file checks everything that IS decidable from what was committed, which is more
// than it sounds: that the files exist, that they are really WOFF2, that each still
// carries the tables Arabic shaping needs, that the unicode-range split is exact rather
// than approximately right, and that every string the interface will actually render has
// a face that covers it. It needs no dependency, so CI runs it on every push.
//
// The one thing neither can check is that the font LOOKS right, which is a person's job.
//
//     node scripts/frontend-fonts-test.mjs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}

const CSS_PATH = 'site/assets/css/fonts.css';
const css = read(CSS_PATH);

/* ── 1 · the faces, parsed out of the generated stylesheet ─────────────────── */

const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
  const field = (k) => (body.match(new RegExp(`${k}\\s*:\\s*([^;]+);`)) ?? [, ''])[1].trim();
  return {
    family: field('font-family').replace(/^['"]|['"]$/g, ''),
    weight: field('font-weight'),
    display: field('font-display'),
    src: field('src'),
    range: field('unicode-range'),
    file: (field('src').match(/url\('([^']+)'\)/) ?? [, ''])[1],
  };
});

ok(faces.length >= 9, `CONTROL: ${faces.length} @font-face rules parsed out of ${CSS_PATH}`);
ok(faces.every((f) => f.family && f.weight && f.file && f.range),
   'every face declares a family, a weight, a file and a unicode-range');

/* ── 2 · §9's three literal requirements ───────────────────────────────────── */

const noSwap = faces.filter((f) => f.display !== 'swap');
ok(noSwap.length === 0,
   `font-display: swap on every face${noSwap.length ? ` — missing on ${noSwap.map((f) => f.file).join(', ')}` : ''}`);

ok(faces.every((f) => /format\('woff2'\)/.test(f.src)) && faces.every((f) => f.file.endsWith('.woff2')),
   'WOFF2, declared and named — not a TTF with a woff2 label on it');

ok(faces.every((f) => f.file.startsWith('/assets/fonts/')),
   'every src is a path on this origin — font-src is \'self\' and anything else is a blocked request');

/* ── 3 · the files are real, and are what they claim ───────────────────────── */

const FONT_DIR = 'site/assets/fonts';
const onDisk = readdirSync(join(root, FONT_DIR)).filter((n) => n.endsWith('.woff2'));

const missing = faces.filter((f) => !existsSync(join(root, f.file.replace(/^\//, 'site/'))));
ok(missing.length === 0,
   `every declared face has its file${missing.length ? ` — missing ${missing.map((f) => f.file).join(', ')}` : ''}`);

const declaredFiles = new Set(faces.map((f) => f.file.split('/').pop()));
const orphans = onDisk.filter((n) => !declaredFiles.has(n));
ok(orphans.length === 0,
   `no font file is shipped that no @font-face names${orphans.length ? ` — ${orphans.join(', ')}` : ''}`);

/* ── 4 · WOFF2, and the tables Arabic shaping needs ────────────────────────── */
//
// A WOFF2 file's table directory is readable WITHOUT decompressing the font: the header is
// 48 bytes, then one entry per table, each starting with a flag byte whose low 6 bits are
// an index into a fixed list of known tags (0x3f means "an arbitrary 4-byte tag follows").
// So which tables a face carries is decidable here, with no font library at all.
//
// This is the half of the shaping guarantee that survives into CI. It cannot say the
// shaping is CORRECT — subset-fonts.py's HarfBuzz comparison says that — but it can say
// nobody has since committed a face with GSUB stripped out, which is the way Arabic breaks.

const KNOWN_TAGS = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf',
  'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT',
  'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT',
  'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar',
  'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd',
  'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

/** Read a UIntBase128 as the WOFF2 spec defines it, returning [value, nextOffset]. */
function uintBase128(buf, at) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const b = buf[at + i];
    value = (value << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [value >>> 0, at + i + 1];
  }
  throw new Error('malformed UIntBase128');
}

function woff2Tables(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'wOF2') return null;
  const numTables = bytes.readUInt16BE(12);
  let at = 48;
  const tags = [];
  for (let i = 0; i < numTables; i++) {
    const flags = bytes[at]; at += 1;
    const known = flags & 0x3f;
    if (known === 0x3f) { tags.push(bytes.toString('ascii', at, at + 4)); at += 4; }
    else tags.push(KNOWN_TAGS[known] ?? `?${known}`);
    [, at] = uintBase128(bytes, at);                       // origLength
    const transform = (flags >> 6) & 0x03;
    // glyf/loca carry a transformLength when transform version is 0; every other table
    // carries one when the version is non-zero. Straight out of the WOFF2 spec.
    const tag = tags[tags.length - 1];
    const hasTransformLength = (tag === 'glyf' || tag === 'loca') ? transform === 0 : transform !== 0;
    if (hasTransformLength) [, at] = uintBase128(bytes, at);
  }
  return tags;
}

const SHAPING_TABLES = ['GSUB', 'GDEF'];
const badTables = [];
let arabicFacesChecked = 0;
for (const f of faces) {
  const bytes = readFileSync(join(root, f.file.replace(/^\//, 'site/')));
  const tags = woff2Tables(bytes);
  if (tags === null) { badTables.push(`${f.file}: not a WOFF2 file`); continue; }
  const isArabic = /U\+0600/.test(f.range);
  if (!isArabic) continue;
  arabicFacesChecked++;
  const absent = SHAPING_TABLES.filter((t) => !tags.includes(t));
  if (absent.length) badTables.push(`${f.file}: no ${absent.join(', ')} — Arabic will render as unjoined letters`);
}
ok(arabicFacesChecked >= 4, `CONTROL: ${arabicFacesChecked} Arabic faces were opened and their tables read`);
ok(badTables.length === 0,
   `every Arabic face still carries GSUB and GDEF${badTables.length ? ` — ${badTables.join('; ')}` : ''}`);

/* ── 5 · the unicode-range split is EXACT ──────────────────────────────────── */
//
// Two faces of the same family and weight whose ranges overlap is the bug this catches:
// which one a browser picks for the shared codepoint is not something to leave to an
// engine's tie-breaking, and the two subsets were split at U+200C-200F precisely to avoid it.

function expand(range) {
  const out = [];
  for (const part of range.split(',')) {
    const m = part.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/);
    if (!m) continue;
    out.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
  }
  return out;
}

const overlaps = [];
for (let i = 0; i < faces.length; i++) {
  for (let j = i + 1; j < faces.length; j++) {
    const a = faces[i], b = faces[j];
    if (a.family !== b.family || a.weight !== b.weight) continue;
    for (const [lo1, hi1] of expand(a.range)) {
      for (const [lo2, hi2] of expand(b.range)) {
        if (lo1 <= hi2 && lo2 <= hi1) {
          overlaps.push(`${a.file} and ${b.file} both claim U+${Math.max(lo1, lo2).toString(16).toUpperCase()}`);
        }
      }
    }
  }
}
ok(overlaps.length === 0,
   `no two faces of the same family and weight claim the same codepoint${overlaps.length ? ` — ${overlaps[0]}` : ''}`);

// CONTROL for the overlap detector, which otherwise passes by finding nothing.
{
  const a = expand('U+0600-06FF'), b = expand('U+06F0-0700');
  const hit = a.some(([l1, h1]) => b.some(([l2, h2]) => l1 <= h2 && l2 <= h1));
  ok(hit, 'CONTROL: the overlap detector DOES fire on two ranges that overlap');
}

/* ── 6 · every character the interface renders has a face ──────────────────── */
//
// The split is only correct if it is also COMPLETE. A codepoint in neither range falls
// through to whatever the operating system has, which on an Arabic-first archive is the
// failure the subsetting was meant to prevent — and it is invisible on the maintainer's
// machine, which has the full fonts installed.
//
// Source: i18n.js's own strings, which are every fixed string the UI can show. Member
// content is not checkable here and does not need to be: it is Arabic and Latin text, and
// the ranges cover both blocks entirely.

const covered = [];
for (const f of faces) covered.push(...expand(f.range));
const isCovered = (cp) => covered.some(([lo, hi]) => cp >= lo && cp <= hi);

const i18n = read('site/assets/js/i18n.js');
const strings = [...i18n.matchAll(/(?:ar|en)\s*:\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
ok(strings.length > 400, `CONTROL: ${strings.length} interface strings read out of i18n.js`);

const uncovered = new Map();
for (const s of strings) {
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (!isCovered(cp)) uncovered.set(cp, (uncovered.get(cp) ?? 0) + 1);
  }
}
const report = [...uncovered.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([cp, n]) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(String.fromCodePoint(cp))} ×${n}`);
ok(uncovered.size === 0,
   `every character in the interface's own strings is covered by a declared range${uncovered.size ? ` — ${uncovered.size} are not: ${report.join(', ')}` : ''}`);

// CONTROL: a codepoint deliberately outside both ranges must be reported as uncovered.
ok(!isCovered(0x4E2D), 'CONTROL: a CJK codepoint is correctly reported as covered by nothing');

/* ── 7 · what the fonts cost ───────────────────────────────────────────────── */
//
// Not a pass/fail. §9's 150 KB budget names HTML + CSS + JS + the first feed page and does
// NOT name fonts -- they get their own sentence in the same section. Printed because a
// number nobody prints is a number nobody notices growing.

const bytes = onDisk.map((n) => statSync(join(root, FONT_DIR, n)).size);
const total = bytes.reduce((a, b) => a + b, 0);
const arabic400 = statSync(join(root, FONT_DIR, 'plex-arabic-400-arabic.woff2')).size;
console.log(`\n# fonts: ${onDisk.length} files, ${(total / 1024).toFixed(1)} KiB total`);
console.log(`#   the one preloaded face (Arabic 400): ${(arabic400 / 1024).toFixed(1)} KiB`);
console.log('#   a page transfers only the faces whose ranges match characters on it.');

console.log(`\n1..${passed + failed}`);
if (failed) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log(`All ${passed} assertions passed.`);
