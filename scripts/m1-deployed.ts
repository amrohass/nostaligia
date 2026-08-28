/* M1's exit criterion, against the deployed system. The one thing no other harness can do.
 *
 *     deno run --allow-net --allow-env --allow-read --allow-write scripts/m1-deployed.ts
 *
 * §10's M1 exit criterion is: "Full contribution lifecycle works; every unauthorized
 * variant is refused; a 4K master survives intact in `originals/` while only renditions are
 * CDN-reachable."
 *
 * scripts/lifecycle/run.ts says in its own header that it does NOT prove this, and it is
 * right: it runs against MinIO on localhost with a worker container on a docker network.
 * Its check "no originals/ object reachable through the public path" is explicitly a
 * BUCKET-POLICY PROXY — a claim about what our code told the database, not about whether a
 * CDN would serve the bytes. That assertion needs a real R2 bucket and a real public
 * origin, which is what this file uses.
 *
 * ── What this proves that the lifecycle harness cannot ───────
 *
 *  1. The master in `originals/` is byte-identical to what was uploaded — compared by
 *     SHA-256 over the object downloaded back out of R2, not by trusting a size field.
 *  2. The `originals/` key is NOT retrievable through the public CDN origin. This is a
 *     live HTTP fetch against the public host, so it fails if the bucket binding is wrong
 *     regardless of what the database was told.
 *  3. The renditions ARE retrievable through that same origin — otherwise (2) would pass
 *     trivially on a CDN that serves nothing at all, which is the failure mode that makes
 *     a negative assertion worthless on its own.
 *  4. The deployed worker, on the deployed platform, finishes post-response work. That is
 *     the property the 24 Aug heartbeat probe showed `min-scale=0` does not have.
 *
 * ── What it still does not prove ─────────────────────────────
 *
 *  · NOT the `request-upload` hop. That gate wants a real Turnstile token from a browser,
 *    and the deployed project holds the real secret rather than Cloudflare's always-pass
 *    test secret. The slot is claimed by calling `claim_upload_slot` directly as the
 *    signed-in member, which exercises the quota, the draft parsing and the RLS path but
 *    NOT the Turnstile gate or the presigner. Those have their own tests.
 *  · NOT a true 3840x2160 source. `fottage/` has no such file — a documented gap. The
 *    largest real master available is 2730x1440, so "4K" below means "the largest real
 *    master we hold", and the rung count is identical either way because §6 never makes a
 *    2160p rendition.
 *
 * ── The bearer-token trap, because it will bite again ────────
 *
 * SUPABASE_SERVICE_ROLE_KEY must be the LEGACY service-role JWT, not the new
 * `sb_secret_...` value. PostgREST parses a JWT out of `Authorization: Bearer`, so the new
 * format answers 401 PGRST301 "Expected 3 parts in JWT; got 1". The `apikey` header accepts
 * either. See docs/session-report-2026-08-24.md §2.2.
 */

import { R2Store } from "../worker/src/store.ts";

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
const SOURCE = env("M1_SOURCE", "fottage/4k.mp4");
const PASSWORD = "m1-deployed-harness-password-1";

/* Counted, not just failed. A run that exits early with nothing wrong is indistinguishable
   from a run that verified everything if only failures are recorded — the same argument
   scripts/lifecycle/run.ts makes about its own `executed` floor. */
let executed = 0;
const failures: string[] = [];
function ck(cond: boolean, msg: string): void {
  executed++;
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const svc = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same HMAC `complete-upload` computes. The timestamp is inside the signed body so a
    signature cannot outlive its window. */
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
  const signature = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return { body, signature };
}

async function rpc(name: string, args: unknown, jwt: string): Promise<Response> {
  return await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(args),
  });
}

const store = new R2Store({
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  bucketPrefix: Deno.env.get("R2_BUCKET_PREFIX") ?? "",
});

console.log(`\nM1 against the deployed system`);
console.log(`  supabase ${SUPABASE_URL}`);
console.log(`  worker   ${WORKER_URL}`);
console.log(`  cdn      ${CDN_ORIGIN}`);
console.log(`  source   ${SOURCE}\n`);

/* ── 0 · The worker is up and refuses an unsigned job ───────── */

console.log("0 · the worker's front door");
{
  const health = await fetch(`${WORKER_URL}/healthz`);
  ck(health.ok, `GET /healthz answers ${health.status}`);

  const unsigned = await fetch(`${WORKER_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ object_key: "x", post_id: "y" }),
  });
  // 401 is the CORRECT healthy answer here, not a failure. The HMAC is the gate (§6).
  ck(unsigned.status === 401, `POST /jobs unsigned is refused 401 (got ${unsigned.status})`);

  const bad = await signJob({ object_key: "x", post_id: "y" }, WORKER_SECRET + "x");
  const badRes = await fetch(`${WORKER_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": bad.signature },
    body: bad.body,
  });
  ck(badRes.status === 401, `POST /jobs with a wrong-key signature is refused 401 (got ${badRes.status})`);
}

/* ── 1 · A member claims a slot ─────────────────────────────── */

console.log("\n1 · the member and the slot");
const email = `m1-deployed-${crypto.randomUUID()}@example.test`;
let jwt = "";
let postId = "";
let objectKey = "";
{
  const su = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const out = await su.json();
  jwt = out.access_token ?? "";
  ck(!!jwt, `signed up a member (${su.status})`);
  if (!jwt) throw new Error(`no session: ${JSON.stringify(out)}`);

  const bytes = (await Deno.stat(SOURCE)).size;
  const res = await rpc("claim_upload_slot", {
    p_bytes: bytes,
    p_object_key: `${out.user.id}/${crypto.randomUUID()}`,
    p_kind: "media",
    p_draft: {
      title_en: "M1 deployed verification",
      title_ar: "تحقّق النشر",
      body_en: "archival description written by scripts/m1-deployed.ts",
      license: "CC-BY-SA-4.0",
      provenance: "generated fixture, no provenance claim",
      consent: { granted: true },
    },
  }, jwt);
  const claim = await res.json();
  // The success shape is the quota object merged with the two ids, so the field is
  // `allowed` — not `ok`, which is what begin_ingest below returns. Checking the wrong one
  // would make a refusal read as a pass and then fail confusingly three steps later.
  ck(res.ok && claim?.allowed === true, `claim_upload_slot granted (${res.status}${claim?.reason ? ` — ${claim.reason}` : ""})`);
  postId = claim.post_id ?? "";
  objectKey = claim.object_key ?? "";
  ck(!!postId && !!objectKey, `slot names a post and an object key`);
  if (!postId || !objectKey) throw new Error(`unexpected claim shape: ${JSON.stringify(claim)}`);
}

/* ── 2 · The bytes reach quarantine ─────────────────────────── */

console.log("\n2 · the master reaches quarantine");
const sourceBytes = await Deno.readFile(SOURCE);
const sourceHash = await sha256(sourceBytes);
{
  const n = await store.upload("quarantine", objectKey, SOURCE, "video/mp4");
  ck(n === sourceBytes.length, `uploaded ${n} bytes to quarantine/`);

  const begin = await fetch(`${SUPABASE_URL}/rest/v1/rpc/begin_ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...svc },
    body: JSON.stringify({ p_object_key: objectKey }),
  });
  const b = await begin.json();
  ck(begin.ok && b?.ok !== false, `begin_ingest moved the row to processing (${begin.status})`);
}

/* ── 3 · The deployed worker does the work ──────────────────── */

console.log("\n3 · the deployed worker");
const startedAt = Date.now();
{
  const { body, signature } = await signJob({ object_key: objectKey, post_id: postId }, WORKER_SECRET);
  const res = await fetch(`${WORKER_URL}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": signature },
    body,
  });
  ck(res.status === 202, `signed job accepted 202 (got ${res.status})`);

  // Poll the row rather than the worker: the worker answered and went quiet by design.
  let state = "";
  let err: unknown = null;
  const deadline = Date.now() + 90 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15000));
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=ingest_state,ingest_error`,
      { headers: svc },
    );
    // A 401 here is the bearer-token trap (a `sb_secret_...` value where PostgREST wants a
    // JWT). Left unreported it would poll silently for the full 90 minutes and then fail as
    // "never reached ready", which is the wrong diagnosis entirely.
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
    const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`      … ${state || "?"} at ${mins}m`);
  }
  ck(state === "ready", `ingest reached 'ready' (got '${state}'${err ? ` — ${JSON.stringify(err)}` : ""})`);
  console.log(`      took ${((Date.now() - startedAt) / 60000).toFixed(1)} minutes`);
}

/* ── 4 · M1's actual sentence ───────────────────────────────── */

console.log("\n4 · the master is intact, and only renditions are CDN-reachable");
{
  const assetsRes = await fetch(
    `${SUPABASE_URL}/rest/v1/media_assets?post_id=eq.${postId}&select=role,rendition,bucket,storage_path,bytes`,
    { headers: svc },
  );
  const assets: Array<Record<string, string>> = assetsRes.ok ? await assetsRes.json() : [];
  const master = assets.find((a) => a.role === "master");
  const renditions = assets.filter((a) => a.role === "rendition");

  ck(!!master, `a master row exists`);
  ck(master?.bucket === "originals", `the master says bucket='originals' (got '${master?.bucket}')`);
  ck(renditions.length > 0, `${renditions.length} rendition rows exist`);
  ck(
    renditions.every((r) => r.bucket === "public"),
    `every rendition says bucket='public'`,
  );
  ck(
    !assets.some((a) => a.bucket === "originals" && a.role !== "master"),
    `nothing but the master is in originals/`,
  );

  // (1) byte-identical, verified by hashing what R2 actually holds.
  const tmp = await Deno.makeTempFile();
  await store.download("originals", master!.storage_path, tmp);
  const back = await Deno.readFile(tmp);
  await Deno.remove(tmp);
  ck(back.length === sourceBytes.length, `the archived master is ${back.length} bytes, as uploaded`);
  ck(await sha256(back) === sourceHash, `the archived master is byte-identical (SHA-256)`);

  // (2) the negative: originals must NOT be served by the public origin.
  const leak = await fetch(`${CDN_ORIGIN}/${master!.storage_path}`);
  ck(
    leak.status === 403 || leak.status === 404,
    `originals/ is NOT reachable through ${CDN_ORIGIN} (got ${leak.status})`,
  );

  // (3) the positive, so the negative above cannot pass on a CDN that serves nothing.
  const rend = renditions[0];
  const served = await fetch(`${CDN_ORIGIN}/${rend.storage_path}`);
  ck(served.ok, `a rendition IS reachable through the CDN (${served.status} for ${rend.storage_path})`);

  // The quarantine copy is cleaned up (step 9 of the pipeline).
  //
  // The status is asserted, not merely the throw. `head` raises on ANY non-2xx and on a
  // network error alike, so a bare try/catch here would report "removed" when the real
  // answer was 403 (a credential that cannot see the bucket) or a DNS failure — a check
  // that passes under the broken implementation as readily as the correct one.
  let quarantineErr = "";
  try {
    await store.head("quarantine", objectKey, 8);
  } catch (e) {
    quarantineErr = e instanceof Error ? e.message : String(e);
  }
  ck(
    /: 404$/.test(quarantineErr),
    `the quarantine object was removed — R2 says 404 (got ${quarantineErr || "the object is still there"})`,
  );
}

console.log(`\n${executed} checks, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  Deno.exit(1);
}
console.log(`post_id ${postId} is left in the archive as pending — approve it to drive M3.\n`);
