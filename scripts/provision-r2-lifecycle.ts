/* §6's lifecycle rule: objects in `quarantine` expire 30 days after upload — and only there.
 *
 *     deno run --allow-net --allow-env scripts/provision-r2-lifecycle.ts            # verify
 *     deno run --allow-net --allow-env scripts/provision-r2-lifecycle.ts --apply    # merge + apply + verify
 *     deno run --allow-net --allow-env scripts/provision-r2-lifecycle.ts --print    # dashboard steps
 *     deno run --allow-net --allow-env scripts/provision-r2-lifecycle.ts --probe-signing
 *
 * Needs R2_ACCOUNT_ID and R2_BUCKET_PREFIX, and for verify/--apply an ADMIN R2 token as
 * R2_ADMIN_ACCESS_KEY_ID / R2_ADMIN_SECRET_ACCESS_KEY. Bucket configuration is not something
 * the object-scoped token the Edge Functions hold can do, which is correct least privilege.
 * --probe-signing uses that object-scoped token (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY).
 *
 * ── Why now ──────────────────────────────────────────────────
 *
 * §6 has always named "a lifecycle rule purging rejected/orphaned objects after 30 days" and
 * none was provisioned. Since 0065 it is load-bearing: the reaper fails an upload whose
 * complete-upload never ran, but it cannot see R2, so a PUT that FINISHED before the tab
 * closed leaves its bytes in quarantine with nothing that will ever remove them. The worker
 * deletes quarantine objects it processes; this removes the ones it never saw.
 *
 * ── Only quarantine, and why that is the whole design ───────
 *
 * `originals` is the archival master — §6: "the thing an institutional partner would want on
 * deposit". `public` is the served archive. An expiry rule on either would delete the archive
 * thirty days after it was built, silently, one object at a time. So verification does not
 * only look for the rule on quarantine: it FAILS if any expiration rule of any kind exists on
 * originals or public. A multipart-abort rule (R2 adds one to new buckets by default) is fine
 * anywhere — it removes only uploads that never finished.
 *
 * ── Why it reads before it writes ────────────────────────────
 *
 * PutBucketLifecycleConfiguration REPLACES the configuration; it does not add a rule — the
 * trap provision-r2-cors.ts documents for PutBucketCors. So --apply GETs the current rules,
 * keeps every one that is not ours verbatim, replaces ours if present, and PUTs the merge.
 * Re-running is idempotent.
 *
 * ── Why the signing is proven on a LIST, not on a lifecycle call ──
 *
 * The obvious probe — send the lifecycle request with the object-scoped token and read
 * `AccessDenied` as "the signature was accepted, only the scope is too narrow" — does not
 * discriminate, and this script was first written that way. Its control (the same request
 * with a corrupted secret) came back `AccessDenied` too, on a real bucket and on a missing
 * one: for bucket configuration R2 refuses on the token's scope BEFORE it checks the
 * signature. provision-r2-cors.ts's header rests on the same inference without a control.
 *
 * So --probe-signing uses an operation the object-scoped token IS allowed — a zero-key
 * ListObjectsV2 on quarantine — through the SAME signer: host, x-amz-date,
 * x-amz-content-sha256, path encoding and query canonicalisation. A good signature answers
 * 200; the corrupted-secret control must answer SignatureDoesNotMatch, or the probe has
 * proved nothing and says so. What it cannot reach is lifecycle-specific: the `lifecycle`
 * subresource and PUT's Content-MD5. --apply exercises those, and a wrong one fails the PUT
 * loudly and changes nothing.
 */

const enc = new TextEncoder();
const RULE_ID = "rma-quarantine-expire-30d";
const EXPIRE_DAYS = 30;

function arg(name: string): boolean {
  return Deno.args.includes("--" + name);
}

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

const PREFIX = Deno.env.get("R2_BUCKET_PREFIX") ?? "";
const BUCKETS = {
  quarantine: `${PREFIX}quarantine`,
  originals: `${PREFIX}originals`,
  public: `${PREFIX}public`,
};

/* Our rule, as S3 lifecycle XML. The empty Prefix filter is the whole bucket. */
const OUR_RULE =
  `<Rule><ID>${RULE_ID}</ID><Filter><Prefix></Prefix></Filter><Status>Enabled</Status>` +
  `<Expiration><Days>${EXPIRE_DAYS}</Days></Expiration></Rule>`;

function configXml(rules: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rules.join("")}` +
    `</LifecycleConfiguration>`;
}

/* Rules as raw XML blocks. Deno has no DOMParser and the shape is flat, so a rule is exactly
   one <Rule>…</Rule> and is carried through verbatim — never re-serialised, so a rule this
   script does not understand survives a merge unchanged. */
function rulesOf(xml: string): string[] {
  return [...xml.matchAll(/<Rule>[\s\S]*?<\/Rule>/g)].map((m) => m[0]);
}

function tag(xml: string, name: string): string | undefined {
  return (new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml) ?? [])[1];
}

/* ── Header-signed SigV4 — the canonicalisation of provision-r2-cors.ts, with any query ── */

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, msg: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/* S3 requires Content-MD5 (or a checksum header) on PutBucketLifecycleConfiguration.
   WebCrypto has no MD5; node:crypto in Deno does. */
async function md5Base64(s: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("md5").update(s, "utf8").digest("base64");
}

interface Creds {
  accessKeyId: string;
  secretAccessKey: string;
}

/* Any bucket-level request. `query` is [key, value] pairs; an empty value is how S3 spells a
   subresource (`lifecycle=` in the canonical form, `?lifecycle` on the wire). */
async function signed(
  method: "GET" | "PUT",
  bucket: string,
  query: [string, string][],
  creds: Creds,
  body = "",
): Promise<Response> {
  const host = `${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const payloadHash = await sha256Hex(body);

  const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  if (method === "PUT") {
    headers["content-type"] = "application/xml";
    headers["content-md5"] = await md5Base64(body);
  }
  const names = Object.keys(headers).sort();
  const canonicalQuery = [...query]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalRequest = [
    method,
    "/" + encodeURIComponent(bucket),
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let k = await hmac(enc.encode("AWS4" + creds.secretAccessKey), dateStamp);
  k = await hmac(k, "auto");
  k = await hmac(k, "s3");
  k = await hmac(k, "aws4_request");
  const sig = [...await hmac(k, stringToSign)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const wireQuery = query
    .map(([key, v]) => (v === "" ? encodeURIComponent(key) : `${encodeURIComponent(key)}=${encodeURIComponent(v)}`))
    .join("&");
  const { host: _drop, ...send } = headers;
  return await fetch(`https://${host}/${bucket}?${wireQuery}`, {
    method,
    headers: {
      ...send,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
        `SignedHeaders=${names.join(";")}, Signature=${sig}`,
    },
    body: method === "PUT" ? body : undefined,
  });
}

function lifecycle(method: "GET" | "PUT", bucket: string, creds: Creds, body = ""): Promise<Response> {
  return signed(method, bucket, [["lifecycle", ""]], creds, body);
}

/* The current rules on a bucket. NoSuchLifecycleConfiguration is "none", not an error. */
async function currentRules(bucket: string, creds: Creds): Promise<string[]> {
  const res = await lifecycle("GET", bucket, creds);
  const text = await res.text();
  if (res.status === 404 && text.includes("NoSuchLifecycleConfiguration")) return [];
  if (!res.ok) {
    throw new Error(`GetBucketLifecycleConfiguration ${bucket}: ${res.status} ${tag(text, "Code") ?? text.slice(0, 200)}`);
  }
  return rulesOf(text);
}

/* ── Modes ─────────────────────────────────────────────────── */

if (arg("print")) {
  console.log(`Cloudflare dashboard → R2 → ${BUCKETS.quarantine} → Settings → Object lifecycle rules → Add rule:
  name            ${RULE_ID}
  applies to      the whole bucket (no prefix)
  action          delete objects ${EXPIRE_DAYS} days after upload
Leave any existing "abort incomplete multipart uploads" rule in place.
Add NOTHING to ${BUCKETS.originals} or ${BUCKETS.public}: an expiry there deletes the archive.
Then run this script with no flag and an admin token to verify all three buckets.`);
  Deno.exit(0);
}

if (arg("probe-signing")) {
  const objectScoped: Creds = { accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY") };
  const corrupted: Creds = { ...objectScoped, secretAccessKey: objectScoped.secretAccessKey.slice(0, -1) + "x" };
  const list: [string, string][] = [["list-type", "2"], ["max-keys", "0"]];
  let bad = 0;
  const outcome = async (r: Response) => (r.ok ? "200" : tag(await r.text(), "Code") ?? String(r.status));
  const expect = (ok: boolean, what: string, got: string) => {
    if (!ok) bad++;
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}: ${got}`);
  };
  const good = await outcome(await signed("GET", BUCKETS.quarantine, list, objectScoped));
  expect(good === "200", "a zero-key list of quarantine, signed by this script, is accepted", good);
  const ctrl = await outcome(await signed("GET", BUCKETS.quarantine, list, corrupted));
  expect(ctrl === "SignatureDoesNotMatch", "CONTROL: the same request with a corrupted secret is refused ON THE SIGNATURE", ctrl);
  if (bad) Deno.exit(1);
  console.log("\nThe shared canonicalisation is right. The lifecycle subresource and Content-MD5 are proven only by --apply.");
  Deno.exit(0);
}

const admin: Creds = {
  accessKeyId: env("R2_ADMIN_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_ADMIN_SECRET_ACCESS_KEY"),
};

if (arg("apply")) {
  const existing = await currentRules(BUCKETS.quarantine, admin);
  const kept = existing.filter((r) => tag(r, "ID") !== RULE_ID);
  console.log(`Applying to ${BUCKETS.quarantine}: ${kept.length} existing rule(s) kept, ${RULE_ID} set.`);
  const res = await lifecycle("PUT", BUCKETS.quarantine, admin, configXml([...kept, OUR_RULE]));
  if (!res.ok) {
    console.error(`  PutBucketLifecycleConfiguration failed: ${res.status} ${await res.text()}`);
    Deno.exit(1);
  }
  console.log("  applied.\n");
}

/* Verify — always, and on all three buckets. */
let failures = 0;
function check(ok: boolean, msg: string) {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${msg}`);
  if (!ok) failures++;
}

const q = await currentRules(BUCKETS.quarantine, admin);
const ours = q.find((r) => tag(r, "ID") === RULE_ID);
check(!!ours, `${BUCKETS.quarantine} carries ${RULE_ID}`);
check(!!ours && tag(ours, "Status") === "Enabled", "  …Enabled");
check(!!ours && tag(tag(ours, "Expiration") ?? "", "Days") === String(EXPIRE_DAYS), `  …expiring after ${EXPIRE_DAYS} days`);
check(!!ours && (tag(ours, "Prefix") ?? "") === "", "  …over the whole bucket");

for (const bucket of [BUCKETS.originals, BUCKETS.public]) {
  const rules = await currentRules(bucket, admin);
  const expiring = rules.filter((r) => r.includes("<Expiration>"));
  check(
    expiring.length === 0,
    `${bucket} has NO expiration rule (${rules.length} rule(s) total` +
      `${expiring.length ? ": " + expiring.map((r) => tag(r, "ID")).join(", ") : ""})`,
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  Deno.exit(1);
}
console.log(`\nQuarantine expires after ${EXPIRE_DAYS} days; originals and public expire nothing.`);
