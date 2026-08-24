// The seam between the pipeline and wherever the bytes actually live.
//
// Two implementations. R2Store is production. LocalStore is a directory on disk, and it
// exists for one specific reason: the dev machine has 8 GB of RAM and is already running
// the Supabase stack, so a MinIO container just to watch a 2-second test clip move between
// three folders is a cost with no return. With the seam, the whole pipeline runs locally
// against `Deno.makeTempDir()` and no container at all.
//
// That trade has a cost and it is named rather than hidden: LocalStore proves the PIPELINE,
// never the WIRE. Whether a presigned COPY is accepted by a real S3 implementation is a
// question only a real S3 implementation can answer, which is what
// worker/scripts/store-roundtrip.ts asks of MinIO in CI — the same argument, and the same
// MinIO, that scripts/sigv4-roundtrip.ts already uses for the presigner.

import { presignR2 } from "../../supabase/functions/_shared/sigv4.ts";

/**
 * §2's three buckets. `quarantine` is read and deleted, `originals` is written and never
 * read back, `public` is written and served by the CDN.
 *
 * Typed as a union rather than a string so a typo cannot invent a fourth bucket — and, more
 * to the point, so nothing can accidentally address `originals` where `public` was meant.
 * complete_ingest refuses that combination at the database, but a refusal after the bytes
 * are already in the wrong bucket is a refusal that arrives too late.
 */
export type Bucket = "quarantine" | "originals" | "public";

export interface ObjectStore {
  /** The first `length` bytes, for the sniffer. Never the whole object. */
  head(bucket: Bucket, key: string, length: number): Promise<Uint8Array>;
  download(bucket: Bucket, key: string, destPath: string): Promise<void>;
  /** Returns the number of bytes written, read from the local file. */
  upload(bucket: Bucket, key: string, srcPath: string, mime: string): Promise<number>;
  /** Server-side. The master is up to 4 GB and must never travel through this process. */
  copy(from: { bucket: Bucket; key: string }, to: { bucket: Bucket; key: string }): Promise<void>;
  remove(bucket: Bucket, key: string): Promise<void>;
}

export interface R2Credentials {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Test-only override, exactly as in _shared/sigv4.ts. */
  endpoint?: { host: string; protocol?: "http:" | "https:" };
  /**
   * Prepended to the logical bucket to form the physical one. Empty means they are the
   * same. See _shared/r2.ts r2BucketPrefix() — the `Bucket` union above stays logical on
   * purpose, because `media_assets.bucket` is a Postgres enum over the same three names.
   */
  bucketPrefix?: string;
}

const SIGNED_URL_TTL_S = 900;

/**
 * The largest derivative a single PUT will carry. See upload() for why buffering is not
 * optional and why this ceiling exists.
 *
 * 2 GiB against --memory=4Gi: comfortably above §6's worst legitimate rung (a 20-minute
 * 1440p at 8 Mbps, ~1.2 GB) and comfortably below the point where the instance dies.
 */
export const MAX_BUFFERED_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function uriEncodePath(key: string): string {
  return key.split("/").map((s) =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    )
  ).join("/");
}

export class R2Store implements ObjectStore {
  constructor(private readonly creds: R2Credentials) {}

  private sign(
    method: "GET" | "PUT" | "DELETE",
    bucket: Bucket,
    key: string,
    signHeaders?: Record<string, string>,
  ) {
    return presignR2({
      accountId: this.creds.accountId,
      accessKeyId: this.creds.accessKeyId,
      secretAccessKey: this.creds.secretAccessKey,
      bucket,
      key,
      method,
      expiresIn: SIGNED_URL_TTL_S,
      signHeaders,
      endpoint: this.creds.endpoint,
      bucketPrefix: this.creds.bucketPrefix,
    });
  }

  async head(bucket: Bucket, key: string, length: number): Promise<Uint8Array> {
    const { url } = await this.sign("GET", bucket, key);
    // Range is NOT in the signature, and does not need to be: an unsigned header is ignored
    // by the signature check, so adding it here cannot invalidate the URL. It is also not a
    // security control — it is a bandwidth control, so that sniffing a 4 GB master costs 64
    // bytes rather than 4 GB.
    const res = await fetch(url, { headers: { Range: `bytes=0-${length - 1}` } });
    if (!res.ok && res.status !== 206) {
      throw new Error(`head ${bucket}/${key}: ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async download(bucket: Bucket, key: string, destPath: string): Promise<void> {
    const { url } = await this.sign("GET", bucket, key);
    const res = await fetch(url);
    if (!res.ok || res.body === null) {
      throw new Error(`download ${bucket}/${key}: ${res.status}`);
    }
    // Streamed to disk. A 4 GB master read into memory is an instance that dies before it
    // has decided whether the file is even a video.
    const file = await Deno.open(destPath, { write: true, create: true, truncate: true });
    await res.body.pipeTo(file.writable);
  }

  async upload(bucket: Bucket, key: string, srcPath: string, mime: string): Promise<number> {
    const { size } = await Deno.stat(srcPath);

    // ── Why the body is buffered rather than streamed ─────────
    //
    // The first version of this streamed the file with `body: file.readable` and a hand-set
    // Content-Length. store-roundtrip.ts answered that with **HTTP 411 Length Required**,
    // which is the same fact scripts/sigv4-roundtrip.ts already records from the other
    // side: Content-Length is a forbidden header, fetch() drops it, and a stream body then
    // goes out chunked. S3 requires a length on PUT, so every upload failed — and it failed
    // only against a real server, never against LocalStore or a fake.
    //
    // Passing a Uint8Array makes the runtime set the length itself, which is the one way to
    // get a correct length through fetch. The cost is that the derivative is held in memory
    // once, sequentially, after ffmpeg has already exited.
    //
    // The worst case §6 admits is a 20-minute 1440p rendition at 8 Mbps — about 1.2 GB —
    // against --memory=4Gi with --concurrency=1. That fits with room to spare, and the
    // guard below turns anything larger into a transient failure with a named reason
    // instead of an instance killed by the kernel. Multipart upload is the fix if a rung
    // ever grows past it; it needs POST, which the presigner deliberately does not emit.
    if (size > MAX_BUFFERED_UPLOAD_BYTES) {
      throw new Error(
        `upload ${bucket}/${key}: ${size} bytes exceeds the ${MAX_BUFFERED_UPLOAD_BYTES}-byte ` +
          "single-PUT ceiling; this rung needs multipart upload",
      );
    }

    // Only content-type is signed. The difference from request-upload is worth stating:
    // there, signing content-length BINDS an untrusted browser to the size its quota was
    // charged for. Here the caller is this process, which already holds the R2 credentials,
    // so a length it computes for itself constrains nobody.
    const { url, headers } = await this.sign("PUT", bucket, key, { "Content-Type": mime });

    const res = await fetch(url, {
      method: "PUT",
      headers,
      body: await Deno.readFile(srcPath),
    });
    if (!res.ok) throw new Error(`upload ${bucket}/${key}: ${res.status}`);
    return size;
  }

  async copy(
    from: { bucket: Bucket; key: string },
    to: { bucket: Bucket; key: string },
  ): Promise<void> {
    // x-amz-copy-source MUST be signed. It is the entire instruction — an unsigned one
    // could be rewritten in flight to copy any object the credentials can reach into the
    // destination this URL authorises.
    // The SOURCE bucket is prefixed here rather than by the signer: this is a header, not
    // the request path, so it never passes through presignR2. Omitting the prefix would
    // name a bucket that does not exist and lose the master — the one object §6 calls the
    // archival copy — while the destination, which the signer does prefix, looked correct.
    const source = `/${this.creds.bucketPrefix ?? ""}${from.bucket}/${uriEncodePath(from.key)}`;
    const { url, headers } = await this.sign("PUT", to.bucket, to.key, {
      "x-amz-copy-source": source,
    });
    const res = await fetch(url, { method: "PUT", headers });
    if (!res.ok) throw new Error(`copy ${from.bucket}/${from.key}: ${res.status}`);
    // A CopyObject response can carry a 200 with an error document in the body. Reading it
    // is not optional: treating that as success loses the master silently.
    const body = await res.text();
    if (body.includes("<Error>")) {
      throw new Error(`copy ${from.bucket}/${from.key}: error in 200 response`);
    }
  }

  async remove(bucket: Bucket, key: string): Promise<void> {
    const { url } = await this.sign("DELETE", bucket, key);
    const res = await fetch(url, { method: "DELETE" });
    // 404 is success: the object is not there, which is what was asked for.
    if (!res.ok && res.status !== 404) {
      throw new Error(`remove ${bucket}/${key}: ${res.status}`);
    }
  }
}

/** A directory per bucket. Local runs and the fixture script use this; production never does. */
export class LocalStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private path(bucket: Bucket, key: string): string {
    return `${this.root}/${bucket}/${key}`;
  }

  private async ensureParent(p: string): Promise<void> {
    const dir = p.slice(0, p.lastIndexOf("/"));
    await Deno.mkdir(dir, { recursive: true });
  }

  async head(bucket: Bucket, key: string, length: number): Promise<Uint8Array> {
    const file = await Deno.open(this.path(bucket, key), { read: true });
    try {
      const buf = new Uint8Array(length);
      let read = 0;
      while (read < length) {
        const n = await file.read(buf.subarray(read));
        if (n === null) break;
        read += n;
      }
      return buf.subarray(0, read);
    } finally {
      file.close();
    }
  }

  async download(bucket: Bucket, key: string, destPath: string): Promise<void> {
    await this.ensureParent(destPath);
    await Deno.copyFile(this.path(bucket, key), destPath);
  }

  async upload(bucket: Bucket, key: string, srcPath: string, _mime: string): Promise<number> {
    const dest = this.path(bucket, key);
    await this.ensureParent(dest);
    await Deno.copyFile(srcPath, dest);
    return (await Deno.stat(dest)).size;
  }

  async copy(
    from: { bucket: Bucket; key: string },
    to: { bucket: Bucket; key: string },
  ): Promise<void> {
    const dest = this.path(to.bucket, to.key);
    await this.ensureParent(dest);
    await Deno.copyFile(this.path(from.bucket, from.key), dest);
  }

  async remove(bucket: Bucket, key: string): Promise<void> {
    try {
      await Deno.remove(this.path(bucket, key));
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
}
