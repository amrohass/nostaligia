// AWS SigV4 presigning for Cloudflare R2, on Web Crypto only.
//
// Hand-rolled rather than imported. This is the one function in the system that holds
// the R2 secret access key, and a dependency here is a dependency with access to it —
// §6 was written after a real compromised-key incident, and "it was a transitive
// update to a signing library" is exactly the incident report nobody wants. The whole
// algorithm is ~80 lines of hashing with no state and no I/O, so the trade is small.
//
// ── The part that is doing security work ─────────────────────
//
// content-length and content-type are SIGNED HEADERS, not decoration. A presigned URL
// normally signs only `host`, which means the URL is a bearer token for "write
// anything of any size to this key". Signing the length binds the URL to the size the
// caller declared and the quota already charged them for: send a different number of
// bytes and the signature does not match, and R2 rejects it with 403 before a byte of
// body is stored. Without that, `bytes: 1` in the request and a 5 GB body is an
// uncapped write, and the daily quota becomes a suggestion.
//
// The client does not have to do anything to cooperate: fetch() and XHR both set
// Content-Length from the body automatically, so a mismatch is a bug or an attack,
// never an accident.

const encoder = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

// `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`. The unparameterised form widens to
// `Uint8Array<ArrayBufferLike>`, which admits a SharedArrayBuffer-backed view, and
// crypto.subtle.importKey does not accept one. Nothing here ever produces such a view —
// the only caller passes encoder.encode(...) — so this narrows the type to what is
// actually being handed over rather than changing any behaviour.
async function hmac(
  key: ArrayBuffer | Uint8Array<ArrayBuffer>,
  msg: string,
): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(msg));
}

// encodeURIComponent leaves !'()* alone; RFC 3986 does not. SigV4 canonicalisation is
// byte-exact, so a single unescaped apostrophe in a key is a 403 that looks like a
// credentials problem and is not.
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * The methods anything here may presign.
 *
 * POST is deliberately absent. R2 accepts POST for multipart and for browser form uploads,
 * and a presigner that can emit one is a presigner that can hand out a URL whose semantics
 * nobody in this repository has reasoned about.
 *
 * HEAD was added for the publisher, which validates a release by reading back what LANDED
 * rather than what it sent. It is not GET-with-a-flag: SigV4 puts the method inside the
 * canonical request, so a GET-signed URL used with HEAD fails the signature check. Adding
 * it here is the whole change — everything downstream is method-agnostic — and it hands out
 * strictly less than the GET it replaces.
 */
export type PresignMethod = "GET" | "HEAD" | "PUT" | "DELETE";

export interface PresignRequestInput {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  method: PresignMethod;
  expiresIn: number;
  /**
   * Headers to include in the SIGNATURE. `host` is added automatically and must not be
   * passed. Names are lowercased and sorted here, because SigV4 canonicalisation is
   * byte-exact and a caller getting the order right is a caller who will eventually get
   * it wrong.
   *
   * Anything signed must be sent verbatim by whoever uses the URL; anything NOT signed is
   * ignored by the signature check, which is why Range can be added freely at fetch time
   * and x-amz-copy-source cannot.
   */
  signHeaders?: Record<string, string>;
  /** Injectable only so the signature is reproducible under test. */
  now?: Date;
  /**
   * Overrides the R2 endpoint. Production callers omit this and get R2.
   *
   * It exists so the signer can be pointed at a real S3 implementation running locally
   * and the resulting URL actually used — which is the only way to find out whether an
   * independent verifier accepts what we produce, short of holding live R2 credentials.
   * See scripts/sigv4-roundtrip.ts.
   *
   * Not a security surface: the endpoint is not a secret, it is covered by the signature
   * through the host header, and pointing it somewhere else cannot widen what the URL
   * authorises — it only produces a URL that R2 would reject.
   */
  endpoint?: { host: string; protocol?: "http:" | "https:" };
  /**
   * Prepended to `bucket` to form the PHYSICAL bucket name. Empty — the normal case —
   * means the logical name is the physical name.
   *
   * It exists because the buckets in the deployment account are named `nostaligia-*`
   * while `quarantine` / `originals` / `public` are structural everywhere else: the
   * worker types them as a union, and `media_assets.bucket` is a Postgres enum. Prefixing
   * HERE, at the one place a bucket name becomes a path segment, keeps the logical names
   * intact through the database, the manifest and CLAUDE.md §2 — and needs no migration.
   *
   * Passed in rather than read from the environment, for the reason r2.ts gives about
   * `endpoint`: this file is deliberately free of anything ambient. See r2BucketPrefix().
   *
   * Not a security surface. It is covered by the signature like the rest of the path, so a
   * wrong value produces a URL R2 rejects rather than one that reaches somewhere else.
   */
  bucketPrefix?: string;
}

export interface PresignedRequest {
  url: string;
  method: PresignMethod;
  /** Exactly what the caller must send. Any deviation invalidates the signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * The signer. Everything else in this file is a wrapper that fills in its arguments.
 *
 * It is one function rather than one per verb on purpose: the worker added three more
 * operations (read the quarantine object, copy the master to originals/, delete the
 * quarantine object) and a second canonicalisation path would be a second place for the
 * byte-exact rules above to be got subtly wrong — in a file whose header explains that a
 * mistake here reads like a credentials problem and is not.
 */
export async function presignR2(i: PresignRequestInput): Promise<PresignedRequest> {
  const host = i.endpoint?.host ?? `${i.accountId}.r2.cloudflarestorage.com`;
  const protocol = i.endpoint?.protocol ?? "https:";
  const region = "auto"; // R2 has one region and calls it this.
  const service = "s3";

  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Each path segment is encoded individually so the separators survive. The prefix and the
  // bucket are ONE segment — encoded together, after concatenation, because the physical
  // bucket is a single path component and encoding them apart would escape nothing
  // differently but would invite a `/` in a prefix to look like it worked.
  const canonicalUri = "/" +
    [`${i.bucketPrefix ?? ""}${i.bucket}`, ...i.key.split("/")].map(uriEncode).join("/");

  // host is always signed; a URL whose host is not covered can be replayed against another
  // endpoint. Sorted byte-wise by name, which is what SigV4 requires and what a caller
  // passing headers in a literal will not reliably do.
  const toSign: Record<string, string> = { host };
  for (const [k, v] of Object.entries(i.signHeaders ?? {})) {
    toSign[k.toLowerCase()] = v;
  }
  const names = Object.keys(toSign).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]}\n`).join("");

  // Sorted by key, byte-wise. These five are already in order, but the sort is left in
  // so adding a parameter later cannot quietly break the signature.
  const params: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${i.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(i.expiresIn)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = params
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");

  // UNSIGNED-PAYLOAD: the body is not available to hash at signing time, which is the
  // entire point of a presigned URL. The length binding above is what replaces it.
  const canonicalRequest = [
    i.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(encoder.encode(`AWS4${i.secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  return {
    url: `${protocol}//${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    method: i.method,
    // host is excluded: fetch() sets it from the URL and refuses to let a caller override
    // it, so listing it here would be an instruction nobody can follow.
    headers: Object.fromEntries(
      Object.entries(i.signHeaders ?? {}).filter(([k]) => k.toLowerCase() !== "host"),
    ),
    expiresAt: new Date(now.getTime() + i.expiresIn * 1000).toISOString(),
  };
}

/** What request-upload hands the browser. See the header for why the length is signed. */
export interface PresignInput {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresIn: number;
  now?: Date;
  endpoint?: { host: string; protocol?: "http:" | "https:" };
  /** See PresignRequestInput.bucketPrefix. Forwarded verbatim. */
  bucketPrefix?: string;
}

export interface PresignResult extends PresignedRequest {
  method: "PUT";
}

/**
 * A presigned PUT bound to a declared type and size.
 *
 * Header casing here is what the browser is told to send, and the signature is computed
 * over the lowercased names, so these two are not in conflict — HTTP header names are
 * case-insensitive and SigV4 canonicalisation is not.
 */
export async function presignR2Put(i: PresignInput): Promise<PresignResult> {
  const signed = await presignR2({
    accountId: i.accountId,
    accessKeyId: i.accessKeyId,
    secretAccessKey: i.secretAccessKey,
    bucket: i.bucket,
    key: i.key,
    method: "PUT",
    expiresIn: i.expiresIn,
    signHeaders: {
      "Content-Length": String(i.contentLength),
      "Content-Type": i.contentType,
    },
    now: i.now,
    endpoint: i.endpoint,
    bucketPrefix: i.bucketPrefix,
  });
  return { ...signed, method: "PUT" };
}
