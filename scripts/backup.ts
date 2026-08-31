/**
 * The self-held backup. §11 gate 3: "one tested restore ... from a backup you hold yourself."
 *
 *   deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/backup.ts --dry-run
 *   deno run ... scripts/backup.ts                       # a real run
 *   deno run ... scripts/backup.ts --pin pre-launch      # a copy nothing will ever prune
 *   deno run --allow-read --allow-write scripts/backup.ts --selftest   # crypto and refusals
 *
 * ── The three decisions this implements (Amro, 31 Aug 2026) ──
 *
 *   destination  a second R2 bucket under a DIFFERENT Cloudflare account;
 *   cadence      weekly full database, INCREMENTAL originals, plus snapshots pinned forever
 *                at pre-launch and immediately after the seed import;
 *   restore into a scratch Supabase project (scripts/restore-verify.ts) — which restores
 *                into a LOCAL container today, because the scratch project is not provisioned
 *                and a container cannot be mistaken for a hosted one.
 *
 * "A different account" is enforced, not trusted: a destination whose account id equals the
 * source's is refused by name. A backup inside the blast radius of the thing it is backing up
 * is the failure mode this decision exists to avoid, and a typo in an env file is exactly how
 * it would happen.
 *
 * ── Why six dumps and not one ────────────────────────────────
 *
 * `supabase db dump` excludes the `auth` schema's STRUCTURE by default, and a restore that
 * loses it gives a `posts` table whose every `created_by` points at a user that does not
 * exist and a `user_roles` table — where §4's authorization actually lives — keyed to nobody.
 * It looks like a successful restore. So: schema, public data, auth data, roles, and the two
 * catalogue reconstructions below that pg_dump does not fully cover.
 *
 * Measured 1 Sep 2026 while running the restore: `--data-only` WITHOUT `--schema` already
 * carries the auth schema's ROWS, so `data.sql` and `auth.sql` overlap and loading both is a
 * primary-key collision on every account. `auth.sql` is kept because that is the CLI's
 * behaviour rather than a promise; restore-verify.ts loads it only when it is the thing that
 * was missing.
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

/**
 * `--to-dir <path>` — the SELF-HELD copy, on a disk rather than in the second account.
 *
 * The standing decision (Amro, 31 Aug 2026) is a second R2 bucket under a different
 * Cloudflare account, and that is still the destination this script is for. This flag does
 * not replace it and does not soften the different-account refusal, which still applies to
 * every R2 run.
 *
 * It exists because §11 gate 3 says "one tested restore ... from a backup you hold
 * yourself", and the second account is not provisioned — so without a sink that needs no
 * credentials, the gate stays blocked on an account signup rather than on anything about
 * this system. A local encrypted copy IS a backup you hold yourself; it is a weaker one
 * (same building, same disk) and the manifest records which kind it was so a restore can
 * never mistake one for the other.
 *
 * The bytes are encrypted exactly as the R2 path encrypts them, read back off the disk and
 * DECRYPTED before the run reports success — same passphrase, same proof, same refusals.
 */
const TO_DIR = value("--to-dir");

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

/* ── Where a backup is WRITTEN ────────────────────────────────────────────── */

/**
 * The destination, behind three methods, so the incremental copy and the read-back-and-
 * decrypt below are written once and hold for both kinds of copy.
 *
 * `present` is deliberately a SIZE comparison and not an etag one: R2 computes a multipart
 * etag differently from a single PUT, so an etag comparison would re-copy every large master
 * on every run, for ever.
 */
interface Sink {
  /** What this is, in the manifest and in the log. A restore must never have to guess. */
  readonly kind: "r2" | "dir";
  readonly where: string;
  put(key: string, body: Uint8Array<ArrayBuffer>): Promise<void>;
  get(key: string): Promise<Uint8Array<ArrayBuffer>>;
  present(key: string, bytes: number): Promise<boolean>;
}

function r2Sink(a: Account): Sink {
  return {
    kind: "r2",
    where: `${a.accountId}/${a.bucket}`,
    async put(key, body) {
      const res = await r2(a, key, "PUT", body);
      if (!res.ok) throw new Error(`PUT ${key} → ${res.status}`);
    },
    async get(key) {
      const res = await r2(a, key, "GET");
      if (!res.ok) throw new Error(`GET ${key} → ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
    async present(key, bytes) {
      const res = await r2(a, key, "HEAD");
      if (!res.ok) return false;
      return Number(res.headers.get("content-length") ?? "-1") === bytes;
    },
  };
}

function dirSink(dir: string): Sink {
  const path = (key: string) => `${dir}/${key}`;
  return {
    kind: "dir",
    where: dir,
    async put(key, body) {
      const p = path(key);
      await Deno.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      await Deno.writeFile(p, body);
    },
    get: (key) => Deno.readFile(path(key)) as Promise<Uint8Array<ArrayBuffer>>,
    async present(key, bytes) {
      try { return (await Deno.stat(path(key))).size === bytes; } catch { return false; }
    },
  };
}

/**
 * Reasons a `--to-dir` path must not be written to. Empty means it may be.
 *
 * The dumps carry member email addresses (§7). They are encrypted, but a directory inside
 * the working tree is one `git add -A` away from being committed, and the whole point of §6
 * is that the thing which must not happen is made impossible rather than remembered. So a
 * destination inside the repository is refused by name.
 */
export function refusesDir(dir: string, repoRoot: string): string[] {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const d = norm(dir);
  const r = norm(repoRoot);
  const out: string[] = [];
  if (!d) out.push("--to-dir was given an empty path");
  if (d && (d === r || d.startsWith(`${r}/`))) {
    out.push(`--to-dir is inside the repository (${repoRoot}) — encrypted member data must not sit in the working tree`);
  }
  return out;
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
    /* ── The fifth dump — CORRECTED 1 Sep 2026, and the correction is the point ──
     *
     * This was written on the finding that "`supabase db dump` DOES NOT EMIT TRIGGERS":
     * 46 non-internal triggers in the catalogue, and the string "CREATE TRIGGER" appearing
     * exactly zero times in the 206 KB schema dump.
     *
     * **The count was right and the conclusion was wrong.** pg_dump emits every one of the
     * 46 — as `CREATE OR REPLACE TRIGGER`, fully schema-qualified. "CREATE TRIGGER" is
     * genuinely absent from the file because that is not the spelling it uses. The measurement
     * looked for one literal string and read its absence as the absence of the thing.
     *
     * It was found the only way it could be: by running a restore. The trigger dump loaded
     * after the schema dump and collided on its first statement — `trigger
     * "audit_log_no_truncate" for relation "audit_log" already exists` — because the schema
     * dump had already created all 46. Nothing short of an actual restore would have said so.
     *
     * The dump is KEPT, for one reason that is not sentiment: it is a reconstruction from
     * `pg_get_triggerdef()`, so it is the copy that still holds if a future CLI or pg_dump
     * version stops emitting triggers the way this one does. It costs 7 KB. What changed is
     * that it is now INSURANCE rather than the load-bearing part, restore-verify.ts rewrites
     * it to `CREATE OR REPLACE TRIGGER` so loading it beside the schema is a no-op, and the
     * completeness check above counts both spellings so the schema dump's own triggers are
     * actually verified.
     *
     * Why it was ever worth this much attention: nearly every invariant in this project IS a
     * trigger — `audit_log_no_update_or_delete` (§3), `comments_bidi_strip` (§1's only filter
     * between a hostile string and a shard), `posts_stamp_authorship` (§5), `provision_profile`
     * (§7), every `*_bump_content_*` the publisher runs on. A restore missing them has every
     * row, every policy, every grant and every function, errors nowhere, and enforces nothing.
     */
    name: "triggers.sql",
    why: "triggers on public AND auth — the auth one is in no other dump, and §7's mandatory handle is it",
    /* ── `auth` is in this filter and the omission was a real hole ──
     *
     * `users_provision_profile` is an AFTER INSERT trigger on `auth.users` (0057) and it is
     * §7's "handle is mandatory" — the thing that gives every new account a profile. The
     * schema dump excludes the auth schema, and the first version of this query said
     * `nspname = 'public'`, so it was in NEITHER file. A restore therefore came back with
     * every account, every profile row, and no way for the NEXT account to get one.
     *
     * Found by `35_provision_profile` going 9-of-12 red against a restored database — which
     * is the whole argument for running the project's own suite rather than counting rows.
     *
     * `public` and `auth` only, deliberately: the other non-internal triggers on a Supabase
     * database live in `cron`, `realtime` and `storage`, belong to the platform rather than
     * to this archive, and a scratch project has its own.
     */
    sql: `select coalesce(string_agg(pg_get_triggerdef(t.oid) || ';', chr(10)
                  order by n.nspname, c.relname, t.tgname), '') as sql
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('public', 'auth') and not t.tgisinternal;`,
  },
  {
    /* ── The sixth dump: EXECUTE grants, reconstructed from the catalogue ──
     *
     * `supabase db dump` emits REVOKE/GRANT for 74 of the 77 functions in `public`. The three
     * it omits are exactly the three whose signature names a type in the `extensions` schema
     * — `fuzz_location`, `justified_precision`, `place_public`, all of which take an
     * `extensions.geography`. Their CREATE statements are dumped in full; only their
     * privileges are dropped.
     *
     * The consequence is not cosmetic. A function with no ACL statement comes back with
     * PostgreSQL's default, which is EXECUTE to PUBLIC — so a restored database hands `anon`
     * three functions the migrations deliberately revoked. `16_function_grants` is the test
     * that says so, and it went red on the first real restore.
     *
     * §4 puts authorization in RLS policies and grants, and §5 says the browser is hostile.
     * A backup that restores the data and loosens the authorization surface is the shape of
     * failure this project cares most about, so the grants are reconstructed from
     * `pg_proc.proacl` the same way the triggers are reconstructed from the catalogue.
     * REVOKE first, then one GRANT per grantee, ordered so a function's revoke always
     * precedes its grants.
     */
    name: "function_acl.sql",
    why: "EXECUTE grants for all functions — the dump omits them for any function taking an extensions type",
    sql: `with f as (
            select p.oid, p.proacl,
                   format('%s.%s(%s)', quote_ident(n.nspname), quote_ident(p.proname),
                          pg_get_function_identity_arguments(p.oid)) as sig
              from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proacl is not null
          ),
          stmts as (
            select sig, 0 as ord, 'REVOKE ALL ON FUNCTION ' || sig || ' FROM PUBLIC;' as stmt from f
            union all
            select f.sig, 1,
                   'GRANT EXECUTE ON FUNCTION ' || f.sig || ' TO ' ||
                   case when a.grantee = 0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end || ';'
              from f, lateral aclexplode(f.proacl) a
             where a.privilege_type = 'EXECUTE'
          )
          select coalesce(string_agg(stmt, chr(10) order by sig, ord, stmt), '') as sql from stmts;`,
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
  /* `CREATE OR REPLACE TRIGGER` is the form pg_dump actually emits, and the first version of
     this pattern did not match it — which is the whole reason the fifth dump below was
     believed to be load-bearing. Both forms are counted now: the catalogue's own
     `pg_get_triggerdef()` emits the plain one, pg_dump the replace one. */
  { what: "triggers", pattern: /^CREATE (OR REPLACE )?(CONSTRAINT )?TRIGGER/gim, sql: `select count(*)::int as n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace ns on ns.oid=c.relnamespace where ns.nspname in ('public','auth') and not t.tgisinternal` },
  /* Every function's EXECUTE grants have to appear SOMEWHERE across the dumps — in the schema
     dump for most, in function_acl.sql for the three the schema dump silently omits. Counting
     REVOKE lines against functions-with-an-ACL is what would have caught that omission
     without a restore. */
  { what: "fn grants", pattern: /^REVOKE ALL ON FUNCTION/gim, sql: `select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public' and p.proacl is not null` },
];

/**
 * The one thing the EXECUTE reconstruction above cannot carry: a grant made WITH GRANT OPTION.
 *
 * `aclexplode` reports it, and the emitted `GRANT EXECUTE … TO role` does not reproduce it —
 * so rather than restore a quietly narrower privilege than the archive has, this refuses. No
 * function in this schema uses one today; the refusal is here so that the day one does, the
 * backup says so instead of losing it.
 */
async function grantOptionCaveats(): Promise<number> {
  return await count(`select count(*)::int as n
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace,
     lateral aclexplode(p.proacl) a
    where ns.nspname = 'public' and p.proacl is not null
      and a.privilege_type = 'EXECUTE' and a.is_grantable`);
}

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

  // The --to-dir refusal. The dumps are encrypted, but a directory in the working tree is one
  // `git add -A` from being committed, and §6's posture is to make that impossible.
  const repo = "C:/repo/RAMALLAH MEMORY";
  ok(refusesDir(`${repo}/backups`, repo).length > 0, "a --to-dir inside the repository is refused");
  ok(refusesDir(repo, repo).length > 0, "and so is the repository root itself");
  ok(refusesDir(`${repo}\\docs\\x`, repo).length > 0, "backslashes do not get past it — this runs on Windows");
  ok(refusesDir("", repo).length > 0, "an empty --to-dir is refused rather than treated as the cwd");
  ok(refusesDir("C:/Temp/rma-backup", repo).length === 0,
     "CONTROL: a path outside the repository is accepted — the refusal discriminates");
  ok(refusesDir(`${repo}-elsewhere/x`, repo).length === 0,
     "CONTROL: a sibling whose name merely STARTS with the repo path is not inside it");

  // The dir sink round-trips the same bytes the R2 sink would, under the same encryption.
  const tmp = await Deno.makeTempDir();
  try {
    const s = dirSink(tmp);
    const key = "db/2026-09-01T00-00-00Z/schema.sql.enc";
    await s.put(key, await encrypt(plain, "correct horse"));
    ok(await s.present(key, (await Deno.stat(`${tmp}/${key}`)).size),
       "the dir sink reports an object it has just written as present, at its size");
    ok(!(await s.present(key, 1)), "CONTROL: and not at the wrong size — present() compares bytes, not existence");
    ok(!(await s.present("db/nothing/here.enc", 0)), "CONTROL: an object it does not have is absent rather than an exception");
    const round = await decrypt(await s.get(key), "correct horse");
    ok(new TextDecoder().decode(round) === new TextDecoder().decode(plain),
       "and what comes off the disk decrypts to the bytes that went in — the same read-back the R2 path does");
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }

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

  const destReady = TO_DIR || (destination.accountId && destination.accessKeyId && destination.secretAccessKey && destination.bucket);
  if (!DRY && !destReady) {
    console.error("backup: the destination is not configured. Put these in supabase/functions/.backup.vars (git-ignored) or the environment:");
    console.error("  BACKUP_R2_ACCOUNT_ID, BACKUP_R2_ACCESS_KEY_ID, BACKUP_R2_SECRET_ACCESS_KEY, BACKUP_R2_BUCKET, BACKUP_PASSPHRASE");
    console.error("  The account MUST be a different Cloudflare account from the archive's — that is the decision this implements,");
    console.error("  and it is checked rather than trusted.");
    console.error("  Or --to-dir <path> for the self-held copy on a disk you hold (§11 gate 3), which needs no account.");
    console.error("\nRun with --dry-run to exercise everything except the destination writes.");
    Deno.exit(1);
  }
  if (!DRY && !passphrase) {
    console.error("backup: BACKUP_PASSPHRASE is not set. The dumps carry member email addresses and are not written in clear.");
    Deno.exit(1);
  }
  /* The different-account rule governs the R2 destination and only it — a `--to-dir` copy
     has no account to compare, and pretending otherwise would either block it or quietly
     weaken the check for everybody. */
  if (!DRY && !TO_DIR && sameAccount(source, destination)) {
    console.error("backup: the destination R2 account id is the SAME as the archive's. Refusing.");
    console.error("  A backup inside the blast radius of the thing it backs up is not a backup.");
    Deno.exit(1);
  }
  if (TO_DIR) {
    const no = refusesDir(TO_DIR, Deno.cwd());
    if (no.length) {
      console.error("backup: refusing the --to-dir destination —");
      for (const r of no) console.error(`  ${r}`);
      Deno.exit(1);
    }
  }

  const sink: Sink = TO_DIR ? dirSink(TO_DIR) : r2Sink(destination);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const root = PIN ? `pinned/${PIN}` : `db/${stamp}`;
  console.log(`\nbackup ${DRY ? "(DRY RUN — nothing will be written)" : ""}`);
  console.log(`  destination       : ${sink.kind === "dir" ? `LOCAL DIRECTORY ${sink.where} — a weaker copy than the second account, and the manifest says so` : sink.where}`);
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
    await sink.put(key, blob);

    /* Read it back and DECRYPT it, before this run is called a success. A passphrase that
       does not work is then found today rather than on the day of the restore, which is the
       only day it matters and the worst day to find out. */
    const round = await decrypt(await sink.get(key), passphrase);
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

    const grantable = await grantOptionCaveats();
    if (grantable > 0) {
      console.log(`\n  ${grantable} EXECUTE grant(s) carry WITH GRANT OPTION, which function_acl.sql cannot reproduce.`);
      if (!DRY) {
        console.error("backup: refusing to store a dump that would restore a narrower privilege than the archive has.");
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
    if (!DRY && await sink.present(dkey, actual)) { skipped++; continue; }
    bytes += actual;
    if (DRY) { copied++; continue; }

    const body = await r2(source, key, "GET");
    if (!body.ok) throw new Error(`GET originals/${key} → ${body.status}`);
    await sink.put(dkey, new Uint8Array(await body.arrayBuffer()));
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
    /* Which KIND of copy this is. A local directory and a second Cloudflare account are not
       equally good backups, and a restore that cannot tell them apart will one day report
       a discharged gate over a copy that was sitting on the same disk as the thing it backs
       up. So it is recorded rather than inferred from the path. */
    destination: { kind: sink.kind, where: sink.where },
    originals_prefix: "originals/",
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
    await sink.put(`${root}/manifest.json`, new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
  }

  console.log(DRY
    ? "\nDRY RUN. Nothing was written. Configure the destination and re-run to make it real."
    : "\nDone. Now prove it: deno run ... scripts/restore-verify.ts");
}
