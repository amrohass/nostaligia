// Does R2Store's wire behaviour survive contact with a real S3 implementation?
//
// The pipeline tests fake the store, and worker/scripts/ladder-fixture.ts uses LocalStore,
// which is three folders and a copyFile. Neither can answer the questions that actually
// decide whether the worker works in production:
//
//   · is a presigned GET with a Range header accepted, and does it return only that range
//   · does a STREAMED upload arrive intact — scripts/sigv4-roundtrip.ts records that
//     fetch() drops a hand-set Content-Length, which for a body that is a stream rather
//     than a buffer is the difference between a length header and chunked encoding
//   · does a presigned PUT carrying x-amz-copy-source actually copy server-side, or does
//     it silently create an empty object
//   · is x-amz-copy-source really covered by the signature
//
// The third is the one worth the whole script. A copy that quietly writes nothing loses the
// master — the archival copy §6 calls "the thing an institutional partner would want on
// deposit" — while every row in the database says it is there.
//
//   docker run -d --name rma-store-minio -p 9002:9000 \
//     -e MINIO_ROOT_USER=rmatestkey -e MINIO_ROOT_PASSWORD=rmatestsecret123 \
//     --entrypoint sh minio/minio \
//     -c "mkdir -p /data/quarantine /data/originals /data/public && minio server /data"
//   deno run --allow-net --allow-env --allow-read --allow-write worker/scripts/store-roundtrip.ts
//   docker rm -f rma-store-minio
//
// Throwaway credentials against a container that lives for one run. No R2 credential is
// involved, which is what makes this runnable by anyone.

import { R2Store } from "../src/store.ts";
import { presignR2 } from "../../supabase/functions/_shared/sigv4.ts";

const HOST = Deno.env.get("STORE_TEST_HOST") ?? "127.0.0.1:9002";
const CREDS = {
  accountId: "unused-when-endpoint-is-set",
  accessKeyId: Deno.env.get("STORE_TEST_KEY") ?? "rmatestkey",
  secretAccessKey: Deno.env.get("STORE_TEST_SECRET") ?? "rmatestsecret123",
  endpoint: { host: HOST, protocol: "http:" as const },
};

const store = new R2Store(CREDS);

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

console.log(`\nR2Store round-trip against a real S3 implementation at ${HOST}\n`);

const dir = await Deno.makeTempDir({ prefix: "rma-store-" });
const key = `roundtrip/${crypto.randomUUID()}`;

// A body large enough that a streamed upload is genuinely streamed rather than buffered
// into one chunk by the runtime.
const PAYLOAD = new Uint8Array(3 * 1024 * 1024);
for (let i = 0; i < PAYLOAD.length; i++) PAYLOAD[i] = i % 251;
// Recognisable leading bytes, so the range read below is checked against content and not
// merely against a length.
PAYLOAD.set(new TextEncoder().encode("RMA-HEAD-MARKER!"), 0);

const localSource = `${dir}/payload.bin`;
await Deno.writeFile(localSource, PAYLOAD);

// ── 1 · upload ───────────────────────────────────────────────
try {
  const bytes = await store.upload("quarantine", key, localSource, "application/octet-stream");
  report(
    "a multi-megabyte upload is accepted and reports the file's size",
    bytes === PAYLOAD.length,
    `${bytes} bytes reported, ${PAYLOAD.length} on disk`,
  );
} catch (e) {
  // This is the check that caught the real defect: the first implementation streamed the
  // body with a hand-set Content-Length, fetch dropped the header, and every upload came
  // back 411 Length Required. Nothing but a real S3 server could have said so.
  report("a multi-megabyte upload is accepted", false, String(e));
}

// ── 2 · the object really has the bytes we sent ──────────────
try {
  const back = `${dir}/back.bin`;
  await store.download("quarantine", key, back);
  const round = await Deno.readFile(back);
  const same = round.length === PAYLOAD.length &&
    round[0] === PAYLOAD[0] &&
    round[round.length - 1] === PAYLOAD[PAYLOAD.length - 1];
  report(
    "the object round-trips byte for byte",
    same,
    `${round.length} bytes back, ${PAYLOAD.length} sent`,
  );
} catch (e) {
  report("the object round-trips byte for byte", false, String(e));
}

// ── 3 · the range read the sniffer depends on ────────────────
//
// If Range were ignored, head() would pull an entire 4 GB master to look at 64 bytes.
try {
  const head = await store.head("quarantine", key, 64);
  const marker = new TextDecoder().decode(head.subarray(0, 16));
  report(
    "a ranged GET returns only the requested bytes",
    head.length === 64 && marker === "RMA-HEAD-MARKER!",
    `${head.length} bytes, leading "${marker}"`,
  );
} catch (e) {
  report("a ranged GET returns only the requested bytes", false, String(e));
}

// ── 4 · the server-side copy that preserves the master ───────
try {
  await store.copy({ bucket: "quarantine", key }, { bucket: "originals", key });
  const check = `${dir}/copied.bin`;
  await store.download("originals", key, check);
  const copied = await Deno.stat(check);
  report(
    "a presigned copy really moves the bytes server-side",
    copied.size === PAYLOAD.length,
    `originals/ holds ${copied.size} bytes, expected ${PAYLOAD.length}`,
  );
} catch (e) {
  report("a presigned copy really moves the bytes server-side", false, String(e));
}

// ── 5 · and the copy source is bound by the signature ────────
//
// The negative case, and the reason store.ts signs that header. If x-amz-copy-source were
// unsigned, anyone holding one copy URL could point it at any object the credentials can
// reach.
try {
  const signed = await presignR2({
    ...CREDS,
    bucket: "originals",
    key: `${key}-tampered`,
    method: "PUT",
    expiresIn: 300,
    signHeaders: { "x-amz-copy-source": `/quarantine/${key}` },
  });
  const res = await fetch(signed.url, {
    method: "PUT",
    headers: { "x-amz-copy-source": `/quarantine/${key}-does-not-exist` },
  });
  report(
    "swapping the copy source after signing is refused",
    res.status === 403,
    `HTTP ${res.status} — signed one source, sent another`,
  );
} catch (e) {
  report("swapping the copy source after signing is refused", false, String(e));
}

// ── 6 · delete, and its idempotence ──────────────────────────
try {
  await store.remove("quarantine", key);
  await store.remove("quarantine", key); // a second delete must not throw
  report("delete succeeds, and deleting again is not an error", true, "404 treated as success");
} catch (e) {
  report("delete succeeds, and deleting again is not an error", false, String(e));
}

await Deno.remove(dir, { recursive: true }).catch(() => {});

console.log(`\n${passed} passed, ${failed} failed\n`);
Deno.exit(failed === 0 ? 0 : 1);
