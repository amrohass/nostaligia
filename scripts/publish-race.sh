#!/usr/bin/env bash
# Two publishers, one lease — the race 17_publish_lease.test.sql cannot express.
#
#     bash scripts/publish-race.sh
#
# ── Why this is not a pgTAP file ─────────────────────────────
#
# Mutual exclusion needs two backends contending inside open transactions. pgTAP runs in
# one session, and dblink — which is installed — refuses a passwordless connection from a
# non-superuser, so using it means writing a database password into the repository. §6
# draws that line in one direction only, and "it is only the local dev password" is exactly
# the sentence that precedes a credential in a public repo.
#
# So: two psql processes, no password anywhere, connection taken from the running container
# the same way the rest of the local stack is reached.
#
# ── What it proves, and why it takes two shapes ──────────────
#
# The single writer is TWO mechanisms and they cover different windows. This script is here
# because each one is invisible while the other is working.
#
#   during A's open transaction   B is refused `contended`  ← the advisory lock
#   after A commits, lease live   B is refused `held`       ← the lease row
#
# Delete the lease row and keep the lock and the `held` check fails: B waits for nothing,
# because A's lock died with A's transaction while A is still building for another ninety
# seconds over HTTP.
#
# ── The third scenario, and why it is the important one ──────
#
# Both of the above were run against a copy of claim_publish_lease with the advisory lock
# deleted and nothing else changed. Measured, not reasoned:
#
#   first claim, empty table   B saw nothing, inserted, and hit `duplicate key value
#                              violates unique constraint publish_lease_pkey`. So the
#                              primary key DOES stop this shape — but by throwing an
#                              exception at a publisher that has already written objects,
#                              instead of telling it cleanly that someone else is busy.
#
#   reclaiming an EXPIRED      A got `reclaimed`. B got `reclaimed`. No error, no
#   lease                      constraint violation, two publishers each holding what they
#                              believe is an exclusive lease, both writing into the same
#                              release directory.
#
# The second has no backstop at all, because both sessions UPDATE an existing row rather
# than inserting a new one, and an UPDATE that blocks and then proceeds is indistinguishable
# from one that never contended. It is also the path taken on every recovery from a crashed
# publisher — the moment the system is least attended to.
#
# That is what checks 7–9 cover, and it is the reason the advisory lock is not optional.

set -euo pipefail

A='00000000-0000-0000-0000-00000000ace1'
B='00000000-0000-0000-0000-00000000bce1'

# How long a simulated build sits inside its transaction, in seconds.
#
# It has to comfortably exceed every round trip the contending session makes before it
# asks, and `docker exec` costs about a second each. Five was the original figure and it
# left roughly one second of margin; the approval scenario at the bottom of this file spent
# that margin on an extra call and read `held` where it expected `contended` — a false
# failure, but the same tightness would eventually produce a false PASS in the scenarios
# that assert a lease is invisible. Ten seconds costs the job half a minute and removes the
# question.
HOLD_S=10

passed=0
failed=0
check() { # check <expected> <actual> <name>
  if [ "$1" = "$2" ]; then
    passed=$((passed + 1)); echo "ok $((passed + failed)) - $3"
  else
    failed=$((failed + 1)); echo "not ok $((passed + failed)) - $3 (expected '$1', got '$2')"
  fi
}

container=$(docker ps --filter name=supabase_db --format '{{.Names}}' | head -1)
if [ -z "$container" ]; then
  echo "No supabase_db container is running. Start the stack first:" >&2
  echo "  npx supabase start -x studio,storage-api,imgproxy,realtime,logflare,vector" >&2
  exit 2
fi
echo "# publish lease race — against $container"

q() { docker exec -i "$container" psql -U postgres -d postgres -At -c "$1"; }

# This script COMMITS, unlike every pgTAP file in the suite, because an uncommitted lease is
# invisible to the second session and invisibility is the thing being tested. So it cleans
# up after itself at both ends.
q "delete from public.publish_lease;" > /dev/null

# ── Session A: claim, then sit inside the open transaction ───
#
# pg_sleep rather than a shell sleep, so the wait happens inside the transaction that is
# supposed to be holding the lock. A shell sleep between two psql calls would prove nothing:
# the transaction would already have ended.
a_out=$(mktemp)
docker exec -i "$container" psql -U postgres -d postgres -At > "$a_out" 2>&1 <<SQL &
begin;
select public.claim_publish_lease('$A', interval '5 minutes', 'race A') ->> 'reason';
select pg_sleep($HOLD_S);
commit;
SQL
a_pid=$!

# Let A get inside its transaction. Also a database call, for the same reason as above.
q "select pg_sleep(1.5);" > /dev/null

# ── Session B, while A is mid-transaction ────────────────────

b_during=$(q "select public.claim_publish_lease('$B') ->> 'reason';")
b_sees=$(q "select count(*) from public.publish_lease;")

check "contended" "$b_during" "while A holds an open transaction, B is refused — the advisory lock"
check "0" "$b_sees" "...and B cannot even SEE A's lease row, so the row alone would not have stopped it"

wait "$a_pid" || true
# psql -At still prints the command tag for BEGIN and COMMIT, so the first line of A's
# output is "BEGIN", not the answer. Pick the reason out by its value.
a_reason=$(grep -m1 -E '^(granted|reheld|reclaimed_expired|held|contended)$' "$a_out" || true)
check "granted" "$a_reason" "A's own claim was granted"

# ── Session B, after A committed ─────────────────────────────

b_after=$(q "select public.claim_publish_lease('$B') ->> 'reason';")
b_sees_now=$(q "select count(*) from public.publish_lease;")

check "held" "$b_after" "after A commits its lock is gone, and the lease row refuses B on its own"
check "1" "$b_sees_now" "...which it can now see"

holder=$(q "select holder from public.publish_lease where id;")
check "$A" "$holder" "and the lease still belongs to A — B never took it in either window"

# ── The reclaim race, which has no constraint to fall back on ─

q "delete from public.publish_lease;" > /dev/null
# A lease from a publisher that crashed: taken ten minutes ago, lapsed a minute ago.
q "insert into public.publish_lease (holder, acquired_at, expires_at)
   values ('00000000-0000-0000-0000-00000000dead', now() - interval '10 minutes',
           now() - interval '1 minute');" > /dev/null

c_out=$(mktemp)
docker exec -i "$container" psql -U postgres -d postgres -At > "$c_out" 2>&1 <<SQL &
begin;
select public.claim_publish_lease('$A', interval '5 minutes', 'reclaim A') ->> 'reason';
select pg_sleep($HOLD_S);
commit;
SQL
c_pid=$!

q "select pg_sleep(1.5);" > /dev/null

d_during=$(q "select public.claim_publish_lease('$B') ->> 'reason';")
check "contended" "$d_during" "two publishers reclaiming the SAME expired lease: only one proceeds"

wait "$c_pid" || true
c_reason=$(grep -m1 -E '^(granted|reheld|reclaimed_expired|held|contended)$' "$c_out" || true)
check "reclaimed_expired" "$c_reason" "...and the one that proceeds is the one that took the lock"

reclaim_holder=$(q "select holder from public.publish_lease where id;")
check "$A" "$reclaim_holder" "...leaving exactly one holder, not two convinced of the same thing"

# ── §10 M2's exit criterion, as two MODERATION ACTIONS ───────
#
# "Two concurrent approvals produce one consistent release." The scope note of 20 Aug 2026
# substitutes moderation actions for cron ticks as the thing that races, because 0042 made
# the approval the trigger and the cron is deferred. What discriminates is unchanged: the
# advisory lock.
#
# Two properties have to hold together, and either one alone is a system that loses work:
#
#   exactly one publisher proceeds      the lock. Without it both build into the same
#                                       release directory (see the reclaim scenario above).
#   the other approval is not lost      the follow-up. Without it the second approval sits
#                                       published-in-nobody's-release until an unrelated
#                                       change happens to trigger a build — which under a
#                                       two-minute cron was one tick away and is now never.

q "delete from public.publish_lease;" > /dev/null

MOD='00000000-0000-0000-0000-00000000e0d1'
P1='00000000-0000-0000-0000-00000000e0a1'
P2='00000000-0000-0000-0000-00000000e0a2'

# approved_by is supplied by hand: posts_enforce_approval takes coalesce(auth.uid(), …) and
# psql as postgres carries no JWT, so without it posts_approved_is_attributable refuses the
# UPDATE. The constraint is doing its job; this is the fixture meeting it.
q "insert into auth.users (id, email) values ('$MOD', 'race-mod@t.local')
     on conflict (id) do nothing;" > /dev/null
q "insert into public.posts (id, kind, title_en, body_en, license, provenance,
                             created_by, ingest_state, status)
   values ('$P1', 'media', 'race one', 'a description', 'CC-BY-SA-4.0', 'fixture',
           '$MOD', 'ready', 'pending'),
          ('$P2', 'media', 'race two', 'a description', 'CC-BY-SA-4.0', 'fixture',
           '$MOD', 'ready', 'pending')
     on conflict (id) do nothing;" > /dev/null

# ── The approval COMMITS before its publisher claims ─────────
#
# This is the shape of the real thing and the first version of this scenario got it wrong in
# an instructive way. It approved and claimed the lease inside ONE open transaction, which
# does not happen: a moderator's UPDATE commits, and the publisher it dispatched then runs in
# a transaction of its own.
#
# Holding both open deadlocks the test against a real property of 0037 — publish_revision is
# a SINGLE row, so every content write updates it and every content write therefore queues
# behind any open transaction that has already bumped it. Session B's approval blocked until
# session A committed, B asked for the lease afterwards, and the check read `held` instead of
# `contended`: the lock was never contended because the two were never concurrent.
#
# Worth stating rather than just fixing, because the serialisation is real and is fine.
# Approval transactions are milliseconds long, and the publisher's transaction — the one that
# is held for the length of a build — never touches publish_revision at all.
q "update public.posts set status = 'approved', approved_by = '$MOD' where id = '$P1';" > /dev/null

# A's publisher: claims, then sits for the length of a build. No bump in here, which is why
# B's approval below is free to commit while it runs.
e_out=$(mktemp)
docker exec -i "$container" psql -U postgres -d postgres -At > "$e_out" 2>&1 <<SQL &
begin;
select public.claim_publish_lease('$A', interval '5 minutes', 'approval A') ->> 'content_revision';
select pg_sleep($HOLD_S);
commit;
SQL
e_pid=$!

# Session B: the second moderator approves while A is mid-build, and the publisher B's
# approval dispatches finds the lease already taken.
#
# ONE round trip, not three. `docker exec` costs about a second, so waiting and then
# approving and then claiming as separate calls spends three of them inside a window this
# script sets the length of. The wait happens inside the session that does the asking.
e_during=$(docker exec -i "$container" psql -U postgres -d postgres -At <<SQL | tail -1
select pg_sleep(1.5);
update public.posts set status = 'approved', approved_by = '$MOD' where id = '$P2';
select public.claim_publish_lease('$B') ->> 'reason';
SQL
)
check "contended" "$e_during" "two approvals racing: only one publisher proceeds — the lock"

wait "$e_pid" || true
# A's claim-time content_revision. The BEGIN/UPDATE tags print first, so pick the integer.
a_rev=$(grep -m1 -E '^[0-9]+$' "$e_out" || true)
check "1" "$([ -n "$a_rev" ] && echo 1 || echo 0)" "...and A's claim reported the revision it read at"

# The release A would have written is stamped with a_rev, which predates B's approval. So
# after A finishes, B's approval is still outstanding — and the lease release is the only
# thing left that can say so.
e_follow=$(q "select public.release_publish_lease('$A', $a_rev) ->> 'followed_up';")
check "true" "$e_follow" "...and B's approval is followed up rather than stranded (0042)"

# `pending`, not the reason. This script never records a release — it is about the lock, not
# about the archive — so publish_pending answers 'no_active_release' here where a system
# with a release would answer 'content_changed'. Both mean work is outstanding, and the
# reason is asserted against a real watermark in 23_publish_on_approval instead.
e_pending=$(q "select (public.publish_pending() ->> 'pending')::text;")
check "true" "$e_pending" "...which is exactly what the archive still says is outstanding"

# The posts go; the auth.users row STAYS. Deleting it cascades ON DELETE SET NULL onto
# audit_log.actor, and audit_log_is_append_only refuses the UPDATE — §3: "audit rows are
# permanent". The insert above is ON CONFLICT DO NOTHING for exactly this reason, so a
# second run reuses the row rather than needing to remove it.
q "delete from public.posts where id in ('$P1', '$P2');" > /dev/null
q "delete from public.publish_lease;" > /dev/null
rm -f "$a_out" "$c_out" "$e_out"

echo
echo "1..$((passed + failed))"
if [ "$failed" -gt 0 ]; then
  echo "$failed of $((passed + failed)) checks failed."
  exit 1
fi
echo "All $passed checks passed."
