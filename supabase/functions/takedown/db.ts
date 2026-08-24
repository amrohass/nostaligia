/* The two database calls takedown makes, and the two identities it makes them with.
 *
 * request_takedown runs as the CALLER — the moderator's own JWT — because 0036 checks
 * is_moderator() from the database and 0012's trigger takes the actor from auth.uid(). Run
 * with the service key it would still work and the audit row would say the actor was
 * nobody, which turns §4's "every moderator action writes who did it" into a lie told by
 * the system rather than by a person.
 *
 * redacted_post_ids runs as the service role, because it is granted to service_role only
 * (0035) and is not the caller's business: the full list of taken-down ids is a list of
 * everything anyone has ever asked to have removed.
 */

import { rpc, serviceRoleJwt } from "../_shared/http.ts";
import type { TakedownDb, TakedownObject } from "./takedown.ts";

export class PostgrestTakedownDb implements TakedownDb {
  constructor(private readonly callerJwt: string) {}

  async requestTakedown(postId: string, note: string | null) {
    const res = await rpc(
      "request_takedown",
      { p_post_id: postId, p_note: note },
      this.callerJwt,
    );
    if (!res.ok) throw new Error("request_takedown returned " + res.status);
    return await res.json() as {
      ok: boolean;
      reason: string;
      post_id?: string;
      objects?: TakedownObject[];
    };
  }

  async redactedPostIds(): Promise<string[]> {
    const res = await rpc("redacted_post_ids", {}, serviceRoleJwt());
    if (!res.ok) throw new Error("redacted_post_ids returned " + res.status);
    return await res.json() as string[];
  }
}
