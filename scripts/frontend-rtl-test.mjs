// §9's RTL rules, checked against the source. M6's "RTL pass incl. slider direction".
//
//   "Arabic-first RTL. CSS logical properties only (ms-, me-, ps-, pe-, inset-inline) —
//    never left/right. Every string through I18N with ar and en keys.
//    Intl.DateTimeFormat('ar-PS'). One digit system, held consistently.
//    The decade slider must run right-to-left in Arabic."
//
// ── What is here and what is NOT ─────────────────────────────
//
// Here: everything decidable from the files. The physical-property ban, the mirroring of
// directional glyphs, the digit system, the date locale, and that the slider is not
// overridden out of the direction it inherits.
//
// NOT here: whether the slider actually renders right-to-left. That is a browser's
// behaviour, not this repository's, and asserting it from source would be asserting a
// belief about Chromium. `scripts/rtl-browser-probe.mjs` measures it in a real browser at
// two document directions and is what the M6 report cites. This file's job on that point is
// narrower and still worth doing: prove nothing in our CSS overrides the direction the
// control inherits, which is the only way we could break it.
//
//     node scripts/frontend-rtl-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}

const cssFiles = readdirSync(join(root, 'site/assets/css')).filter((n) => n.endsWith('.css'));

/* ── 1 · logical properties only ───────────────────────────────────────────── */
//
// The rule §9 states, as a rule rather than as a habit. Physical sides are how an RTL
// layout regresses: they are correct on the maintainer's screen in one language and wrong
// in the other, and nothing about the code looks wrong.

/** Physical side properties that have a logical equivalent and therefore have no excuse. */
const PHYSICAL = new RegExp(
  [
    String.raw`(?:margin|padding)-(?:left|right)\s*:`,
    String.raw`border-(?:left|right)-(?:width|style|color)?\s*:`,
    String.raw`border-(?:top|bottom)-(?:left|right)-radius\s*:`,
    String.raw`(?:^|[;{\s])(?:left|right)\s*:`,
    String.raw`text-align\s*:\s*(?:left|right)`,
    String.raw`float\s*:\s*(?:left|right)`,
    String.raw`clear\s*:\s*(?:left|right)`,
  ].join('|'),
  'g',
);

/** Strip comments first: a comment that says the word "left" is not a layout rule. */
const uncommented = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const physical = [];
for (const name of cssFiles) {
  const src = uncommented(read(`site/assets/css/${name}`));
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(PHYSICAL)) physical.push(`${name}:${i + 1} ${m[0].trim()}`);
  });
}
ok(physical.length === 0,
   `no physical side property in any stylesheet${physical.length ? ` — ${physical.slice(0, 6).join(', ')}${physical.length > 6 ? ` (+${physical.length - 6})` : ''}` : ''}`);

// CONTROL. The scan above passes by finding nothing, which is also what a broken scan does.
{
  const fixture = '.x { margin-left: 4px; text-align: right; inset-inline-start: 0; }';
  const hits = [...fixture.matchAll(PHYSICAL)].map((m) => m[0].trim());
  ok(hits.length === 2, `CONTROL: the scan finds both physical rules in a fixture and ignores the logical one (${hits.join(' | ')})`);
  ok(uncommented('/* left: 0 */ .y { color: red; }').match(PHYSICAL) === null,
     'CONTROL: the word "left" inside a comment is not reported as a layout rule');
}

// Logical properties are actually being used, rather than the file simply having no layout.
{
  const all = cssFiles.map((n) => read(`site/assets/css/${n}`)).join('\n');
  const logical = (all.match(/inset-inline|margin-inline|padding-inline|border-inline|text-align\s*:\s*(?:start|end)/g) ?? []).length;
  ok(logical >= 20, `CONTROL: ${logical} logical-property declarations are present — the ban is not passing over an empty stylesheet`);
}

/* ── 2 · the decade slider inherits its direction ──────────────────────────── */
//
// A range input follows the document's `dir`, so in an Arabic document the track runs
// right-to-left with the minimum at the right, which is what §9 asks for. The only way
// this project breaks it is by overriding `direction` on the control or its container.

{
  const all = cssFiles.map((n) => `\n/*${n}*/\n` + uncommented(read(`site/assets/css/${n}`))).join('');
  const sliderBlocks = [...all.matchAll(/\.decade-slider[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  ok(sliderBlocks.length >= 3, `CONTROL: ${sliderBlocks.length} .decade-slider rules found to inspect`);
  const overrides = sliderBlocks.filter((b) => /(?:^|[;\s])(?:direction|writing-mode|transform)\s*:/.test(b));
  ok(overrides.length === 0,
     `nothing overrides direction, writing-mode or transform on the slider — it inherits the document's, which is what makes it run right-to-left in Arabic${overrides.length ? ` — ${overrides.join(' | ')}` : ''}`);

  // The `transform: scaleX(-1)` trick is how people "fix" a slider that already worked,
  // and it mirrors the thumb and the keyboard direction with it. Banned by name across the
  // whole stylesheet, because it would be applied here or to an ancestor.
  ok(!/scaleX\s*\(\s*-1\s*\)/.test(all),
     'no scaleX(-1) anywhere — mirroring a control with a transform reverses its keyboard behaviour too');
}

/* ── 3 · directional glyphs mirror between the two languages ───────────────── */
//
// An arrow is not a translation-invariant character. "Back" is where the reading started,
// which is the left in English and the RIGHT in Arabic, so a string that ships the same
// arrow in both is wrong in one of them. `admin.backToSite` was, until M6.

const i18n = read('site/assets/js/i18n.js');
const MIRRORED = { '←': '→', '→': '←', '‹': '›', '›': '‹', '◂': '▸', '▸': '◂' };
const entries = [...i18n.matchAll(/'([\w.]+)':\s*\{\s*ar:\s*'((?:[^'\\]|\\.)*)'\s*,\s*en:\s*'((?:[^'\\]|\\.)*)'/g)];
ok(entries.length > 300, `CONTROL: ${entries.length} ar/en string pairs parsed out of i18n.js`);

const unmirrored = [];
for (const [, key, ar, en] of entries) {
  for (const ch of Object.keys(MIRRORED)) {
    if (ar.includes(ch) && en.includes(ch)) unmirrored.push(`${key} has ${ch} in both languages`);
  }
}
ok(unmirrored.length === 0,
   `no horizontal arrow points the same way in both languages${unmirrored.length ? ` — ${unmirrored.join(', ')}` : ''}`);

/* ── 4 · one digit system, and the date locale §9 names ────────────────────── */

const js = readdirSync(join(root, 'site/assets/js'))
  .filter((n) => n.endsWith('.js'))
  .map((n) => ({ name: n, src: read(`site/assets/js/${n}`) }));

{
  const locales = new Set();
  for (const { src } of js) {
    for (const m of src.matchAll(/Intl\.\w+\(\s*'([a-zA-Z-]+)'/g)) locales.add(m[1]);
    for (const m of src.matchAll(/toLocaleDateString\(\s*'([a-zA-Z-]+)'/g)) locales.add(m[1]);
  }
  ok(locales.size > 0, `CONTROL: ${locales.size} Intl locale(s) named in the front end: ${[...locales].join(', ')}`);
  ok(locales.has('ar-PS'), `§9's 'ar-PS' is the Arabic date locale${locales.has('ar-PS') ? '' : ` — found ${[...locales].join(', ')}`}`);
}

{
  // "One digit system, held consistently" — the numbering system must be chosen in ONE
  // place. Two views disagreeing about latn vs arab is the failure this catches, and it
  // looks like nothing on a page that happens to show only one of them.
  const withNumbering = js.filter(({ src }) => /numberingSystem|-nu-/.test(src)).map((f) => f.name);
  ok(withNumbering.length <= 1,
     `the digit system is decided in one module${withNumbering.length > 1 ? ` — but ${withNumbering.join(' and ')} each decide it` : ` (${withNumbering[0] ?? 'none — the locale default, which is one system'})`}`);
}

console.log(`\n1..${passed + failed}`);
if (failed) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
console.log(`All ${passed} assertions passed.`);
