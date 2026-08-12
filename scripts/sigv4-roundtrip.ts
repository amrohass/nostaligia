// Does an independent S3 implementation accept what our presigner produces?
//
// This is the question the unit tests in supabase/functions/_shared/sigv4.test.ts
// deliberately cannot answer. They prove the signature is deterministic and varies with
// content-length; they cannot prove it is CORRECT, because the only thing available to
// compare against is the same code that produced it.
//
// So this signs against MinIO -- a real, strict S3 server -- and performs the upload.
// MinIO recomputes the signature from the request it receives and rejects any mismatch,
// which makes it an independent verifier of the whole canonicalisation: header order,
// the trailing newline, UNSIGNED-PAYLOAD, RFC 3986 path encoding, the HMAC chain.
//
// The negative cases matter more than the positive one. sigv4.ts claims that signing
// content-length binds the URL to the size the quota was charged for -- that `bytes: 1`
// followed by a 5 GB body is refused. Nothing verified that claim until this script. A
// presigner that signs the length but is ignored by the server would pass every unit
// test and leave the quota unenforceable.
//
//   docker run -d --name rma-sigv4-minio -p 9000:9000 \
//     -e MINIO_ROOT_USER=rmatestkey -e MINIO_ROOT_PASSWORD=rmatestsecret123 \
//     --entrypoint sh minio/minio -c "mkdir -p /data/quarantine && minio server /data"
//   deno run --allow-net --allow-env scripts/sigv4-roundtrip.ts
//   docker rm -f rma-sigv4-minio
//
// Credentials here are throwaway values for a container that exists for the length of
// this run. No real R2 credential is involved, which is the point -- this is verifiable
// on any machine without holding one.

import { presignR2Put } from "../supabase/functions/_shared/sigv4.ts";

const HOST = Deno.env.get("SIGV4_TEST_HOST") ?? "127.0.0.1:9000";
const BUCKET = "quarantine";

const CREDS = {
  accountId: "unused-when-endpoint-is-set",
  accessKeyId: Deno.env.get("SIGV4_TEST_KEY") ?? "rmatestkey",
  secretAccessKey: Deno.env.get("SIGV4_TEST_SECRET") ?? "rmatestsecret123",
  endpoint: { host: HOST, protocol: "http:" as const },
};

let passed = 0;
let failed = 0;

function report(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`  ok    ${name}\n          ${detail}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n          ${detail}`);
  }
}

function bodyOf(n: number): Uint8Array {
  return new Uint8Array(n).fill(0x41);
}

async function put(
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
): Promise<{ status: number; text: string }> {
  // Content-Length is set by fetch from the body; sending it by hand is a forbidden
  // header and would be dropped. That is exactly the property the design relies on --
  // the client cannot lie about the length even if it wants to.
  const { "Content-Length": _omit, ...sendable } = headers;
  const res = await fetch(url, { method: "PUT", headers: sendable, body });
  return { status: res.status, text: (await res.text()).slice(0, 200) };
}

console.log(`\nSigV4 round-trip against a real S3 implementation at ${HOST}\n`);

// ── 1 · the positive path ────────────────────────────────────
{
  const size = 4096;
  const p = await presignR2Put({
    ...CREDS,
    bucket: BUCKET,
    key: `roundtrip/${crypto.randomUUID()}`,
    contentType: "image/jpeg",
    contentLength: size,
    expiresIn: 300,
  });
  const r = await put(p.url, p.headers, bodyOf(size));
  report(
    "a correctly signed PUT is accepted",
    r.status === 200,
    `HTTP ${r.status} ${r.text || "(empty body)"}`,
  );
}

// ── 2 · the binding, which is the whole security claim ───────
{
  const declared = 4096;
  const p = await presignR2Put({
    ...CREDS,
    bucket: BUCKET,
    key: `roundtrip/${crypto.randomUUID()}`,
    contentType: "image/jpeg",
    contentLength: declared,
    expiresIn: 300,
  });
  // Declared 4 KiB, sending 1 MiB. This is `bytes: 1` plus a 5 GB body, scaled down.
  const r = await put(p.url, p.headers, bodyOf(1024 * 1024));
  report(
    "a body larger than the declared content-length is REFUSED",
    r.status === 403,
    `HTTP ${r.status} — declared ${declared}, sent ${1024 * 1024}`,
  );
}

{
  const declared = 4096;
  const p = await presignR2Put({
    ...CREDS,
    bucket: BUCKET,
    key: `roundtrip/${crypto.randomUUID()}`,
    contentType: "image/jpeg",
    contentLength: declared,
    expiresIn: 300,
  });
  const r = await put(p.url, p.headers, bodyOf(1));
  report(
    "a body smaller than the declared content-length is also refused",
    r.status === 403,
    `HTTP ${r.status} — declared ${declared}, sent 1`,
  );
}

// ── 3 · the other bound header ───────────────────────────────
{
  const size = 2048;
  const p = await presignR2Put({
    ...CREDS,
    bucket: BUCKET,
    key: `roundtrip/${crypto.randomUUID()}`,
    contentType: "image/jpeg",
    contentLength: size,
    expiresIn: 300,
  });
  const r = await put(p.url, { ...p.headers, "Content-Type": "text/html" }, bodyOf(size));
  report(
    "swapping the content-type is refused",
    r.status === 403,
    `HTTP ${r.status} — signed image/jpeg, sent text/html`,
  );
}

// ── 4 · tampering with the URL itself ────────────────────────
{
  const size = 2048;
  const key = `roundtrip/${crypto.randomUUID()}`;
  const p = await presignR2Put({
    ...CREDS,
    bucket: BUCKET,
    key,
    contentType: "image/jpeg",
    contentLength: size,
    expiresIn: 300,
  });
  // Repointing the URL at another object is the attack a bare presigned URL invites.
  const moved = p.url.replace(key, `roundtrip/${crypto.randomUUID()}`);
  const r = await put(moved, p.headers, bodyOf(size));
  report(
    "repointing the URL at a different object key is refused",
    r.status === 403,
    `HTTP ${r.status}`,
  );
}

// ── 5 · expiry is enforced by the server, not just reported ──
{
  const size = 512;
  const p = await presignR2Put({
    ...CREDS,
    bucket: BUCKET,
    key: `roundtrip/${crypto.randomUUID()}`,
    contentType: "image/jpeg",
    contentLength: size,
    expiresIn: 1,
    now: new Date(Date.now() - 60_000), // signed a minute ago, valid for one second
  });
  const r = await put(p.url, p.headers, bodyOf(size));
  report(
    "an expired URL is refused",
    r.status === 403,
    `HTTP ${r.status} — expiresAt ${p.expiresAt}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
Deno.exit(failed === 0 ? 0 : 1);
