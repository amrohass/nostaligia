#!/usr/bin/env bash
# The contribution lifecycle, end to end.
#
#     bash scripts/lifecycle.sh
#
# request-upload → presigned PUT → an S3 server → complete-upload → the worker container →
# derivatives in public/, master in originals/. The seams between those, which every unit
# test in the repository stops short of.
#
# ── The environment contract ─────────────────────────────────
#
# Nothing here is specific to GitHub Actions, and nothing here starts a service. Connection
# details come from the environment, discovered where they can be — the same shape as
# scripts/publish-race.sh, which finds the running container rather than being told about
# it. Bring the three services up however you like; this checks they are there and refuses
# clearly if they are not.
#
#   SUPABASE_URL                default http://127.0.0.1:54321
#   SUPABASE_ANON_KEY           discovered from `supabase status` if unset
#   SUPABASE_SERVICE_ROLE_KEY   discovered from `supabase status` if unset
#   R2_ENDPOINT                 default http://127.0.0.1:9000   (the S3 server)
#   R2_ACCESS_KEY_ID            required
#   R2_SECRET_ACCESS_KEY        required
#   R2_ACCOUNT_ID               default "lifecycle" — a MinIO host ignores it
#   MEDIA_WORKER_URL            default http://127.0.0.1:8080   (checked, not started)
#
# The Edge Functions must be served with R2_ENDPOINT set to the same value, or check 1
# fails and says so by name. That is deliberate: a harness that silently signed for
# Cloudflare and then failed on a connection error would be worse than one that stops.
#
# ── Why the work is in Deno and this is a wrapper ────────────
#
# Because the alternative is jq, curl, and shell quoting around HMAC signing and JPEG byte
# inspection — and CLAUDE.md's own trap list already says heavy quoting fails in this
# harness. The repository has Deno everywhere. This file owns the contract and the
# preflight; scripts/lifecycle/run.ts does the work and owns the assertions.
#
# ── WHAT A GREEN RUN DOES NOT PROVE ──────────────────────────
#
# The full list is at the top of scripts/lifecycle/run.ts and is worth reading before
# quoting this anywhere. The short version:
#
#   · NOT §11 gate 2, and NOT M1's exit criterion. Both say "end to end", which means real
#     R2 and a deployed worker. This is MinIO on localhost.
#   · "No originals/ object reachable through the public path" is a BUCKET-POLICY PROXY.
#     MinIO has no CDN in front of it, so what is checked is which bucket our code recorded
#     — a claim about us, not about what a CDN would serve.
#   · Nothing about Cloud Run: concurrency, scale-to-zero, the post-202 background work, or
#     the request timeout.
#
# Green here is not a gate met. Say so every time this passes.

set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
R2_ENDPOINT="${R2_ENDPOINT:-http://127.0.0.1:9000}"
MEDIA_WORKER_URL="${MEDIA_WORKER_URL:-http://127.0.0.1:8080}"
R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-lifecycle}"

# Discovered, not demanded — `supabase status -o env` prints the local keys, and requiring
# the operator to paste them is how a harness stops being run.
if [ -z "${SUPABASE_ANON_KEY:-}" ] || [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  if command -v supabase > /dev/null 2>&1; then
    eval "$(supabase status -o env 2>/dev/null | sed 's/^/export /')" || true
    SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-${ANON_KEY:-}}"
    SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-${SERVICE_ROLE_KEY:-}}"
  fi
fi

missing=""
for v in SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do
  [ -z "${!v:-}" ] && missing="$missing $v"
done
if [ -n "$missing" ]; then
  echo "lifecycle: missing required environment:$missing" >&2
  echo "  the Supabase keys come from \`supabase status -o env\` when the stack is up" >&2
  exit 2
fi

# ── Preflight ────────────────────────────────────────────────
#
# Three services, checked before any fixture is built. A harness that fails on check 14
# because MinIO was never started has wasted the operator's attention on the wrong
# question.

up() { # up <name> <url>
  if ! curl -fsS -o /dev/null --max-time 5 "$2" 2>/dev/null; then
    echo "lifecycle: $1 is not answering at $2" >&2
    return 1
  fi
  echo "  ok  $1 — $2"
}

echo "# preflight"
fail=0
up "supabase"      "$SUPABASE_URL/rest/v1/" || fail=1
up "object store"  "$R2_ENDPOINT/minio/health/live" || fail=1
up "media worker"  "$MEDIA_WORKER_URL/healthz" || fail=1
[ "$fail" -eq 0 ] || { echo "lifecycle: bring the stack up first" >&2; exit 2; }

# The functions gateway answers 404 for an unknown function rather than refusing to
# connect, which distinguishes "edge runtime is serving" from "the stack is up without it"
# — the exact misconfiguration that would otherwise surface as an unexplained failure.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  -H "apikey: $SUPABASE_ANON_KEY" "$SUPABASE_URL/functions/v1/request-upload" || true)
if [ "$code" = "000" ]; then
  echo "lifecycle: nothing is serving edge functions at $SUPABASE_URL/functions/v1/" >&2
  echo "  start the stack WITHOUT -x edge-runtime, or run \`supabase functions serve\`" >&2
  exit 2
fi
echo "  ok  edge functions — HTTP $code from request-upload"
echo

export SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY
export R2_ENDPOINT R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

exec deno run \
  --allow-net --allow-env --allow-read --allow-write --allow-run \
  "$(dirname "$0")/lifecycle/run.ts"
