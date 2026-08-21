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
import type { RollbackDb } from "./rollback.ts";
import type { ContentBlocks, SourcePlace, SourcePost, SourceProfile } from "./shards.ts";

export class PostgrestDb implements Db, RollbackDb {
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

  contentBlocks(): Promise<ContentBlocks> {
    return this.call("published_content_blocks");
  }

  publishableProfiles(): Promise<SourceProfile[]> {
    return this.call("publishable_profiles");
  }

  publishablePlaces(): Promise<SourcePlace[]> {
    return this.call("publishable_places");
  }

  unpublishablePostIds(): Promise<string[]> {
    return this.call("unpublishable_post_ids");
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

  async releaseLease(holder: string, claimedContentRevision?: number): Promise<void> {
    // Omitted rather than sent as null when the caller has no revision to give. 0042's
    // default is NULL and means "do not follow up", so an absent argument and an explicit
    // null are the same thing to the database — but sending the key only when it carries a
    // value keeps the wire honest about whether a follow-up was ever possible.
    const args: Record<string, unknown> = { p_holder: holder };
    if (claimedContentRevision !== undefined) {
      args.p_claimed_content_revision = claimedContentRevision;
    }
    await this.call("release_publish_lease", args);
  }

  recordRelease(path: string, contentRevision: number, counterRevision: number, holder: string) {
    return this.call<{ recorded: boolean; id?: string; reason?: string }>("record_release", {
      p_path: path,
      p_content_revision: contentRevision,
      p_counter_revision: counterRevision,
      p_holder: holder,
    });
  }

  rollbackRelease(path: string, holder: string, reason: string) {
    return this.call<{
      rolled_back: boolean;
      reason?: string;
      previous_path?: string | null;
      held?: boolean;
    }>("rollback_release", { p_path: path, p_holder: holder, p_reason: reason });
  }

  activateRelease(id: string, holder: string) {
    return this.call<{ activated: boolean; reason?: string; previous_path?: string | null }>(
      "activate_release",
      { p_id: id, p_holder: holder },
    );
  }
}
