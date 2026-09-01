/* Sessions for the authenticated E2E harness, without weakening the captcha.
 *
 * ── The blocker this exists to remove ────────────────────────
 *
 * GoTrue captcha protection has been on since 31 Aug 2026. Measured again 2 Sep against
 * the deployed project, with a real harness account and its real password:
 *
 *     POST /auth/v1/token?grant_type=password   ->  400 captcha_failed
 *                                                   "(no captcha_token found)"
 *
 * and Turnstile does not answer automation, so no script can supply the missing token.
 * That is why every authenticated path — signup, sign-in, upload, admin, comment,
 * moderate — had zero automated coverage, which is precisely where six sessions of
 * defects then landed.
 *
 * ── The unlock, and why it is not a weakening ────────────────
 *
 * The captcha guards the PASSWORD grant. It does not guard the REFRESH grant:
 *
 *     POST /auth/v1/token?grant_type=refresh_token  ->  200, a real session
 *
 * measured, not assumed. So a harness that already holds a refresh token can mint access
 * tokens indefinitely without ever presenting a captcha. Nothing about the deployed
 * Turnstile configuration changes: the site key, the secret, and the protection setting
 * are untouched, a human signing in still meets the challenge, and a bot hitting /signup
 * or the password grant is still refused. What changed is that this repository now holds
 * a credential it obtained legitimately — the same posture as the harness passwords that
 * are already literals in scripts/e2e-deployed.ts, one notch stronger because a refresh
 * token is revocable from the dashboard and a password is not.
 *
 * DELIBERATELY NOT DONE: Cloudflare's always-pass test sitekey/secret on the deployed
 * project. That would disable the bot gate for every real visitor to close a test gap,
 * and it is the hole the 31 Aug audit closed.
 *
 * ── Rotation, which is not optional ──────────────────────────
 *
 * GoTrue rotates: every exchange returns a NEW refresh token and the old one is only
 * good inside a short reuse window (measured: the old token still worked immediately
 * after, so there is a grace interval — but it is a grace, not a guarantee). A harness
 * that does not persist the new token works for one run and then, days later, fails in a
 * way that looks like a broken test. So every exchange writes back, and a refusal is
 * reported as `re-authenticate manually` with the exact command, never as a test failure.
 *
 * ── Where the tokens live ────────────────────────────────────
 *
 * `.harness.vars` at the repository root: git-ignored, and blocked from a force-add by
 * scripts/forbidden-paths.ere, on the same pattern as .dev.vars and .backup.vars. It
 * holds refresh tokens ONLY. No service-role key is ever written to it, and no password.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const VARS_PATH = join(ROOT, '.harness.vars');

export const ROLES = ['member', 'moderator', 'admin'];

const cfg = JSON.parse(readFileSync(join(ROOT, 'config/site.json'), 'utf8'));
export const SUPABASE = `https://${cfg.domains.supabase}`;
export const ANON = cfg.supabase.anon_key;
export const PROJECT_REF = cfg.domains.supabase.split('.')[0];
export const CDN = `https://${cfg.domains.cdn}`;

/** Raised when the stored credential can no longer mint a session. Never a bare failure. */
export class ReauthRequired extends Error {
  constructor(role, detail) {
    super(
      `harness credential for '${role}' is stale — RE-AUTHENTICATE MANUALLY.\n` +
        `    ${detail}\n` +
        `    Fix it with:  node scripts/harness-bootstrap.mjs --role ${role}\n` +
        `    (or, without a service-role key: sign in as the ${role} in a real browser,\n` +
        `     read sessionStorage['rma.refresh'] in devtools, and run\n` +
        `       node scripts/harness-bootstrap.mjs --paste ${role} <that-token>)`,
    );
    this.name = 'ReauthRequired';
    this.role = role;
  }
}

/* ── The store ─────────────────────────────────────────────── */

/**
 * `.harness.vars` is dotenv-shaped so a human can read and edit it, and so it looks like
 * its two siblings. Keys are RMA_HARNESS_<ROLE>_REFRESH / _EMAIL / _ID.
 */
export function readVars() {
  if (!existsSync(VARS_PATH)) return {};
  const out = {};
  for (const line of readFileSync(VARS_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Written through a temp file and renamed, because the alternative is a harness that
 * loses every credential in the file when it is killed mid-write — and the recovery from
 * that is a manual browser sign-in per role.
 */
export function writeVars(vars) {
  const header = [
    '# Ramallah Memory Atlas — E2E harness credentials. LOCAL ONLY.',
    '#',
    '# Git-ignored (.gitignore) and blocked from a force-add (scripts/forbidden-paths.ere).',
    '# Every value here is a GoTrue REFRESH TOKEN for a harness account on the deployed',
    '# staging project. Each one mints moderator- or admin-level access tokens with no',
    '# captcha and no password. Treat it as a credential, because it is one.',
    '#',
    '# REWRITTEN ON EVERY USE: GoTrue rotates the refresh token on each exchange, so a stale',
    '# copy of this file is a harness that fails days later for no visible reason.',
    '#',
    '# Bootstrap or repair:  node scripts/harness-bootstrap.mjs --all',
    `# Generated ${new Date().toISOString()}`,
    '',
  ].join('\n');
  const body = Object.entries(vars)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const tmp = `${VARS_PATH}.tmp`;
  writeFileSync(tmp, `${header}${body}\n`, { mode: 0o600 });
  renameSync(tmp, VARS_PATH);
}

const key = (role, field) => `RMA_HARNESS_${role.toUpperCase()}_${field}`;

export function storeCredential(role, { refresh_token, email, id }) {
  const vars = readVars();
  if (refresh_token) vars[key(role, 'REFRESH')] = refresh_token;
  if (email) vars[key(role, 'EMAIL')] = email;
  if (id) vars[key(role, 'ID')] = id;
  writeVars(vars);
}

/* ── The exchange ──────────────────────────────────────────── */

/**
 * refresh token -> access token, persisting the rotation.
 *
 * Returns { accessToken, refreshToken, userId, email, role, expiresAt }.
 * Throws ReauthRequired — never a generic Error — when the credential is spent.
 */
export async function sessionFor(role) {
  const vars = readVars();
  const stored = vars[key(role, 'REFRESH')];
  if (!stored) {
    throw new ReauthRequired(role, `no ${key(role, 'REFRESH')} in .harness.vars`);
  }

  const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: stored }),
  });
  const body = await res.json().catch(() => ({}));

  if (!res.ok || !body.access_token) {
    throw new ReauthRequired(
      role,
      `refresh grant answered ${res.status} ${body.error_code ?? body.code ?? ''} ${body.msg ?? body.error_description ?? ''}`.trim(),
    );
  }

  /* Persist FIRST. If the process dies between here and the caller's work, the file holds
     the token that is certainly live rather than the one that is certainly spent. */
  if (body.refresh_token && body.refresh_token !== stored) {
    storeCredential(role, { refresh_token: body.refresh_token });
  }

  const claims = decodeClaims(body.access_token);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? stored,
    userId: claims.sub,
    email: vars[key(role, 'EMAIL')] ?? claims.email ?? null,
    /* §4: the claim is under app_metadata, set by public.custom_access_token_hook. It is
       what Edge Functions read; RLS reads public.authz_role() against the table instead,
       so a missing claim here is an Edge-Function-level defect, not an authorization
       hole — and the harness asserts on it rather than assuming it. */
    claimedRole: claims.app_metadata?.user_role ?? null,
    expiresAt: claims.exp,
  };
}

export function decodeClaims(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

/** Headers for a PostgREST or Edge Function call as this role. */
export function authHeaders(session, extra = {}) {
  return {
    apikey: ANON,
    Authorization: `Bearer ${session.accessToken}`,
    ...extra,
  };
}

/** Headers for an ANONYMOUS call — the signed-out visitor, who is a test subject too. */
export function anonHeaders(extra = {}) {
  return { apikey: ANON, Authorization: `Bearer ${ANON}`, ...extra };
}

/**
 * The service-role key, read from the logged-in Supabase CLI at call time.
 *
 * NEVER persisted and never printed. It is deliberately not in `.harness.vars`: the whole
 * point of the refresh-token design is that the routine harness runs on a credential that
 * mints exactly one member's, one moderator's and one admin's session, and nothing more.
 * Only the bootstrap and the fixture teardown need to outrank that, and both are
 * occasional, human-run, and fail loudly if the CLI is not logged in.
 */
export function serviceRoleKey() {
  const out = execFileSync(
    process.platform === 'win32' ? 'cmd.exe' : 'sh',
    process.platform === 'win32'
      ? ['/c', 'npx', 'supabase', 'projects', 'api-keys', '--project-ref', PROJECT_REF]
      : ['-c', `npx supabase projects api-keys --project-ref ${PROJECT_REF}`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const line = out.split('\n').find((l) => l.trim().startsWith('{"keys"'));
  if (!line) {
    throw new Error(
      'could not read the project API keys from the Supabase CLI.\n' +
        '    Is it logged in?  npx supabase login\n' +
        '    (This is only needed by the bootstrap and by fixture teardown; the E2E run itself\n' +
        '     uses .harness.vars and never touches a service-role key.)',
    );
  }
  const found = JSON.parse(line).keys.find((k) => k.id === 'service_role');
  if (!found) throw new Error('no legacy service_role key on this project');
  return found.api_key;
}

/* ── A session that is NOT the stored one ───────────────────── */

/**
 * Mints a throwaway session through the admin API, leaving `.harness.vars` untouched.
 *
 * This exists for the browser harness. auth.js keeps the refresh token in
 * sessionStorage['rma.refresh'] and exchanges it on load, so seeding a browser means
 * handing it a refresh token — and the browser will then ROTATE it, silently putting the
 * copy in `.harness.vars` one generation behind. GoTrue's reuse grace hides that for a
 * while and then it does not, and the failure arrives days later looking like a broken
 * test. So the browser gets its own, and the stored credential is never spent by a page.
 *
 * Needs the service-role key, like the bootstrap. Sends no mail (generate_link returns the
 * link rather than mailing it) and creates nothing.
 */
export async function mintDisposable(role) {
  const vars = readVars();
  const email = vars[`RMA_HARNESS_${role.toUpperCase()}_EMAIL`];
  if (!email) throw new ReauthRequired(role, `no RMA_HARNESS_${role.toUpperCase()}_EMAIL in .harness.vars`);

  const svc = serviceRoleKey();
  const gen = await fetch(`${SUPABASE}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', email }),
  });
  const gb = await gen.json().catch(() => ({}));
  if (!gb.hashed_token) throw new Error(`generate_link ${gen.status}: ${JSON.stringify(gb).slice(0, 200)}`);

  const ver = await fetch(`${SUPABASE}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: gb.hashed_token }),
  });
  const vb = await ver.json().catch(() => ({}));
  if (!vb.refresh_token) throw new Error(`verify ${ver.status}: ${JSON.stringify(vb).slice(0, 200)}`);
  return { ...vb, email };
}
