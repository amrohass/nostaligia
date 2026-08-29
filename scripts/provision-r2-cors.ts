/* Give the `quarantine` bucket a CORS policy, then prove a browser PUT would survive it.
 *
 *     deno run --allow-net --allow-env --allow-read scripts/provision-r2-cors.ts
 *     deno run --allow-net --allow-env --allow-read scripts/provision-r2-cors.ts --print
 *     deno run --allow-net --allow-env --allow-read scripts/provision-r2-cors.ts --apply
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * §2's write path has the browser PUT the file straight to `quarantine/` with a presigned
 * URL. That is a cross-origin request carrying `Content-Type: image/jpeg`, which is not a
 * CORS-safelisted value, so the browser sends a preflight — and an R2 bucket has no CORS
 * policy until somebody gives it one. Measured on 29 Aug 2026: an OPTIONS preflight to
 * `quarantine` answered 403 with no `Access-Control-*` headers for GET, PUT and HEAD
 * alike, which is R2 saying no rule matched.
 *
 * The member sees none of that. upload.js's `put()` gets `xhr.onerror`, maps it to
 * `up.err.offline`, and shows "لا يوجد اتصال" — the same sentence produced by a missing
 * `apikey` in the Edge Function's Allow-Headers and by a `connect-src` that omits the S3
 * endpoint. Three unrelated causes, one message; this script removes one of them and
 * checks that it is gone rather than assuming.
 *
 * ── The check is the point, as in provision-basemap.ts ───────
 *
 * Applying a policy tells you nothing about whether the upload works, so the default mode
 * takes NO credential and simply asks R2 the question a browser asks: an OPTIONS preflight
 * for `PUT` + `content-type` from each allowed origin. Run it before and after. It is also
 * the honest way to check this from a machine that holds only the object-scoped token.
 *
 * ── Two things it deliberately will not do ───────────────────
 *
 * It does not touch the `public` bucket. `PutBucketCors` REPLACES a policy rather than
 * merging into it, `public` demonstrably already has one (the r2.dev origin echoes
 * `Access-Control-Allow-Origin` on a GET), and the object-scoped token cannot read it back
 * to merge. Overwriting a working read path to add a header would trade a broken upload
 * for a broken archive. `--print` emits the rule the closeout audit wants there — adding
 * `Range` to AllowedHeaders — as text, to be merged by hand in the dashboard.
 *
 * It does not invent an origin. The list comes from config/site.json's
 * `function_cors.upload_allowed_origins`, which is the same list the Edge Functions
 * enforce, because §2 wants one source for every origin and two lists that must agree are
 * one list that will not.
 *
 * ── Why the signing is here and not in _shared/sigv4.ts ──────
 *
 * `presignR2()` produces a QUERY-presigned URL, and R2 refuses that form for this
 * operation — measured: `InvalidArgument: Search param X-Amz-Algorithm is unsupported for
 * bucket cors`. Bucket subresources want header-signed SigV4 with a real payload hash,
 * which is a different canonical request. It stays in this file rather than widening the
 * signer the upload path depends on: this signs BUCKET CONFIGURATION with an admin
 * credential, an operation class nothing in the app performs, and sigv4.ts's own header
 * explains why a second path through it is where byte-exact rules get subtly wrong.
 *
 * It is not unverified. The identical canonicalisation was run against real R2 with the
 * object-scoped token and came back `AccessDenied` rather than `SignatureDoesNotMatch` —
 * R2 validated the signature and then refused on permissions, which is exactly the
 * discrimination that proves the signing correct and the token too narrow.
 */

const enc = new TextEncoder();

function arg(name: string): boolean {
  return Deno.args.includes("--" + name);
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

const cfg = JSON.parse(await Deno.readTextFile(new URL("../config/site.json", import.meta.url)));
const ORIGINS: string[] = cfg.function_cors.upload_allowed_origins;
const PREFIX = Deno.env.get("R2_BUCKET_PREFIX") ?? "";

if (!ORIGINS.length) {
  console.error("config/site.json lists no upload_allowed_origins; nothing to allow.");
  Deno.exit(1);
}

/* ── The policy ────────────────────────────────────────────────
 *
 * PUT only, `content-type` only. The client sends exactly one header it is not allowed to
 * omit — presignR2Put signs Content-Length and Content-Type, and upload.js drops the
 * length because a browser refuses to let script set it. Anything wider here would be
 * allowing a request this application never makes. */
const QUARANTINE_RULE = {
  AllowedOrigins: ORIGINS,
  AllowedMethods: ["PUT"],
  AllowedHeaders: ["content-type"],
  MaxAgeSeconds: 3600,
};

/* What the closeout audit wants MERGED into the public bucket's existing policy. Printed,
 * never applied — see the header. */
const PUBLIC_RULE_NOTE = {
  AllowedOrigins: ORIGINS,
  AllowedMethods: ["GET", "HEAD"],
  AllowedHeaders: ["range"],
  MaxAgeSeconds: 3600,
};

function toXml(rule: typeof QUARANTINE_RULE): string {
  const lines = [
    ...rule.AllowedOrigins.map((o) => `    <AllowedOrigin>${o}</AllowedOrigin>`),
    ...rule.AllowedMethods.map((m) => `    <AllowedMethod>${m}</AllowedMethod>`),
    ...rule.AllowedHeaders.map((h) => `    <AllowedHeader>${h}</AllowedHeader>`),
    `    <MaxAgeSeconds>${rule.MaxAgeSeconds}</MaxAgeSeconds>`,
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">\n` +
    `  <CORSRule>\n${lines.join("\n")}\n  </CORSRule>\n</CORSConfiguration>`;
}

/* ── Header-signed SigV4, for one operation ──────────────────── */

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, matching _shared/sigv4.ts.
 * TypeScript 5.7 made the typed arrays generic over their buffer and the default
 * `ArrayBufferLike` admits `SharedArrayBuffer`, which is not a `BufferSource` — the same
 * error the closeout audit found in two scripts that CI had been running without ever
 * type-checking. */
async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  msg: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

async function putBucketCors(bucket: string, xml: string): Promise<Response> {
  const accountId = env("R2_ACCOUNT_ID");
  const accessKeyId = env("R2_ADMIN_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_ADMIN_SECRET_ACCESS_KEY");

  const host = `${accountId}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = await sha256Hex(xml);

  const headers: Record<string, string> = {
    host,
    "content-type": "application/xml",
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "PUT",
    "/" + encodeURIComponent(bucket),
    "cors=",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let k = await hmac(enc.encode("AWS4" + secretAccessKey), dateStamp);
  k = await hmac(k, "auto");
  k = await hmac(k, "s3");
  k = await hmac(k, "aws4_request");
  const sig = [...await hmac(k, stringToSign)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const { host: _drop, ...sendHeaders } = headers;
  return await fetch(`https://${host}/${bucket}?cors`, {
    method: "PUT",
    headers: {
      ...sendHeaders,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
    body: xml,
  });
}

/* ── The check: exactly what a browser asks ──────────────────── */

let failures = 0;
function check(ok: boolean, msg: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${msg}`);
  if (!ok) failures++;
}

async function verify(bucket: string): Promise<void> {
  const accountId = env("R2_ACCOUNT_ID");
  for (const origin of ORIGINS) {
    const res = await fetch(`https://${accountId}.r2.cloudflarestorage.com/${bucket}/cors-preflight-probe`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    await res.body?.cancel();
    const allowOrigin = res.headers.get("Access-Control-Allow-Origin");
    const allowHeaders = (res.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase();
    check(
      res.ok && (allowOrigin === origin || allowOrigin === "*"),
      `preflight from ${origin}: ${res.status}, Allow-Origin ${allowOrigin ?? "(absent)"}`,
    );
    check(
      allowHeaders.includes("content-type") || allowHeaders === "*",
      `  and content-type is allowed (got ${allowHeaders || "(absent)"})`,
    );
  }
}

/* ── Run ─────────────────────────────────────────────────────── */

const quarantine = `${PREFIX}quarantine`;

if (arg("print")) {
  console.log("Dashboard JSON — R2 > " + quarantine + " > Settings > CORS policy:\n");
  console.log(JSON.stringify([QUARANTINE_RULE], null, 2));
  console.log("\nMERGE this into the EXISTING policy on " + PREFIX + "public (do not replace it);");
  console.log("it is the closeout audit's Range item, and an older Android WebView needs it:\n");
  console.log(JSON.stringify([PUBLIC_RULE_NOTE], null, 2));
  Deno.exit(0);
}

if (arg("apply")) {
  console.log(`Applying CORS policy to ${quarantine}…`);
  const res = await putBucketCors(quarantine, toXml(QUARANTINE_RULE));
  const body = await res.text();
  if (!res.ok) {
    console.error(`  PutBucketCors failed: ${res.status}\n${body}`);
    if (body.includes("AccessDenied")) {
      console.error(
        "\n  AccessDenied means the signature was ACCEPTED and the token is too narrow.\n" +
          "  Bucket configuration needs an Admin Read & Write R2 token, which is NOT the\n" +
          "  object-scoped one the Edge Functions use. Create one, export it as\n" +
          "  R2_ADMIN_ACCESS_KEY_ID / R2_ADMIN_SECRET_ACCESS_KEY, and run again — or paste\n" +
          "  the output of --print into the dashboard instead.",
      );
    }
    Deno.exit(1);
  }
  console.log("  applied.\n");
}

console.log(`Preflight check against ${quarantine} — what the browser actually asks:`);
await verify(quarantine);

if (failures) {
  console.error(
    `\n${failures} check(s) failed. The browser PUT will fail with xhr.onerror, and the\n` +
      `member will be told "لا يوجد اتصال" with nothing naming CORS. Run with --apply\n` +
      `(admin token) or --print (paste into the dashboard).`,
  );
  Deno.exit(1);
}
console.log("\nAll checks passed — a browser PUT to quarantine survives the preflight.");
