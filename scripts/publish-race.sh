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
select pg_sleep(5);
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
select pg_sleep(5);
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

q "delete from public.publish_lease;" > /dev/null
rm -f "$a_out" "$c_out"

echo
echo "1..$((passed + failed))"
if [ "$failed" -gt 0 ]; then
  echo "$failed of $((passed + failed)) checks failed."
  exit 1
fi
echo "All $passed checks passed."
