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

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
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

export interface PresignInput {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  key: string;
  contentType: string;
  contentLength: number;
  expiresIn: number;
  /** Injectable only so the signature is reproducible under test. */
  now?: Date;
}

export interface PresignResult {
  url: string;
  method: "PUT";
  /** Exactly what the client must send. Any deviation invalidates the signature. */
  headers: Record<string, string>;
  expiresAt: string;
}

export async function presignR2Put(i: PresignInput): Promise<PresignResult> {
  const host = `${i.accountId}.r2.cloudflarestorage.com`;
  const region = "auto"; // R2 has one region and calls it this.
  const service = "s3";

  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  // Each path segment is encoded individually so the separators survive.
  const canonicalUri = "/" +
    [i.bucket, ...i.key.split("/")].map(uriEncode).join("/");

  const signedHeaders = "content-length;content-type;host";
  const canonicalHeaders =
    `content-length:${i.contentLength}\n` +
    `content-type:${i.contentType}\n` +
    `host:${host}\n`;

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
    "PUT",
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
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    method: "PUT",
    headers: {
      "Content-Type": i.contentType,
      "Content-Length": String(i.contentLength),
    },
    expiresAt: new Date(now.getTime() + i.expiresIn * 1000).toISOString(),
  };
}
