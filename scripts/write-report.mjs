// Assemble a report out of its sections and write it ONCE.
//
//     node scripts/write-report.mjs --out docs/audit-2026-08-31.md base.md m1.md m2.md …
//     node scripts/write-report.mjs --out docs/audit-2026-08-31.md --replace …
//     node scripts/write-report.mjs --check docs/audit-2026-08-31.md
//     node scripts/write-report.mjs --selftest
//
// ── Why this file exists ─────────────────────────────────────
//
// docs/audit-2026-08-31.md was committed containing THREE concatenated copies of itself, the
// first two cut off mid-sentence. Nothing in this repository wrote it: the sections lived in
// a scratchpad and were assembled by hand, across retries, with a `String.replace` whose
// replacement text happened to contain a `$` followed by a backtick. In a replacement string
// that sequence means "everything before the match", so one splice pasted the whole document
// back into itself, twice.
//
// Two things follow, and this file is both of them.
//
// **Writing is a truncating write, never an append.** A retry must produce the same file, not
// a longer one. There is exactly one write below and it is `writeFileSync` with an explicit
// `flag: 'w'` — spelled out rather than left to the default, because the default is the whole
// bug and a reader should not have to know what it is.
//
// **A finished report is CHECKED before it is believed.** Truncating alone would not have
// caught the original: the splice happened inside the string, before any write. So the check
// is on the property that actually failed — a `## ` heading appearing more than once. Every
// way a report doubles (an append, a retry, a `$`-splice, a bad merge) shows up as a repeated
// heading, and none of them shows up as an error. `--check` runs that alone over a file that
// already exists, which is how the committed report is verified.
//
// **Nothing here calls String.replace with a string replacement**, and nothing should. If a
// substitution is ever needed, use `split(anchor).join(text)`, which has no metacharacters.

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/* ── The invariant ────────────────────────────────────────────────────────── */

/**
 * Every `## ` heading, in order, with the line it is on.
 *
 * Fenced code blocks are skipped: a report quoting a shell session or a diff can legitimately
 * contain a line starting with `## `, and counting those would make the check fire on a
 * correct document — which is the fastest way to get a check turned off.
 */
export function headings(text) {
  const out = [];
  let fenced = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```') || line.startsWith('~~~')) { fenced = !fenced; continue; }
    if (fenced) continue;
    if (line.startsWith('## ')) out.push({ line: i + 1, text: line.trim() });
  }
  return out;
}

/** The headings that appear more than once, with every line they appear on. */
export function duplicated(text) {
  const seen = new Map();
  for (const h of headings(text)) {
    if (!seen.has(h.text)) seen.set(h.text, []);
    seen.get(h.text).push(h.line);
  }
  return [...seen].filter(([, lines]) => lines.length > 1).map(([heading, lines]) => ({ heading, lines }));
}

/* ── Assembly ─────────────────────────────────────────────────────────────── */

/**
 * The sections, joined.
 *
 * One blank line between them and exactly one newline at the end, so re-running over the same
 * inputs is byte-identical — a report that differs from itself on a retry is indistinguishable
 * from one that changed.
 */
export function assemble(parts) {
  return parts.map((p) => p.replace(/\s+$/, '')).join('\n\n') + '\n';
}

/* ── The command ──────────────────────────────────────────────────────────── */

function fail(message) {
  console.error(`write-report: ${message}`);
  process.exit(1);
}

function checkFile(path) {
  const abs = resolve(root, path);
  if (!existsSync(abs)) fail(`${path} does not exist`);
  const text = readFileSync(abs, 'utf8');
  const dupes = duplicated(text);
  if (dupes.length) {
    console.error(`write-report: ${path} has ${dupes.length} repeated heading(s) — it looks appended to, not rewritten:`);
    for (const d of dupes) console.error(`  ${d.heading}  — lines ${d.lines.join(', ')}`);
    process.exit(1);
  }
  console.log(`write-report: ${path} — ${headings(text).length} headings, each exactly once, ${text.length} bytes`);
}

function writeReport(out, partPaths, replace) {
  const abs = resolve(root, out);

  /* The loud refusal. A report path that already holds something is either a rerun that
     should say so, or the append this file exists to prevent — and telling them apart is the
     author's job, not a default's. */
  if (existsSync(abs) && statSync(abs).size > 0) {
    const existing = readFileSync(abs, 'utf8');
    if (existing.trim() && !replace) {
      fail(`${out} already has content (${existing.length} bytes, ${headings(existing).length} headings).\n` +
           '  Nothing was written. Pass --replace to overwrite it deliberately, or write to a new path.\n' +
           '  This refusal is the whole point of this script: the 31 Aug audit shipped as three\n' +
           '  concatenated copies of itself because a rerun appended instead of replacing.');
    }
  }

  const parts = partPaths.map((p) => {
    const at = resolve(root, p);
    if (!existsSync(at)) fail(`section ${p} does not exist`);
    return readFileSync(at, 'utf8');
  });

  const text = assemble(parts);

  const dupes = duplicated(text);
  if (dupes.length) {
    console.error(`write-report: the assembled report repeats ${dupes.length} heading(s) — refusing to write it:`);
    for (const d of dupes) console.error(`  ${d.heading}  — lines ${d.lines.join(', ')}`);
    process.exit(1);
  }

  // The one write. `flag: 'w'` truncates; it is spelled out because the alternative is the bug.
  writeFileSync(abs, text, { encoding: 'utf8', flag: 'w' });

  // Read it back rather than trusting the write: this is the step that would have caught the
  // original, and it costs one file read.
  const written = readFileSync(abs, 'utf8');
  if (written !== text) fail(`${out} does not match what was written — ${written.length} bytes on disk, ${text.length} intended`);

  console.log(`write-report: ${out} — ${partPaths.length} sections, ${headings(text).length} headings, ${text.length} bytes`);
}

/* ── Self-test ────────────────────────────────────────────────────────────── */

async function selftest() {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');

  const work = mkdtempSync(join(tmpdir(), 'write-report-'));
  const me = fileURLToPath(import.meta.url);
  let passed = 0;
  let failed = 0;
  const ok = (cond, name) => {
    if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
    else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
  };

  const at = (name) => join(work, name);
  const put = (name, text) => { writeFileSync(at(name), text, { encoding: 'utf8', flag: 'w' }); return at(name); };
  const run = (args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [me, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
  };

  const a = put('a.md', '# Report\n\n## One\n\nfirst\n');
  const b = put('b.md', '## Two\n\nsecond\n');

  // 1 · the ordinary case
  const out1 = at('r1.md');
  const r1 = run(['--out', out1, a, b]);
  ok(r1.code === 0, 'a report writes to a path that does not exist');
  ok(readFileSync(out1, 'utf8') === '# Report\n\n## One\n\nfirst\n\n## Two\n\nsecond\n',
     'and its content is the sections joined, with one trailing newline');

  // 2 · the refusal, and the file it did not touch
  const before = readFileSync(out1, 'utf8');
  const r2 = run(['--out', out1, a, b]);
  ok(r2.code !== 0, 'a second run over a report that already has content is REFUSED');
  ok(/already has content/.test(r2.out), 'and it says so by name rather than failing obscurely');
  ok(readFileSync(out1, 'utf8') === before,
     'and the existing report is byte-for-byte untouched — a refusal that half-wrote would be worse than an append');

  // 3 · --replace REPLACES. This is the append bug, asserted directly.
  const r3 = run(['--out', out1, '--replace', b]);
  ok(r3.code === 0, '--replace overwrites deliberately');
  ok(readFileSync(out1, 'utf8') === '## Two\n\nsecond\n',
     'and the result is the NEW content only — not the new content after the old');

  // 4 · an empty file is not content
  const out4 = put('r4.md', '');
  ok(run(['--out', out4, a]).code === 0, 'an existing but EMPTY report is written without --replace');

  // 5 · the invariant, which is what actually caught the original
  const dupe = put('dupe.md', '## One\n\nagain\n');
  const r5 = run(['--out', at('r5.md'), a, dupe]);
  ok(r5.code !== 0, 'sections that repeat a `## ` heading are refused before anything is written');
  ok(/## One/.test(r5.out), 'and the repeated heading is named');
  ok(!existsSync(at('r5.md')), 'and no partial report is left behind');

  // 6 · CONTROL. Without this, a checker that refused everything would pass 5.
  ok(run(['--out', at('r6.md'), a, b]).code === 0,
     'CONTROL: two sections with DIFFERENT headings are accepted — the check discriminates');

  // 7 · the exact bug. `$` before a backtick, `$&`, `$$` and `$'` are all replacement
  //     metacharacters, and every one of them must survive to disk verbatim.
  const hazard = '## Three\n\nA `$' + '`' + '` before a backtick, plus $& and $$ and $\' for company.\n';
  const h = put('h.md', hazard);
  const out7 = at('r7.md');
  ok(run(['--out', out7, h]).code === 0, 'a section full of replacement metacharacters writes');
  ok(readFileSync(out7, 'utf8') === hazard.replace(/\s+$/, '') + '\n',
     'and they reach disk verbatim — the tripling was $-backtick expanding to the whole prefix');
  // CONTROL: the hazard really is in the fixture. Without it the assertion above passes for a
  // fixture that never contained the thing it is testing.
  ok(hazard.indexOf('$' + '`') > -1 && hazard.indexOf('$&') > -1,
     'CONTROL: the fixture really does carry $-backtick and $&');

  // 8 · --check, over a file rather than sections
  ok(run(['--check', out1]).code === 0, '--check passes a report whose headings are unique');
  ok(run(['--check', dupe + '']).code === 0, 'CONTROL: --check passes a single-heading file');
  const tripled = put('tripled.md', readFileSync(out1, 'utf8').repeat(3));
  const r8 = run(['--check', tripled]);
  ok(r8.code !== 0, '--check FAILS a report that contains three copies of itself');
  ok(/looks appended to/.test(r8.out), 'and names the shape of the failure');

  // 9 · a fenced block is not a heading
  const fenced = put('fenced.md', '## Four\n\n```\n## One\n## One\n```\n');
  ok(run(['--out', at('r9.md'), a, fenced]).code === 0,
     'a `## ` inside a fenced block is quoted text, not a heading');

  rmSync(work, { recursive: true, force: true });
  console.log(`\n1..${passed + failed}`);
  if (failed) { console.log(`${failed} assertion(s) failed.`); process.exit(1); }
  console.log(`All ${passed} assertions passed.`);
}

/* ── Arguments ────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);

if (argv.includes('--selftest')) {
  await selftest();
} else if (argv.includes('--check')) {
  const path = argv[argv.indexOf('--check') + 1];
  if (!path) fail('--check needs a path');
  checkFile(path);
} else {
  const outAt = argv.indexOf('--out');
  if (outAt === -1) fail('usage: --out <report.md> [--replace] <section.md>…   |   --check <report.md>   |   --selftest');
  const out = argv[outAt + 1];
  if (!out) fail('--out needs a path');
  const replace = argv.includes('--replace');
  const parts = argv.filter((a, i) => i !== outAt && i !== outAt + 1 && a !== '--replace');
  if (!parts.length) fail('no sections given — a report with no sections is an empty file, not a report');
  writeReport(out, parts, replace);
}
