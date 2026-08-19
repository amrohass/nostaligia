/* Cloudflare cache purge.
 *
 * §8 step 2. Derivatives are served `max-age=31536000, immutable`, so deleting the object
 * from R2 evicts nothing the CDN already holds — a taken-down photo would stay retrievable
 * at its original URL for up to a year by anyone with the link, which is the population a
 * takedown is usually about.
 *
 * ── When it is not configured ────────────────────────────────
 *
 * The token is capability-bearing (§6) and lives in the function environment only. Until a
 * Cloudflare account exists there is nothing to put there, and this returns
 * `not_configured` rather than pretending. takedown.ts then reports ok:false with
 * cdn_reason, and the moderator is told the bytes are deleted but a cached copy may
 * persist — which is true, and is the kind of thing a person needs to know before they tell
 * a contributor their photograph has been removed.
 *
 * A silent skip here would be the worst available choice: the same green tick for a
 * complete removal and for one that leaves the file served from a hundred edge locations.
 */

export interface PurgeResult {
  purged: boolean;
  reason: string;
}

export interface CloudflareConfig {
  zoneId: string;
  token: string;
  /** The CDN origin the paths hang off, e.g. https://cdn.example.org */
  cdnOrigin: string;
}

/** Reads the environment without throwing — absence is a state this handles, not an error. */
export function cloudflareFromEnv(cdnOrigin: string): CloudflareConfig | null {
  const zoneId = Deno.env.get("CLOUDFLARE_ZONE_ID");
  const token = Deno.env.get("CLOUDFLARE_PURGE_TOKEN");
  if (!zoneId || !token || !cdnOrigin) return null;
  return { zoneId, token, cdnOrigin };
}

export class CloudflarePurger {
  constructor(private readonly cfg: CloudflareConfig | null) {}

  async purge(paths: string[]): Promise<PurgeResult> {
    if (!this.cfg) return { purged: false, reason: "not_configured" };
    if (paths.length === 0) return { purged: true, reason: "nothing_to_purge" };

    // The API takes at most 30 URLs per call, so this chunks rather than assuming. A post
    // with a full video ladder plus poster and thumb is six; a bulk import taken down in
    // one action could be far more.
    for (let i = 0; i < paths.length; i += 30) {
      const files = paths.slice(i, i + 30).map((p) => this.cfg!.cdnOrigin + "/" + p);
      const res = await fetch(
        "https://api.cloudflare.com/client/v4/zones/" + this.cfg.zoneId + "/purge_cache",
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + this.cfg.token,
            "content-type": "application/json",
          },
          body: JSON.stringify({ files }),
        },
      );
      const ok = res.ok;
      await res.body?.cancel();
      // Reported by status only. Cloudflare's error body can echo the zone id, and this
      // string travels back to a browser.
      if (!ok) return { purged: false, reason: "api_" + res.status };
    }
    return { purged: true, reason: "purged" };
  }
}
