/* Withdrawal, across the two systems that cannot share a transaction.
 *
 *     anonymize the profile → clear the auth user → delete the avatar → stamp the receipt
 *
 * §7 gives a contributor the right to withdraw. 0051 does the database half atomically and
 * explains why the account is anonymized rather than deleted: `audit_log.actor` is ON
 * DELETE SET NULL, §3's append-only trigger refuses the UPDATE that cascade attempts, and
 * `DELETE /auth/v1/admin/users/{id}` therefore answers 500 / 23001 for anybody who has ever
 * acted. That is the system working as designed, and it is why this file exists.
 *
 * ── "Atomically" stops at the database boundary, and the ORDER is the mitigation ─
 *
 * The RPC is a transaction; the GoTrue call is HTTP. Nothing can make them one unit, so the
 * question is which half-done state a failure leaves — and the two are not equally bad:
 *
 *   profile scrubbed, auth not    the name, avatar and bio are gone from every surface a
 *                                 reader can reach. What remains is an email address behind
 *                                 the service-role key. Invisible, and recovered by calling
 *                                 this endpoint again.
 *
 *   auth cleared, profile not     the person can no longer sign in, and their name is still
 *                                 on every card they contributed. They cannot fix it and
 *                                 they cannot ask, because they cannot log in.
 *
 * So the database goes first, exactly as §8's takedown marks the post before deleting the
 * bytes and for the same reason. 0051's RPC is idempotent so that retrying is the recovery
 * path rather than a second deletion.
 *
 * ── Reported, never swallowed ────────────────────────────────
 *
 * Every step returns its own result, following takedown.ts. `auth_scrubbed: false` with
 * `ok: true` is a real and expected state, and it is exactly what
 * `deleted_at is not null and auth_scrubbed_at is null` finds in the database. Telling a
 * contributor their account is gone when their email is still in auth.users would be the
 * one lie this whole feature exists to avoid.
 */

import type { ObjectSink } from "../_shared/r2.ts";

export interface DeletionDb {
  /**
   * Anonymizes the profile and returns the account id plus the OLD avatar path.
   *
   * Runs as the CALLER, like request_takedown: 0051 checks `is_admin()` from the database
   * against the caller's own token, and the audit row takes its actor from auth.uid(). Run
   * with the service key it would still work, and every deletion in the permanent record
   * would be attributed to nobody.
   */
  requestAccountDeletion(userId: string | null): Promise<{
    ok: boolean;
    reason: string;
    user_id?: string;
    handle?: string;
    avatar_path?: string | null;
    auth_scrubbed?: boolean;
  }>;
  /** Stamps auth_scrubbed_at. service_role only (0051) — a browser may not claim this. */
  markAuthScrubbed(userId: string): Promise<{ ok: boolean; reason: string }>;
}

/** The GoTrue admin API, behind an interface so the orchestration is testable without it. */
export interface AuthScrubber {
  scrub(userId: string): Promise<{ scrubbed: boolean; reason: string }>;
}

export interface Deps {
  db: DeletionDb;
  auth: AuthScrubber;
  /** The `public` bucket. The avatar is the one object a profile owns outright. */
  avatars: ObjectSink;
}

export interface DeletionOutcome {
  ok: boolean;
  reason: string;
  user_id?: string;
  handle?: string;
  /** False is not a failure — it is the retry list. See the header. */
  auth_scrubbed: boolean;
  auth_reason: string;
  /** null when there was no avatar to remove, which is the common case (§7's default). */
  avatar_removed: boolean | null;
}

export async function deleteAccount(
  userId: string | null,
  deps: Deps,
): Promise<DeletionOutcome> {
  const marked = await deps.db.requestAccountDeletion(userId);

  if (!marked.ok) {
    return {
      ok: false,
      reason: marked.reason,
      auth_scrubbed: false,
      auth_reason: "not_attempted",
      avatar_removed: null,
    };
  }

  const target = marked.user_id!;

  // `already_deleted` reaches here on purpose rather than returning early. It is what a
  // retry looks like, and a retry exists precisely because one of the steps below did not
  // finish the first time. Returning early would make the endpoint unable to complete the
  // work it is being called a second time to complete.
  //
  // 0051 reports `auth_scrubbed` on that path so a retry that has nothing left to do says
  // so instead of calling GoTrue again for no reason.
  let authScrubbed = marked.auth_scrubbed === true;
  let authReason = authScrubbed ? "already_scrubbed" : "not_attempted";

  if (!authScrubbed) {
    const res = await deps.auth.scrub(target);
    authScrubbed = res.scrubbed;
    authReason = res.reason;

    // The receipt is written ONLY after GoTrue confirms. Stamping it optimistically would
    // take a half-finished erasure off the one list anybody would look at to find it.
    if (authScrubbed) {
      const stamped = await deps.db.markAuthScrubbed(target);
      if (!stamped.ok) authReason = "scrubbed_unrecorded:" + stamped.reason;
    }
  }

  // The avatar, last, and only when 0051 handed one back. `avatar_path` is NULL after the
  // scrub, so this call is the only thing that will ever know where those bytes were —
  // after this request nothing in the database points at them and they would sit in a
  // CDN-fronted bucket forever.
  //
  // §7 makes the avatar mandatory but generated by default, so most withdrawals have no
  // object here at all; `null` says "nothing to remove", which is not the same as "failed".
  let avatarRemoved: boolean | null = null;
  const avatarPath = marked.avatar_path;
  if (avatarPath) {
    try {
      avatarRemoved = await deps.avatars.remove(avatarPath);
    } catch {
      avatarRemoved = false;
    }
  }

  // 207, not 200, upstream when either half is incomplete — the handler maps this. The
  // profile IS anonymized either way, which is the part that governs what anyone can see.
  return {
    ok: true,
    reason: marked.reason,
    user_id: target,
    handle: marked.handle,
    auth_scrubbed: authScrubbed,
    auth_reason: authReason,
    avatar_removed: avatarRemoved,
  };
}
