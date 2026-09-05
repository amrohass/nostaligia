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
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, renameSync, unlinkSync } from 'node:fs';
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
 *
 * AND IT MUST BE ORDERED RIGHT, which is subtler and cost two false findings on the first
 * run. The prelude lands immediately after `begin;` — BEFORE the test file inserts its own
 * fixtures. So a mutation written as an UPDATE over existing rows touches nothing the test
 * will look at: `update posts set location_public = location` rewrote six real rows and
 * then the test created a fresh fixture, correctly fuzzed by the trigger, and passed. Both
 * mutations reported SURVIVED and both were no-ops.
 *
 * The rule that falls out: mutate the MECHANISM, never the data. Redefine the function the
 * trigger calls, drop the predicate out of the view, change the column default. Then a
 * fixture created after the prelude is created wrong, which is the thing being tested.
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
      -- raw one. fuzz_location becomes the identity, so the trigger still fires, every
      -- column stays populated, every shape stays valid — and every contributor's exact
      -- coordinate is what gets published.
      --
      -- Mutating the FUNCTION rather than the rows is load-bearing: an UPDATE that sets
      -- location_public = location runs before the test inserts its fixture, the trigger
      -- then fuzzes that fixture correctly, and the mutation is a no-op that reports
      -- SURVIVED. That is exactly what the first run of this file did.
      create or replace function public.fuzz_location(
        p_location extensions.geography, p_precision public.location_precision)
      returns extensions.geography language sql immutable parallel safe set search_path = ''
      as $mutant$ select p_location $mutant$;
    `,
  },
  {
    id: 'publishable-ignores-takedown',
    invariant: '§8 — a taken-down post is not publishable',
    catches: ['18_publishable_posts', '19_takedown'],
    kind: 'sql',
    sql: `
      -- The takedown flag stops being consulted. Written as a column DEFAULT plus a rule on
      -- the write path rather than an update of existing rows, for the ordering reason in
      -- the header: the test sets takedown = true on its own fixture AFTER the prelude
      -- runs, so clearing the flag beforehand changes nothing and reports a false SURVIVED.
      --
      -- A BEFORE trigger that forces the flag back to false is the mechanism-level version:
      -- the view keeps its predicate and is tested honestly; the flag simply never sticks,
      -- which is what "a takedown that does not take effect" actually looks like.
      create or replace function public.__mutant_clear_takedown()
      returns trigger language plpgsql as $mutant$
      begin new.takedown := false; return new; end $mutant$;
      create trigger zzz_mutant_clear_takedown before insert or update on public.posts
        for each row execute function public.__mutant_clear_takedown();
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
      const m = /const\s+BUDGET\s*=\s*[\d\s*]+;/.exec(src);
      if (!m) return null;
      return src.replace(m[0], 'const BUDGET = 1024;');
    },
    run: 'node scripts/frontend-budget.mjs',
  },
  {
    id: 'recovery-adopts-on-landing',
    invariant: '§7 — a recovery link is HELD, not adopted, until the password is actually set',
    catches: ['frontend-auth-test'],
    kind: 'source',
    file: 'site/assets/js/auth.js',
    mutate: (src) => {
      /* The "fix" this guards against, written the way somebody would actually write it:
         adopt the session on landing, as the official SDK does. Everything still works —
         the reset completes, the member is signed in — and a link opened on a borrowed
         device now leaves a live session behind whether or not a password was ever set. */
      const held = 'recovery = tokens && tokens.access_token ? tokens : null;';
      if (!src.includes(held)) return null;
      return src.replace(held, held +
        ' if (recovery) adopt({ access_token: recovery.access_token,' +
        ' refresh_token: recovery.refresh_token, expires_in: recovery.expires_in, user: {} });');
    },
    run: 'node scripts/frontend-auth-test.mjs',
  },
  {
    id: 'recovery-no-redirect',
    invariant: 'a reset link comes back to THIS origin, not to whatever Site URL happens to be',
    catches: ['frontend-auth-test'],
    kind: 'source',
    file: 'site/assets/js/auth.js',
    mutate: (src) => {
      /* Drop redirect_to. GoTrue still sends the mail and still answers 200, so nothing
         fails and nothing looks different — the member simply lands wherever the project's
         Site URL points, which on this deployment is localhost:3000. */
      const m = /\n\s+if \(redirectTo\) payload\.redirect_to = redirectTo;/.exec(src);
      if (!m) return null;
      return src.replace(m[0], '');
    },
    run: 'node scripts/frontend-auth-test.mjs',
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
    id: 'exif-strip-flag',
    invariant: '§11 gate 2 — EXIF is stripped from every derivative',
    catches: ['worker/src/ladder.test.ts'],
    kind: 'source',
    /* worker/src/ladder.ts, NOT scripts/exif-gate.ts.
     *
     * The gate script is the END-TO-END proof and needs R2 credentials and a real
     * photograph, so the only thing runnable against a mutated copy of it here is
     * `deno check` — and a type-check passes whether or not the assertion inside it is
     * right. That mutation could never be killed, and an unkillable mutation reports a
     * permanent false SURVIVED, which is worse than not testing it: it would sit in the
     * findings list forever and train everyone to ignore the findings list.
     *
     * The MECHANISM is one ffmpeg flag, `-map_metadata -1`, and it has a real offline
     * test. Remove it from STRIP and every rung still transcodes, every output still
     * exists, and every photograph in the archive keeps its GPS. */
    file: 'worker/src/ladder.ts',
    mutate: (src) => {
      const m = 'const STRIP = ["-map_metadata", "-1"';
      if (!src.includes(m)) return null;
      return src.replace(m, 'const STRIP = ["-map_chapters", "-1"');
    },
    run: 'deno test --allow-all worker/src/ladder.test.ts',
    note: 'the -map_metadata -1 flag, which IS the strip; the end-to-end gate needs R2',
  },
  {
    id: 'label-detached',
    invariant: 'a visible caption is ATTACHED to its control, so the control has a name',
    catches: ['frontend-view-test'],
    kind: 'source',
    file: 'site/assets/js/ui.js',
    mutate: (src) => {
      /* The tidy-up this guards against: keep the caption, drop the association. Nothing
         on screen moves — the same words in the same font, in the same place — and every
         control the helper names loses its accessible name in one edit. This is the shape
         the defect had before 5 Sep 2026, and the source scan alone would NOT catch it,
         because a caption with no props is how the two wrapping labels are legitimately
         built. The mechanism assertion is what catches it. */
      const wired = "return el('label.field__label', { 'for': control.id }, text);";
      if (!src.includes(wired)) return null;
      return src.replace(wired, "return el('label.field__label', null, text);");
    },
    run: 'node scripts/frontend-view-test.mjs',
  },
  {
    id: 'label-caption-only',
    invariant: 'no <label> is built with props that name no control',
    catches: ['frontend-view-test'],
    kind: 'source',
    file: 'site/assets/js/public.js',
    mutate: (src) => {
      /* The old construction, put back at ONE call site — which is exactly how it would
         return: somebody adds a field and copies the block above it. The licence select is
         the one that was actually wrong, and axe called it `select-name`, critical. */
      const wired = "labelFor(t('share.fLicense'), licenseSelect),";
      if (!src.includes(wired)) return null;
      return src.replace(wired, "el('label.field__label', { text: t('share.fLicense') }),");
    },
    run: 'node scripts/frontend-view-test.mjs',
  },
  /* 0060's four, and the shape of them is unusual enough to explain once.
   *
   * The migration is not applied to the deployed database yet, so these cannot ride the
   * `--prelude` hook the SQL mutations above use: the clean run would be red before any
   * mutation and every one of them would report INCONCLUSIVE forever. Instead the
   * MIGRATION FILE is the source that gets mutated, and the test is run with that file as
   * its own prelude — so the clean run applies the real migration inside the test's own
   * rolled-back transaction and the mutated run applies a broken one. Both arms are real,
   * and this keeps working unchanged after the migration is applied. */
  {
    id: 'confirm-trigger-dropped',
    invariant: '0060 — the upload path is gated, which RLS alone cannot do',
    catches: ['37_email_confirmation'],
    kind: 'source',
    file: 'supabase/migrations/20260905090000_email_confirmation.sql',
    mutate: (src) => {
      /* THE mutation for this migration. claim_upload_slot is SECURITY DEFINER, so RLS on
         posts never evaluates on the one path a member uploads through: without the
         trigger, posts_insert's confirmation term is decorative and the door is open while
         every policy test stays green. */
      const m = /create trigger posts_require_confirmed_email[\s\S]*?;\s*$/.exec(src);
      if (!m) return null;
      return src.replace(m[0], '');
    },
    run: 'node scripts/pgtap-deployed.mjs --tap --prelude ' +
      'supabase/migrations/20260905090000_email_confirmation.sql 37_email_confirmation',
  },
  {
    id: 'confirm-policy-term-dropped',
    invariant: '0060 — the POLICY refuses an unconfirmed post too, not only the trigger',
    catches: ['37_email_confirmation'],
    kind: 'source',
    file: 'supabase/migrations/20260905090000_email_confirmation.sql',
    mutate: (src) => {
      /* The other half of the pair. The trigger answers first on an ordinary insert, so
         nothing would notice this clause going missing — which is why the test disables the
         trigger for one statement to ask the policy directly. */
      const wired = `    (select auth.uid()) is not null
    and public.email_confirmed()
    and created_by = (select auth.uid())
    and status = 'pending'`;
      if (!src.includes(wired)) return null;
      return src.replace(wired, `    (select auth.uid()) is not null
    and created_by = (select auth.uid())
    and status = 'pending'`);
    },
    run: 'node scripts/pgtap-deployed.mjs --tap --prelude ' +
      'supabase/migrations/20260905090000_email_confirmation.sql 37_email_confirmation',
  },
  {
    id: 'confirm-amr-ignored',
    invariant: '0060 — only a MAILED-LINK session may confirm an account',
    catches: ['37_email_confirmation'],
    kind: 'source',
    file: 'supabase/migrations/20260905090000_email_confirmation.sql',
    mutate: (src) => {
      /* Accept any session. Everything still works — confirmation succeeds, the member
         contributes — and the flag stops meaning "this person holds the mailbox", which is
         the only thing it was ever for. A squatted address could then confirm itself. */
      const guard = '  if not v_link then';
      if (!src.includes(guard)) return null;
      return src.replace(guard, '  if false then');
    },
    run: 'node scripts/pgtap-deployed.mjs --tap --prelude ' +
      'supabase/migrations/20260905090000_email_confirmation.sql 37_email_confirmation',
  },
  {
    id: 'confirm-unknown-locks-out',
    invariant: "0060 — a confirmation status we could not READ must not lock a member out",
    catches: ['e2e-browser'],
    kind: 'source',
    file: 'site/assets/js/public.js',
    mutate: (src) => {
      /* The tightening somebody would make on purpose, reading `!== false` as sloppy. It
         is not: a single failed RPC would then close every write path in the archive for
         everyone, and the database refuses an unconfirmed write anyway. */
      const held = 'function confirmedEnough() { return state.confirmed !== false; }';
      if (!src.includes(held)) return null;
      return src.replace(held, 'function confirmedEnough() { return state.confirmed === true; }');
    },
    run: 'node scripts/e2e-browser.mjs',
    note: 'needs PLAYWRIGHT_DIR in the environment',
  },
  {
    id: 'confirm-share-ungated',
    invariant: '0060 — an unconfirmed member meets the screen BEFORE writing a description',
    catches: ['e2e-browser'],
    kind: 'source',
    file: 'site/assets/js/public.js',
    mutate: (src) => {
      const gate = '    if (!confirmedEnough()) { openConfirmDialog(openShareSheet); return; }';
      if (!src.includes(gate)) return null;
      return src.replace(gate, '');
    },
    run: 'node scripts/e2e-browser.mjs',
    note: 'needs PLAYWRIGHT_DIR in the environment',
  },
  {
    id: 'confirm-resend-sends-body-email',
    invariant: '§7 — the address a confirmation mail goes to is never the browser\'s to name',
    catches: ['e2e-browser'],
    kind: 'source',
    file: 'site/assets/js/public.js',
    mutate: (src) => {
      /* The helpful-looking edit: send the address so the server does not have to look it
         up. Today it would be correct and the mail would arrive; tomorrow it is a parameter
         an attacker sets, and the endpoint mails anybody. The server ignores it either way
         — this mutation is caught by the CLIENT assertion, which is the point: the body is
         where the habit forms. */
      const body = "body: JSON.stringify({ turnstile_token: captcha })";
      if (!src.includes(body)) return null;
      return src.replace(body,
        "body: JSON.stringify({ turnstile_token: captcha, email: state.account && state.account.email })");
    },
    run: 'node scripts/e2e-browser.mjs',
    note: 'needs PLAYWRIGHT_DIR in the environment',
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

/* ── Surviving a KILL, which `finally` does not ──────────────
 *
 * The in-memory `original` plus a `finally` covers a crash, and the SIGINT handler beside
 * it covers Ctrl-C. NEITHER covers the process being killed outright — a teardown, a
 * closed terminal, an OOM — and on 5 Sep 2026 one of those left a mutated migration on
 * disk and then something worse: a 23 KB file of NUL bytes, because NTFS had committed the
 * restore's new SIZE and never flushed its data. The file was UNTRACKED, so git held no
 * copy and it had to be rebuilt from the session transcript by hand.
 *
 * Two changes fall out, and the second is the one that would have saved the file:
 *
 *   1. the restore writes a temp file and RENAMES it over the target. A rename on the same
 *      volume is atomic, so the target is either the old bytes or the new ones and never a
 *      size with no data behind it.
 *   2. the original is copied to a SIBLING on disk before anything is mutated, and removed
 *      only once the restore has been read back and verified byte for byte. A killed run
 *      leaves that sibling next to the file it belongs to, and the startup check below
 *      refuses to run again until somebody has dealt with it.
 *
 * A sibling rather than the temp directory: `work` is removed on exit, which is exactly the
 * moment the backup stops being available and starts being needed. */
const BACKUP_SUFFIX = '.mutation-backup';

/** Write `text` to `file` so that the file is never observed half-written. */
function writeAtomic(file, text) {
  const tmp = `${file}.mutation-tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/* Refuse to start on top of a previous run's wreckage. Checked against the catalogue's own
   file list rather than by walking the tree: every file this script can touch is named in
   it, so the check is exhaustive by construction and costs nothing. */
{
  const stranded = [];
  for (const m of MUTATIONS) {
    for (const f of [m.file, ...(m.restoreAlso ?? [])]) {
      if (f && existsSync(f + BACKUP_SUFFIX)) stranded.push(f);
    }
  }
  if (stranded.length) {
    console.error('\nREFUSING TO RUN — a previous mutation pass was killed before it restored:\n');
    for (const f of stranded) {
      console.error(`  ${f}`);
      console.error(`    its original is at ${f}${BACKUP_SUFFIX}`);
    }
    console.error('\nCompare each file with its backup, put the original back, and delete the');
    console.error('backup. Do not assume the file on disk is merely mutated: a kill during the');
    console.error('restore can leave it the right SIZE and entirely NUL (5 Sep 2026).\n');
    process.exit(2);
  }
}

function runSource(m) {
  const original = readFileSync(m.file, 'utf8');
  const extras = (m.restoreAlso ?? []).map((f) => [f, readFileSync(f, 'utf8')]);
  const backups = [[m.file, original], ...extras];

  /* BEFORE the first byte is mutated, and while nothing is racing it. */
  for (const [f, text] of backups) writeFileSync(f + BACKUP_SUFFIX, text, 'utf8');

  const restore = () => {
    writeAtomic(m.file, original);
    for (const [f, text] of extras) writeAtomic(f, text);
  };
  /* Registered for the whole life of the mutation: a Ctrl-C between the write and the
     restore would otherwise leave a deliberately broken file in the working tree. */
  process.on('SIGINT', restore);
  try {
    const before = runCmd(m.run);
    const mutated = m.mutate(original);
    if (mutated === null) return { skipped: 'the mutation did not match — the file has changed shape' };
    if (mutated === original) return { skipped: 'the mutation was a no-op' };
    writeAtomic(m.file, mutated);
    const after = runCmd(m.run);
    return { before, after };
  } finally {
    restore();
    process.off('SIGINT', restore);
    /* Read back and COMPARE before dropping the backup. A restore that silently wrote
       nothing is the failure this whole block exists for, and "we called writeFileSync" is
       not evidence that the bytes are there. */
    let verified = true;
    for (const [f, text] of backups) {
      try {
        if (readFileSync(f, 'utf8') !== text) verified = false;
      } catch { verified = false; }
    }
    if (verified) {
      for (const [f] of backups) {
        try { unlinkSync(f + BACKUP_SUFFIX); } catch { /* already gone */ }
      }
    } else {
      console.error(`   ! RESTORE DID NOT VERIFY for ${m.file} — the original is kept at`);
      console.error(`     ${m.file}${BACKUP_SUFFIX}. Put it back before doing anything else.`);
    }
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
    /* WHY the clean run was red, and it has to speak both vocabularies.

       This filter was pgTAP's alone -- `not ok` -- so for a mutation guarded by a
       BROWSER suite it matched nothing except the word "errors" inside a line that was
       reporting a success ("no uncaught page errors"), and then printed that as the
       diagnosis. 5 Sep 2026: several runs were spent reading a passing assertion as the
       explanation of a failure. e2e-browser and a11y-sweep mark a failure with a cross,
       and both end on a counted summary line; pgTAP says `not ok`. Match all of them,
       and say plainly when there is nothing to match rather than printing whatever the
       filter happened to catch. */
    const why = (r.before.out ?? '').split('\n')
      .filter((l) => /not ok|\u2717|FAILED|\bchecks?, [1-9]/.test(l))
      .slice(0, 6);
    console.log(why.length
      ? why.map((l) => `     ${l.trim()}`).join('\n')
      : `     (exit ${r.before.code}, and no failure line in its output -- run it directly)`);
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
