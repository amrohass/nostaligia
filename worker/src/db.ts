// The worker's entire reach into the database: two functions, no tables.
//
// Migration 0026 gave media_worker a Postgres role with NO table grants and EXECUTE on
// exactly complete_ingest and fail_ingest. This module cannot do more than that even if it
// tried, which is the point — the boundary is enforced by grants, not by this file being
// careful. 10_ingest_rpcs and 14_release_ingest assert both halves: what it can reach, and
// what it cannot.
//
// ── What credential this holds, and what it does not ─────────
//
// A JWT with `role: "media_worker"`, minted OUT OF BAND and handed in as an environment
// variable. Not the JWT signing secret, and not a service-role key. A fully compromised
// worker therefore holds a token that expires and that can call two functions; it cannot
// mint a token for another role, cannot read a single post, and cannot approve anything.
//
// PostgREST switches into media_worker because 0026 made `authenticator` a member of it, so
// the role claim in this token is honoured by the database rather than trusted by us.

export interface AssetRow {
  role: "master" | "rendition" | "thumb" | "poster";
  rendition?: string | null;
  storage_path: string;
  bucket: "originals" | "public";
  mime: string;
  bytes?: number | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  bitrate_kbps?: number | null;
  sort_order: number;
}

export interface RpcOutcome {
  ok: boolean;
  reason?: string;
  [k: string]: unknown;
}

export interface IngestReporter {
  complete(objectKey: string, sniffedMime: string, assets: AssetRow[]): Promise<RpcOutcome>;
  fail(objectKey: string, reason: string): Promise<RpcOutcome>;
}

export interface PostgrestConfig {
  url: string;
  anonKey: string;
  workerJwt: string;
}

export class PostgrestReporter implements IngestReporter {
  constructor(private readonly cfg: PostgrestConfig) {}

  private async call(fn: string, args: Record<string, unknown>): Promise<RpcOutcome> {
    const res = await fetch(`${this.cfg.url.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: this.cfg.anonKey,
        Authorization: `Bearer ${this.cfg.workerJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    // A non-2xx here is PostgREST refusing the CALL — an expired token, a role that lost its
    // grant. That is not a bad file and must never become fail_ingest, or a rotated
    // credential would burn every upload that arrived during the rotation.
    if (!res.ok) {
      throw new Error(`${fn}: PostgREST ${res.status}`);
    }
    return await res.json() as RpcOutcome;
  }

  complete(objectKey: string, sniffedMime: string, assets: AssetRow[]): Promise<RpcOutcome> {
    return this.call("complete_ingest", {
      p_object_key: objectKey,
      p_sniffed_mime: sniffedMime,
      p_assets: assets,
    });
  }

  fail(objectKey: string, reason: string): Promise<RpcOutcome> {
    // fail_ingest truncates to 500 characters and the text is shown to the uploader (§7:
    // never to the public). Reasons are named constants from the pipeline, never ffmpeg's
    // stderr — that would echo attacker-supplied bytes back into a page.
    return this.call("fail_ingest", { p_object_key: objectKey, p_reason: reason });
  }
}
