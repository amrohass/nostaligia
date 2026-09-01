#!/usr/bin/env node
/* Run the pgTAP suite against the LIVE deployed database, each file inside its own
   rolled-back transaction.
 *
 * WHY THIS EXISTS. CI runs `supabase test db`, which needs Docker, and Docker on the
 * maintainer's machine has been wedged for three sessions running. That left CI as the
 * only executor of the suite -- and CI builds a FRESH database from the same migration
 * files, so a green run there says the migrations are self-consistent and says nothing
 * whatever about the database people actually use. On 30 Aug 2026 the hosted database was
 * three migrations behind while all six CI jobs were green. This closes that gap.
 *
 * It is NOT a replacement for `supabase test db`. pg_prove parses TAP and reports which
 * assertion failed; this reports how many did, per file, because the Management API hands
 * back only the last statement's rows and pgTAP 1.3 keeps no per-assertion table. When a
 * file comes back red, run that one file locally (or read its plan) to find the line.
 *
 * HOW IT AVOIDS PASSING FOR THE WRONG REASON -- the failure mode this repository keeps
 * finding in its own tests. Three separate things are asserted per file, and a file is
 * green only if all three hold:
 *   1. the appended probe statement returned a row at all (a file that errors out mid-way
 *      returns an API error instead, and an error is never read as a pass);
 *   2. `curr_test` equals the file's own `plan(N)` -- a file that dies after assertion 3
 *      of 17 has a truthful `failed` count of 0, and that is exactly the reading this
 *      catches;
 *   3. `num_failed()` is 0.
 * The suite-level total is checked the same way CI checks it: the number of files and the
 * summed plan count are DERIVED from the files, never written down.
 *
 *   node scripts/pgtap-deployed.mjs            # whole suite
 *   node scripts/pgtap-deployed.mjs 05 19      # only files whose name contains 05 or 19
 */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toTapCapture } from './lib/pgtap-tap.mjs';

const TESTS = 'supabase/tests';
const argv = process.argv.slice(2);
/* --tap rewrites every top-level SELECT into an INSERT so the whole TAP stream comes back
   as one result set, which is the only way to learn WHICH assertion failed. Opt-in,
   because the rewrite is a SQL parse and the plain counting path has to stay available
   for any file the parse cannot handle. See scripts/lib/pgtap-tap.mjs. */
const tapMode = argv.includes('--tap') || argv.includes('--local');

/* --local <container> runs the same suite against a LOCAL Postgres container instead of the
 * linked project, through `docker exec … psql`.
 *
 * It exists for §11 gate 3. A restore is only proved by running the project's own suite
 * against the RESTORED database, and the restored database is a local container — reachable
 * by neither `supabase db query --linked` (which goes to the hosted project) nor by
 * `supabase test db` (which runs the suite against whatever the local stack currently holds,
 * and in some CLI versions resets it first, which would silently replace the thing under
 * test with one built from migrations).
 *
 * `docker exec` is also the safety property: it cannot reach a hosted project at all, so a
 * mistyped container name fails to start rather than running the suite somewhere real.
 *
 * It implies --tap. psql returns rows, not the CLI's JSON envelope, and the TAP stream is a
 * single two-column result that reads back the same way in both; the counting path's
 * three-column probe would need a second shape that nothing here would exercise.
 */
const localIdx = argv.indexOf('--local');
const LOCAL = localIdx === -1 ? null : argv[localIdx + 1];
if (localIdx !== -1 && (!LOCAL || LOCAL.startsWith('--'))) {
  console.error('--local needs a container name, e.g. --local supabase_db_<ref>. It will not guess one.');
  process.exit(1);
}
/* `localIdx + 1` only when there IS one — otherwise -1 + 1 is 0 and the first filter
   argument would be silently swallowed. */
const localValueIdx = localIdx === -1 ? -1 : localIdx + 1;
const filter = argv.filter((a, i) => a !== '--tap' && a !== '--local' && i !== localValueIdx);
const files = readdirSync(TESTS)
  .filter((f) => f.endsWith('.test.sql'))
  .filter((f) => filter.length === 0 || filter.some((p) => f.includes(p)))
  .sort();

if (files.length === 0) {
  console.error('no test files matched — refusing to report a green run over nothing');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'pgtap-deployed-'));

/* Removed when the process ends, however it ends.
 *
 * This directory takes a rewritten copy of every test file -- 37 of them a run -- and it was
 * never cleaned up, so a temp root collected one `pgtap-deployed-*` per invocation forever.
 * The contents are the project's own SQL rather than anybody's data, which is why it was
 * never urgent and also why it stayed. `restore-verify.ts` spawns this script, and a backup
 * tool that enumerates and deletes what it writes cannot have a child process that does not.
 *
 * `exit` covers a normal end and an explicit `process.exit`; SIGINT does not fire it, so
 * Ctrl-C is registered separately. */
function sweepWork() {
  try { rmSync(work, { recursive: true, force: true }); } catch { /* nothing left to do */ }
}
process.on('exit', sweepWork);
process.on('SIGINT', () => { sweepWork(); process.exit(130); });

/* Appended after the file's own `select * from finish();` and before its `rollback;`.
   `reset role` first: a file that ends inside `set local role authenticated` would
   otherwise probe the temp table as a role that cannot read it. */
const PROBE = `
reset role;
select
  coalesce((select value from __tcache__ where label = 'plan'),      -1) as planned,
  coalesce((select value from __tcache__ where label = 'curr_test'), -1) as ran,
  num_failed()                                                           as failed;
`;

let redFiles = 0;
let totalPlanned = 0;
let totalRan = 0;
let totalFailed = 0;
const rows = [];

for (const f of files) {
  const src = readFileSync(join(TESTS, f), 'utf8');

  /* Splice before the LAST `rollback;`. Every file in this suite ends with one and the
     shape is asserted rather than assumed — a file that ever stops being
     begin/…/rollback must fail loudly here, not run against the deployed database
     without a rollback at the end of it. */
  const idx = src.lastIndexOf('rollback;');
  if (idx === -1) {
    console.error(`  ${f}: no trailing 'rollback;' — refusing to run it against the deployed database`);
    redFiles++;
    rows.push({ file: f, planned: -1, ran: -1, failed: -1, note: 'no rollback' });
    continue;
  }
  const spliced = tapMode
    ? toTapCapture(src)
    : src.slice(0, idx) + PROBE + '\n' + src.slice(idx);

  const path = join(work, f);
  writeFileSync(path, spliced);

  let out;
  let j = null;
  if (LOCAL) {
    try {
      /* -q -t -A -F ~@~: no command tags, no headers, no padding, and a field
         separator no TAP line can contain. The SQL goes in on stdin because the file is on
         the host and psql is inside the container. */
      out = execSync(`docker exec -i ${LOCAL} psql -U postgres -d postgres -q -t -A -F "~@~" -f -`, {
        encoding: 'utf8',
        input: spliced,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    /* `select seq, line from _tap order by seq` — one row per TAP line, seq first. A pgTAP
       diagnostic can itself contain a newline, which psql prints as further physical lines
       with no separator on them; those belong to the row above rather than being dropped,
       or a failing assertion's explanation disappears exactly when it is wanted. */
    const tap = [];
    for (const raw of out.split('\n')) {
      const l = raw.replace(/\r$/, '');
      const sep = l.indexOf('~@~');
      if (sep === -1) {
        if (tap.length && l.length) tap[tap.length - 1].line += `\n${l}`;
        continue;
      }
      tap.push({ seq: Number(l.slice(0, sep)), line: l.slice(sep + 3) });
    }
    if (tap.length) j = { rows: tap };
  } else {
    try {
      /* execSync, not execFileSync: on Windows `supabase` on PATH is a shim, not an .exe,
         and execFileSync cannot start it -- which surfaced as every file reporting DID NOT
         COMPLETE with no ERROR line, i.e. a red suite for a reason that was not the suite. */
      out = execSync(`supabase db query --linked -f "${path}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
    }
    const m = out.match(/\{[\s\S]*\}/);
    if (m) { try { j = JSON.parse(m[0]); } catch { j = null; } }
  }

  let rec = null;
  if (j) {
    try {
      if (tapMode && Array.isArray(j.rows)) {
        /* Read the counters back off the TAP stream itself rather than off __tcache__,
           so this path and the counting path can disagree — and if they ever do, the
           rewrite is wrong and that is worth seeing. */
        const lines = j.rows.map((r) => String(r.line ?? ''));
        const bad = lines.filter((l) => /^not ok\b/.test(l));
        const ran = lines.filter((l) => /^(not )?ok\b/.test(l)).length;
        const planLine = lines.find((l) => /^\d+\.\.\d+$/.test(l)) || '';
        const planned = planLine ? Number(planLine.split('..')[1]) : -1;
        rec = { planned, ran, failed: bad.length, bad };
      } else if (Array.isArray(j.rows) && j.rows.length === 1) {
        rec = j.rows[0];
      }
    } catch { /* falls through to the error path below */ }
  }

  if (!rec) {
    const err = (out.split(String.fromCharCode(10)).find((l) => l.includes("ERROR:")) || "(no ERROR line - see raw output)").trim();
    console.log(`  not ok  ${f.padEnd(34)} DID NOT COMPLETE — ${err}`);
    redFiles++;
    rows.push({ file: f, planned: -1, ran: -1, failed: -1, note: err.slice(0, 200) });
    continue;
  }

  const { planned, ran, failed } = rec;
  totalPlanned += planned > 0 ? planned : 0;
  totalRan += ran > 0 ? ran : 0;
  totalFailed += failed > 0 ? failed : 0;

  const green = planned > 0 && ran === planned && failed === 0;
  if (!green) redFiles++;
  rows.push({ file: f, planned, ran, failed, note: green ? '' : 'RED' });
  console.log(
    `  ${green ? 'ok    ' : 'not ok'}  ${f.padEnd(34)} plan ${String(planned).padStart(3)}  ran ${String(ran).padStart(3)}  failed ${failed}`,
  );
  if (rec.bad) for (const b of rec.bad) console.log(`            ${b}`);
}

/* Derived, never hardcoded — the same argument CI's step makes about its own counts. */
const expectFiles = readdirSync(TESTS).filter((f) => f.endsWith('.test.sql')).length;
const expectPlan = readdirSync(TESTS)
  .filter((f) => f.endsWith('.test.sql'))
  .map((f) => readFileSync(join(TESTS, f), 'utf8').match(/plan\((\d+)\)/))
  .reduce((s, m) => s + (m ? Number(m[1]) : 0), 0);

console.log('');
console.log(`files run      ${files.length}${filter.length ? ` (filtered from ${expectFiles})` : ` of ${expectFiles}`}`);
console.log(`assertions     ${totalRan} ran of ${totalPlanned} planned${filter.length ? '' : ` (suite declares ${expectPlan})`}`);
console.log(`failed         ${totalFailed}`);
console.log(`red files      ${redFiles}`);

if (!filter.length && files.length === expectFiles && totalPlanned !== expectPlan) {
  console.error('\nplan total does not match the suite declaration — a file did not reach its own plan()');
  process.exit(1);
}
process.exit(redFiles === 0 ? 0 : 1);
