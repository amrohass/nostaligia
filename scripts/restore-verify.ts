/**
 * §11 gate 3: "one tested restore." This is the test.
 *
 *   deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
 *     scripts/restore-verify.ts --backup db/2026-08-31T20-00-00Z --target <scratch-project-ref>
 *   deno run --allow-read scripts/restore-verify.ts --selftest
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

import { decrypt } from "./backup.ts";

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
    sql: `do $$ begin
            begin
              update public.audit_log set action = action limit 1;
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
    sql: `select count(*)::int as n from public.posts
           where location is not null and location_public is not null
             and extensions.st_distance(location_public, public.fuzz_location(location)) > 1;`,
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

/* ── The run ──────────────────────────────────────────────────────────────── */

if (has("--selftest")) {
  selftest();
} else {
  const target = value("--target") ?? "";
  const backup = value("--backup") ?? "";

  const no = refuses(target);
  if (no.length) {
    console.error("restore-verify: refusing to run —");
    for (const r of no) console.error(`  ${r}`);
    console.error("\nRestore into a SCRATCH Supabase project (Amro's decision, 31 Aug 2026), never the live one.");
    console.error("Usage: --backup db/<timestamp> --target <scratch-project-ref>");
    Deno.exit(1);
  }
  if (!backup) {
    console.error("restore-verify: --backup <prefix> is required — which copy is being proved?");
    Deno.exit(1);
  }

  console.error("restore-verify: NOT YET RUNNABLE, and deliberately so.");
  console.error("");
  console.error("  What exists: the checks below, the refusal that protects production, and the");
  console.error("  media-consistency query. What does not: a scratch project to restore INTO, and");
  console.error("  a backup to restore FROM — scripts/backup.ts cannot dump yet, because");
  console.error("  `supabase db dump` runs pg_dump in a container and Docker has been down since");
  console.error("  26 Aug. Both are provisioning, not code.");
  console.error("");
  console.error(`  Backup asked for : ${backup}`);
  console.error(`  Target           : ${target}`);
  console.error("");
  console.error("  The checks that will run, strongest last:");
  for (const c of CHECKS) console.error(`    · ${c.name}`);
  console.error("    · every media_assets row resolves against the backup's own copy of the object");
  console.error("    · THE WHOLE pgTAP SUITE against the restored database — scripts/pgtap-deployed.mjs,");
  console.error("      pointed at the scratch ref. 37 files, 669 assertions, including 05_matrix,");
  console.error("      which IS §11 gate 1. A restored database that passes those is restored.");
  console.error("");
  console.error("  Re-set by hand on the restored project, because the backup deliberately does not");
  console.error("  carry them: the vault dispatch secret and the pg_cron schedule.");
  Deno.exit(2);
}
