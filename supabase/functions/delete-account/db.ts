/* The two database calls withdrawal makes, and the two identities it makes them with.
 *
 * request_account_deletion runs as the CALLER — the member's or admin's own JWT — because
 * 0051 checks `is_admin()` from the database and writes `auth.uid()` into the audit row.
 * Run with the service key it would still work, and §3's permanent record of every deletion
 * would name nobody. Same argument takedown/db.ts makes about request_takedown, and the
 * same one §4 makes about the moderation ledger generally.
 *
 * mark_account_auth_scrubbed runs as the service role because 0051 grants it to service_role
 * ONLY. It is a claim that an email is gone from auth.users, and nothing a browser holds is
 * in a position to make that claim.
 */

import { rpc, serviceRoleJwt } from "../_shared/http.ts";
import type { DeletionDb } from "./deletion.ts";

export class PostgrestDeletionDb implements DeletionDb {
  constructor(private readonly callerJwt: string) {}

  async requestAccountDeletion(userId: string | null) {
    const res = await rpc(
      "request_account_deletion",
      // p_note is deliberately not exposed by this endpoint. 0051 writes it to
      // moderation_actions only on the admin path, and this function has no admin UI yet —
      // shipping the parameter with nothing to fill it invites a caller to put the
      // contributor's reason for leaving into a permanent, team-readable table.
      { p_user_id: userId },
      this.callerJwt,
    );
    if (!res.ok) throw new Error("request_account_deletion returned " + res.status);
    return await res.json() as {
      ok: boolean;
      reason: string;
      user_id?: string;
      handle?: string;
      avatar_path?: string | null;
      auth_scrubbed?: boolean;
    };
  }

  async markAuthScrubbed(userId: string) {
    const res = await rpc(
      "mark_account_auth_scrubbed",
      { p_user_id: userId },
      serviceRoleJwt(),
    );
    if (!res.ok) throw new Error("mark_account_auth_scrubbed returned " + res.status);
    return await res.json() as { ok: boolean; reason: string };
  }
}
