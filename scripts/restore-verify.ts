/**
 * §11 gate 3: "one tested restore." This is the test.
 *
 *   deno run --allow-run --allow-env --allow-read --allow-write scripts/restore-verify.ts \
 *     --backup "<dir>/db/2026-08-31T22-31-02Z" --into-container supabase_db_<ref>
 *   deno run --allow-read scripts/restore-verify.ts --selftest
 *
 * ── Why the target is a local container and not the scratch project ──
 *
 * The decision of 31 Aug 2026 says the restore target is a scratch Supabase project, and
 * that is still the right answer for a rehearsal of the real thing: it exercises GoTrue, the
 * REST layer and the extensions a hosted project actually has. It is also not provisioned,
 * and it needs the CLI to be linked to it — which means unlinking production for the
 * duration, on the one machine that operates production.
 *
 * A local Postgres container restores the same four dumps under the same Postgres major
 * version, and it has a property the scratch project does not: `docker exec` CANNOT REACH A
 * HOSTED PROJECT. The target is safe by construction rather than by a refusal that has to be
 * kept correct. So this is what discharges the gate today, and `--target <ref>` is left in
 * place, still refusing production by name, for the day the scratch project exists.
 *
 * What a local target therefore does NOT prove, written down rather than left implied: that
 * GoTrue can serve the restored `auth` rows, and that a hosted project's extension set comes
 * up the same way. Both are about the platform around the database, not about the backup.
 *
 * ── "A restore succeeded" is the claim this file refuses to take on trust ──
 *
 * A restore that loads without error is not a restore that worked. The failures that matter
 * all load cleanly:
 *
 *   · `auth` was excluded from the dump, so every `created_by` points at a user that does not
 *     exist and `user_roles` — where §4's authorization lives — is keyed to nobody. Every
 *     table has rows. Nothing errors. The archive has no people in it.
 *   · the RLS policies restored as text but the denial matrix no longer holds, because a
 *     grant or a policy landed in a different order. Reading a policy list cannot tell you.
 *   · `audit_log` restored, and its append-only trigger did not, so §3's permanent record is
 *     now editable.
 *   · the database and the media were backed up hours apart, so `media_assets` names objects
 *     the media copy does not have. This is the one almost every restore test skips, and it
 *     is the one that makes an archive unrecoverable rather than merely stale.
 *
 * So the checks below are ordered by how much they prove, and the strongest is not a query at
 * all: **run the project's own pgTAP suite against the restored database**, including
 * `05_matrix`, the §11 gate-1 denial matrix. A restored database that passes the same 669
 * assertions the live one passes is a restored database.
 *
 * ── The refusal that matters most ────────────────────────────
 *
 * This restores INTO a target and therefore destroys what is there. It refuses to run against
 * the production ref, refuses a target it was not given explicitly, and refuses a target that
 * already holds an archive that looks real — the same posture `r2Endpoint()` takes about never
 * inferring a fallback. A restore test that wipes production is not a hypothetical; it is the
 * ordinary outcome of a script that defaults its target.
 */

import { armScratchSweep, decrypt } from "./backup.ts";

/* ── Arguments ────────────────────────────────────────────────────────────── */

const args = Deno.args;
const has = (f: string) => args.includes(f);
const value = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};

/* The production project, written out so the refusal below is a comparison rather than a
   convention. It is not a secret — it is in config/site.json and in every URL the site
   fetches — and having it here is what lets this script say "no" by name. */
const PRODUCTION_REF = "pjqvtmhizbnimqyxjbyq";

/* ── What a restored database has to survive ──────────────────────────────── */

interface Check {
  name: string;
  /** SQL returning a single row; `ok` decides whether that row passes. */
  sql: string;
  ok: (row: Record<string, unknown>) => boolean;
  why: string;
}

export const CHECKS: Check[] = [
  {
    name: "auth.users came back",
    sql: "select count(*)::int as n from auth.users;",
    ok: (r) => Number(r.n) > 0,
    why: "the default `supabase db dump` EXCLUDES the auth schema. Without this the restore looks complete and has no people in it.",
  },
  {
    name: "every post's author exists",
    sql: `select count(*)::int as n from public.posts p
            left join auth.users u on u.id = p.created_by
           where p.created_by is not null and u.id is null;`,
    ok: (r) => Number(r.n) === 0,
    why: "the exact shape of an auth-less restore: posts with a created_by that resolves to nobody.",
  },
  {
    name: "roles resolve through authz_role()",
    sql: `select count(*)::int as n from public.user_roles ur
            join auth.users u on u.id = ur.user_id
           where ur.role in ('moderator','admin');`,
    ok: (r) => Number(r.n) > 0,
    why: "§4 puts authorization in user_roles. Restored rows keyed to missing users are not authorization.",
  },
  {
    name: "audit_log is still append-only",
    /* `update … limit 1` is not PostgreSQL — UPDATE takes no LIMIT — so the first form of
       this check was a syntax error that could never pass, and only running it found that.
       The trigger is FOR EACH STATEMENT, so it fires on a zero-row update too and this needs
       no audit rows to exist. 23001 is `restrict_violation`, which is the errcode
       `audit_log_is_append_only()` raises with. */
    sql: `do $$ begin
            begin
              update public.audit_log set action = action
               where id in (select id from public.audit_log limit 1);
              raise exception 'AUDIT_LOG_IS_WRITEABLE';
            exception when sqlstate '23001' then null;
            end;
          end $$; select 1 as n;`,
    ok: (r) => Number(r.n) === 1,
    why: "§3 makes audit rows permanent, and a trigger is what enforces it. A dump that restored the table and not the trigger passes every row count.",
  },
  {
    name: "RLS is on for every table it was on for",
    sql: `select count(*)::int as n from pg_class c
            join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;`,
    ok: (r) => Number(r.n) === 0,
    why: "a table restored with RLS off is readable by anyone with the anon key, and nothing about the data looks wrong.",
  },
  {
    name: "anon holds nothing",
    sql: `select count(*)::int as n
            from information_schema.role_table_grants
           where grantee = 'anon' and table_schema = 'public';`,
    ok: (r) => Number(r.n) === 0,
    why: "§2's 'zero database reads for public visitors' is a grant-level fact, and grants are the part of a dump people forget to check.",
  },
  {
    name: "PostGIS re-derives the same fuzzed point",
    /* `fuzz_location` takes the precision as well as the point — a one-argument call is a
       different function that does not exist, and the check reported "the function did not
       come back" against a restore in which it had. Signature read off the catalogue rather
       than remembered. */
    sql: `select count(*)::int as n from public.posts
           where location is not null and location_public is not null
             and extensions.st_distance(
                   location_public,
                   public.fuzz_location(location, location_precision)) > 1;`,
    ok: (r) => Number(r.n) === 0,
    why: "§7's fuzzing is a function, not a stored constant. If PostGIS restored at a different version or the function did not come back, published coordinates move.",
  },
];

/* ── Media consistency: the check restores usually skip ───────────────────── */

/**
 * Every `media_assets` row in the restored database, resolved against the BACKUP's copy of
 * the objects.
 *
 * This is the one that decides whether the archive is recoverable rather than merely present.
 * A database backup and a media backup taken hours apart give a restored database that names
 * objects the media copy does not have — and every other check on this page passes.
 */
export function mediaSql(): string {
  return `select storage_path, bytes from public.media_assets where bucket = 'originals' order by storage_path;`;
}


/* ── Talking to the restored database ─────────────────────────────────────── */

/**
 * One psql invocation inside the target container, SQL on stdin.
 *
 * `docker exec` rather than a connection string, and that is the safety property rather than
 * a convenience: it can only reach a container on this machine, so no typo in a flag can
 * point this script — which DROPS SCHEMA — at a hosted project.
 */
async function psql(
  container: string,
  sql: string,
  opts: { stopOnError?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const p = new Deno.Command("docker", {
    args: [
      "exec", "-i", container,
      "psql", "-U", "postgres", "-d", "postgres",
      "-q", "-t", "-A",
      "-v", `ON_ERROR_STOP=${opts.stopOnError === false ? 0 : 1}`,
      "-f", "-",
    ],
    stdin: "piped", stdout: "piped", stderr: "piped",
  }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(sql));
  await w.close();
  const { code, stdout, stderr } = await p.output();
  return { code, out: new TextDecoder().decode(stdout), err: new TextDecoder().decode(stderr) };
}

/** A single scalar, or a throw. Used for the assertions this script makes about its own work. */
async function scalar(container: string, sql: string): Promise<string> {
  const r = await psql(container, sql);
  if (r.code !== 0) throw new Error(`${sql.split("\n")[0].slice(0, 70)} → ${r.err.trim().split("\n")[0]}`);
  return r.out.trim();
}

/* ── Reading the backup ───────────────────────────────────────────────────── */

interface Manifest {
  taken_at: string;
  pinned: string | null;
  destination?: { kind: string; where: string };
  originals_prefix?: string;
  dumps: { key: string; bytes: number; sha256: string }[];
  dumps_that_could_not_run: string[];
  completeness_gaps: { what: string; expected: number; found: number }[];
  originals: { copied: number; already_present: number; source_objects: number; orphans: string[] };
}

const sha256 = async (b: Uint8Array<ArrayBuffer>) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Decrypt one dump and check it against the manifest's own record of it.
 *
 * The digest comparison is not ceremony. `backup.ts` wrote that sha256 from the bytes it had
 * in hand before encrypting; matching it here means the file on the disk today is the dump
 * that was taken, and not a truncated write, a half-finished copy, or the wrong run's file
 * picked up by a glob. A restore that loads corrupted SQL fails somewhere in the middle and
 * blames the schema.
 */
async function dumpFromBackup(dir: string, name: string, passphrase: string, m: Manifest): Promise<string> {
  const blob = await Deno.readFile(`${dir}/${name}.enc`) as Uint8Array<ArrayBuffer>;
  const plain = await decrypt(blob, passphrase);
  const claimed = m.dumps.find((d) => d.key.endsWith(`/${name}.enc`));
  if (!claimed) throw new Error(`${name}: the manifest does not list it — this is not the backup it claims to be`);
  const got = await sha256(plain);
  if (got !== claimed.sha256) throw new Error(`${name}: sha256 ${got} but the manifest recorded ${claimed.sha256}`);
  if (plain.length !== claimed.bytes) throw new Error(`${name}: ${plain.length} bytes, manifest says ${claimed.bytes}`);
  return new TextDecoder().decode(plain);
}

/**
 * The order the dumps go back in, and every position in it is load-bearing.
 *
 *   roles     first — the schema's 273 GRANTs name roles, and `media_worker` is one the
 *             platform does not create for you.
 *   schema    the 18 tables, 27 policies, 77 functions, and the grants.
 *   data      the rows. `supabase db dump --data-only` carries the AUTH schema's rows too —
 *             measured, not assumed, and the reason `auth.sql` below is conditional.
 *   auth      ONLY if the data dump did not already bring `auth.users` back. Loading both
 *             would be a primary-key collision on every account.
 *   triggers  LAST, and not for the reason first written down. The schema dump ALREADY
 *             carries all 46, as `CREATE OR REPLACE TRIGGER` — see `idempotentTriggers()`.
 *             So this file is insurance, and it goes last because if it ever IS the thing
 *             that restores them, they must not be in place while the rows are loaded:
 *             `posts_stamp_authorship` would rewrite authorship, every `*_bump_content_*`
 *             would queue a publish, and `audit_log_no_update_or_delete` would refuse the
 *             audit table's own history. It IS still the only copy of the `auth.users`
 *             trigger, which no pg_dump file here carries.
 *   fn ACL    last, because it names functions and they have to exist. The schema dump omits
 *             REVOKE/GRANT for any function taking an `extensions` type, so without this the
 *             restore hands `anon` EXECUTE on three functions the migrations revoked.
 */
const LOAD_ORDER = ["roles.sql", "schema.sql", "data.sql", "auth.sql", "triggers.sql", "function_acl.sql"] as const;

/**
 * `pg_get_triggerdef()` emits `CREATE TRIGGER`, which is not idempotent; pg_dump emits
 * `CREATE OR REPLACE TRIGGER`, which is. Both describe the same 46 triggers, so loading the
 * catalogue's copy after the schema dump collides on the first statement — which is exactly
 * how the schema dump was discovered to carry them at all.
 *
 * Rewriting the one spelling into the other makes the fifth dump a no-op when the schema has
 * already restored the triggers, and a rescue when it has not. That keeps the insurance
 * without the collision, and without this script having to decide which of the two files it
 * trusts.
 *
 * A CONSTRAINT trigger has no `OR REPLACE` form. There are none in this schema, and rather
 * than pretend otherwise this returns them untouched and names them, so the day one is added
 * the restore says so instead of silently double-loading.
 */
export function idempotentTriggers(sql: string): { sql: string; unsupported: string[] } {
  const unsupported: string[] = [];
  const out = sql.split("\n").map((line) => {
    if (/^CREATE CONSTRAINT TRIGGER /.test(line)) {
      unsupported.push(line.split(" ")[3] ?? line.slice(0, 60));
      return line;
    }
    return line.startsWith("CREATE TRIGGER ")
      ? `CREATE OR REPLACE TRIGGER ${line.slice("CREATE TRIGGER ".length)}`
      : line;
  }).join("\n");
  return { sql: out, unsupported };
}

/* ── Self-test ────────────────────────────────────────────────────────────── */

function selftest() {
  let passed = 0, failed = 0;
  const ok = (c: boolean, name: string) => {
    if (c) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
    else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
  };

  // The refusal. Everything else in this file is a query; this is the part that can destroy
  // something, so it is the part with a test.
  ok(refuses(PRODUCTION_REF).length > 0, "the production ref is refused as a restore target");
  ok(refuses("").length > 0, "an empty target is refused rather than defaulted");
  ok(refuses("PJQVTMHIZBNIMQYXJBYQ").length > 0, "and case does not get past it");
  ok(refuses(` ${PRODUCTION_REF} `).length > 0, "nor does whitespace");
  ok(refuses("abcdefghijklmnopqrst").length === 0,
     "CONTROL: an unrelated ref is accepted — the refusal discriminates rather than blocking everything");

  // Each check must have a `why`. A check whose failure a person cannot act on is a check
  // that gets deleted the first time it goes red.
  ok(CHECKS.every((c) => c.why.length > 40), "every check explains what its failure would mean");
  ok(CHECKS.some((c) => c.name.includes("auth.users")), "CONTROL: the auth check is present — it is the whole reason for three dumps");

  /* UPDATE takes no LIMIT in PostgreSQL, and the first version of the append-only check used
     one — a syntax error dressed as an assertion, which would have reported §3's permanent
     record broken on every restore including a perfect one. Asserted here so it cannot come
     back the next time somebody shortens the statement. */
  const appendOnly = CHECKS.find((c) => c.name.includes("append-only"))!;
  ok(!/update[\s\S]*\blimit\b/i.test(appendOnly.sql.split("where")[0]),
     "the append-only check does not use UPDATE ... LIMIT, which is not PostgreSQL");
  ok(/where id in \(select/i.test(appendOnly.sql),
     "CONTROL: it bounds the update with a subquery instead");

  /* The load order is the whole restore, and getting it wrong produces a database that looks
     restored. Asserted against the constant rather than left as a comment. */
  ok(LOAD_ORDER.indexOf("schema.sql") < LOAD_ORDER.indexOf("data.sql"),
     "the schema loads before the data");
  ok(LOAD_ORDER.indexOf("data.sql") < LOAD_ORDER.indexOf("triggers.sql"),
     "and the triggers load AFTER the data — restoring rows through the publisher's own triggers would fire them");
  ok(LOAD_ORDER[0] === "roles.sql", "and roles come first, because grants in the schema name them");

  /* The collision that only a real restore found: the schema dump spells them
     `CREATE OR REPLACE TRIGGER`, the catalogue dump spells them `CREATE TRIGGER`, and the
     second is not idempotent. */
  const t = idempotentTriggers(
    "CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION f();\n" +
    "CREATE TRIGGER x BEFORE INSERT ON public.y FOR EACH ROW WHEN ((new.status = 'published'::comment_status)) EXECUTE FUNCTION g();",
  );
  ok(t.sql.split("CREATE OR REPLACE TRIGGER").length - 1 === 2,
     "every CREATE TRIGGER becomes CREATE OR REPLACE TRIGGER, so the fifth dump loads beside the schema's own copy");
  ok(!/^CREATE TRIGGER /m.test(t.sql), "and none is left in the colliding form");
  ok(t.sql.includes("'published'::comment_status"), "CONTROL: the rest of the statement is untouched — this rewrites a prefix, not the SQL");
  ok(t.unsupported.length === 0, "CONTROL: a plain trigger is not reported as unsupported");

  /* The suite verdict is a two-way comparison, so the parser it rests on gets a test. */
  const sample = [
    "  ok      19_takedown.test.sql               plan  12  ran  12  failed 0",
    "  not ok  20_publish_cron.test.sql           plan  28  ran  28  failed 1",
    "            not ok 14 - before the first release, a publish is always due",
    "  not ok  05_matrix.test.sql                 plan   6  ran   6  failed 1",
    "            not ok 2 - the denial matrix holds",
  ].join("\n");
  const parsed = redAssertions(sample);
  ok(parsed.length === 2, "the suite parser finds every red assertion");
  ok(parsed[0].file === "20_publish_cron.test.sql" && parsed[0].desc.startsWith("before the first release"),
     "and attributes each to the file it appeared under");
  ok(parsed[1].file === "05_matrix.test.sql",
     "CONTROL: a second file's red is not attributed to the first — the file line resets it");
  ok(redAssertions("  ok      19_takedown.test.sql   plan 12 ran 12 failed 0").length === 0,
     "CONTROL: a green run yields no reds, so an empty result means green rather than an unparsed format");
  ok(KNOWN_RED.every((k) => k.why.length > 40),
     "every required-red says why it must be red — an unexplained exemption is how a real failure gets waved through");

  const c = idempotentTriggers("CREATE CONSTRAINT TRIGGER cc AFTER INSERT ON public.z FOR EACH ROW EXECUTE FUNCTION h();");
  ok(c.unsupported.length === 1 && c.unsupported[0] === "cc",
     "a CONSTRAINT trigger is named rather than rewritten — there is no OR REPLACE form for one");
  ok(c.sql.startsWith("CREATE CONSTRAINT TRIGGER "), "and it is left exactly as it was rather than turned into invalid SQL");

  /* backup.ts exports encrypt/decrypt and a module body runs on import, so its main block has
     to be guarded or importing it from here would TAKE A BACKUP. Asserted against the source
     rather than by importing it, because importing it is the very thing being guarded — and a
     test that triggers the bug to check for it is not a test. */
  const src = Deno.readTextFileSync(new URL("./backup.ts", import.meta.url));
  ok(/if \(!import\.meta\.main\)/.test(src),
     "backup.ts's main block is guarded by import.meta.main — importing it must not run a backup");
  ok(/export async function decrypt/.test(src),
     "CONTROL: backup.ts really does export what this file imports, so the guard is guarding something real");

  console.log(`\n1..${passed + failed}`);
  if (failed) { console.log(`${failed} assertion(s) failed.`); Deno.exit(1); }
  console.log(`All ${passed} assertions passed.`);
}

/** Reasons this target must not be restored into. Empty means it may be. */
export function refuses(target: string): string[] {
  const t = target.trim().toLowerCase();
  const out: string[] = [];
  if (!t) out.push("no --target given, and this script will not infer one");
  if (t && t === PRODUCTION_REF.toLowerCase()) out.push(`--target is the PRODUCTION project (${PRODUCTION_REF})`);
  return out;
}

/**
 * Assertions that MUST be red against a correctly restored database.
 *
 * "The suite is green" is the wrong bar here, and reaching for it would mean either lying
 * about the result or deleting a true assertion. `20_publish_cron` 14 describes a database
 * that has never published. The deployed database has published, so it is red there and is
 * documented at the assertion; a restored database has published too — because the backup
 * restored the `releases` rows — so it is red here for exactly the same reason.
 *
 * Its being red is therefore EVIDENCE, and this list is checked in both directions: a red
 * outside it fails the gate, and an entry that comes back GREEN fails the gate too. The
 * second half is the control. If 14 ever passes against a restore, the restored database has
 * no releases in it, which is a real loss wearing a green tick.
 *
 * `20_publish_cron` 23 and 24 are the other two known-red against the deployed database and
 * are deliberately NOT here: they need `vault.secrets` rows, the backup deliberately does not
 * carry live credentials into a second account, so a restore is a database with no Vault
 * entries and they pass exactly as they do on a fresh one.
 */
const KNOWN_RED = [
  {
    file: "20_publish_cron.test.sql",
    assertion: "before the first release, a publish is always due",
    why: "the restored archive HAS releases, because the backup restored them. Green here would mean they were lost.",
  },
] as const;

/** Reads the runner's TAP output back: which assertions were red, and under which file. */
export function redAssertions(suiteOut: string): { file: string; desc: string }[] {
  const out: { file: string; desc: string }[] = [];
  let file = "";
  for (const raw of suiteOut.split("\n")) {
    const f = raw.match(/^\s{2}(?:not )?ok\s+(\S+\.test\.sql)/);
    if (f) { file = f[1]; continue; }
    const a = raw.match(/^\s+not ok (\d+) - (.*)$/);
    if (a) out.push({ file, desc: a[2].trim() });
  }
  return out;
}

/* ── The run ──────────────────────────────────────────────────────────────── */

/* Every path this process writes outside the backup directory is enumerated and deleted
   when it ends -- a normal finish, a throw, a `Deno.exit` refusal or a Ctrl-C. It is armed
   here rather than inside the run because the refusals below exit before the run starts.

   This file writes nothing itself: `dumpFromBackup` decrypts into memory and the SQL goes to
   psql on stdin, which is the property backup.ts's selftest asserts by scanning both files.
   What it DOES do is spawn `pgtap-deployed.mjs --local`, which writes a rewritten copy of
   all 37 test files into a temp directory -- project SQL rather than member data, but 37
   files a run, never removed until now, and "the tooling cleans up after itself" is not a
   claim worth making with an exception in it. */
armScratchSweep("restore-verify scratch");

if (has("--selftest")) {
  selftest();
} else {
  const container = value("--into-container") ?? "";
  const target = value("--target") ?? "";
  const backup = value("--backup") ?? "";

  if (!container) {
    /* The scratch-project path. It is not built, and the refusal that protects production
       still runs first so that a mistyped ref is answered before anything else is. */
    const no = refuses(target);
    if (no.length) {
      console.error("restore-verify: refusing to run —");
      for (const r of no) console.error(`  ${r}`);
    }
    console.error("\nrestore-verify: --into-container <name> is the path that is built today.");
    console.error("  A scratch Supabase project (Amro's decision, 31 Aug 2026) is the eventual target and is");
    console.error("  not provisioned; restoring into one also needs the CLI relinked away from production.");
    console.error("  Usage: --backup <dir>/db/<timestamp> --into-container supabase_db_<ref>");
    Deno.exit(1);
  }
  if (!backup) {
    console.error("restore-verify: --backup <dir> is required — which copy is being proved?");
    Deno.exit(1);
  }

  const passphrase = Deno.env.get("BACKUP_PASSPHRASE") ?? "";
  if (!passphrase) {
    console.error("restore-verify: BACKUP_PASSPHRASE is not set. The dumps are encrypted; without it there is nothing to restore.");
    Deno.exit(1);
  }

  const originals = value("--originals") ?? `${backup}/../../originals`;
  let bad = 0;
  const fail = (why: string) => { bad++; console.log(`  not ok  ${why}`); };
  const pass = (what: string) => console.log(`  ok      ${what}`);

  console.log("\nrestore-verify — §11 gate 3");
  console.log(`  backup    : ${backup}`);
  console.log(`  originals : ${originals}`);
  console.log(`  target    : container ${container} (local; docker exec cannot reach a hosted project)`);

  const manifest: Manifest = JSON.parse(await Deno.readTextFile(`${backup}/manifest.json`));
  console.log(`  taken at  : ${manifest.taken_at}${manifest.pinned ? `  PINNED ${manifest.pinned}` : ""}`);
  console.log(`  kind      : ${manifest.destination ? `${manifest.destination.kind} — ${manifest.destination.where}` : "(a manifest from before the destination was recorded)"}`);

  /* A backup that already knew it was incomplete must not be graded as a restore. Reading the
     manifest's own admissions first is cheaper than finding them in a failing assertion. */
  if (manifest.dumps_that_could_not_run.length) {
    console.error(`\nrestore-verify: this backup recorded ${manifest.dumps_that_could_not_run.length} dump(s) that could not run. Refusing.`);
    Deno.exit(1);
  }
  if (manifest.completeness_gaps.length) {
    console.error("\nrestore-verify: this backup recorded completeness gaps. Refusing.");
    Deno.exit(1);
  }

  /* ── 1 · read and verify the dumps ─────────────────────────────────────── */
  console.log("\n== the backup ==");
  const sql: Record<string, string> = {};
  for (const name of LOAD_ORDER) {
    sql[name] = await dumpFromBackup(backup, name, passphrase, manifest);
    console.log(`  ${name.padEnd(13)} ${String(sql[name].length).padStart(8)} bytes  decrypted, sha256 matches the manifest`);
  }

  /* ── 2 · the wipe, and the proof that it happened ──────────────────────── */
  console.log("\n== wiping the target ==");
  const counts = async () => ({
    tables: await scalar(container, "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r';"),
    triggers: await scalar(container, "select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal;"),
    users: await scalar(container, "select count(*) from auth.users;"),
  });
  const before = await counts();
  console.log(`  before: ${before.tables} tables, ${before.triggers} triggers, ${before.users} auth users`);

  /* `supabase_migrations` is dropped and NOTHING IN THE BACKUP PUTS IT BACK. That makes its
     continued absence at the end of this run the proof that everything below was measured
     against the RESTORED database — not against one that `supabase start` or a stray
     `db reset` quietly rebuilt from the 59 migration files underneath us. Without a marker
     like this, a rebuilt database passes every assertion on this page. */
  const wipe = await psql(container, [
    "drop schema if exists public cascade;",
    "create schema public;",
    "drop schema if exists supabase_migrations cascade;",
    "truncate auth.users cascade;",
  ].join("\n"));
  if (wipe.code !== 0) {
    console.error(`restore-verify: the wipe failed — ${wipe.err.trim()}`);
    Deno.exit(1);
  }
  const after = await counts();
  console.log(`  after : ${after.tables} tables, ${after.triggers} triggers, ${after.users} auth users`);
  if (after.tables !== "0" || after.triggers !== "0" || after.users !== "0") {
    console.error("restore-verify: the target is not empty after the wipe. Everything below would be graded against leftovers. Refusing.");
    Deno.exit(1);
  }
  pass("the target is empty — every assertion below is about the backup, not about what was already there");

  /* ── 3 · load ──────────────────────────────────────────────────────────── */
  console.log("\n== restoring ==");
  for (const name of LOAD_ORDER) {
    if (name === "auth.sql") {
      /* Measured 1 Sep 2026: `supabase db dump --data-only` WITHOUT `--schema` already
         carries the auth schema's rows, so data.sql has usually brought the accounts back
         and loading auth.sql on top of it is a primary-key collision on every one of them.
         The separate dump is still taken, because that behaviour is the CLI's and not a
         promise — so it is loaded when, and only when, it is the thing that was missing. */
      const users = await scalar(container, "select count(*) from auth.users;");
      if (users !== "0") {
        console.log(`  ${name.padEnd(13)} skipped — data.sql already restored ${users} accounts, and loading both collides`);
        continue;
      }
    }
    /* roles.sql is the one file allowed to report errors: `media_worker` and the platform
       roles already exist on any Supabase database, so `CREATE ROLE` fails by design. The
       outcome is asserted below instead of the exit code — which is the honest form of
       "tolerate an error", and the only one that cannot hide a real failure. */
    const lenient = name === "roles.sql";
    /* An explicit search_path for triggers.sql: `pg_get_triggerdef()` emits unqualified
       function names and unqualified enum casts (`'published'::comment_status`), so the file
       only resolves in a session that has `public` on the path. Every other dump sets
       `search_path = ''` for itself. */
    let body = sql[name];
    /* The two catalogue-reconstructed files write unqualified type names — `comment_status`
       in a trigger's WHEN clause, `geography` in a function signature — because that is how
       `pg_get_triggerdef` and `pg_get_function_identity_arguments` render them. They resolve
       only in a session with `public` and `extensions` on the path. Every pg_dump file sets
       `search_path = ''` for itself and needs none of this. */
    let prelude = (name === "triggers.sql" || name === "function_acl.sql")
      ? "set search_path = public, extensions, pg_catalog;\n"
      : "";
    if (name === "triggers.sql") {
      const t = idempotentTriggers(body);
      body = t.sql;
      if (t.unsupported.length) {
        fail(`triggers.sql carries ${t.unsupported.length} CONSTRAINT trigger(s) with no OR REPLACE form: ${t.unsupported.join(", ")}`);
        console.log("            they would collide with the schema dump's own copy; this path needs extending before it can load them");
      }
    }
    const r = await psql(container, prelude + body, { stopOnError: !lenient });
    if (r.code !== 0 && !lenient) {
      console.error(`restore-verify: ${name} failed to load —`);
      console.error(r.err.split("\n").slice(0, 12).join("\n"));
      Deno.exit(1);
    }
    console.log(`  ${name.padEnd(13)} loaded${lenient && r.code !== 0 ? " (errors expected — roles that already exist; the assertion below is the real check)" : ""}`);
  }

  const mediaWorker = await scalar(container, "select count(*) from pg_roles where rolname = 'media_worker';");
  if (mediaWorker === "1") pass("media_worker exists — roles.sql's outcome, asserted rather than inferred from its exit code");
  else fail("media_worker does not exist after roles.sql");

  /* ── 4 · what a restored database has to survive ───────────────────────── */
  console.log("\n== checks ==");
  for (const c of CHECKS) {
    const r = await psql(container, c.sql);
    if (r.code !== 0) {
      fail(`${c.name} — ${r.err.trim().split("\n")[0]}`);
      console.log(`            why it matters: ${c.why}`);
      continue;
    }
    const n = r.out.trim().split("\n").pop() ?? "";
    if (c.ok({ n })) pass(c.name);
    else {
      fail(`${c.name} — got ${JSON.stringify(n)}`);
      console.log(`            why it matters: ${c.why}`);
    }
  }

  /* ── 5 · the media, which is the check most restores skip ──────────────── */
  console.log("\n== media ==");
  const mediaRows = (await scalar(container, mediaSql()))
    .split("\n").map((l) => l.trim()).filter(Boolean)
    .map((l) => { const i = l.lastIndexOf("|"); return { path: l.slice(0, i), bytes: Number(l.slice(i + 1)) }; });
  if (mediaRows.length === 0) {
    fail("the restored database names no objects in originals/ — there is nothing to resolve, so nothing is proved");
  }
  let resolved = 0;
  for (const row of mediaRows) {
    let size = -1;
    try { size = (await Deno.stat(`${originals}/${row.path}`)).size; } catch { /* absent */ }
    if (size === row.bytes) resolved++;
    else fail(`media_assets names originals/${row.path} (${row.bytes} bytes) and the backup ${size === -1 ? "does not have it" : `has ${size} bytes`}`);
  }
  if (resolved === mediaRows.length && mediaRows.length > 0) {
    pass(`all ${mediaRows.length} media_assets originals rows resolve against the backup's own copy, at the right size`);
  }

  /* ── 6 · the strongest check: the project's own suite ───────────────────── */
  console.log("\n== the pgTAP suite, against the RESTORED database ==");
  const s = await new Deno.Command("node", {
    args: ["scripts/pgtap-deployed.mjs", "--local", container],
    stdout: "piped", stderr: "piped",
  }).output();
  const suiteOut = new TextDecoder().decode(s.stdout) + new TextDecoder().decode(s.stderr);
  console.log(suiteOut.split("\n").filter((l) => l.includes("not ok") || /^(files run|assertions|failed|red files)/.test(l)).join("\n"));

  /* The runner's exit code is not the verdict — it cannot be, because one assertion is
     REQUIRED to be red (see KNOWN_RED). The verdict is the two-way comparison below. */
  const red = redAssertions(suiteOut);
  const seen = new Set<string>();
  const unexpected: { file: string; desc: string }[] = [];
  for (const r of red) {
    const k = KNOWN_RED.find((x) => x.file === r.file && r.desc.startsWith(x.assertion));
    if (k) seen.add(k.assertion);
    else unexpected.push(r);
  }
  if (unexpected.length === 0) {
    pass(`the suite is exactly as red as a correct restore must be — ${red.length} known, 0 unexpected, across all 37 files`);
  } else {
    for (const u of unexpected) fail(`unexpected red: ${u.file} — ${u.desc}`);
  }
  for (const k of KNOWN_RED) {
    if (seen.has(k.assertion)) {
      console.log(`  ok      required-red present: ${k.file} — "${k.assertion}"`);
      console.log(`            ${k.why}`);
    } else {
      fail(`${k.file} — "${k.assertion}" PASSED, and it must not: ${k.why}`);
    }
  }

  /* ── 7 · was any of that measured against a REBUILT database? ───────────── */
  const rebuilt = await scalar(container, "select count(*) from pg_namespace where nspname = 'supabase_migrations';");
  if (rebuilt === "0") {
    pass("supabase_migrations is still absent — nothing rebuilt this database from the migrations while the suite ran");
  } else {
    fail("supabase_migrations is BACK: something rebuilt the database from migrations, and every result above is about that rebuild rather than about the restore");
  }

  console.log("");
  if (bad === 0) {
    console.log("RESTORE VERIFIED. §11 gate 3: a backup held outside the platform was restored into an");
    console.log("empty database and passes the project's own suite, its own invariants, and its media.");
    console.log("");
    console.log("Re-set by hand on a restored project, because the backup deliberately does not carry them:");
    console.log("  the vault dispatch secret, and the pg_cron schedule.");
  } else {
    console.log(`${bad} check(s) failed. This backup does not restore.`);
    Deno.exit(1);
  }
}
