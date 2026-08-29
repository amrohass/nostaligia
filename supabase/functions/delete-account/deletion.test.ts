/* deleteAccount() — the orchestration across two systems that cannot share a transaction.
 *
 * 0051's pgTAP file covers the database half exhaustively and it is the better place for
 * anything expressible in SQL. What it cannot reach is the part this file is about: what
 * happens when the SECOND system fails, and whether the failure is reported or swallowed.
 *
 * Every test below is a half-done state. That is deliberate — the happy path is one test
 * and the states around it are the feature, because "your account is deleted" said over a
 * failed GoTrue call is the one outcome this design exists to prevent.
 */

import { assertEquals } from "jsr:@std/assert@1";
import { deleteAccount, type AuthScrubber, type DeletionDb } from "./deletion.ts";
import type { ObjectSink } from "../_shared/r2.ts";

const USER = "11111111-2222-4333-8444-555555555555";

type MarkResult = Awaited<ReturnType<DeletionDb["requestAccountDeletion"]>>;

function db(mark: MarkResult, stamp = { ok: true, reason: "scrubbed" }) {
  const calls: string[] = [];
  const impl: DeletionDb = {
    requestAccountDeletion(userId) {
      calls.push("mark:" + userId);
      return Promise.resolve(mark);
    },
    markAuthScrubbed(userId) {
      calls.push("stamp:" + userId);
      return Promise.resolve(stamp);
    },
  };
  return { impl, calls };
}

function auth(result: { scrubbed: boolean; reason: string }) {
  const calls: string[] = [];
  const impl: AuthScrubber = {
    scrub(userId) {
      calls.push(userId);
      return Promise.resolve(result);
    },
  };
  return { impl, calls };
}

function sink(removed: boolean | Error) {
  const calls: string[] = [];
  const impl = {
    put: () => Promise.reject(new Error("not used")),
    exists: () => Promise.resolve(false),
    remove(key: string) {
      calls.push(key);
      return removed instanceof Error
        ? Promise.reject(removed)
        : Promise.resolve(removed);
    },
  } as unknown as ObjectSink;
  return { impl, calls };
}

const DELETED: MarkResult = {
  ok: true,
  reason: "deleted",
  user_id: USER,
  handle: "deleted_user_abc123def456",
  avatar_path: "avatars/" + USER + ".webp",
  auth_scrubbed: false,
};

Deno.test("the happy path scrubs auth, stamps the receipt, and removes the avatar", async () => {
  const d = db(DELETED);
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(true);

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  assertEquals(out.ok, true);
  assertEquals(out.auth_scrubbed, true);
  assertEquals(out.avatar_removed, true);
  assertEquals(a.calls, [USER]);
  assertEquals(s.calls, ["avatars/" + USER + ".webp"]);
  // The order is the safety property: mark, then stamp. Asserted as a sequence rather than
  // as two independent facts, because the ordering is the whole mitigation for the two
  // systems not being one transaction.
  assertEquals(d.calls, ["mark:null", "stamp:" + USER]);
});

Deno.test("a refused deletion touches neither GoTrue nor the bucket", async () => {
  const d = db({ ok: false, reason: "forbidden" });
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(true);

  const out = await deleteAccount(USER, { db: d.impl, auth: a.impl, avatars: s.impl });

  assertEquals(out.ok, false);
  assertEquals(out.reason, "forbidden");
  assertEquals(out.auth_reason, "not_attempted");
  // The assertion that matters. A handler that reported the refusal but had already
  // cleared the email would satisfy `ok: false` and be catastrophic, so the calls are
  // asserted rather than the return value alone.
  assertEquals(a.calls, []);
  assertEquals(s.calls, []);
});

Deno.test("GoTrue failing does NOT stamp the receipt — the retry list must stay accurate", async () => {
  const d = db(DELETED);
  const a = auth({ scrubbed: false, reason: "gotrue_500" });
  const s = sink(true);

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  // ok:true is correct and is the point of the ordering: the profile IS anonymized.
  assertEquals(out.ok, true);
  assertEquals(out.auth_scrubbed, false);
  assertEquals(out.auth_reason, "gotrue_500");
  // Never stamped. auth_scrubbed_at staying NULL is what puts this account on
  // `deleted_at is not null and auth_scrubbed_at is null`, which is the only list anybody
  // would look at to find a half-finished erasure.
  assertEquals(d.calls, ["mark:null"]);
});

Deno.test("a scrub that succeeds but cannot be recorded says so distinctly", async () => {
  const d = db(DELETED, { ok: false, reason: "unknown_profile" });
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(true);

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  assertEquals(out.auth_scrubbed, true);
  // Distinct from both "scrubbed" and "gotrue_500": the email IS gone, and the database
  // does not know it. Collapsing this into either one would mean an operator either
  // re-runs a completed scrub or never learns the receipt is missing.
  assertEquals(out.auth_reason, "scrubbed_unrecorded:unknown_profile");
});

Deno.test("a retry finishes the half that was left, and does not redo the half that was not", async () => {
  const d = db({ ...DELETED, reason: "already_deleted", avatar_path: null, auth_scrubbed: false });
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(true);

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  assertEquals(out.reason, "already_deleted");
  assertEquals(out.auth_scrubbed, true);
  // The retry is the recovery path, so `already_deleted` must NOT short-circuit: this is
  // the call that exists to complete the GoTrue half after it failed once.
  assertEquals(a.calls, [USER]);
});

Deno.test("a retry with nothing left to do calls GoTrue zero times", async () => {
  const d = db({ ...DELETED, reason: "already_deleted", avatar_path: null, auth_scrubbed: true });
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(true);

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  assertEquals(out.auth_scrubbed, true);
  assertEquals(out.auth_reason, "already_scrubbed");
  assertEquals(a.calls, []);
  assertEquals(d.calls, ["mark:null"]);
});

Deno.test("no avatar means null, which is not the same as a failed removal", async () => {
  const d = db({ ...DELETED, avatar_path: null });
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(true);

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  // §7 makes the avatar mandatory but generated by default, so this is the COMMON case.
  // Reporting it as `false` would put a 207 on the ordinary withdrawal of an account that
  // never uploaded a picture.
  assertEquals(out.avatar_removed, null);
  assertEquals(s.calls, []);
});

Deno.test("a bucket that throws is reported as false, not as a crash", async () => {
  const d = db(DELETED);
  const a = auth({ scrubbed: true, reason: "scrubbed" });
  const s = sink(new Error("network"));

  const out = await deleteAccount(null, { db: d.impl, auth: a.impl, avatars: s.impl });

  // The whole request must not fail: the profile is anonymized and the email is cleared.
  // An orphaned avatar object is the smallest of the three problems and the only one still
  // fixable afterwards — but it is reported, because nothing else in the system will ever
  // know where those bytes were once avatar_path is NULL.
  assertEquals(out.ok, true);
  assertEquals(out.auth_scrubbed, true);
  assertEquals(out.avatar_removed, false);
});
