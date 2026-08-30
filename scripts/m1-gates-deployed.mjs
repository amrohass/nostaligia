/* `request-upload`'s refusals, against the DEPLOYED Edge Function, with a real token.
 *
 * WHAT THIS CAN AND CANNOT REACH, stated up front because the boundary is the finding.
 * handler.ts refuses in a deliberate order, and Turnstile sits in the middle of it:
 *
 *     free gate   svg_rejected · unsupported_type · invalid_bytes · over_absolute_cap
 *                 · duration_required            ← reachable here, and checked below
 *     gate 2      unauthenticated                ← reachable here
 *     gate 3      turnstile_required / turnstile_failed
 *     gate 4      over_size_cap · over_duration_cap   ← NOT reachable from automation
 *
 * A Turnstile token cannot be minted by a script. Measured rather than assumed, on
 * 31 Aug 2026: real Chromium, headed, at the live origin, `turnstile.render()` with the
 * site's own key produced NO iframe and called back neither success nor error for 45
 * seconds. That is Turnstile working as designed against automation. So the two ROLE caps
 * are covered by the function's unit tests and by the database's own role-derived quota
 * (08_upload_quota, which asserts a member with a forged admin claim still gets the member
 * budget) — and this script proves the gate ordering instead, which is the part that can
 * be checked live: a 300 MB member request comes back `turnstile_required`, so the cap
 * genuinely is behind the challenge rather than absent.
 *
 * NOTHING HERE CREATES A ROW. Every assertion is a refusal, and every refusal happens
 * before claim_upload_slot. That is deliberate: an audit should not leave pending posts
 * with no bytes behind them scattered through the archive.
 *
 *   node scripts/m1-gates-deployed.mjs
 */

import { readFileSync } from 'node:fs';

const cfg = JSON.parse(readFileSync('config/site.json', 'utf8'));
const ANON = cfg.supabase.anon_key;
const SUPABASE = 'https://' + cfg.domains.supabase;
const ORIGIN = 'https://nostaligia.pages.dev';

/* The deployed harness accounts. The password is a literal in scripts/e2e-deployed.ts and
   these are synthetic addresses on a staging project — it authorises nothing anywhere else. */
const PASSWORD = 'e2e-deployed-harness-password-1';
const MEMBER = 'e2e-member-f7108f78-86d3-4162-b4e9-0c3256ec1898@mail.example.com';

let n = 0;
let bad = 0;
const ok = (cond, msg) => {
  n++;
  console.log(`  ${cond ? 'ok    ' : 'NOT OK'} ${n} - ${msg}`);
  if (!cond) bad++;
};

const res = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: MEMBER, password: PASSWORD }),
});
const session = await res.json();
if (!session.access_token) {
  console.error('could not sign in as the harness member — refusing to report gates unverified');
  console.error(JSON.stringify(session).slice(0, 200));
  process.exit(1);
}
const TOKEN = session.access_token;

const draft = {
  title_ar: 'تدقيق البوابات',
  body_ar: 'طلب مرفوض عمدًا للتحقق من ترتيب البوابات — مراجعة ٣١ آب ٢٠٢٦.',
};

async function ask(body, { auth = true } = {}) {
  const headers = { apikey: ANON, 'Content-Type': 'application/json', Origin: ORIGIN };
  if (auth) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${SUPABASE}/functions/v1/request-upload`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  let j = {};
  try { j = await r.json(); } catch { /* status alone */ }
  return { status: r.status, error: j.error, body: j };
}

console.log('request-upload, deployed, as a real signed-in member\n');

/* §6 names SVG specifically. Declared mime only — the bytes are re-sniffed by the worker,
   which is a different defence and is not what this asserts. */
const svg = await ask({ kind: 'media', mime: 'image/svg+xml', bytes: 1024, draft });
ok(svg.status === 415 && svg.error === 'svg_rejected',
  `SVG refused by declared mime: ${svg.status} ${svg.error}`);

const weird = await ask({ kind: 'media', mime: 'application/x-msdownload', bytes: 1024, draft });
ok(weird.status === 415 && weird.error === 'unsupported_type',
  `a type outside the allowlist is refused: ${weird.status} ${weird.error}`);

const zero = await ask({ kind: 'media', mime: 'image/jpeg', bytes: 0, draft });
ok(zero.status === 400 && zero.error === 'invalid_bytes',
  `a zero-byte declaration is refused, not treated as a free upload: ${zero.status} ${zero.error}`);

const neg = await ask({ kind: 'media', mime: 'image/jpeg', bytes: -1, draft });
ok(neg.status === 400 && neg.error === 'invalid_bytes',
  `a negative size is refused: ${neg.status} ${neg.error}`);

/* Above the largest cap any role has, so no role could ever admit it. */
const huge = await ask({ kind: 'media', mime: 'video/mp4', bytes: 5 * 1024 * 1024 * 1024, duration_s: 60, draft });
ok(huge.status === 413 && huge.error === 'over_absolute_cap',
  `5 GB is refused above every role's cap: ${huge.status} ${huge.error} (detail ${JSON.stringify(huge.body.detail)})`);

/* A video with no declared duration would be uncappable, so absence is a refusal. */
const nodur = await ask({ kind: 'media', mime: 'video/mp4', bytes: 1024 * 1024, draft });
ok(nodur.status === 400 && nodur.error === 'duration_required',
  `a video with no declared duration is refused, not admitted uncapped: ${nodur.status} ${nodur.error}`);

/* CONTROL. Without this, every assertion above is satisfied by a function that refuses
   everything — including the two role caps this script cannot reach. A declaration that
   breaks no free-gate rule must get PAST the free gate, and the proof that it did is that
   it stops at the NEXT gate: Turnstile. */
const okSize = await ask({ kind: 'media', mime: 'image/jpeg', bytes: 100 * 1024 * 1024, draft });
ok(okSize.status === 400 && okSize.error === 'turnstile_required',
  `CONTROL: a lawful 100 MB declaration passes the free gate and stops at Turnstile: ${okSize.status} ${okSize.error}`);

/* And the gate-ordering claim itself: the role cap is BEHIND Turnstile, not missing. */
const over = await ask({ kind: 'media', mime: 'image/jpeg', bytes: 300 * 1024 * 1024, draft });
ok(over.status === 400 && over.error === 'turnstile_required',
  `300 MB (over a member's cap, under the absolute one) also stops at Turnstile — the role cap is behind the challenge, not absent`);

const anon = await ask({ kind: 'media', mime: 'image/jpeg', bytes: 1024, draft }, { auth: false });
ok(anon.status === 401, `unauthenticated request-upload is refused ${anon.status}`);

console.log(`\n1..${n}`);
console.log(bad === 0 ? 'All assertions passed.' : `${bad} assertion(s) failed.`);
process.exit(bad === 0 ? 0 : 1);
