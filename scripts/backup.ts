/**
 * The self-held backup. §11 gate 3: "one tested restore ... from a backup you hold yourself."
 *
 *   deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/backup.ts --dry-run
 *   deno run ... scripts/backup.ts                       # a real run
 *   deno run ... scripts/backup.ts --pin pre-launch      # a copy nothing will ever prune
 *   deno run --allow-read scripts/backup.ts --selftest   # the crypto and the refusals
 *
 * ── The three decisions this implements (Amro, 31 Aug 2026) ──
 *
 *   destination  a second R2 bucket under a DIFFERENT Cloudflare account;
 *   cadence      weekly full database, INCREMENTAL originals, plus snapshots pinned forever
 *                at pre-launch and immediately after the seed import;
 *   restore into a scratch Supabase project (scripts/restore-verify.ts).
 *
 * "A different account" is enforced, not trusted: a destination whose account id equals the
 * source's is refused by name. A backup inside the blast radius of the thing it is backing up
 * is the failure mode this decision exists to avoid, and a typo in an env file is exactly how
 * it would happen.
 *
 * ── Why three dumps and not one ──────────────────────────────
 *
 * `supabase db dump` excludes the `auth` schema by default. A restore from a default dump
 * gives a `posts` table whose every `created_by` points at a user that does not exist and a
 * `user_roles` table — where §4's authorization actually lives — keyed to nobody. It looks
 * like a successful restore. So: schema, public data, auth data, and roles.
 *
 * `vault` and `cron` are excluded too and are deliberately NOT dumped: the vault holds the
 * publisher's dispatch secret, and a backup that carries live credentials into a second
 * account has widened the blast radius rather than narrowed it. They are re-set by hand on a
 * restored project, and restore-verify.ts says so rather than leaving it to be discovered.
 *
 * ── What is copied from R2, and what is not ──────────────────
 *
 *   originals/   ALWAYS, incrementally. The only irreplaceable bytes in the system.
 *   basemap      ONCE. 174 MB of the 176 MB `public` bucket, rebuilt from Protomaps about
 *                yearly, so copying it weekly would be ~99% of the transfer for ~0% of the
 *                risk. Skipped when the destination already has it at the same size.
 *   public/      otherwise NOT. Renditions re-derive from originals and the release tree
 *                re-derives from Postgres — but "derivable" is not "free": for 300 items it
 *                is hours of worker time and a real bill. Recorded as an accepted cost, not
 *                waved away.
 *   quarantine/  NEVER. Unvalidated uploads that have not passed magic-byte validation.
 *                Copying them would be copying the one thing §6 refuses to trust.
 *
 * ── Encryption ───────────────────────────────────────────────
 *
 * The database dumps carry member email addresses. §7's "emails are never published" governs
 * publications rather than backups, but it makes encryption of the dumps mandatory rather
 * than advisable — so they are AES-256-GCM, key from PBKDF2-SHA256 over BACKUP_PASSPHRASE,
 * and the script refuses to run without one.
 *
 * **The originals are NOT encrypted by this script, and that is a stated gap rather than an
 * oversight.** A 4 GB master cannot be AES-GCM'd in memory, Web Crypto has no streaming AEAD,
 * and a chunked framing is a file format — inventing one here would put the archive's only
 * irreplaceable bytes behind code nobody has reviewed. They rely on the destination bucket
 * being private and on R2's own encryption at rest. If that is not enough, the answer is
 * `age` or `rclone crypt` in front of this, not a format invented in this file.
 *
 * ── The passphrase is the credential that kills you twice ────
 *
 * Lost, the dumps are landfill. Stored beside the backup, it is not protection. This script
 * cannot solve that, so it does the two things it can: it refuses to run without one, and it
 * DECRYPTS what it just uploaded before reporting success — so a passphrase that does not
 * work is found on the day of the backup rather than the day of the restore.
 */

import { presignR2 } from '../supabase/functions/_shared/sigv4.ts';

/* ── Arguments ────────────────────────────────────────────────────────────── */

const args = Deno.args;
const has = (f: string) => args.includes(f);
const value = (f: string): string | undefined => {
  const i = args.indexOf(f);
  return i === -1 ? undefined : args[i + 1];
};

const DRY = has("--dry-run");
const PIN = value("--pin");

/* ── Env, read from a file rather than exported ───────────────────────────── */

/* Parsed rather than sourced: .dev.vars is a KEY=VALUE file, not a shell script, and
   `export`ing it would put live secrets in this process's environment for anything else to
   read. Values go into locals and are never logged. */
function readVars(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text: string;
  try { text = Deno.readTextFileSync(path); } catch { return out; }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/* Read where they are USED, not at module load, so `--selftest` needs no `--allow-env` and
   never has a live credential in the process at all. A self-test that has to be handed the
   keys is a self-test people stop running. */
const sourceVars = () => readVars("supabase/functions/.dev.vars");
const destVars = () => ({ ...readVars("supabase/functions/.backup.vars"), ...Deno.env.toObject() });

/* ── Encryption ───────────────────────────────────────────────────────────── */

const MAGIC = "RMA-BAK1";           // 8 bytes, so a file that is not one of ours says so
const SALT_BYTES = 16;
const IV_BYTES = 12;
const PBKDF2_ROUNDS = 600_000;      // OWASP's 2023 floor for PBKDF2-SHA256

async function deriveKey(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"],
  );
  return await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * MAGIC ‖ salt ‖ iv ‖ ciphertext.
 *
 * The salt travels with the file on purpose — it is not a secret, and a salt kept anywhere
 * else is one more thing to lose. A fresh salt AND a fresh iv per file, so two dumps of the
 * same database under the same passphrase share no key material.
 */
export async function encrypt(plain: Uint8Array<ArrayBuffer>, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const magic = new TextEncoder().encode(MAGIC);

  const out = new Uint8Array(magic.length + salt.length + iv.length + ct.length);
  out.set(magic, 0);
  out.set(salt, magic.length);
  out.set(iv, magic.length + salt.length);
  out.set(ct, magic.length + salt.length + iv.length);
  return out;
}

export async function decrypt(blob: Uint8Array<ArrayBuffer>, passphrase: string): Promise<Uint8Array<ArrayBuffer>> {
  const magic = new TextDecoder().decode(blob.slice(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error(`not a backup file — header is ${JSON.stringify(magic)}`);
  const salt = blob.slice(MAGIC.length, MAGIC.length + SALT_BYTES);
  const iv = blob.slice(MAGIC.length + SALT_BYTES, MAGIC.length + SALT_BYTES + IV_BYTES);
  const ct = blob.slice(MAGIC.length + SALT_BYTES + IV_BYTES);
  const key = await deriveKey(passphrase, salt);
  // AES-GCM authenticates: a wrong passphrase throws here rather than returning rubbish,
  // which is what makes the verify-after-upload below meaningful.
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

/* ── R2 ───────────────────────────────────────────────────────────────────── */

interface Account { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; prefix: string }

async function r2(a: Account, key: string, method: "GET" | "HEAD" | "PUT", body?: Uint8Array<ArrayBuffer>): Promise<Response> {
  const p = await presignR2({
    accountId: a.accountId,
    accessKeyId: a.accessKeyId,
    secretAccessKey: a.secretAccessKey,
    bucket: a.bucket,
    key,
    method,
    expiresIn: 3600,
    bucketPrefix: a.prefix,
  });
  return await fetch(p.url, { method, body: body as BodyInit | undefined });
}

/**
 * What `originals/` should contain, taken from the DATABASE rather than from a bucket listing.
 *
 * Not a stylistic choice. `presignR2` signs one object, and S3's ListObjectsV2 puts its
 * parameters in the QUERY STRING, which is inside the SigV4 canonical request — so listing
 * would mean either widening a shared crypto module that production Edge Functions depend on,
 * or writing a second signer here. Neither is worth it when a better answer exists.
 *
 * And it IS better. `media_assets` is what the archive believes it has; the bucket is what it
 * actually has. Backing up from the database means the backup covers exactly what the restored
 * database will reference, and the two lists can be COMPARED — an object the database names
 * and the bucket does not have is a broken archive, and it is found here instead of on the day
 * of the restore. A bucket listing cannot notice that, because it only ever sees what is there.
 */
async function originalsFromDatabase(): Promise<Map<string, number>> {
  const sql = `select storage_path, bytes from public.media_assets where bucket = 'originals' order by storage_path;`;
  const file = await Deno.makeTempFile({ suffix: ".sql" });
  await Deno.writeTextFile(file, sql);
  try {
    const { code, stdout, stderr } = await new Deno.Command("npx", {
      args: ["supabase", "db", "query", "--linked", "-f", file],
      stdout: "piped", stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(stdout);
    if (code !== 0) throw new Error(`media_assets query exited ${code}\n${new TextDecoder().decode(stderr)}`);
    const json = /\{[\s\S]*\}/.exec(text);
    if (!json) throw new Error(`media_assets query returned nothing parseable:\n${text.slice(0, 400)}`);
    const rows = JSON.parse(json[0]).rows as { storage_path: string; bytes: number }[];
    return new Map(rows.map((r) => [r.storage_path, Number(r.bytes)]));
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

/** Does the destination already hold this object, at this size? */
async function presentAt(a: Account, key: string, bytes: number): Promise<boolean> {
  const res = await r2(a, key, "HEAD");
  if (!res.ok) return false;
  // Size, not etag: R2 computes a multipart etag differently from a single PUT, so an etag
  // comparison would re-copy every large master on every run, for ever.
  return Number(res.headers.get("content-length") ?? "-1") === bytes;
}

/* ── The database ─────────────────────────────────────────────────────────── */

/**
 * Four dumps, and each is named for what a restore would be missing without it.
 *
 * `--linked` rather than a connection string: the CLI mints its own temporary login role, so
 * a dump from a logged-in machine needs no database password at all. Headless in CI it would
 * need one, or an access token that can manage the entire project — which is a security
 * decision rather than a convenience one, and is why this is a script a person runs.
 */
interface Dump { name: string; why: string; args?: string[]; sql?: string }

const DUMPS: Dump[] = [
  { name: "schema.sql", args: ["db", "dump", "--linked"], why: "public schema" },
  { name: "data.sql", args: ["db", "dump", "--linked", "--data-only"], why: "public data" },
  { name: "auth.sql", args: ["db", "dump", "--linked", "--data-only", "--schema", "auth"], why: "auth.users — WITHOUT THIS every created_by points at nobody" },
  { name: "roles.sql", args: ["db", "dump", "--linked", "--role-only"], why: "database roles" },
  {
    /* ── The fourth dump, and it is not paranoia ──────────────
     *
     * `supabase db dump` DOES NOT EMIT TRIGGERS. Measured 1 Sep 2026 against the deployed
     * database: 46 non-internal triggers on `public` tables, and the 206 KB schema dump
     * contains the string "CREATE TRIGGER" exactly zero times. Everything else matches to
     * the object — 18 tables of 18, 27 policies of 27, 77 functions of 77, 16 enums of 16.
     * The trigger FUNCTIONS are all there. Only the bindings are gone.
     *
     * For this project that is the difference between a backup and a souvenir, because
     * nearly every invariant here IS a trigger:
     *
     *   audit_log_no_update_or_delete   §3's "audit rows are permanent"
     *   comments_bidi_strip             §1: the ONLY filter between a hostile string and a shard
     *   posts_stamp_authorship          §5's edit-after-approval reset
     *   provision_profile               §7's mandatory handle, on every new account
     *   *_bump_content_*                the publisher's trigger, so nothing would ever publish
     *
     * A restore without these has every row, every policy, every grant and every function.
     * It errors nowhere. And its audit log is editable, its comments are unfiltered, and an
     * approved post can be edited without falling back to pending.
     *
     * pg_get_triggerdef() emits exactly the CREATE TRIGGER that made each one, so this is a
     * reconstruction from the catalogue rather than a hand-written list that would drift the
     * first time somebody adds a trigger.
     */
    name: "triggers.sql",
    why: "46 triggers `supabase db dump` does not emit — §3, §5, §7 and the publisher all live in these",
    sql: `select coalesce(string_agg(pg_get_triggerdef(t.oid) || ';', chr(10)
                  order by c.relname, t.tgname), '') as sql
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not t.tgisinternal;`,
  },
];

/** Runs one statement through the CLI and returns the single text column it selects. */
async function queryText(sql: string): Promise<string> {
  const file = await Deno.makeTempFile({ suffix: ".sql" });
  await Deno.writeTextFile(file, sql);
  try {
    const { code, stdout, stderr } = await new Deno.Command("npx", {
      args: ["supabase", "db", "query", "--linked", "-f", file],
      stdout: "piped", stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(stdout);
    if (code !== 0) throw new Error(`query exited ${code}: ${new TextDecoder().decode(stderr)}`);
    const json = /\{[\s\S]*\}/.exec(text);
    if (!json) throw new Error(`query returned nothing parseable: ${text.slice(0, 300)}`);
    return String(JSON.parse(json[0]).rows?.[0]?.sql ?? "");
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

async function dump(d: Dump): Promise<Uint8Array<ArrayBuffer>> {
  if (d.sql) {
    const text = await queryText(d.sql);
    if (!text.trim()) throw new Error(`${d.name}: came back empty — refusing to store it`);
    return new TextEncoder().encode(text);
  }
  const cmd = new Deno.Command("npx", {
    args: ["supabase", ...(d.args ?? [])],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(`${d.name}: supabase ${(d.args ?? []).join(" ")} exited ${code}: ${new TextDecoder().decode(stderr)}`);
  }
  // The CLI prints progress to stderr and SQL to stdout, so stdout is the artefact. A dump
  // that came back empty is a failure, not an empty database: `db dump` always emits at
  // least a header.
  if (stdout.length < 64) throw new Error(`${d.name}: dump is ${stdout.length} bytes — refusing to store it`);
  return stdout;
}

/**
 * Does what came out actually contain the database?
 *
 * The trigger gap above was found by counting, not by reading, and it would have been found
 * on the day of the restore otherwise. So the counting is now part of the job: ask the
 * catalogue how many of each object there are, count them in the dump text, and report every
 * mismatch. It is cheap, it is exhaustive over the object kinds that matter, and it is the
 * only thing standing between "the dump ran" and "the dump is the database".
 *
 * Indexes are deliberately absent: half of them are PRIMARY KEY and UNIQUE constraints, which
 * pg_dump emits as ALTER TABLE ... ADD CONSTRAINT rather than CREATE INDEX, so a count
 * comparison would report a mismatch on a correct dump — and a check that cries wolf is a
 * check that gets removed.
 */
const COMPLETENESS = [
  { what: "tables", pattern: /^CREATE TABLE/gim, sql: `select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and c.relkind='r'` },
  { what: "policies", pattern: /^CREATE POLICY/gim, sql: `select count(*)::int as n from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public'` },
  { what: "functions", pattern: /^CREATE OR REPLACE FUNCTION/gim, sql: `select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public'` },
  { what: "enums", pattern: /^CREATE TYPE/gim, sql: `select count(*)::int as n from pg_type t join pg_namespace ns on ns.oid=t.typnamespace where ns.nspname='public' and t.typtype='e'` },
  { what: "triggers", pattern: /^CREATE (CONSTRAINT )?TRIGGER/gim, sql: `select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname='public' and not t.tgisinternal` },
];

async function completeness(allSql: string): Promise<{ what: string; expected: number; found: number }[]> {
  const out: { what: string; expected: number; found: number }[] = [];
  for (const c of COMPLETENESS) {
    out.push({
      what: c.what,
      expected: await count(c.sql),
      found: (allSql.match(c.pattern) ?? []).length,
    });
  }
  return out;
}

/** The counting queries select `n`, so they need their own reader. */
async function count(sql: string): Promise<number> {
  const file = await Deno.makeTempFile({ suffix: ".sql" });
  await Deno.writeTextFile(file, `${sql};`);
  try {
    const { stdout } = await new Deno.Command("npx", {
      args: ["supabase", "db", "query", "--linked", "-f", file],
      stdout: "piped", stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(stdout);
    const json = /\{[\s\S]*\}/.exec(text);
    return json ? Number(JSON.parse(json[0]).rows?.[0]?.n ?? 0) : 0;
  } finally {
    await Deno.remove(file).catch(() => {});
  }
}

/* ── Self-test ────────────────────────────────────────────────────────────── */

async function selftest() {
  let passed = 0, failed = 0;
  const ok = (c: boolean, name: string) => {
    if (c) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
    else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
  };

  const plain = new TextEncoder().encode("-- a dump with an email in it: someone@example.com\n");

  const blob = await encrypt(plain, "correct horse");
  ok(!new TextDecoder().decode(blob).includes("someone@example.com"),
     "the plaintext is not in the ciphertext");
  ok(new TextDecoder().decode(blob.slice(0, 8)) === MAGIC,
     "and the file says what it is, so a wrong file is not mistaken for a wrong passphrase");

  const back = await decrypt(blob, "correct horse");
  ok(new TextDecoder().decode(back) === new TextDecoder().decode(plain),
     "CONTROL: the right passphrase returns the bytes exactly");

  let threw = false;
  try { await decrypt(blob, "correct horse "); } catch { threw = true; }
  ok(threw, "a passphrase one space out throws rather than returning rubbish — AES-GCM authenticates");

  threw = false;
  try { await decrypt(new TextEncoder().encode("PK not ours at all"), "correct horse"); } catch { threw = true; }
  ok(threw, "a file that is not a backup is refused by its header");

  const a = await encrypt(plain, "correct horse");
  const b = await encrypt(plain, "correct horse");
  ok(new TextDecoder().decode(a) !== new TextDecoder().decode(b),
     "two encryptions of the same bytes differ — a fresh salt and iv each time");

  // The refusal that keeps the backup out of the blast radius.
  ok(sameAccount({ accountId: "abc" } as Account, { accountId: "abc" } as Account),
     "a destination in the SAME account is detected");
  ok(!sameAccount({ accountId: "abc" } as Account, { accountId: "def" } as Account),
     "CONTROL: a different account is not");

  console.log(`\n1..${passed + failed}`);
  if (failed) { console.log(`${failed} assertion(s) failed.`); Deno.exit(1); }
  console.log(`All ${passed} assertions passed.`);
}

function sameAccount(a: Account, b: Account): boolean {
  return a.accountId.trim().toLowerCase() === b.accountId.trim().toLowerCase();
}

/* ── The run ──────────────────────────────────────────────────────────────── */

/* `import.meta.main`, and it is not boilerplate.
 *
 * This file EXPORTS encrypt/decrypt, so restore-verify.ts imports it — and a module body runs
 * on import. Without this guard, the moment anything imports `decrypt` and actually uses it,
 * running the RESTORE verifier would fall into the else-branch below and start taking a
 * BACKUP: dumping the database and writing to R2, because the importing script's argv happens
 * not to contain `--selftest`.
 *
 * It is currently invisible: `decrypt` is imported by restore-verify.ts and not yet called, so
 * TypeScript elides the import and this file never loads. That is the worst kind of latent —
 * the bug arrives with the line that finishes the restore, and looks nothing like its cause.
 */
if (!import.meta.main) {
  // imported for encrypt/decrypt; nothing below is this module's business
} else if (has("--selftest")) {
  await selftest();
} else {
  const src = sourceVars();
  const dst = destVars();
  const missing: string[] = [];
  const need = (o: Record<string, string>, k: string) => { if (!o[k]) missing.push(k); return o[k] ?? ""; };

  const source: Account = {
    accountId: need(src, "R2_ACCOUNT_ID"),
    accessKeyId: need(src, "R2_ACCESS_KEY_ID"),
    secretAccessKey: need(src, "R2_SECRET_ACCESS_KEY"),
    bucket: "originals",
    prefix: src.R2_BUCKET_PREFIX ?? "",
  };

  const passphrase = dst.BACKUP_PASSPHRASE ?? "";
  const destination: Account = {
    accountId: dst.BACKUP_R2_ACCOUNT_ID ?? "",
    accessKeyId: dst.BACKUP_R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: dst.BACKUP_R2_SECRET_ACCESS_KEY ?? "",
    bucket: dst.BACKUP_R2_BUCKET ?? "",
    prefix: dst.BACKUP_R2_BUCKET_PREFIX ?? "",
  };

  if (missing.length) {
    console.error(`backup: ${missing.join(", ")} missing from supabase/functions/.dev.vars — the SOURCE cannot be read.`);
    Deno.exit(1);
  }

  const destReady = destination.accountId && destination.accessKeyId && destination.secretAccessKey && destination.bucket;
  if (!DRY && !destReady) {
    console.error("backup: the destination is not configured. Put these in supabase/functions/.backup.vars (git-ignored) or the environment:");
    console.error("  BACKUP_R2_ACCOUNT_ID, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY, BACKUP_R2_BUCKET, BACKUP_PASSPHRASE");
    console.error("  The account MUST be a different Cloudflare account from the archive's — that is the decision this implements,");
    console.error("  and it is checked rather than trusted.");
    console.error("\nRun with --dry-run to exercise everything except the destination writes.");
    Deno.exit(1);
  }
  if (!DRY && !passphrase) {
    console.error("backup: BACKUP_PASSPHRASE is not set. The dumps carry member email addresses and are not written in clear.");
    Deno.exit(1);
  }
  if (!DRY && sameAccount(source, destination)) {
    console.error("backup: the destination R2 account id is the SAME as the archive's. Refusing.");
    console.error("  A backup inside the blast radius of the thing it backs up is not a backup.");
    Deno.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const root = PIN ? `pinned/${PIN}` : `db/${stamp}`;
  console.log(`\nbackup ${DRY ? "(DRY RUN — nothing will be written)" : ""}`);
  console.log(`  destination prefix : ${root}`);
  if (PIN) console.log("  PINNED — this copy is never pruned. §11's pre-launch and post-seed-import snapshots live here.");

  /* 1 · the database */
  console.log("\n== database ==");
  const artefacts: { key: string; bytes: number; sha256: string }[] = [];
  const dumpFailures: string[] = [];
  let allSql = "";
  for (const d of DUMPS) {
    let plain: Uint8Array<ArrayBuffer>;
    try {
      plain = await dump(d);
    } catch (e) {
      /* A DRY RUN is a diagnostic, so a dump that cannot run is a FINDING rather than an
         abort — dying on the first one hides everything after it, which on a machine with no
         Docker is the entire rest of the report. A real run still throws: half a backup that
         says it succeeded is the worst outcome available. */
      if (!DRY) throw e;
      // The first line of the message. Split on a code point rather than an escape, because
      // the whole reason this file exists is that things get lost between layers.
      const msg = String((e as Error).message ?? e).split(String.fromCharCode(10))[0];
      dumpFailures.push(`${d.name}: ${msg}`);
      console.log(`  ${d.name.padEnd(12)} ${"CANNOT RUN".padStart(9)}        ${d.why}`);
      continue;
    }
    allSql += new TextDecoder().decode(plain) + String.fromCharCode(10);
    const digest = await crypto.subtle.digest("SHA-256", plain);
    const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = `${root}/${d.name}.enc`;
    console.log(`  ${d.name.padEnd(12)} ${String(plain.length).padStart(9)} bytes  ${d.why}`);

    if (DRY) { artefacts.push({ key, bytes: plain.length, sha256: sha }); continue; }

    const blob = await encrypt(plain, passphrase);
    const put = await r2(destination, key, "PUT", blob);
    if (!put.ok) throw new Error(`PUT ${key} → ${put.status}`);

    /* Read it back and DECRYPT it, before this run is called a success. A passphrase that
       does not work is then found today rather than on the day of the restore, which is the
       only day it matters and the worst day to find out. */
    const got = await r2(destination, key, "GET");
    if (!got.ok) throw new Error(`GET ${key} → ${got.status}`);
    const round = await decrypt(new Uint8Array(await got.arrayBuffer()), passphrase);
    const rd = await crypto.subtle.digest("SHA-256", round);
    const rsha = [...new Uint8Array(rd)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (rsha !== sha) throw new Error(`${key}: what came back does not match what went up`);
    console.log(`               → ${key}  encrypted, re-read and decrypted, sha256 matches`);
    artefacts.push({ key, bytes: plain.length, sha256: sha });
  }

  /* Is what came out actually the database? */
  let gaps: { what: string; expected: number; found: number }[] = [];
  if (!dumpFailures.length) {
    gaps = (await completeness(allSql)).filter((g) => g.found < g.expected);
    console.log("\n  completeness, catalogue vs dump:");
    for (const g of await completeness(allSql)) {
      const mark = g.found < g.expected ? "  <-- MISSING" : "";
      console.log(`    ${g.what.padEnd(10)} ${String(g.expected).padStart(4)} in the database, ${String(g.found).padStart(4)} in the dump${mark}`);
    }
    if (gaps.length) {
      console.log("\n  A dump missing these restores a database that loads cleanly and does not work.");
      if (!DRY) {
        console.error("\nbackup: refusing to store an incomplete dump.");
        Deno.exit(1);
      }
    }
  }

  if (dumpFailures.length) {
    console.log(`\n  ${dumpFailures.length} of ${DUMPS.length} dumps cannot run here:`);
    for (const f of dumpFailures) console.log(`    ${f}`);
    console.log("  `supabase db dump` runs pg_dump inside a container. With no Docker there is no dump,");
    console.log("  and therefore no database backup — §11 gate 3 cannot be discharged until that is fixed.");
  }

  /* 2 · originals, incrementally */
  console.log("\n== originals (incremental) ==");
  const here = await originalsFromDatabase();
  const total = [...here.values()].reduce((a, b) => a + b, 0);
  console.log(`  media_assets names ${here.size} objects in originals/, ${total.toLocaleString()} bytes`);

  let copied = 0, skipped = 0, bytes = 0;
  const orphans: string[] = [];

  for (const [key, size] of here) {
    /* Is it actually there? A row the archive believes in and a bucket that does not have the
       bytes is a broken archive, and this is where it surfaces — a listing-based backup could
       never notice, because it only ever sees what exists. It does not stop the run: the rest
       of the archive is still worth backing up, and a half-backup announced is better than no
       backup because of one bad row. */
    const head = await r2(source, key, "HEAD");
    if (!head.ok) {
      orphans.push(`${key} → HEAD ${head.status}`);
      continue;
    }
    const actual = Number(head.headers.get("content-length") ?? "-1");
    if (actual !== size) orphans.push(`${key} → ${actual} bytes on R2, media_assets says ${size}`);

    const dkey = `originals/${key}`;
    if (!DRY && await presentAt(destination, dkey, actual)) { skipped++; continue; }
    bytes += actual;
    if (DRY) { copied++; continue; }

    const body = await r2(source, key, "GET");
    if (!body.ok) throw new Error(`GET originals/${key} → ${body.status}`);
    const put = await r2(destination, dkey, "PUT", new Uint8Array(await body.arrayBuffer()));
    if (!put.ok) throw new Error(`PUT ${dkey} → ${put.status}`);
    copied++;
  }
  console.log(`  ${DRY ? "would copy" : "copied"} ${copied}, already present ${skipped}, ${bytes.toLocaleString()} bytes`);
  if (orphans.length) {
    console.log(`\n  ${orphans.length} object(s) the DATABASE names and the BUCKET does not match:`);
    for (const o of orphans) console.log(`    ${o}`);
    console.log("  Nothing about the backup fixes this — it is an archive problem, reported here because");
    console.log("  this is the one job that reads both sides.");
  }

  /* 3 · the manifest, so a restore knows what it is looking at */
  const manifest = {
    taken_at: new Date().toISOString(),
    pinned: PIN ?? null,
    source_account: source.accountId,
    dumps: artefacts,
    dumps_that_could_not_run: dumpFailures,
    completeness_gaps: gaps,
    originals: { copied, already_present: skipped, source_objects: here.size, orphans },
    not_backed_up: {
      quarantine: "never — unvalidated uploads (§6)",
      public_renditions: "re-derivable from originals, at hours of worker time",
      basemap: "rebuilt from Protomaps; copy once, out of band",
      vault_and_cron: "live credentials — deliberately not carried into a second account",
    },
  };
  console.log("\n== manifest ==");
  console.log(JSON.stringify(manifest, null, 2));
  if (!DRY) {
    const put = await r2(destination, `${root}/manifest.json`, "PUT", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
    if (!put.ok) throw new Error(`PUT manifest → ${put.status}`);
  }

  console.log(DRY
    ? "\nDRY RUN. Nothing was written. Configure the destination and re-run to make it real."
    : "\nDone. Now prove it: deno run ... scripts/restore-verify.ts");
}
