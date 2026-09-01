#!/usr/bin/env node
/* The authenticated paths, against the DEPLOYED system, as the real roles.
 *
 *     node scripts/harness-bootstrap.mjs --all      (once, or when a token goes stale)
 *     node scripts/e2e-authenticated.mjs
 *     node scripts/e2e-authenticated.mjs --keep     (leave the fixtures for inspection)
 *
 * ── Why this file exists ─────────────────────────────────────
 *
 * Every authenticated path had ZERO automated coverage, because GoTrue's captcha refuses a
 * password grant to a script and Turnstile will not mint a token for one. Six sessions of
 * defects landed in exactly that gap: an admin dashboard that silently stopped rendering
 * for two days, a sign-in form with no captcha widget, a comment box that discarded every
 * comment it took. scripts/lib/harness-auth.mjs removes the blocker — refresh grants are
 * not captcha-gated — and this is what that unlock is FOR.
 *
 * It complements rather than replaces:
 *   · scripts/e2e-deployed.ts   the contributor's journey WITH BYTES. Needs R2 credentials.
 *   · scripts/m1-gates-deployed.mjs   request-upload's refusals, signed out.
 *   · scripts/pgtap-deployed.mjs      the policies themselves, as postgres.
 * This one is the middle layer nothing covered: a real session, over PostgREST and the
 * Edge Functions, as a member / moderator / admin, ending at the CDN a visitor reads.
 *
 * ── What it will NOT do ──────────────────────────────────────
 *
 * It never touches Turnstile configuration, and it never uses Cloudflare's always-pass test
 * secret. `request-upload` therefore stays out of reach above its Turnstile gate; the parts
 * of the upload path below it (claim_upload_slot, the quota, the precision rules) are
 * reachable and are tested here.
 *
 * ── Fixtures ─────────────────────────────────────────────────
 *
 * Everything it creates is titled with FIXTURE_TAG and deleted at the end, through the
 * service-role key, on an unload handler so a thrown assertion still cleans up. A `--keep`
 * run leaves them and says so. It NEVER deletes anything it did not create.
 */

import {
  ANON, CDN, ROLES, SUPABASE,
  ReauthRequired, anonHeaders, authHeaders, sessionFor, serviceRoleKey,
} from './lib/harness-auth.mjs';

const KEEP = process.argv.includes('--keep');
const FIXTURE_TAG = `E2E-AUTH-${Date.now()}`;

let executed = 0;
const failures = [];
function ck(cond, msg, detail) {
  executed++;
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${cond || !detail ? '' : `\n        ${detail}`}`);
  if (!cond) failures.push(msg);
}
const section = (n, title) => console.log(`\n${n} · ${title}`);

/* ── PostgREST, as whoever ──────────────────────────────────── */

const rest = (path, init = {}, headers = anonHeaders()) =>
  fetch(`${SUPABASE}/rest/v1/${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers ?? {}) },
  });

const rpc = (fn, args, headers) =>
  rest(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args ?? {}) }, headers);

async function body(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

/* The service key is used for TWO things only, both of which legitimately outrank every
   session: reading a row back as the ground truth an assertion is made against, and
   deleting the fixtures. Never to perform an action under test. */
const SVC = serviceRoleKey();
const svcHeaders = { apikey: SVC, Authorization: `Bearer ${SVC}` };
const svc = (path, init = {}) => rest(path, init, svcHeaders);

/* ── Teardown, on unload so a throw still runs it ───────────── */

const createdPosts = new Set();
const createdComments = new Set();
let teardownDone = false;

async function teardown() {
  if (teardownDone) return;
  teardownDone = true;
  if (KEEP) {
    console.log(`\n--keep: leaving ${createdPosts.size} post(s) and ${createdComments.size} comment(s) tagged ${FIXTURE_TAG}`);
    return;
  }
  for (const id of createdComments) await svc(`comments?id=eq.${id}`, { method: 'DELETE' });
  for (const id of createdPosts) {
    await svc(`media_assets?post_id=eq.${id}`, { method: 'DELETE' });
    await svc(`comments?post_id=eq.${id}`, { method: 'DELETE' });
    await svc(`likes?post_id=eq.${id}`, { method: 'DELETE' });
    await svc(`saves?post_id=eq.${id}`, { method: 'DELETE' });
    await svc(`posts?id=eq.${id}`, { method: 'DELETE' });
  }
  console.log(`\ncleaned up ${createdPosts.size} post(s), ${createdComments.size} comment(s)`);
}

/* ── main ──────────────────────────────────────────────────── */

console.log(`\nAuthenticated end-to-end, against the deployed system`);
console.log(`  supabase ${SUPABASE}`);
console.log(`  cdn      ${CDN}`);
console.log(`  fixtures ${FIXTURE_TAG}\n`);

let member, moderator, admin;

section(0, 'the harness credentials themselves');
try {
  [member, moderator, admin] = await Promise.all(ROLES.map(sessionFor));
  ck(true, `three sessions minted from .harness.vars, no captcha presented`);
  for (const [role, s] of [['member', member], ['moderator', moderator], ['admin', admin]]) {
    /* The DATABASE's answer, which is what every policy reads (§4). The JWT claim is
       absent on this project and deliberately cannot over-grant, so it is not the thing
       to assert on. */
    const r = await rpc('authz_role', {}, authHeaders(s));
    const got = await body(r);
    ck(got === role, `${role}: authz_role() answers '${got}'`, `session for ${s.email}`);
  }
} catch (e) {
  if (e instanceof ReauthRequired) {
    console.error(`\n${e.message}\n`);
    process.exit(2);
  }
  throw e;
}

/* ── 1 · a member's own submission ──────────────────────────── */

section(1, 'a member submits (claim_upload_slot — the quota path under the Turnstile gate)');
let postId = '';
{
  const res = await rpc('claim_upload_slot', {
    p_bytes: 1024,
    p_object_key: `${member.userId}/${crypto.randomUUID()}`,
    p_kind: 'media',
    p_draft: {
      title_en: `${FIXTURE_TAG} submission`,
      title_ar: `${FIXTURE_TAG} مساهمة`,
      body_en: 'archival description written by scripts/e2e-authenticated.mjs',
      body_ar: 'وصف أرشيفي',
      license: 'CC-BY-SA-4.0',
      provenance: 'harness fixture; no provenance claim is made',
      consent: { granted: true },
      decade: '1980',
    },
  }, authHeaders(member));
  const claim = await body(res);
  ck(res.ok && claim?.allowed === true, `claim_upload_slot granted (${res.status})`, JSON.stringify(claim).slice(0, 200));
  postId = claim?.post_id ?? '';
  if (postId) createdPosts.add(postId);

  const [row] = await body(await svc(`posts?id=eq.${postId}&select=status,created_by,ingest_state`));
  ck(row?.status === 'pending', `it lands 'pending' (§1: everything user-submitted is reviewed)`);
  ck(row?.created_by === member.userId, `created_by is stamped by the trigger, not by the client`);
}

/* ── 2 · unapproved content is UNREADABLE, not merely hidden ── */

section(2, '§5 — a pending post is unreadable by everyone but its author and a moderator');
{
  /* Anon is refused at the PRIVILEGE layer, not by an empty result set: 0015 grants
     `anon` no SELECT on posts at all, so PostgREST answers 42501 before RLS is reached.
     Asserted as "denied, and specifically at that layer" rather than as "no rows" —
     the first draft of this check expected an empty array, which would have gone green
     against a database that granted anon SELECT and then filtered it with a policy. Both
     are safe today; only one of them stays safe if a policy is ever edited. */
  const anonRes = await rest(`posts?id=eq.${postId}&select=id`);
  const asAnon = await body(anonRes);
  const anonText = JSON.stringify(asAnon);
  ck(
    anonRes.status === 401 || anonRes.status === 403 || (Array.isArray(asAnon) && asAnon.length === 0),
    `anon cannot read it (${anonRes.status})`, anonText.slice(0, 140),
  );
  ck(!anonText.includes(postId), `and the response contains no trace of the id`);

  /* A DIFFERENT member, not the author. The author seeing their own pending row is
     correct (§9's /me) and would make an "a member cannot see it" assertion pass for the
     wrong reason if the author were the one asked. */
  const other = await rest(`posts?id=eq.${postId}&select=id`, {}, authHeaders(admin));
  const otherRows = await body(other);
  ck(
    Array.isArray(otherRows) && otherRows.length === 1,
    `an ADMIN can see it (${otherRows.length} row) — moderators review what members cannot see`,
  );

  const mine = await body(await rest(`posts?id=eq.${postId}&select=id,status`, {}, authHeaders(member)));
  ck(mine.length === 1 && mine[0].status === 'pending', `its author sees their own pending row (§9's /me)`);
}

/* ── 3 · comments: §1's one exception, and its remaining filter ─ */

section(3, 'comments — published on insert, and bidi still stripped');
let approvedPostId = '';
{
  const approved = await body(await svc('posts?status=eq.approved&takedown=is.false&select=id&limit=1'));
  approvedPostId = approved[0]?.id ?? '';
  ck(!!approvedPostId, `found an approved post to comment on`);

  /* U+202E RIGHT-TO-LEFT OVERRIDE and U+2066 LEFT-TO-RIGHT ISOLATE. §6 requires both
     stripped ON INGEST, and since 0054 removed prior review this trigger is the ONLY
     filter between a hostile string and a shard. */
  const hostile = `${FIXTURE_TAG} ‮reversed‬ and ⁦isolated⁩ end`;
  const res = await rest('comments?select=id,status,body', {
    method: 'POST',
    body: JSON.stringify({ post_id: approvedPostId, body: hostile, lang: 'en' }),
    headers: { Prefer: 'return=representation' },
  }, authHeaders(member));
  const rows = await body(res);
  ck(res.ok && rows?.[0]?.id, `a member's comment is accepted (${res.status})`, JSON.stringify(rows).slice(0, 200));
  const commentId = rows?.[0]?.id;
  if (commentId) createdComments.add(commentId);

  ck(rows?.[0]?.status === 'published', `it is 'published' the moment it is written (§1, 0054)`);

  const stored = rows?.[0]?.body ?? '';
  ck(!/[‪-‮⁦-⁩]/.test(stored), `every bidi control was stripped before the row landed`,
    `stored: ${JSON.stringify(stored)}`);
  ck(stored.includes('reversed') && stored.includes('isolated'), `and the visible text survived intact`);

  /* Two refusals that must still hold after the amendment. */
  const anonComment = await rest('comments', {
    method: 'POST', body: JSON.stringify({ post_id: approvedPostId, body: 'anon', lang: 'en' }),
  });
  ck(!anonComment.ok, `a signed-out visitor still cannot comment (${anonComment.status})`);

  const onPending = await rest('comments', {
    method: 'POST', body: JSON.stringify({ post_id: postId, body: `${FIXTURE_TAG} on a pending post`, lang: 'en' }),
  }, authHeaders(member));
  const pendingBody = await body(onPending);
  ck(!onPending.ok, `nobody can comment on a post that is not approved (${onPending.status})`);
  ck(/row-level security/i.test(JSON.stringify(pendingBody)),
     `refused by the POLICY, not by a column grant`, JSON.stringify(pendingBody).slice(0, 160));
}

let releaseBeforeApproval = '';

/* ── 4 · moderation, and §4's dual audit trail ──────────────── */

section(4, 'a moderator approves — and a member cannot');
{
  /* `select=id,status` is load-bearing: return=representation without it makes PostgREST
     do RETURNING *, which needs SELECT on columns 0015 withholds from `authenticated`,
     and the statement then fails 42501 BEFORE RLS is consulted. A harness that read any
     403 as "the policy refused" would go green against a database that let members
     approve their own uploads. That exact false pass is on record from 28 Aug. */
  const patch = (session) => rest(`posts?id=eq.${postId}&select=id,status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'approved' }),
    headers: { Prefer: 'return=representation' },
  }, authHeaders(session));

  const statusNow = async () => (await body(await svc(`posts?id=eq.${postId}&select=status`)))[0]?.status;

  const asMember = await patch(member);
  const memberText = JSON.stringify(await body(asMember));
  ck(!asMember.ok, `the member's own approval is refused (${asMember.status})`);
  ck(/row-level security/i.test(memberText), `by the RLS policy, not a column grant`, memberText.slice(0, 160));
  ck(await statusNow() === 'pending', `and the STORED status is still 'pending'`);

  /* Captured before the approval so section 6 can prove the pointer MOVED rather than
     merely that a release exists. §2's amendment makes the moderation action the trigger
     and the cron is unscheduled, so nothing else would move it during this run. */
  const m0 = await fetch(`${CDN}/manifest.json?cb=${Date.now()}`);
  releaseBeforeApproval = m0.ok ? (await m0.json()).release ?? '' : '';

  const auditBefore = (await body(await svc(`audit_log?target_id=eq.${postId}&select=id`))).length;
  const modActBefore = (await body(await svc(`moderation_actions?target_id=eq.${postId}&select=id`))).length;

  const asMod = await patch(moderator);
  ck(asMod.ok, `the moderator's approval succeeds (${asMod.status})`);

  const [row] = await body(await svc(
    `posts?id=eq.${postId}&select=status,approved_by,approved_at,content_hash`));
  ck(row?.status === 'approved', `status is 'approved'`);
  ck(row?.approved_by === moderator.userId, `approved_by names the moderator (trigger, §5)`);
  ck(!!row?.content_hash, `content_hash is recorded — the publisher refuses rows whose hash drifts`);

  /* §4: "Every moderator and admin action writes to moderation_actions AND audit_log."
     Both, not either — the 31 Aug check found the AND unmet for a site-copy edit. */
  const auditAfter = (await body(await svc(`audit_log?target_id=eq.${postId}&select=id,actor,action`)));
  const modActAfter = (await body(await svc(`moderation_actions?target_id=eq.${postId}&select=id,actor,action`)));
  ck(auditAfter.length > auditBefore, `audit_log gained a row (${auditBefore} → ${auditAfter.length})`);
  ck(modActAfter.length > modActBefore, `moderation_actions gained a row (${modActBefore} → ${modActAfter.length})`);
  ck(auditAfter.some((r) => r.actor === moderator.userId), `and the audit row names the moderator as actor`);
}

/* ── 5 · §4's admin-only capability ─────────────────────────── */

section(5, '§4 — only an admin may edit site copy');
{
  /* An EXISTING block, and its draft is restored verbatim at the end. An earlier draft of
     this section used a key/locale pair the seed had never created, and save_content_block
     happily upserted it — leaving a real row in a governance table as a side effect of a
     test. Read the row first, refuse to run if it is not there. */
  const KEY = 'footer.blurb';
  const LOCALE = 'ar';
  const path = `content_blocks?key=eq.${KEY}&locale=eq.${LOCALE}&select=key,locale,draft,version`;
  const [before] = await body(await svc(path));
  ck(!!before, `the block ${KEY}/${LOCALE} exists (version ${before?.version})`);
  if (!before) throw new Error(`${KEY}/${LOCALE} is missing — refusing to create it from a test`);

  const save = (session, draft) => rpc('save_content_block',
    { p_key: KEY, p_locale: LOCALE, p_draft: draft }, authHeaders(session));

  /* THE ASSERTION SHAPE THAT MATTERS. save_content_block reports its refusal in the BODY
     with HTTP 200 — {"saved": false, "reason": "denied"} — so `!res.ok` is false for a
     correct refusal, and a status-code assertion here says the exact opposite of the
     truth. The mirror of that mistake is a test that reads 200 as success and goes green
     against a function that refuses everything. Assert the body AND the store. */
  const asModRes = await save(moderator, `${FIXTURE_TAG} a moderator must not write this`);
  const asMod = await body(asModRes);
  ck(asMod?.saved === false && asMod?.reason === 'denied',
     `a MODERATOR is refused — ${JSON.stringify(asMod)} (§4 gives site copy to admin alone)`);

  const [unchanged] = await body(await svc(path));
  ck(unchanged?.draft === before?.draft && unchanged?.version === before?.version,
     `and the stored draft and version did not move`);

  const asAdminRes = await save(admin, `${FIXTURE_TAG} admin write`);
  const asAdmin = await body(asAdminRes);
  ck(asAdmin?.saved === true, `the ADMIN's save succeeds — ${JSON.stringify(asAdmin)}`);

  /* §4's AND. 0059 (31 Aug) made moderation_actions.target_id nullable and added
     target_key precisely so this pair could be written for a target not keyed by uuid.
     The shapes come from 0059 itself, not from a guess: target_type is the singular
     'content_block', and target_key is 'content_block:<key>:<locale>'. */
  const tk = `content_block:${KEY}:${LOCALE}`;
  const acts = await body(await svc(
    `moderation_actions?target_key=eq.${encodeURIComponent(tk)}&select=id,actor,action&order=created_at.desc&limit=5`));
  const audits = await body(await svc(
    `audit_log?target_type=eq.content_block&select=id,actor,action&order=created_at.desc&limit=5`));
  ck(Array.isArray(acts) && acts.some((r) => r.actor === admin.userId),
     `moderation_actions names the admin against ${tk}`, JSON.stringify(acts).slice(0, 200));
  ck(Array.isArray(audits) && audits.some((r) => r.actor === admin.userId),
     `audit_log names the admin too — §4's AND, not OR`, JSON.stringify(audits).slice(0, 200));

  /* Restore. A test that leaves the site's own copy saying FIXTURE is worse than no test. */
  const restored = await body(await save(admin, before.draft));
  ck(restored?.saved === true, `the original draft is restored`);
  const [now] = await body(await svc(path));
  ck(now?.draft === before.draft, `and it reads back byte-identical to what was there`);
}

/* ── 6 · publish, and the public read path ──────────────────── */

section(6, 'publish fires on approval, and the item resolves where a browser reads');
{
  /* §2's amendment: the trigger IS the moderation action. Approving in section 4 should
     already have dispatched. Poll the manifest rather than dispatching again — a second
     dispatch would be answered `held` and prove nothing. */
  const manifestOf = async () => {
    const r = await fetch(`${CDN}/manifest.json?cb=${Date.now()}`);
    return r.ok ? (await r.json()) : null;
  };

  const deadline = Date.now() + 90_000;
  let release = releaseBeforeApproval;
  while (Date.now() < deadline) {
    const m = await manifestOf();
    release = m?.release ?? '';
    if (release && release !== releaseBeforeApproval) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  ck(!!release, `manifest.json names a release (${release || 'NONE'})`);
  ck(release !== releaseBeforeApproval,
     `the approval dispatched a publish and the pointer MOVED (${releaseBeforeApproval} → ${release})`,
     'the moderation action is the trigger; the cron is unscheduled, so nothing else would move it');

  /* THE INVARIANT THE FIRST RUN GOT BACKWARDS, and it is worth more than the assertion it
     replaced. This fixture is approved, but it claimed a slot and never uploaded bytes, so
     `ingest_state` is not 'ready' — and `publishable_posts` (0031) requires approved AND
     not-taken-down AND ready. So it must be ABSENT from the release. An earlier draft
     asserted it was PRESENT and failed, which read like a broken publish pipeline and was
     in fact the pipeline correctly refusing to publish an item with no media. */
  const [state] = await body(await svc(`posts?id=eq.${postId}&select=ingest_state,status`));
  ck(state?.status === 'approved' && state?.ingest_state !== 'ready',
     `the fixture is approved but ingest_state='${state?.ingest_state}' — not publishable`);
  const absent = await fetch(`${CDN}${release}item/${postId}.json?cb=${Date.now()}`);
  ck(absent.status === 404,
     `and it is correctly ABSENT from the release (${absent.status}) — approval alone does not publish media`);
  const noPage = await fetch(`${CDN}/item/${postId}/index.html?cb=${Date.now()}`);
  ck(!noPage.ok, `no prerendered page was written for it either (${noPage.status})`);

  /* Now the real read path, on an item that IS publishable — the one this run commented
     on. Fetched with NO credential of any kind, because §2's promise is zero database
     reads for a public visitor, and the anon key is still a credential. */
  const shardUrl = `${CDN}${release}item/${approvedPostId}.json?cb=${Date.now()}`;
  const bare = await fetch(shardUrl, { headers: {} });
  ck(bare.ok, `a published item resolves for a visitor with NO credential (${bare.status})`);
  if (bare.ok) {
    const item = await bare.json();
    ck(item?.id === approvedPostId, `the shard is the right item`);
    ck(typeof item?.title_ar === 'string' || typeof item?.title_en === 'string', `it carries its titles`);
  }

  const page = await fetch(`${CDN}/item/${approvedPostId}/index.html?cb=${Date.now()}`);
  ck(page.ok, `its prerendered page exists at the bucket root (${page.status}) — §9's WhatsApp card`);
  if (page.ok) {
    const html = await page.text();
    ck(/<meta property="og:title"/.test(html), `it carries og:title`);
    ck(/<meta property="og:description"/.test(html), `it carries og:description`);
    ck(/<meta property="og:image"/.test(html), `it carries og:image — a card without one is the growth failure §9 names`);
    ck(/max-age=300/.test(page.headers.get('cache-control') ?? ''),
       `and it is short-cached (${page.headers.get('cache-control')}) — it is rewritten every publish`);
  }
}

/* ── 7 · the comment reaches the shard a visitor reads ──────── */

section(7, "§2's amendment — a published comment travels inside item/{id}.json");
{
  const manifest = await (await fetch(`${CDN}/manifest.json?cb=${Date.now()}`)).json();
  const res = await fetch(`${CDN}${manifest.release}item/${approvedPostId}.json?cb=${Date.now()}`);
  ck(res.ok, `the commented item's shard is fetchable (${res.status})`);
  if (res.ok) {
    const item = await res.json();
    const comments = item?.comments ?? [];
    ck(Array.isArray(comments), `it carries a comments array (${comments.length})`);
    const mine = comments.find((c) => String(c.body ?? '').includes(FIXTURE_TAG));
    ck(!!mine, `this run's comment is in it — a visitor can actually read it`,
       mine ? '' : '0015 grants anon nothing, so a comment absent from the shard is unreadable');
    if (mine) {
      ck(!/[‪-‮⁦-⁩]/.test(mine.body), `and it reached the shard with no bidi controls`);
    }
  }
}

/* ── 8 · takedown removes the bytes, not the pointer ────────── */

section(8, '§8 — takedown does not wait for the publish cycle');
{
  const started = Date.now();
  const res = await fetch(`${SUPABASE}/functions/v1/takedown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(moderator) },
    body: JSON.stringify({ post_id: postId, reason: `${FIXTURE_TAG} harness takedown` }),
  });
  const out = await body(res);
  const elapsed = Date.now() - started;

  /* `res.ok` IS TRUE FOR 207, and 207 means `objects_remain` — the post is marked and
     hidden but some part of the removal did not complete (handler.ts:82). The first run of
     this file asserted `res.ok` and went green on a 207, which is precisely the
     non-discriminating shape this session set out to find. Assert the two apart. */
  ck(res.status === 200 || res.status === 207,
     `a moderator's takedown is accepted (${res.status})`, JSON.stringify(out).slice(0, 240));
  ck(res.status === 200,
     `every object was actually removed — 200, not 207 objects_remain`,
     res.status === 207
       ? `reason=${out?.reason}; CLOUDFLARE_PURGE_TOKEN is unset on this project, so §8's CDN purge is a no-op and a takedown cannot report a clean 200. Gated on Amro, recorded in the 29 Aug closeout audit.`
       : '');
  ck(elapsed < 60_000, `it returned in ${(elapsed / 1000).toFixed(1)} s — M2's exit criterion is < 1 min`);

  const [row] = await body(await svc(`posts?id=eq.${postId}&select=takedown`));
  ck(row?.takedown === true, `the row is marked taken down`);

  /* §8's step 1 includes the prerendered page, added 21 Aug because a takedown used to
     leave the item legible as HTML at the exact URL people had shared. */
  const page = await fetch(`${CDN}/item/${postId}/index.html?cb=${Date.now()}`);
  ck(!page.ok, `the prerendered page is GONE (${page.status}) — §8 step 1, not the next publish`);

  const red = await fetch(`${CDN}/redactions.json?cb=${Date.now()}`);
  ck(red.ok, `redactions.json is served (${red.status})`);
  if (red.ok) {
    const j = await red.json();
    const ids = j?.ids ?? j?.posts ?? j;
    ck(JSON.stringify(ids).includes(postId), `and it names the item clients must filter out`);
  }
}

/* ── done ──────────────────────────────────────────────────── */

await teardown();

console.log(`\n${executed} checks, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  ✗ ${f}`).join('\n'));
  process.exit(1);
}
console.log('OK.\n');
