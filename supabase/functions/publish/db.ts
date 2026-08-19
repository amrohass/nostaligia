/* The Db interface, over PostgREST, as the service role.
 *
 * Every method is one RPC against a function 0034 or 0035 granted to service_role and
 * nobody else. There is no table access here at all: the publisher reads the archive
 * through publishable_posts(), which carries the same predicate as the RLS policies rather
 * than a second copy of it, and writes nothing except through the lease and ledger
 * functions.
 *
 * A non-2xx from PostgREST throws. It is never turned into an empty result — a publisher
 * that read "no approved posts" from a network error would build an empty release, validate
 * it happily, and flip the pointer onto an archive with nothing in it.
 */

import { env, rpc } from "../_shared/http.ts";
import type { Db } from "./release.ts";
import type { SourcePost } from "./shards.ts";

export class PostgrestDb implements Db {
  private readonly key = env("SUPABASE_SERVICE_ROLE_KEY");

  private async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await rpc(name, args, this.key);
    if (!res.ok) {
      // The status, not the body. PostgREST echoes SQL detail on some errors and this
      // function's logs are not a place to accumulate schema information.
      throw new Error(`${name} returned ${res.status}`);
    }
    return await res.json() as T;
  }

  publishablePosts(): Promise<Array<SourcePost & { hash_matches?: boolean }>> {
    return this.call("publishable_posts");
  }

  redactedPostIds(): Promise<string[]> {
    return this.call("redacted_post_ids");
  }

  async claimLease(holder: string, ttlSeconds: number, note: string) {
    const out = await this.call<{
      acquired: boolean;
      reason: string;
      content_revision?: number;
      counter_revision?: number;
    }>("claim_publish_lease", {
      p_holder: holder,
      // PostgREST sends jsonb; an interval arrives as an ISO-8601 duration string, which
      // Postgres casts on the way into the parameter.
      p_ttl: `PT${ttlSeconds}S`,
      p_note: note,
    });
    // Present only on the branches that granted the lease — a refusal carries no revision
    // because there is no build to stamp.
    return {
      acquired: out.acquired === true,
      reason: out.reason,
      content_revision: out.content_revision,
      counter_revision: out.counter_revision,
    };
  }

  async releaseLease(holder: string): Promise<void> {
    await this.call("release_publish_lease", { p_holder: holder });
  }

  recordRelease(path: string, contentRevision: number, counterRevision: number) {
    return this.call<{ recorded: boolean; id?: string; reason?: string }>("record_release", {
      p_path: path,
      p_content_revision: contentRevision,
      p_counter_revision: counterRevision,
    });
  }

  activateRelease(id: string) {
    return this.call<{ activated: boolean; previous_path?: string | null }>("activate_release", {
      p_id: id,
    });
  }
}
