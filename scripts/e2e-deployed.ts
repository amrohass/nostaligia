/* The contributor's whole journey, against the DEPLOYED system, with a photograph.
 *
 *     deno run --allow-net --allow-env --allow-read --allow-write scripts/e2e-deployed.ts
 *
 * scripts/m1-deployed.ts proves M1's sentence with a video: a 4K-class master survives
 * intact in `originals/` while only renditions are CDN-reachable. It stops at `pending`,
 * which is where M1 stops.
 *
 * This carries the same upload three milestones further — approval, publish, and the shard
 * a browser actually reads — and swaps the video for a photograph, because the one launch
 * gate that has never run against the network is about a JPEG:
 *
 *     §11 gate 2 — "EXIF stripping verified on a real photo carrying GPS data, end to end."
 *
 * worker/scripts/exif-gate.ts already proves the pipeline strips it. It says so itself in
 * its closing section: it runs against LocalStore, so "end to end" in §11's sense — a real
 * R2 quarantine bucket, the real container, the object fetched back over the CDN — is
 * precisely the part it does not cover. That is this file's reason to exist.
 *
 * ── What it asserts, and why each one is not redundant ───────
 *
 *   0  the worker's front door: /healthz, and an unsigned job refused 401. 401 is the
 *      HEALTHY answer (§6: the HMAC is the gate), so it is asserted as a pass.
 *   1  a member signs up and claims a slot through the quota path.
 *   2  a real photograph carrying real GPS rationals reaches quarantine over the wire.
 *   3  `complete-upload` dispatches the job for real — the hop that was dead until
 *      MEDIA_WORKER_URL was set — and the DEPLOYED container finishes post-response work.
 *      That last part is the property the 24 Aug heartbeat probe showed `min-scale=0`
 *      does not have.
 *   4  §11 gate 2, over the CDN: the derivative a visitor can actually fetch carries no
 *      GPS, in any container, by any encoding. Fetched from the public origin, not read
 *      from a bucket with a credential — a browser is what the gate is about.
 *   5  §6's other half, which a naive "no EXIF anywhere" test would destroy silently: the
 *      master in `originals/` is byte-identical AND still carries the coordinates. It is
 *      the preservation copy and it is never CDN-fronted, so it is allowed to.
 *   6  a moderator approves it under RLS — as the moderator, not as service_role, so the
 *      policy is what admits the write rather than a key that outranks it.
 *   7  publish flips the pointer.
 *   8  the item is in the feed shard the front end reads, and has a prerendered page with
 *      OG tags at the bucket root (§9).
 *
 * ── The fixture, and why the GPS is synthetic ────────────────
 *
 * The photograph is real and comes from `fottage/`, which is git-ignored. The coordinates
 * injected into it are Al-Manara, Ramallah — a public square, not anybody's home, and not
 * where the photograph was taken. exif-gate.ts makes the same choice for the same reason:
 * committing a real photograph carrying somebody's real location, in order to prove that we
 * remove locations, would be a poor joke. Nothing here is written back to the repository.
 *
 * ── The bearer-token trap, because it will bite again ────────
 *
 * SUPABASE_SERVICE_ROLE_KEY must be the LEGACY service-role JWT, not `sb_secret_...`.
 * PostgREST parses a JWT out of `Authorization: Bearer`, so the new format answers
 * 401 PGRST301 "Expected 3 parts in JWT; got 1". See docs/session-report-2026-08-24.md §2.2.
 */

import { R2Store } from "../worker/src/store.ts";
import {
  buildExifApp1,
  gpsWireBytes,
  indexOfBytes,
  injectExif,
  jpegMarkers,
  RAMALLAH,
  readGps,
  riffChunks,
} from "../worker/scripts/lib/exif.ts";

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const ANON_KEY = env("SUPABASE_ANON_KEY");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const WORKER_URL = env("MEDIA_WORKER_URL").replace(/\/$/, "");
const WORKER_SECRET = env("MEDIA_WORKER_SECRET");
const CDN_ORIGIN = env("CDN_ORIGIN").replace(/\/$/, "");
const PUBLISH_SECRET = env("PUBLISH_SECRET");
const SOURCE = env("E2E_SOURCE", "fottage/صورة (1).JPG");
const PASSWORD = "e2e-deployed-harness-password-1";

/* The caption is the second half of the leak test. Coordinates can be argued away as
   numbers that might coincide; this string cannot appear in a clean derivative by accident. */
const DESCRIPTION = "SENSITIVE-CAPTION-DO-NOT-PUBLISH";
const LAT_WIRE = gpsWireBytes(RAMALLAH.latitude);
const LON_WIRE = gpsWireBytes(RAMALLAH.longitude);
const CAPTION_WIRE = new TextEncoder().encode(DESCRIPTION);

/* Counted, not just failed: a run that exits early with nothing wrong is otherwise
   indistinguishable from a run that verified everything. */
let executed = 0;
const failures: string[] = [];
function ck(cond: boolean, msg: string): void {
  executed++;
  console.log(`  ${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures.push(msg);
}

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function sha256(bytes: Uint8Array): Promise<string> {
  // Copied into a fresh ArrayBuffer rather than passed straight through: a Uint8Array can
  // be backed by a SharedArrayBuffer, which digest() does not accept, and the compiler is
  // right to say so.
  const d = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same HMAC `complete-upload` computes; the timestamp is inside the signed body. */
async function signJob(job: Record<string, unknown>, secret: string) {
  const body = JSON.stringify({ ...job, issued_at: new Date().toISOString() });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return {
    body,
    signature: Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

async function rpc(name: string, args: unknown, jwt: string): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(args),
  });
}

/** Every account this run made, so the archive is not left littered with them. */
const created: string[] = [];

/**
 * A confirmed member, made through the ADMIN API rather than `/auth/v1/signup`.
 *
 * Not a shortcut, and worth stating because it is a real gap in what this file proves. Two
 * things block the public path from a harness, and neither is a defect:
 *
 *   · the deployed project rejects `example.com` and `.test` outright
 *     (`email_address_invalid`), so a throwaway address has to look real;
 *   · email confirmation is ON, so signup sends a message and returns no session at all —
 *     and the project's send quota answers `over_email_send_rate_limit` well before a
 *     sweep of these finishes.
 *
 * So the account is created confirmed, and then signed in with a password like anybody
 * else. Everything after this line is the real token path. What is NOT covered is the
 * public sign-up itself — Turnstile and the confirmation round-trip — which is the same
 * boundary that keeps `request-upload` out of reach here.
 */
async function createMember(label: string): Promise<{ jwt: string; id: string; email: string }> {
  const email = `e2e-${label}-${crypto.randomUUID()}@mail.example.com`;
  const made = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...svc },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
  });
  const user = await made.json();
  if (!made.ok || !user?.id) {
    throw new Error(`admin create failed (${made.status}): ${JSON.stringify(user)}`);
  }
  created.push(user.id);

  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const out = await res.json();
  if (!out.access_token) throw new Error(`sign-in failed (${res.status}): ${JSON.stringify(out)}`);
  return { jwt: out.access_token, id: user.id, email };
}

const store = new R2Store({
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  bucketPrefix: Deno.env.get("R2_BUCKET_PREFIX") ?? "",
});

console.log(`\nThe contributor's journey, against the deployed system`);
console.log(`  supabase ${SUPABASE_URL}`);
console.log(`  worker   ${WORKER_URL}`);
console.log(`  cdn      ${CDN_ORIGIN}`);
console.log(`  source   ${SOURCE}\n`);

/* ── 0 · the worker's front door ────────────────────────────── */

console.log("0 · the worker's front door");
{
  const health = await fetch(`${WORKER_URL}/healthz`);
  ck(health.ok, `GET /healthz answers ${health.status}`);

  const unsigned = await fetch(`${WORKER_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ object_key: "x", post_id: "y" }),
  });
  ck(unsigned.status === 401, `POST /jobs unsigned is refused 401 (got ${unsigned.status})`);

  const bad = await signJob({ object_key: "x", post_id: "y" }, WORKER_SECRET + "x");
  const badRes = await fetch(`${WORKER_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": bad.signature },
    body: bad.body,
  });
  ck(badRes.status === 401, `POST /jobs wrongly signed is refused 401 (got ${badRes.status})`);
}

/* ── 1 · the fixture, checked before it is trusted ──────────── */

console.log("\n1 · the photograph, carrying real GPS");
const original = await Deno.readFile(SOURCE);
const carrying = injectExif(original, buildExifApp1(RAMALLAH, DESCRIPTION));
{
  // A fixture with no GPS would pass every check below without the pipeline doing anything.
  const gps = readGps(carrying);
  ck(gps !== null, `the fixture carries GPS — otherwise every check below is vacuous`);
  ck(
    gps !== null && Math.abs(gps.latitude - RAMALLAH.latitude) < 1e-6 &&
      Math.abs(gps.longitude - RAMALLAH.longitude) < 1e-6,
    `it reads back as ${gps?.latitude},${gps?.longitude}`,
  );
  ck(jpegMarkers(carrying)[0] === 0xffe1, `the APP1 sits where a camera puts it`);
  ck(indexOfBytes(carrying, LAT_WIRE) !== -1, `the latitude rationals are in the bytes`);
  ck(indexOfBytes(carrying, CAPTION_WIRE) !== -1, `the caption is in the bytes`);
}

const scratch = await Deno.makeTempDir({ prefix: "rma-e2e-" });
const fixturePath = `${scratch}/carrying.jpg`;
await Deno.writeFile(fixturePath, carrying);
const sourceHash = await sha256(carrying);

/* ── 2 · a member claims a slot and the bytes reach quarantine ─ */

console.log("\n2 · the member, the slot, and the bytes");
const member = await createMember("member");
let postId = "";
let objectKey = "";
{
  ck(!!member.jwt, `signed up a member`);

  const res = await rpc("claim_upload_slot", {
    p_bytes: carrying.length,
    p_object_key: `${member.id}/${crypto.randomUUID()}`,
    p_kind: "media",
    p_draft: {
      title_en: "Deployed end-to-end verification",
      title_ar: "تحقّق شامل من النشر",
      body_en: "archival description written by scripts/e2e-deployed.ts",
      body_ar: "وصف أرشيفي",
      license: "CC-BY-SA-4.0",
      provenance: "harness fixture; no provenance claim is made",
      consent: { granted: true },
      decade: "1980",
    },
  }, member.jwt);
  const claim = await res.json();
  ck(
    res.ok && claim?.allowed === true,
    `claim_upload_slot granted (${res.status}${claim?.reason ? ` — ${claim.reason}` : ""})`,
  );
  postId = claim.post_id ?? "";
  objectKey = claim.object_key ?? "";
  if (!postId || !objectKey) throw new Error(`unexpected claim shape: ${JSON.stringify(claim)}`);
  ck(true, `post ${postId}`);

  const n = await store.upload("quarantine", objectKey, fixturePath, "image/jpeg");
  ck(n === carrying.length, `uploaded ${n} bytes to quarantine/`);
}

/* ── 3 · complete-upload dispatches, the worker works ───────── */

console.log("\n3 · complete-upload dispatches, and the deployed worker works");
{
  // The REAL hop, not a hand-signed job. This is the one that was dead — MEDIA_WORKER_URL
  // unset meant a 503 `worker_not_configured` — so signing the job here ourselves would
  // skip the exact thing the deployment was for.
  //
  // It also covers begin_ingest, which this function calls itself. Calling that first, as
  // an earlier draft of this file did, moves the row to 'processing' and complete-upload
  // then answers 200 already_processing having invoked nobody — a green run that proves
  // the opposite of what it claims.
  //
  // request-upload remains uncovered: it wants a real Turnstile token from a browser, and
  // the project holds the real secret rather than Cloudflare's always-pass test one.
  const res = await fetch(`${SUPABASE_URL}/functions/v1/complete-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${member.jwt}`,
    },
    body: JSON.stringify({ object_key: objectKey }),
  });
  const out = await res.json().catch(() => ({}));
  ck(
    res.status === 202 && out?.status === "processing",
    `complete-upload handed the job over (${res.status} ${JSON.stringify(out)})`,
  );
  ck(out?.post_id === postId, `it names the post the slot claimed`);

  // Poll the row, not the worker: it answered and went quiet by design.
  const startedAt = Date.now();
  let state = "";
  let err: unknown = null;
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=ingest_state,ingest_error`,
      { headers: svc },
    );
    // A 401 here is the bearer-token trap. Unreported it would poll silently and then fail
    // as "never reached ready", which is the wrong diagnosis entirely.
    if (!r.ok) {
      throw new Error(
        `polling posts failed ${r.status}: ${await r.text()}\n` +
          `  SUPABASE_SERVICE_ROLE_KEY must be the LEGACY service-role JWT, not sb_secret_...`,
      );
    }
    const rows = await r.json();
    state = rows[0]?.ingest_state ?? "";
    err = rows[0]?.ingest_error ?? null;
    if (state === "ready" || state === "failed") break;
    console.log(`      … ${state || "?"} at ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  }
  ck(state === "ready", `ingest reached 'ready' (got '${state}'${err ? ` — ${JSON.stringify(err)}` : ""})`);
  console.log(`      took ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
}

/* ── 4 · §11 gate 2, over the CDN ───────────────────────────── */

console.log("\n4 · §11 gate 2 — the derivative a visitor can fetch");
const assetsRes = await fetch(
  `${SUPABASE_URL}/rest/v1/media_assets?post_id=eq.${postId}&select=role,rendition,bucket,storage_path,bytes,mime`,
  { headers: svc },
);
const assets: Array<Record<string, string>> = assetsRes.ok ? await assetsRes.json() : [];
const master = assets.find((a) => a.role === "master");
const published = assets.filter((a) => a.bucket === "public");
{
  ck(assets.length > 0, `${assets.length} media_assets rows exist`);
  ck(!!master && master.bucket === "originals", `the master says bucket='originals'`);
  ck(published.length > 0, `${published.length} rows are in public/`);

  for (const a of published) {
    const res = await fetch(`${CDN_ORIGIN}/${a.storage_path}`);
    if (!res.ok) {
      ck(false, `${a.role} is reachable over the CDN (got ${res.status} for ${a.storage_path})`);
      continue;
    }
    ck(true, `${a.role}${a.rendition ? ` ${a.rendition}` : ""} is served by the CDN (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());

    // Stated in the container it is supposed to be …
    const chunks = riffChunks(bytes);
    ck(!chunks.includes("EXIF"), `${a.role} carries no EXIF chunk`);
    ck(!chunks.includes("XMP "), `${a.role} carries no XMP chunk`);
    // … and again without believing anything about the container. This is the check that
    // does the real work: it finds the coordinates wherever they are, in whatever the file
    // turned out to be — including a file that is not a WebP at all.
    ck(indexOfBytes(bytes, LAT_WIRE) === -1, `${a.role} does not contain the latitude rationals (§7)`);
    ck(indexOfBytes(bytes, LON_WIRE) === -1, `${a.role} does not contain the longitude rationals (§7)`);
    ck(indexOfBytes(bytes, CAPTION_WIRE) === -1, `${a.role} does not contain the source caption`);
    ck(readGps(bytes) === null, `${a.role} yields no GPS when parsed as a JPEG either`);
  }
}

/* ── 5 · §6's other half — preservation ─────────────────────── */

console.log("\n5 · the master is intact, and NOT reachable over the CDN");
{
  const tmp = await Deno.makeTempFile();
  await store.download("originals", master!.storage_path, tmp);
  const back = await Deno.readFile(tmp);
  await Deno.remove(tmp);
  ck(back.length === carrying.length, `the archived master is ${back.length} bytes, as uploaded`);
  ck(await sha256(back) === sourceHash, `the archived master is byte-identical (SHA-256)`);
  // The direction a naive "no EXIF anywhere" test would destroy in silence.
  ck(readGps(back) !== null, `the archival copy still carries its GPS — §6 says untouched`);

  const leak = await fetch(`${CDN_ORIGIN}/${master!.storage_path}`);
  ck(
    leak.status === 403 || leak.status === 404,
    `originals/ is NOT served by ${CDN_ORIGIN} (got ${leak.status})`,
  );

  let quarantineErr = "";
  try {
    await store.head("quarantine", objectKey, 8);
  } catch (e) {
    quarantineErr = e instanceof Error ? e.message : String(e);
  }
  ck(
    /: 404$/.test(quarantineErr),
    `the quarantine object was removed — R2 says 404 (got ${quarantineErr || "still there"})`,
  );
}

/* ── 6 · a moderator approves it, under RLS ─────────────────── */

console.log("\n6 · approval, as the moderator rather than as service_role");
{
  const mod = await createMember("moderator");
  // user_roles is service-role only by design (§4): the role may not come from anything the
  // browser can write. Granting it is an operator act, so it is the only step here that
  // legitimately uses the service key.
  const grant = await fetch(`${SUPABASE_URL}/rest/v1/user_roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates", ...svc },
    body: JSON.stringify({ user_id: mod.id, role: "moderator" }),
  });
  ck(grant.ok, `granted the moderator role (${grant.status})`);

  // A fresh session, so the JWT carries the claim the hook mints. RLS reads authz_role()
  // rather than the claim, but the admin UI reads the claim, and signing in again is what a
  // moderator would actually do.
  const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email: mod.email, password: PASSWORD }),
  });
  const session = await signIn.json();
  const modJwt = session.access_token ?? mod.jwt;

  // `select=id,status` is load-bearing, not tidiness. `Prefer: return=representation`
  // without it makes PostgREST do RETURNING *, which needs SELECT on EVERY column —
  // and 0015 grants `authenticated` a subset, deliberately (location, consent, created_by,
  // the approval stamps). The whole statement then fails 42501 "permission denied for
  // table posts" before RLS is ever consulted.
  //
  // That cost this harness a false pass: the member check below read any 403 as proof the
  // policy had refused, and the privilege error is a 403 too. It would have gone green
  // against a database that let members approve their own uploads.
  const patch = (jwt: string) =>
    fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=id,status`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: ANON_KEY,
        Authorization: `Bearer ${jwt}`,
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status: "approved" }),
    });

  /** The row as only the service key can see it. The assertion that actually matters. */
  const statusNow = async (): Promise<string> => {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=status`, {
      headers: svc,
    });
    return (await r.json())[0]?.status ?? "";
  };

  // The member must NOT be able to approve their own upload. Asserted before the moderator
  // does, because "the moderator could" means nothing if everyone else could too — and
  // asserted on the STORED status rather than on a status code, so that a refusal for the
  // wrong reason cannot be mistaken for the policy doing its job.
  const asMember = await patch(member.jwt);
  const memberBody = await asMember.text();
  ck(!asMember.ok, `the member's approval is refused (${asMember.status})`);
  ck(
    /row-level security/i.test(memberBody),
    `refused by the RLS policy, not by a column grant (${memberBody.slice(0, 120)})`,
  );
  ck(await statusNow() === "pending", `and the stored status is still 'pending'`);

  const approve = await patch(modJwt);
  const rows = approve.ok ? await approve.json() : [];
  ck(approve.ok && rows.length === 1, `the moderator approved it (${approve.status})`);

  // §5: the trigger stamps the approver and the hash. The publisher refuses rows whose hash
  // no longer matches, so an unstamped row would be a release that silently omits the item.
  const after = await fetch(
    `${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=status,approved_by,approved_at,content_hash`,
    { headers: svc },
  );
  const [row] = await after.json();
  ck(row?.status === "approved", `status is 'approved'`);
  ck(row?.approved_by === mod.id, `approved_by names the moderator`);
  ck(!!row?.approved_at, `approved_at is stamped`);
  ck(!!row?.content_hash, `content_hash is recorded (§5)`);
}

/* ── 7 · publish ────────────────────────────────────────────── */

console.log("\n7 · publish flips the pointer");
let release = "";
{
  const before = await fetch(`${CDN_ORIGIN}/manifest.json?cb=${Date.now()}`);
  const beforeRelease = before.ok ? (await before.json()).release : "";

  const res = await fetch(`${SUPABASE_URL}/functions/v1/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PUBLISH_SECRET}` },
  });
  const out = await res.json();
  ck(res.ok && out?.published === true, `publish returned ${res.status} ${JSON.stringify(out)}`);
  release = out?.release ?? "";

  const after = await fetch(`${CDN_ORIGIN}/manifest.json?cb=${Date.now()}`);
  const afterRelease = after.ok ? (await after.json()).release : "";
  ck(after.ok, `manifest.json is served (${after.status})`);
  ck(afterRelease === release, `manifest.json names the new release ${afterRelease}`);
  ck(afterRelease !== beforeRelease, `the pointer moved (was ${beforeRelease || "unset"})`);
}

/* ── 8 · the item is in what a browser reads ────────────────── */

console.log("\n8 · the shards, and the permalink");
{
  const base = `${CDN_ORIGIN}${release}`.replace(/\/$/, "");

  const feedRes = await fetch(`${base}/feed/page-1.json`);
  ck(feedRes.ok, `feed/page-1.json is served (${feedRes.status})`);
  const feed = feedRes.ok ? await feedRes.json() : { items: [] };
  const items: Array<Record<string, unknown>> = feed.items ?? feed.posts ?? [];
  const mine = items.find((i) => i.id === postId);
  ck(!!mine, `the item is in the feed shard (${items.length} items)`);

  const itemRes = await fetch(`${base}/item/${postId}.json`);
  ck(itemRes.ok, `item/${postId}.json is served (${itemRes.status})`);

  // §9: the prerendered page is at the ROOT of the bucket, not under /v/ — a permalink
  // must not require resolving the pointer first.
  const pageRes = await fetch(`${CDN_ORIGIN}/item/${postId}/index.html`);
  ck(pageRes.ok, `the prerendered page is served (${pageRes.status})`);
  if (pageRes.ok) {
    const html = await pageRes.text();
    ck(/<meta[^>]+og:title/i.test(html), `it carries an og:title`);
    ck(/<meta[^>]+og:image/i.test(html), `it carries an og:image`);
    ck(
      indexOfBytes(new TextEncoder().encode(html), CAPTION_WIRE) === -1,
      `it does not carry the source caption`,
    );
  }
}

/* ── what this run left behind ──────────────────────────────── */
//
// Deliberately NOT cleaned up. The post is published, which is the thing the run set out to
// demonstrate, and the two accounts are referenced by it — `created_by` on the post and
// `approved_by` on the approval. Deleting them to tidy up would break the row the archive
// is now serving, so removal is a takedown (§8) plus a publish, not a DELETE here.
console.log(`\nleft in the archive, remove deliberately rather than by cleanup:`);
console.log(`  post      ${postId}`);
for (const id of created) console.log(`  auth user ${id}`);

console.log(`\n${executed} checks, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  Deno.exit(1);
}
console.log(`\npost_id ${postId} is approved and published in release ${release}.\n`);
