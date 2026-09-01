#!/usr/bin/env node
/* The monitor. §10's M6 ("publish age, function errors, storage/egress, budget") and
 * §11's gate 5.
 *
 *   node scripts/monitor.mjs                 # check everything, print, exit non-zero on an alert
 *   node scripts/monitor.mjs --json          # the same, as one JSON object
 *   node scripts/monitor.mjs --selftest      # no credential, no network: does it discriminate
 *   node scripts/monitor.mjs --only publish  # one check
 *
 * ── Gate 5, stated exactly ───────────────────────────────────
 *
 *   "Publish-age monitoring separates a held pipeline from an idle one — an operator hold
 *    left set stops the archive as silently as a broken cron, so the alert must report
 *    `held_by_operator` distinctly from `unchanged` and fire on the first."
 *
 * The database half was built in migration 0819170000: `publish_pending()` names a hold as
 * a hold rather than folding it into "nothing to do". This is the other half — the thing
 * that reads it and shouts.
 *
 * ── Why publish AGE alone would be wrong here ────────────────
 *
 * This is the part that would be easy to get backwards, so it is written down. §2's cron is
 * UNSCHEDULED: since migration 0820140000 a publish is dispatched by the moderation action
 * itself. So an archive nobody has touched for a fortnight has a fortnight-old release and
 * is perfectly healthy, and an age threshold on its own would page the maintainer every
 * fortnight until they stopped reading the alerts.
 *
 * What is actually wrong is a pipeline that HAS WORK and is not doing it. So age is only
 * ever read together with `pending`, and the hold is alerted on its own, on sight, whatever
 * the age — which is what "fire on the first" means.
 *
 * ── The four checks, and what each can honestly say ──────────
 *
 *   publish   the gate. Reads publish_pending() through `supabase db query --linked`,
 *             which needs no database password (the CLI mints a temporary login role).
 *   storage   what the archive holds, read from the DATABASE rather than by listing the
 *             bucket — the reasoning is backup.ts's and is repeated at the function.
 *             Watches §2's own three thresholds for reinstating the incremental diff.
 *             EGRESS is deliberately NOT claimed: §6 makes media egress structurally $0 on
 *             R2 and the figure is in Cloudflare's GraphQL analytics behind a different
 *             token. "egress: 0" from a source that does not carry egress would be a
 *             reassurance rather than a measurement.
 *   budget    §9's 150 KB first paint, by running the existing measurement.
 *   functions Edge Function errors. NOT IMPLEMENTED, and it says so rather than passing:
 *             see the note in checkFunctions().
 *
 * A check that cannot run reports `unknown`, never `ok`. That distinction is the whole
 * value of the thing: a monitor that reports green when it could not look is worse than no
 * monitor, because it is believed.
 */

import { execSync, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const value = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };

/* ── Severities ────────────────────────────────────────────────────────────── */
//
// Three, and the middle one is load-bearing. `unknown` is NOT `ok`: a check that could not
// reach its source has not said the system is healthy, and collapsing the two is how a
// monitor comes to be trusted for something it never measured.
const OK = 'ok', WARN = 'warn', ALERT = 'alert', UNKNOWN = 'unknown';
const RANK = { [OK]: 0, [UNKNOWN]: 1, [WARN]: 2, [ALERT]: 3 };

/**
 * How long a pipeline may have PENDING WORK before it is a problem.
 *
 * Not "how old may a release be". See the header: with the cron unscheduled, an idle
 * archive's release is as old as the last approval and that is correct. 20 minutes is
 * generous against §2's 2-5 minute debounce and short enough that a broken dispatch is
 * caught the same morning.
 */
const PENDING_GRACE_MINUTES = 20;

/* ── The publish check — §11 gate 5 ────────────────────────────────────────── */

/**
 * Turn one `publish_pending()` result into a verdict.
 *
 * Pure, and exported in spirit for the self-test: this is the function that has to be
 * right, and it must be checkable without a database.
 */
export function judgePublish(row, nowMs) {
  const reason = row?.reason ?? null;
  const ageMinutes = row?.active_created_at
    ? Math.round((nowMs - Date.parse(row.active_created_at)) / 60000)
    : null;

  if (reason === null) {
    return { level: UNKNOWN, reason, ageMinutes, message: 'publish_pending() returned nothing readable' };
  }

  // Gate 5's whole point. On sight, on the first observation, whatever the age -- a hold is
  // a person having stopped the archive, and the failure mode is that they forget.
  if (reason === 'held_by_operator') {
    return {
      level: ALERT,
      reason,
      ageMinutes,
      heldBy: row.held_by ?? null,
      heldAt: row.held_at ?? null,
      // `hold_reason`, not `held_reason`. The first live run of this alert printed no
      // reason at all, because the key was misspelled here -- and 0819170000 is explicit
      // that the reason column has NO DEFAULT precisely so "the operator who finds a held
      // pipeline at 3am has something to go on". Dropping it silently is most of the value
      // of the alert. The self-test now asserts the reason reaches the message.
      holdReason: row.hold_reason ?? null,
      message: `the pipeline is HELD BY AN OPERATOR${row.hold_reason ? ` — "${row.hold_reason}"` : ''}`
        + `${row.held_at ? `, since ${String(row.held_at).slice(0, 19).replace('T', ' ')}` : ''}`
        + '. Nothing publishes until it is released. This is not an idle pipeline.',
    };
  }

  if (reason === 'no_active_release') {
    return { level: ALERT, reason, ageMinutes, message: 'there is no active release — the archive has never published, or the pointer is gone' };
  }

  // Work is waiting. Only NOW does age mean anything.
  if (row.pending === true) {
    const late = ageMinutes !== null && ageMinutes > PENDING_GRACE_MINUTES;
    return {
      level: late ? ALERT : OK,
      reason,
      ageMinutes,
      message: late
        ? `${reason}: work has been waiting and the active release is ${ageMinutes} minutes old (grace ${PENDING_GRACE_MINUTES}m) — the publisher is not running`
        : `${reason}: a publish is due and the release is ${ageMinutes}m old, inside the ${PENDING_GRACE_MINUTES}m grace`,
    };
  }

  // Nothing to do. An old release here is CORRECT and must never alert -- see the header.
  return {
    level: OK,
    reason,
    ageMinutes,
    message: reason === 'counters_within_floor'
      ? `counters are waiting on §6's one-hour floor; the release is ${ageMinutes}m old and that is by design`
      : `nothing to publish; the release is ${ageMinutes}m old and that is correct for an idle archive`,
  };
}

/** The first line of an error, which is the part worth putting on one line of output. */
function firstLine(e) {
  return String(e && e.message ? e.message : e).split(String.fromCharCode(10))[0];
}

function queryDeployed(sql) {
  const dir = mkdtempSync(join(tmpdir(), 'rma-monitor-'));
  const file = join(dir, 'q.sql');
  try {
    writeFileSync(file, sql, 'utf8');
    // execSync, not execFileSync: on Windows `supabase` is a .cmd shim and direct spawn
    // answers ENOENT. scripts/pgtap-deployed.mjs already goes through a shell for the same
    // reason, and this is the same invocation.
    const out = execSync(`supabase db query --linked -f "${file}"`, {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000,
    });
    const json = /\{[\s\S]*\}/.exec(out);
    if (!json) throw new Error('no JSON in the CLI output');
    return JSON.parse(json[0]).rows ?? [];
  } finally {
    // Enumerated and removed, the same rule scripts/backup.ts now holds itself to.
    rmSync(dir, { recursive: true, force: true });
  }
}

function checkPublish() {
  let rows;
  try {
    rows = queryDeployed('select public.publish_pending() as state;');
  } catch (e) {
    return { name: 'publish', level: UNKNOWN, message: `could not reach the database: ${String(e.message).split('\n')[0]}` };
  }
  const state = rows[0]?.state;
  const v = judgePublish(state, Date.now());
  return { name: 'publish', ...v, state };
}

/* ── Storage, and §2's three thresholds ────────────────────────────────────── */

/**
 * Read from the DATABASE, not by listing the bucket, and for the reason backup.ts already
 * wrote down: `presignR2` signs ONE object, S3's ListObjectsV2 puts its parameters in the
 * query string and therefore inside the SigV4 canonical request, and listing would mean
 * either widening a crypto module that production Edge Functions depend on or writing a
 * second signer. Neither is worth it here either.
 *
 * And the database is the better source in the same way it is there: `media_assets` is what
 * the archive BELIEVES it has, which is what a cost projection should be built on, and it
 * is the number that moves when somebody uploads rather than when a lifecycle rule fires.
 *
 * What is watched is §2's own reinstate-the-diff thresholds, quoted from the amendment:
 * "Reinstate the diff when the archive passes 1,500 items, the publish rate passes 100
 * releases/day, or /v/ passes 5 GB." Two of the three are exact here. The third is not:
 * nothing in the database knows how many bytes the release tree occupies, so it is
 * ESTIMATED from the release count and said to be an estimate.
 *
 * EGRESS is deliberately absent rather than reported as zero. §6 makes media egress
 * structurally $0 on R2, and the figure is not in any source this script can reach -- it is
 * in Cloudflare's GraphQL analytics behind a different token. "egress: 0" from a source that
 * does not carry egress is a reassurance, not a measurement.
 */
function checkStorage() {
  let rows;
  try {
    rows = queryDeployed(`
      select
        (select count(*) from public.posts where status = 'approved' and not takedown)      as items,
        (select coalesce(sum(bytes), 0) from public.media_assets where bucket = 'originals') as originals_bytes,
        (select coalesce(sum(bytes), 0) from public.media_assets where bucket = 'public')    as public_bytes,
        (select count(*) from public.releases)                                               as releases,
        (select count(*) from public.releases where created_at > now() - interval '1 day')   as releases_today;`);
  } catch (e) {
    return { name: 'storage', level: UNKNOWN, message: `could not reach the database: ${firstLine(e)}` };
  }

  const r = rows[0];
  if (!r) return { name: 'storage', level: UNKNOWN, message: 'the storage query returned no row' };

  const gib = (n) => (Number(n) / 1024 ** 3).toFixed(2);
  const items = Number(r.items);
  const releasesToday = Number(r.releases_today);

  // §2's amendment: ~660 objects a release at 300 items. The tree is not measurable from
  // here, so this is arithmetic on a documented figure and is labelled as such.
  const hits = [];
  if (items > 1500) hits.push(`${items} items is past §2's 1,500`);
  if (releasesToday > 100) hits.push(`${releasesToday} releases today is past §2's 100/day`);

  return {
    name: 'storage',
    // A threshold crossed here is not an outage. It is §2 saying the incremental diff and
    // release pruning are now one piece of work that needs doing -- a WARN, on purpose.
    level: hits.length ? WARN : OK,
    message: hits.length
      ? `${hits.join('; ')} — §2's deferred incremental diff is now due`
      : `${items} items · originals ${gib(r.originals_bytes)} GiB · public ${gib(r.public_bytes)} GiB · `
        + `${r.releases} releases (${releasesToday} today) — all inside §2's thresholds`,
    items,
    originalsBytes: Number(r.originals_bytes),
    publicBytes: Number(r.public_bytes),
    releases: Number(r.releases),
    releasesToday,
    note: 'egress is not measured here — see the comment; /v/ size is not in the database',
  };
}

/* ── The performance budget ────────────────────────────────────────────────── */

function checkBudget() {
  try {
    const out = execFileSync(process.execPath, [join(root, 'scripts/frontend-budget.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    const m = /first paint, brotli:\s*([\d.]+) KiB/.exec(out);
    const b = /§9's budget:\s*([\d.]+) KiB/.exec(out);
    if (!m || !b) return { name: 'budget', level: UNKNOWN, message: 'the budget script printed something this could not read' };
    const used = Number(m[1]), ceiling = Number(b[1]);
    const pct = Math.round((used / ceiling) * 100);
    return {
      name: 'budget',
      level: used > ceiling ? ALERT : used > ceiling * 0.9 ? WARN : OK,
      message: `first paint ${used} KiB of ${ceiling} KiB (${pct}%)`,
      used, ceiling,
    };
  } catch (e) {
    return { name: 'budget', level: UNKNOWN, message: `could not run the budget check: ${String(e.message).split('\n')[0]}` };
  }
}

/* ── Edge Function errors ──────────────────────────────────────────────────── */

function checkFunctions() {
  /*
   * NOT IMPLEMENTED, and reported as `unknown` rather than quietly omitted.
   *
   * Supabase's function logs live behind the Management API's analytics endpoint, which
   * needs a personal access token with a scope this project has not provisioned, and the
   * log retention on the current plan is short enough that a daily poll would miss most of
   * a night. Both are Amro's calls rather than code, so the honest state is a named gap.
   *
   * What partially covers it today: `request-upload` now logs Turnstile's own error codes
   * (1 Sep), so the one failure that was invisible from outside is at least IN the log for
   * whoever opens the dashboard.
   */
  return {
    name: 'functions',
    level: UNKNOWN,
    message: 'Edge Function error rates are not collected — needs a Management API token with analytics scope (Amro). Not silently skipped.',
  };
}

/* ── The self-test ─────────────────────────────────────────────────────────── */
//
// No credential and no network. It exists because the alerting logic is the part that must
// be right and is the part hardest to observe in production -- gate 5 fails SILENTLY, which
// is the whole reason it is a gate.

function selftest() {
  let passed = 0, failed = 0;
  const ok = (cond, name) => {
    if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
    else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
  };

  const now = Date.parse('2026-09-01T12:00:00Z');
  const ago = (m) => new Date(now - m * 60000).toISOString();

  // ── gate 5's requirement, both halves ──
  const held = judgePublish({
    pending: false, reason: 'held_by_operator', hold_reason: 'investigating a bad shard',
    held_by: 'a-moderator-uuid', held_at: ago(3), active_created_at: ago(3),
  }, now);
  ok(held.level === ALERT, 'a HELD pipeline alerts');
  // The key is `hold_reason` and this file read `held_reason` for its first live run, so
  // the alert named no reason. The column has no default for exactly this reason.
  ok(/investigating a bad shard/.test(held.message),
     "and the OPERATOR'S OWN REASON reaches the message, not just the fact of a hold");
  ok(held.ageMinutes === 3, 'and it alerts after 3 minutes — "fire on the first", not after a timeout');
  ok(/HELD BY AN OPERATOR/.test(held.message) && /not an idle pipeline/.test(held.message),
     'and the message says a human stopped it, in those words');

  const idle = judgePublish({ pending: false, reason: 'unchanged', active_created_at: ago(60 * 24 * 14) }, now);
  ok(idle.level === OK, 'an IDLE pipeline does not alert, even at a fortnight old');
  ok(idle.reason !== held.reason,
     'the two are distinguished by reason, which is what §11 gate 5 asks the database for');

  // The discrimination stated as the gate states it: same age, opposite verdict.
  const heldSameAge = judgePublish({ pending: false, reason: 'held_by_operator', active_created_at: ago(60 * 24 * 14) }, now);
  ok(heldSameAge.level === ALERT && idle.level === OK,
     'CONTROL: at the SAME age, held alerts and unchanged does not — the age is not what decides it');

  // ── the pending-work path ──
  const fresh = judgePublish({ pending: true, reason: 'content_changed', active_created_at: ago(5) }, now);
  ok(fresh.level === OK, `pending work inside the ${PENDING_GRACE_MINUTES}m grace is not yet an alert`);
  const stuck = judgePublish({ pending: true, reason: 'content_changed', active_created_at: ago(90) }, now);
  ok(stuck.level === ALERT, 'pending work past the grace IS an alert — the publisher is not running');
  ok(/not running/.test(stuck.message), 'and it says the publisher is not running rather than naming an age');

  ok(judgePublish({ pending: false, reason: 'counters_within_floor', active_created_at: ago(30) }, now).level === OK,
     "§6's one-hour counter floor is a design, not a fault");
  ok(judgePublish({ pending: true, reason: 'no_active_release' }, now).level === ALERT,
     'no active release at all is an alert');

  // ── unknown is not ok ──
  ok(judgePublish(null, now).level === UNKNOWN, 'an unreadable answer is UNKNOWN');
  ok(RANK[UNKNOWN] > RANK[OK], 'and UNKNOWN outranks OK, so it cannot be reported as healthy');
  ok(RANK[ALERT] > RANK[WARN] && RANK[WARN] > RANK[UNKNOWN], 'the severity order is alert > warn > unknown > ok');

  // ── the exit code is derived from the worst check, not from the last one ──
  const worst = [{ level: OK }, { level: ALERT }, { level: OK }].reduce((a, c) => (RANK[c.level] > RANK[a] ? c.level : a), OK);
  ok(worst === ALERT, 'CONTROL: one alert among many ok checks decides the run');

  // ── --require: a check that could not look is a failure when it was named ──
  {
    const sample = [{ name: 'publish', level: UNKNOWN }, { name: 'budget', level: OK }];
    const blindOf = (req) => sample.filter((c) => req.includes(c.name) && c.level === UNKNOWN);
    ok(blindOf(['publish']).length === 1, '--require publish fails when the publish check could not run');
    ok(blindOf(['budget']).length === 0, 'CONTROL: and does not fail for a check that DID run');
    ok(blindOf([]).length === 0, 'CONTROL: with nothing required, an unknown is not a failure');
  }

  console.log(`\n1..${passed + failed}`);
  if (failed) { console.error(`\n${failed} assertion(s) failed.`); process.exit(1); }
  console.log(`All ${passed} assertions passed.`);
}

/* ── The run ───────────────────────────────────────────────────────────────── */

if (has('--selftest')) {
  selftest();
} else {
  const only = value('--only');
  const checks = [];
  const wanted = (n) => !only || only === n;

  if (wanted('publish')) checks.push(checkPublish());
  if (wanted('budget')) checks.push(checkBudget());
  if (wanted('functions')) checks.push(checkFunctions());
  if (wanted('storage')) checks.push(checkStorage());

  const worst = checks.reduce((a, c) => (RANK[c.level] > RANK[a] ? c.level : a), OK);

  /* `--require publish` — a named check that could not LOOK fails the run.
   *
   * Without this the scheduled job becomes the failure it exists to prevent. On a runner
   * with no Supabase credential the publish check reports `unknown`, `unknown` is not an
   * alert, the workflow goes green every night, and gate 5's monitor is "running" while
   * measuring nothing. Naming the check that must actually have run turns a missing secret
   * into a red build on the first night rather than into a quiet forever. */
  const required = (value('--require') ?? '').split(',').filter(Boolean);
  const blind = checks.filter((c) => required.includes(c.name) && c.level === UNKNOWN);

  if (has('--json')) {
    console.log(JSON.stringify({ at: new Date().toISOString(), worst, blind: blind.map((c) => c.name), checks }, null, 2));
  } else {
    const mark = { [OK]: 'ok     ', [WARN]: 'WARN   ', [ALERT]: 'ALERT  ', [UNKNOWN]: 'unknown' };
    console.log(`\nmonitor — ${new Date().toISOString()}\n`);
    for (const c of checks) console.log(`  ${mark[c.level]} ${c.name.padEnd(10)} ${c.message}`);
    console.log(`\nworst: ${worst}`);
    for (const c of blind) console.log(`\nREQUIRED CHECK COULD NOT RUN: ${c.name} — ${c.message}`);
    if (worst === ALERT || blind.length) console.log('\nThis run FAILS. Something needs a person.');
  }

  // An ALERT fails the run, and so does a REQUIRED check that could not look. A WARN is a
  // number moving in the wrong direction and an unrequired UNKNOWN is a check nobody asked
  // to be sure of — both are worth printing every time and neither is worth waking
  // somebody for.
  process.exit(worst === ALERT || blind.length ? 1 : 0);
}
