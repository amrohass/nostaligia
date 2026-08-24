/* R2Store's wire details that no other test can reach.
 *
 * store-roundtrip.ts covers the store against a real S3 implementation, but it needs Docker
 * and MinIO. What is asserted here is the one instruction that does NOT travel through
 * presignR2 and therefore gets none of its canonicalisation: `x-amz-copy-source`.
 *
 * That header names the SOURCE bucket. The destination goes through the signer and is
 * prefixed there; the source is a string built by hand. Getting only the destination right
 * produces a copy that fails against a bucket which does not exist — and the object it
 * fails to preserve is the archival master, which §6 calls the thing an institutional
 * partner would want on deposit. It is the most expensive silent mistake in the file.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import { R2Store } from "./store.ts";

const CREDS = {
  accountId: "acct",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/** Captures one request and answers it plausibly, so copy() reaches its own assertions. */
function captureFetch(): { calls: Request[]; restore: () => void } {
  const calls: Request[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(typeof input === "string" ? input : input.toString(), init));
    // A CopyObject success carries a body; copy() reads it and looks for <Error>.
    return Promise.resolve(
      new Response("<CopyObjectResult><ETag>\"x\"</ETag></CopyObjectResult>", { status: 200 }),
    );
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

Deno.test("copy names the prefixed SOURCE bucket in x-amz-copy-source", async () => {
  const { calls, restore } = captureFetch();
  try {
    const store = new R2Store({ ...CREDS, bucketPrefix: "nostaligia-" });
    await store.copy(
      { bucket: "quarantine", key: "u/obj" },
      { bucket: "originals", key: "u/obj" },
    );
  } finally {
    restore();
  }

  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].headers.get("x-amz-copy-source"),
    "/nostaligia-quarantine/u/obj",
    "the source bucket is a header, not a signed path — the signer never prefixes it",
  );
  assert(
    new URL(calls[0].url).pathname.startsWith("/nostaligia-originals/"),
    "and the destination, which does go through the signer, is prefixed too",
  );
});

Deno.test("...and with no prefix both sides stay bare", async () => {
  const { calls, restore } = captureFetch();
  try {
    const store = new R2Store(CREDS);
    await store.copy(
      { bucket: "quarantine", key: "u/obj" },
      { bucket: "originals", key: "u/obj" },
    );
  } finally {
    restore();
  }

  assertEquals(
    calls[0].headers.get("x-amz-copy-source"),
    "/quarantine/u/obj",
    "unset must be a no-op — store-roundtrip.ts creates MinIO buckets under bare names",
  );
  assert(new URL(calls[0].url).pathname.startsWith("/originals/"));
});

Deno.test("a copy source with awkward characters is encoded, prefix and all", async () => {
  const { calls, restore } = captureFetch();
  try {
    const store = new R2Store({ ...CREDS, bucketPrefix: "nostaligia-" });
    await store.copy(
      { bucket: "quarantine", key: "u/it's here" },
      { bucket: "originals", key: "u/it's here" },
    );
  } finally {
    restore();
  }

  assertEquals(
    calls[0].headers.get("x-amz-copy-source"),
    "/nostaligia-quarantine/u/it%27s%20here",
    "an unescaped apostrophe here is a 403 that reads like a credentials problem",
  );
});
