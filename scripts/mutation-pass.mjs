#!/usr/bin/env node
/* Break each invariant on purpose, and check that the suite notices.
 *
 *     node scripts/mutation-pass.mjs              # every mutation
 *     node scripts/mutation-pass.mjs rls bidi     # only mutations whose id matches
 *     node scripts/mutation-pass.mjs --list
 *
 * ── The question this asks ───────────────────────────────────
 *
 * A green suite proves that the tests pass. It does not prove that they would fail. Six
 * non-discriminating tests have been found in this repository, every one of them by
 * accident:
 *
 *   · a "member cannot approve their own upload" check that read any 403 as a refusal,
 *     and would have stayed green against a database that let them (28 Aug);
 *   · a captcha probe run with credentials that fail anyway, so both arms answered
 *     `invalid_credentials` and neither said anything (31 Aug);
 *   · `05_matrix` — §11 gate 1's own denial matrix — which had never run against the
 *     deployed database at all, aborting on its first fixture (31 Aug);
 *   · a CSS comment claiming a rule "reserves the row before the image decodes" while it
 *     reserved nothing, which is why nobody looked again for two days (1 Sep);
 *   · a self-scanning source check that matched its own control fixture (1 Sep);
 *   · and, found while writing this session's own new suite, `res.ok` on a takedown —
 *     true for 207 `objects_remain`.
 *
 * Finding the seventh by accident is not a plan. This finds them on purpose.
 *
 * ── How a mutation is applied, and why it is safe ────────────
 *
 * SQL mutations are spliced into each pgTAP file immediately after its own `begin;`, so
 * they live and die inside the transaction the file already rolls back
 * (scripts/pgtap-deployed.mjs --prelude). A `drop policy` against the DEPLOYED database is
 * undone by the same rollback that undoes the test's fixtures, and the runner refuses to
 * run any file that does not end in `rollback;`.
 *
 * SOURCE mutations edit a file on disk, run the test, and restore the exact bytes in a
 * `finally`. The original is held in memory and written back whatever happens, including
 * on SIGINT. Nothing is committed and `git status` is checked at the end.
 *
 * ── Reading the result ───────────────────────────────────────
 *
 * SURVIVED is the finding. It means the invariant was broken and the suite still went
 * green — so that test is not protecting what its name says it protects. A run with any
 * SURVIVED exits non-zero.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const filters = argv.filter((a) => !a.startsWith('--'));
const work = mkdtempSync(join(tmpdir(), 'mutation-pass-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch { /* gone */ } });

/* ── The catalogue ─────────────────────────────────────────── */

/**
 * Each entry names ONE invariant, the mutation that falsifies it, and the test that is
 * supposed to catch it. `kind: 'sql'` mutations are spliced into the named pgTAP files;
 * `kind: 'source'` mutations rewrite a file and run a command.
 *
 * A mutation must break the PROPERTY, not the syntax. Deleting a function so the test
 * errors out proves nothing — every test "fails" when the database is broken. Each one
 * below leaves a working system that is wrong in exactly one way.
 */
const MUTATIONS = [
  {
    id: 'rls-posts-anon-select',
    invariant: '§5 — unapproved content is unreadable by non-moderators at the policy level',
    catches: ['05_matrix', '01_posts_rls'],
    kind: 'sql',
    sql: `
      -- Hand anon everything. The most direct possible falsification of the denial matrix:
      -- the table is readable, the policies are still there, and nothing else changes.
      grant select on public.posts to anon;
      drop policy if exists posts_select_public on public.posts;
      create policy posts_select_public on public.posts for select to anon using (true);
    `,
  },
  {
    id: 'rls-member-approves',
    invariant: '§4 — only a moderator may approve',
    catches: ['05_matrix', '01_posts_rls', '15_moderation_queue'],
    kind: 'sql',
    sql: `
      -- Let any authenticated member update any post. The single most valuable denial in
      -- the matrix, and the one whose test passed for the wrong reason on 28 Aug.
      drop policy if exists posts_update_moderator on public.posts;
      create policy posts_update_moderator on public.posts
        for update to authenticated using (true) with check (true);
    `,
  },
  {
    id: 'grants-anon-execute',
    invariant: '§4 — privileged functions are not executable by anon',
    catches: ['16_function_grants'],
    kind: 'sql',
    sql: `
      -- Exactly the drift 0058 was written for, reintroduced: an explicit grant to anon on
      -- functions that must never be callable without a session.
      grant execute on function public.profile_view(text) to anon;
      grant execute on function public.upload_daily_limits(public.app_role) to anon;
    `,
  },
  {
    id: 'grants-user-roles-writable',
    invariant: '§4 — role never lives anywhere a browser can write',
    catches: ['16_function_grants', '00_structure', '05_matrix'],
    kind: 'sql',
    sql: `
      -- The whole §4 threat model in one statement.
      grant select, insert, update on public.user_roles to authenticated;
    `,
  },
  {
    id: 'bidi-strip-noop',
    invariant: '§6 — bidi controls are stripped on ingest',
    catches: ['25_bidi'],
    kind: 'sql',
    sql: `
      -- strip_bidi becomes the identity function. Everything still runs; the triggers still
      -- fire; the characters simply survive. Since 0054 removed prior review of comments
      -- this is the ONLY filter between a hostile string and a shard.
      create or replace function public.strip_bidi(t text)
      returns text language sql immutable parallel safe set search_path = ''
      as $mutant$ select t $mutant$;
    `,
  },
  {
    id: 'comments-publish-on-insert',
    invariant: "§1's amendment — a comment is published the moment it is written",
    catches: ['33_comments_publish'],
    kind: 'sql',
    sql: `
      -- Back to prior restraint, which is what 0054 removed. The insert still succeeds and
      -- the row still lands; it is simply invisible, exactly as every comment written
      -- before 30 Aug was.
      alter table public.comments alter column status set default 'pending';
    `,
  },
  {
    id: 'location-fuzzing-off',
    invariant: '§7 — publish location_public, never location',
    catches: ['02_location_and_shape', '18_publishable_posts', '31_precision_control'],
    kind: 'sql',
    sql: `
      -- The highest-severity failure this project can have: the fuzzed point becomes the
      -- raw one. Every shape stays valid, every column stays populated, and every
      -- contributor's home coordinate is published to three decimal places more.
      update public.posts set location_public = location where location is not null;
    `,
  },
  {
    id: 'publishable-ignores-takedown',
    invariant: '§8 — a taken-down post is not publishable',
    catches: ['18_publishable_posts', '19_takedown'],
    kind: 'sql',
    sql: `
      -- Clear the flag rather than editing the view: the view's own logic stays under test,
      -- and a taken-down row becomes publishable again by the front door.
      update public.posts set takedown = false where takedown = true;
    `,
  },
  {
    id: 'budget-threshold',
    invariant: "§9 — first load stays under 150 KiB brotli",
    catches: ['frontend-budget'],
    kind: 'source',
    file: 'scripts/frontend-budget.mjs',
    mutate: (src) => {
      /* Falsify the BUDGET, not the measurement: drop the ceiling below what the site
         really weighs. A mutation that inflated the site instead would be testing the
         scales rather than the assertion. */
      const m = /const\s+BUDGET_KIB\s*=\s*(\d+)/.exec(src);
      if (!m) return null;
      return src.replace(m[0], `const BUDGET_KIB = 1`);
    },
    run: 'node scripts/frontend-budget.mjs',
  },
  {
    id: 'csp-unsafe-inline',
    invariant: "§6 — CSP carries no 'unsafe-inline'",
    catches: ['frontend-csp-test'],
    kind: 'source',
    file: 'config/site.json',
    mutate: (src) => {
      const cfg = JSON.parse(src);
      if (!cfg.csp?.['script-src']) return null;
      cfg.csp['script-src'] = [...cfg.csp['script-src'], "'unsafe-inline'"];
      return JSON.stringify(cfg, null, 2) + '\n';
    },
    run: 'node scripts/build-site-config.mjs && node scripts/frontend-csp-test.mjs',
    restoreAlso: ['site/_headers', 'site/assets/js/config.js'],
  },
  {
    id: 'exif-gate-passthrough',
    invariant: '§11 gate 2 — EXIF is stripped from every derivative',
    catches: ['exif-gate'],
    kind: 'source',
    file: 'scripts/exif-gate.ts',
    mutate: (src) => {
      /* The gate's job is to REFUSE a derivative that still carries GPS. Make it accept
         one: the probe still runs end to end and still reports, it simply stops judging. */
      const m = /gpsFound\s*===?\s*null|readGps\([^)]*\)\s*===?\s*null/.exec(src);
      if (!m) return null;
      return src.replace(m[0], 'true');
    },
    run: 'deno check scripts/exif-gate.ts',
    note: 'compile-only: the full gate needs R2 credentials and a real photograph',
  },
];

if (argv.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.id.padEnd(30)} ${m.invariant}`);
  process.exit(0);
}

const selected = MUTATIONS.filter((m) =>
  filters.length === 0 || filters.some((f) => m.id.includes(f) || m.invariant.includes(f)));

/* ── Running one mutation ──────────────────────────────────── */

const results = [];

function runCmd(cmd) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 24 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

/** The pgTAP files this mutation is supposed to make red, with and without the mutation. */
function runSql(m) {
  const path = join(work, `${m.id}.sql`);
  writeFileSync(path, m.sql, 'utf8');
  const names = m.catches.join(' ');

  const before = runCmd(`node scripts/pgtap-deployed.mjs --tap ${names}`);
  const after = runCmd(`node scripts/pgtap-deployed.mjs --tap --prelude "${path}" ${names}`);
  return { before, after };
}

function runSource(m) {
  const original = readFileSync(m.file, 'utf8');
  const extras = (m.restoreAlso ?? []).map((f) => [f, readFileSync(f, 'utf8')]);
  const restore = () => {
    writeFileSync(m.file, original, 'utf8');
    for (const [f, text] of extras) writeFileSync(f, text, 'utf8');
  };
  /* Registered for the whole life of the mutation: a Ctrl-C between the write and the
     restore would otherwise leave a deliberately broken file in the working tree. */
  process.on('SIGINT', restore);
  try {
    const before = runCmd(m.run);
    const mutated = m.mutate(original);
    if (mutated === null) return { skipped: 'the mutation did not match — the file has changed shape' };
    if (mutated === original) return { skipped: 'the mutation was a no-op' };
    writeFileSync(m.file, mutated, 'utf8');
    const after = runCmd(m.run);
    return { before, after };
  } finally {
    restore();
    process.off('SIGINT', restore);
  }
}

console.log(`\nMutation pass — ${selected.length} invariant(s)\n`);

for (const m of selected) {
  console.log(`── ${m.id}`);
  console.log(`   ${m.invariant}`);
  console.log(`   guarded by: ${m.catches.join(', ')}${m.note ? `  (${m.note})` : ''}`);

  const r = m.kind === 'sql' ? runSql(m) : runSource(m);

  if (r.skipped) {
    console.log(`   ~ SKIPPED — ${r.skipped}\n`);
    results.push({ ...m, verdict: 'SKIPPED', detail: r.skipped });
    continue;
  }

  /* Both halves matter. A test that was ALREADY red proves nothing about the mutation —
     it would "fail" whatever you did to it, and reading that as a kill is how a broken
     suite comes to look rigorous. */
  const greenBefore = r.before.code === 0;
  const redAfter = r.after.code !== 0;

  let verdict;
  if (!greenBefore) verdict = 'INCONCLUSIVE';
  else if (redAfter) verdict = 'KILLED';
  else verdict = 'SURVIVED';

  const mark = { KILLED: '✓', SURVIVED: '✗', INCONCLUSIVE: '~' }[verdict];
  console.log(`   ${mark} ${verdict}` +
    (verdict === 'INCONCLUSIVE'
      ? ` — the test was already red before the mutation; it cannot judge this`
      : ` — clean: exit ${r.before.code}, mutated: exit ${r.after.code}`));
  if (verdict === 'SURVIVED') {
    console.log(`     THE INVARIANT WAS BROKEN AND THE SUITE STAYED GREEN.`);
    console.log(`     ${m.catches.join(', ')} does not protect what its name says it protects.`);
  }
  if (verdict === 'INCONCLUSIVE') {
    console.log(`     ${(r.before.out ?? '').split('\n').filter((l) => /not ok|error/i.test(l)).slice(0, 2).join('\n     ')}`);
  }
  console.log('');
  results.push({ ...m, verdict });
}

/* ── The working tree must be exactly as it was ─────────────── */

const dirty = runCmd('git status --porcelain').out.trim();
const unexpected = dirty.split('\n').filter((l) => l && !/\.harness\.vars/.test(l));

console.log('─'.repeat(70));
for (const v of ['SURVIVED', 'INCONCLUSIVE', 'SKIPPED', 'KILLED']) {
  const n = results.filter((r) => r.verdict === v).length;
  if (n) console.log(`${v.padEnd(14)} ${n}`);
}
console.log(`\nworking tree after the run: ${unexpected.length === 0 ? 'clean' : 'DIRTY —\n' + unexpected.join('\n')}`);

const survived = results.filter((r) => r.verdict === 'SURVIVED');
if (survived.length) {
  console.log(`\nFINDINGS — these tests do not discriminate:`);
  for (const s of survived) console.log(`  ✗ ${s.catches.join(', ')} survives: ${s.invariant}`);
}
process.exit(survived.length || unexpected.length ? 1 : 0);
