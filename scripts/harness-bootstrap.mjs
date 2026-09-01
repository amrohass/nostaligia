#!/usr/bin/env node
/* Puts a live refresh token in `.harness.vars` for each harness role.
 *
 *     node scripts/harness-bootstrap.mjs --all
 *     node scripts/harness-bootstrap.mjs --role moderator
 *     node scripts/harness-bootstrap.mjs --paste admin <refresh-token-from-a-browser>
 *     node scripts/harness-bootstrap.mjs --status
 *
 * Read scripts/lib/harness-auth.mjs first — it carries the reasoning for the whole
 * approach and the measurement that justifies it. This file is the mechanism.
 *
 * ── Two ways in, and why both exist ──────────────────────────
 *
 * `--role` / `--all` mints a session through the ADMIN API:
 *
 *     POST /auth/v1/admin/generate_link  {type: magiclink, email}   -> hashed_token
 *     POST /auth/v1/verify               {type: magiclink, token_hash} -> a real session
 *
 * Neither hop is captcha-gated (measured 2 Sep 2026 against the deployed project), and
 * generate_link SENDS NO MAIL — it returns the link rather than mailing it, which matters
 * because the project's send quota answers `over_email_send_rate_limit` after a handful of
 * real signups. It needs the service-role key, which is read from the logged-in Supabase
 * CLI at call time and never written down.
 *
 * `--paste` takes a refresh token a human copied out of a real browser session
 * (devtools → Application → Session Storage → `rma.refresh`). It needs no service-role
 * key at all, and it is the path for anybody who has the browser but not the CLI login.
 *
 * ── The harness admin ────────────────────────────────────────
 *
 * Before 2 Sep the deployed project had three harness members and three harness
 * moderators and NO harness admin — the only admin was `admin@admin.com`, a real human's
 * account. So every admin-only capability in §4 (site copy, roles, the dashboard's admin
 * half) was either untested or tested by borrowing a person's identity. `--ensure-admin`
 * creates `e2e-admin-<uuid>@mail.example.com`, confirmed, and grants it `admin` in
 * public.user_roles through the Supabase CLI's postgres connection — user_roles is
 * service-role-only by design (0013), which is exactly why this needs the CLI and not a
 * PostgREST call.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  ANON, PROJECT_REF, ROLES, ROOT, SUPABASE, VARS_PATH,
  decodeClaims, readVars, serviceRoleKey, storeCredential,
} from './lib/harness-auth.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueAfter = (f) => (argv.indexOf(f) >= 0 ? argv[argv.indexOf(f) + 1] : undefined);

const HARNESS_EMAIL = /^e2e-(member|moderator|admin)-.*@mail\.example\.com$/;

let failures = 0;
const say = (ok, msg) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; };

/* ── Postgres, via the CLI's Management connection ──────────── */

function sql(text) {
  const tmp = join(ROOT, `.harness-bootstrap-${process.pid}.sql`);
  writeFileSync(tmp, text, 'utf8');
  try {
    const out = execFileSync(
      process.platform === 'win32' ? 'cmd.exe' : 'sh',
      process.platform === 'win32'
        ? ['/c', 'npx', 'supabase', 'db', 'query', '--linked', '-f', tmp]
        : ['-c', `npx supabase db query --linked -f ${JSON.stringify(tmp)}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 },
    );
    /* The CLI pretty-prints the result object across many lines and wraps it in chatter
       ("Initialising login role...", a version notice). So slice from the first brace to
       the last rather than hunting for a single-line JSON payload — which is what an
       earlier draft did, and it silently returned zero rows for every query, which reads
       exactly like "the project has no harness accounts". */
    const first = out.indexOf('{');
    const last = out.lastIndexOf('}');
    if (first < 0 || last < first) return [];
    try {
      return JSON.parse(out.slice(first, last + 1)).rows ?? [];
    } catch {
      throw new Error(`could not parse the CLI's output:\n${out.slice(0, 400)}`);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/* ── Who the harness accounts are ───────────────────────────── */

/**
 * Deliberately reads the DATABASE rather than trusting `.harness.vars`: the file is the
 * cache, `auth.users` joined to `public.user_roles` is the fact. A role whose stored email
 * no longer exists, or has been re-roled, is the failure mode this catches.
 */
function harnessAccounts() {
  const rows = sql(`
    select u.email, u.id::text as id, coalesce(r.role::text, 'member') as role,
           (u.email_confirmed_at is not null) as confirmed
    from auth.users u
    left join public.user_roles r on r.user_id = u.id
    where u.email like 'e2e-%@mail.example.com'
    order by u.created_at;
  `);
  const pick = (role) => rows.filter((r) => r.role === role && r.confirmed && HARNESS_EMAIL.test(r.email));
  return {
    all: rows,
    member: pick('member').find((r) => r.email.startsWith('e2e-member-')) ?? null,
    moderator: pick('moderator')[0] ?? null,
    admin: pick('admin')[0] ?? null,
  };
}

/* ── Creating the admin the project never had ───────────────── */

async function ensureAdmin(svc) {
  const found = harnessAccounts().admin;
  if (found) {
    say(true, `harness admin already exists: ${found.email}`);
    return found;
  }
  const email = `e2e-admin-${crypto.randomUUID()}@mail.example.com`;
  const res = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: `e2e-harness-${crypto.randomUUID()}`,
      email_confirm: true,
    }),
  });
  const user = await res.json();
  if (!res.ok || !user?.id) {
    say(false, `admin create failed (${res.status}): ${JSON.stringify(user).slice(0, 200)}`);
    return null;
  }
  /* user_roles has no grant to anon or authenticated (0013), so this cannot go through
     PostgREST even with the service key's RLS bypass — the GRANT is what is missing, not
     a policy. The CLI's postgres connection is the intended door. */
  sql(`insert into public.user_roles (user_id, role) values ('${user.id}', 'admin')
       on conflict (user_id) do update set role = 'admin';
       select 1 as ok;`);
  const verified = sql(`select coalesce(r.role::text,'(none)') as role
                        from public.user_roles r where r.user_id = '${user.id}';`);
  const ok = verified[0]?.role === 'admin';
  say(ok, `created harness admin ${email} with role=${verified[0]?.role ?? '(none)'}`);
  return ok ? { email, id: user.id, role: 'admin', confirmed: true } : null;
}

/* ── Minting a session without a browser ────────────────────── */

async function mint(svc, email) {
  const gen = await fetch(`${SUPABASE}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const gb = await gen.json().catch(() => ({}));
  if (!gen.ok || !gb.hashed_token) {
    throw new Error(`generate_link ${gen.status}: ${JSON.stringify(gb).slice(0, 200)}`);
  }
  const ver = await fetch(`${SUPABASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gb.hashed_token }),
  });
  const vb = await ver.json().catch(() => ({}));
  if (!ver.ok || !vb.refresh_token) {
    throw new Error(`verify ${ver.status}: ${JSON.stringify(vb).slice(0, 200)}`);
  }
  return vb;
}

/* ── Modes ─────────────────────────────────────────────────── */

async function bootstrap(roles) {
  const svc = serviceRoleKey();
  say(true, `service-role key read from the Supabase CLI (not persisted)`);

  if (roles.includes('admin')) await ensureAdmin(svc);

  const accounts = harnessAccounts();
  console.log(`\n  harness accounts on ${PROJECT_REF}: ` +
    ROLES.map((r) => `${r}=${accounts[r] ? '1' : '0'}`).join('  ') +
    `  (${accounts.all.length} total)`);

  for (const role of roles) {
    const acct = accounts[role];
    if (!acct) {
      say(false, `no confirmed harness ${role} on the project — cannot bootstrap`);
      continue;
    }
    try {
      const session = await mint(svc, acct.email);
      const claims = decodeClaims(session.access_token);
      const claimed = claims.app_metadata?.user_role ?? null;
      storeCredential(role, { refresh_token: session.refresh_token, email: acct.email, id: acct.id });
      say(claims.sub === acct.id, `${role}: session minted for ${acct.email}, refresh token stored`);

      /* NOT a failure, and it took a wrong assertion here to see why. The hosted project
         does not run public.custom_access_token_hook — config.toml enables it but
         `supabase config push` has never been safe to run — so NO token carries
         app_metadata.user_role. That is a known, handled state rather than a hole:
         request-upload's effectiveRole(null, db) defers to the database, admin-boot.js
         gates on DB.rpc('authz_role'), and every RLS policy reads public.authz_role().
         The claim can only ever LOWER the effective role, so its absence over-grants
         nobody. Reported so a harness run says which world it is in. */
      console.log(
        `      JWT app_metadata.user_role=${claimed ?? '(absent — hook not enabled on the hosted project)'}` +
        `  ·  database role=${acct.role}`,
      );
    } catch (e) {
      say(false, `${role}: ${e.message}`);
    }
  }
}

function paste(role, token) {
  if (!ROLES.includes(role)) { say(false, `unknown role '${role}'`); return; }
  if (!token || token.length < 12) { say(false, 'that does not look like a refresh token'); return; }
  storeCredential(role, { refresh_token: token });
  say(true, `${role}: refresh token stored from --paste (not verified until first use)`);
}

async function status() {
  const vars = readVars();
  console.log(`\n  ${VARS_PATH}`);
  for (const role of ROLES) {
    const stored = vars[`RMA_HARNESS_${role.toUpperCase()}_REFRESH`];
    const email = vars[`RMA_HARNESS_${role.toUpperCase()}_EMAIL`] ?? '(unknown)';
    if (!stored) { say(false, `${role}: no credential stored`); continue; }
    const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: stored }),
    });
    const body = await res.json().catch(() => ({}));
    if (body.access_token) {
      if (body.refresh_token && body.refresh_token !== stored) {
        storeCredential(role, { refresh_token: body.refresh_token });
      }
      const c = decodeClaims(body.access_token);
      say(true, `${role}: live — ${email}  user_role=${c.app_metadata?.user_role ?? '(absent)'}`);
    } else {
      say(false, `${role}: STALE (${res.status} ${body.error_code ?? body.msg ?? ''}) — re-authenticate manually`);
    }
  }
}

/* ── main ──────────────────────────────────────────────────── */

console.log(`\nHarness credentials — ${SUPABASE}`);

if (has('--status')) {
  await status();
} else if (has('--paste')) {
  paste(valueAfter('--paste'), argv[argv.indexOf('--paste') + 2]);
} else if (has('--all')) {
  await bootstrap(ROLES);
} else if (has('--role')) {
  await bootstrap([valueAfter('--role')]);
} else {
  console.log(`
usage:
  --all                     mint a session for member, moderator and admin (creates the
                            harness admin if the project has none)
  --role <r>                just one of member | moderator | admin
  --paste <role> <token>    store a refresh token copied from a real browser session
                            (devtools -> Session Storage -> rma.refresh). No CLI login needed.
  --status                  exchange each stored token and report live / stale
`);
  process.exit(2);
}

console.log(failures ? `\n${failures} problem(s).\n` : '\nOK.\n');
process.exit(failures ? 1 : 0);
