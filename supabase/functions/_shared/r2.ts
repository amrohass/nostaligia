/* ObjectSink over R2, using the presigner the upload path already trusts.
 *
 * A presigned URL rather than a signed request: _shared/sigv4.ts is the only SigV4
 * implementation in this repository, it is covered by sigv4.test.ts and by a round-trip
 * against a real S3 implementation in CI, and a second signing path written for this
 * function would be a second one to get subtly wrong.
 *
 * ── Content-Length ───────────────────────────────────────────
 *
 * Not signed here, unlike request-upload. Bodies are strings of known length, so fetch sets
 * the header itself and sends a normal request — the 411 the worker hit came from a STREAM
 * body, where fetch cannot know the length and falls back to chunked. Signing a length the
 * caller does not control would only create a way for the two to disagree.
 */

import { presignR2 } from "./sigv4.ts";

/**
 * Somewhere to put objects, and take them away again.
 *
 * Bucket-fixed: one instance addresses one bucket. Takedown needs both `public` and
 * `originals` and builds two, which is deliberate — a sink that took the bucket per call
 * would make "which bucket" a parameter at every call site, and §6's whole rule about
 * originals/ is that the two are not interchangeable.
 */
export interface ObjectSink {
  /** Writes one object. Throws on failure — a partial release must not be flipped onto. */
  put(key: string, body: string, contentType: string, cacheControl: string): Promise<void>;
  /** True when the object is retrievable. Used to check what LANDED, not what was sent. */
  exists(key: string): Promise<boolean>;
  /** Removes one object. Resolves true when it is gone, including when it never existed. */
  remove(key: string): Promise<boolean>;
}

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Long enough to survive a slow upload, short enough that a leaked URL is not a key. */
const URL_TTL_SECONDS = 300;

export class R2Sink implements ObjectSink {
  constructor(private readonly cfg: R2Config) {}

  async put(key: string, body: string, contentType: string, cacheControl: string): Promise<void> {
    // Both headers are SIGNED. An unsigned header is ignored by the signature check and
    // may be dropped or honoured at the store's discretion — and cache-control is not a
    // detail here: it is the difference between a pointer that updates within a minute
    // and one the CDN holds for a year.
    const signed = await presignR2({
      ...this.cfg,
      key,
      method: "PUT",
      expiresIn: URL_TTL_SECONDS,
      signHeaders: { "content-type": contentType, "cache-control": cacheControl },
    });

    const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body });
    if (!res.ok) {
      // The body is read and discarded so the connection can be reused; the status is what
      // the caller acts on. R2's error XML is not echoed anywhere it could reach a client.
      await res.body?.cancel();
      throw new Error(`PUT ${key} failed with ${res.status}`);
    }
    await res.body?.cancel();
  }

  async exists(key: string): Promise<boolean> {
    const signed = await presignR2({
      ...this.cfg,
      key,
      method: "HEAD",
      expiresIn: URL_TTL_SECONDS,
    });
    const res = await fetch(signed.url, { method: "HEAD" });
    await res.body?.cancel();
    return res.ok;
  }

  /**
   * §8 step 1: "delete/rename the object in R2 immediately."
   *
   * 404 counts as success. A takedown retried after a partial failure — which is the
   * documented recovery path in 0036 — must not fail on the objects the first attempt
   * already removed, or the retry can never complete.
   */
  async remove(key: string): Promise<boolean> {
    const signed = await presignR2({
      ...this.cfg,
      key,
      method: "DELETE",
      expiresIn: URL_TTL_SECONDS,
    });
    const res = await fetch(signed.url, { method: "DELETE" });
    await res.body?.cancel();
    return res.ok || res.status === 404;
  }
}
