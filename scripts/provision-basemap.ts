/* Put the PMTiles basemap in the `public` bucket, then prove the CDN in front of it can
 * actually serve the format.
 *
 *     deno run --allow-net --allow-env --allow-read scripts/provision-basemap.ts \
 *       --file <local.pmtiles> --key basemap/<name>.pmtiles
 *
 * CLAUDE.md §2 names two things to provision for M4 and says neither is code. This script
 * is not the code they were excluded from being — it is the act of provisioning, written
 * down so it is repeatable and so the second half is CHECKED rather than assumed.
 *
 * ── The upload is the easy half ──────────────────────────────
 *
 * §2: "the CDN in front of R2 must pass Range requests through and allow the `Range` header
 * in CORS. A server that answers a range request with the whole file is refused by
 * pmtiles.js rather than sliced — quietly downloading a multi-megabyte archive on a phone
 * to read 127 bytes is the failure the whole format exists to avoid, and it must not be the
 * thing that 'works'."
 *
 * So this script ends by doing exactly what a browser does: ask for the first 127 bytes and
 * insist on a 206 with 127 bytes in it. A 200 fails the run. That check is the entire reason
 * this is a script rather than two shell commands — the upload succeeding tells you nothing
 * about whether the map will draw.
 *
 * ── Why it signs with the repository's own R2 client ─────────
 *
 * `worker/src/store.ts` is the signer already exercised against a real S3 implementation in
 * CI and against real R2 by the deployed harnesses. A second signing path here would be a
 * new credential and a new address in one file, which this project's own record says is
 * where wiring defects come from.
 */

import { R2Store } from "../worker/src/store.ts";

/* ── Arguments ─────────────────────────────────────────────── */

function arg(name: string): string | null {
  const i = Deno.args.indexOf("--" + name);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}

const file = arg("file");
const key = arg("key");
if (!file || !key) {
  console.error(
    "usage: provision-basemap.ts --file <local.pmtiles> --key basemap/<name>.pmtiles",
  );
  Deno.exit(2);
}
if (!key.endsWith(".pmtiles")) {
  console.error("--key must end in .pmtiles; build-site-config.mjs refuses anything else");
  Deno.exit(2);
}

/* ── The archive, checked before it is uploaded ─────────────── */
//
// A PMTiles v3 header is 127 bytes beginning "PMTiles" and carrying the spec version at
// byte 7. pmtiles.js checks exactly this and raises `map.err.version` otherwise. Checking it
// here means a wrong file is caught before 180 MB crosses the wire rather than after.

const head = new Uint8Array(127);
using fh = await Deno.open(file, { read: true });
const readCount = await fh.read(head);
if (readCount !== 127) {
  console.error(`${file}: shorter than a PMTiles header`);
  Deno.exit(1);
}
const magic = new TextDecoder().decode(head.slice(0, 7));
if (magic !== "PMTiles") {
  console.error(`${file}: not a PMTiles archive (magic ${JSON.stringify(magic)})`);
  Deno.exit(1);
}
if (head[7] !== 3) {
  console.error(`${file}: PMTiles spec version ${head[7]}, and pmtiles.js reads v3 only`);
  Deno.exit(1);
}

const bytes = (await Deno.stat(file)).size;
console.log(`archive  ${file}`);
console.log(`         PMTiles v3, ${(bytes / 1024 / 1024).toFixed(1)} MiB`);

/* ── Upload ────────────────────────────────────────────────── */

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    console.error(`missing ${name} — source it from worker/.dev.vars, never commit it`);
    Deno.exit(2);
  }
  return v;
}

const store = new R2Store({
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  // Unset means no prefix, which is what MinIO and CI use. Against real R2 the physical
  // buckets are `nostaligia-*` while the Bucket union stays logical — the same trap
  // scripts/lifecycle/run.ts carries a comment about, and the same NoSuchBucket if omitted.
  bucketPrefix: Deno.env.get("R2_BUCKET_PREFIX") ?? "",
});

console.log(`upload   public/${key}`);
// The registered type. `application/octet-stream` would also work for Range, but a CDN that
// decides compression by content type must not try to gzip an already-gzipped archive.
const uploaded = await store.upload("public", key, file, "application/vnd.pmtiles");
console.log(`         ${uploaded} bytes`);

/* ── The half that actually decides whether the map draws ──── */

const origin = arg("origin") ?? Deno.env.get("CDN_ORIGIN") ?? "";
if (!origin) {
  console.log("");
  console.log("Range check SKIPPED — pass --origin https://<cdn> to run it.");
  console.log("The upload proves storage. It proves nothing about whether the map draws.");
  Deno.exit(0);
}

const url = `${origin.replace(/\/$/, "")}/${key}`;
console.log("");
console.log(`range    ${url}`);

let failed = false;
function check(ok: boolean, msg: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${msg}`);
  if (!ok) failed = true;
}

// Exactly what pmtiles.js asks for on its first call: the 127-byte header.
const res = await fetch(url, { headers: { Range: "bytes=0-126" } });
const body = new Uint8Array(await res.arrayBuffer());

// 206 and ONLY 206. A 200 here means the CDN ignored the header and sent the whole archive,
// which is the failure §2 says must not be the thing that "works".
check(res.status === 206, `206 Partial Content (got ${res.status})`);
check(body.length === 127, `127 bytes returned (got ${body.length})`);
check(
  new TextDecoder().decode(body.slice(0, 7)) === "PMTiles",
  "the bytes are the archive header, not an error page",
);
check(
  (res.headers.get("Content-Range") ?? "").startsWith("bytes 0-126/"),
  `Content-Range names the slice (got ${JSON.stringify(res.headers.get("Content-Range"))})`,
);

// A second, non-zero range. A server that answers the FIRST range correctly and then serves
// from a cache keyed without the header gets this one wrong, and a map that draws its
// header and no tiles is the symptom.
const mid = await fetch(url, { headers: { Range: "bytes=1000-1063" } });
check(mid.status === 206, `a second range is also 206 (got ${mid.status})`);
check(
  (await mid.arrayBuffer()).byteLength === 64,
  "...and returns its 64 bytes",
);

/* ── CORS, and why this one is a warning ────────────────────
 *
 * The obvious reading is that a cross-origin `Range` request is preflighted, so `Range`
 * must be in the bucket's Access-Control-Allow-Headers or the fetch never leaves the
 * browser. That is what this check originally asserted, and it FAILED the run against a
 * bucket the map then worked perfectly through.
 *
 * Measured 29 Aug 2026 with headless Chromium, from a page on the real site origin: the
 * browser sent ZERO preflights and the fetch returned 206 with the 127 header bytes. The
 * Fetch standard safelists `Range` when the value is a single simple byte range —
 * `bytes=0-126` is one, and every range pmtiles.js constructs is one.
 *
 * So the ALLOW-ORIGIN half below is load-bearing and stays a failure; the ALLOW-HEADERS
 * half is a warning. It is still worth reporting: the safelist is recent, and §10's
 * "usable on a mid-range Android" is a device that may be running an old WebView which
 * preflights anyway. Adding `Range` to the bucket's AllowedHeaders costs nothing and
 * removes the dependence on a browser being new enough.
 */
const siteOrigin = arg("site-origin") ?? "";
if (siteOrigin) {
  // The simple GET is the request the browser actually makes. Its ACAO is what decides
  // whether the response is readable, safelist or not.
  const cors = await fetch(url, {
    headers: { Origin: siteOrigin, Range: "bytes=0-126" },
  });
  await cors.body?.cancel();
  const getOrigin = cors.headers.get("Access-Control-Allow-Origin") ?? "";
  check(
    getOrigin === siteOrigin || getOrigin === "*",
    `the ranged GET is readable by ${siteOrigin} (got ${JSON.stringify(getOrigin)})`,
  );

  const pre = await fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: siteOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range",
    },
  });
  const allowH = (pre.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
  if (!(allowH.includes("range") || allowH === "*")) {
    console.log(
      `  warn the bucket's CORS AllowedHeaders omits Range (got ${JSON.stringify(allowH)}).`,
    );
    console.log(
      "       Current browsers safelist a simple range and never preflight, so the map",
    );
    console.log(
      "       works today. An older WebView will preflight and get nothing. Adding",
    );
    console.log('       "Range" to AllowedHeaders on the bucket removes the dependency.');
  } else {
    check(true, "preflight allows the Range header");
  }
} else {
  console.log("  --   CORS not checked; pass --site-origin https://<site>");
}

console.log("");
if (failed) {
  console.log("Range is NOT usable through this origin. Do not set basemap.path yet —");
  console.log("map.js would fetch the archive and refuse it, which is the correct refusal.");
  Deno.exit(1);
}
console.log(`Range works. Set config/site.json basemap.path to ${JSON.stringify(key)},`);
console.log("then: node scripts/build-site-config.mjs");
