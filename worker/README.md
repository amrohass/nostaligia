# The media ingestion worker

The container that turns a quarantined upload into derivatives. CLAUDE.md §6, amended
12 Aug 2026: **one worker for all media** — image, audio and video alike — because the Edge
Function has no ffmpeg and a 200 MB upload exhausts a Deno isolate before a WASM decoder
finishes.

It is a plain container with no host-specific SDK, so **which host runs it is a deployment
choice, not an architectural one**. The commands below use Scaleway Serverless Containers
because it scales to zero and needs no invoker identity; nothing in `src/` knows that. It
ran on Cloud Run first, and the move cost no change under `src/` — which is the claim above,
tested.

That claim holds for the *container*. It does **not** extend to the execution model: the
worker answers 202 and works with no request in flight, which is a Cloud Run–specific
guarantee (`--no-cpu-throttling`) rather than a portable one. See the deadline gap under
Deploy.

---

## What it does

```
POST /jobs  { object_key, post_id, issued_at }  + X-Signature
  1  verify the HMAC, constant-time ............ bad → 401, before any I/O
  2  reject anything outside a 5-minute window . stale → 401
  3  answer 202 ................................ then work in the background
  4  read 64 bytes, sniff them (§6) ............ unknown → fail_ingest
                                                 SVG     → fail_ingest
  5  ffprobe; refuse over 20 minutes (§6) ...... → fail_ingest
  6  COPY quarantine → originals ............... server-side, BEFORE any transcode
  7  transcode; upload derivatives to public/
  8  complete_ingest(...)
  9  DELETE the quarantine object .............. best-effort
```

**Preservation happens before delivery.** If the process dies mid-ladder the archival copy
already exists. Doing it last would make the most valuable artefact the most likely to be
lost.

| family | `originals/` | `public/` |
|---|---|---|
| image | master, untouched | one WebP display rendition (long edge ≤ 1920) + thumb |
| video | master, untouched | every rung ≤ source height from **1440p 8 Mbps · 1080p 5 · 720p 2.5 · 480p 1**, H.264 + AAC, faststart · + poster · + thumb |
| audio | master, untouched | Opus mono 48 kbps, EBU R128 normalized, on the `audio` rung · + waveform thumb |

**4K is never a rendition.** §6: the master is the archival copy and is not streamed. A
2160p row here would mean the preservation path had become a delivery path.

### Public paths are keyed by post, not by uploader

An object key is `{uploader_uuid}/{random}`. Deriving CDN URLs from it would put the
uploader's user id in every `src` on the site, and anyone could then group the whole archive
by contributor from the HTML alone — §7's aggregate de-anonymisation vector, handed out in a
filename. Derivatives therefore live at `{post_id}/…`. The master keeps the object key,
because `originals/` is never CDN-fronted.

---

## Permanent vs transient — the split that matters

`fail_ingest` is **terminal**. Nothing walks it back.

| | | |
|---|---|---|
| **permanent** | the bytes are the problem — unrecognised, SVG, too long, will not decode | `fail_ingest`, slot spent |
| **transient** | the world is the problem — R2 unreachable, PostgREST refusing, out of disk | **no RPC**, non-2xx to the caller |

On a transient failure `complete-upload` calls `release_ingest` (migration 0031) and the row
returns to `awaiting_bytes` for a retry, bounded to three attempts by `posts.ingest_attempts`.
When in doubt the code treats a failure as transient: the cost of being wrong that way is a
retry, and the cost of being wrong the other way is a lost photograph.

---

## Authentication

**Inbound** — an HMAC-SHA256 over the raw request body, shared with `complete-upload`. The
timestamp is inside the signed payload, so a signature cannot outlive its window.

A platform invoker identity would be stronger, and is not used, deliberately. On Cloud Run
it would require the Edge Function to mint a Google OIDC token, and there is **no keyless
path** to one: Workload Identity Federation needs the caller to present a token from a
federated IdP, and Supabase Edge Functions expose no ambient machine identity to user code.
So it means a GCP service-account private key in Supabase secrets. Scaleway's
`privacy=private` has the same shape with a Scaleway token in place of the Google one.
Either way it is a **new capability-bearing credential in a new place**, which §6 argues
against more strongly than it argues for IAM.

The host therefore has no bearing on this trust boundary — the HMAC is the gate on every
platform, which is what made the container portable between them. Signature rejection costs
one HMAC and no I/O, and `max-scale` bounds what a flood can spend.

**Outbound** — a JWT asserting `role: media_worker`, minted out of band. The worker never
holds the signing secret, so a full compromise yields a token that can call two functions,
not the ability to mint `service_role`.

---

## Secrets

Never in this repository, never in the Dockerfile, never a build arg.

| name | capability-bearing | where it comes from |
|---|:--:|---|
| `MEDIA_WORKER_SECRET` | yes | `secret-environment-variables`; the same value in Supabase Function secrets |
| `MEDIA_WORKER_JWT` | yes | `scripts/mint-worker-jwt.ts`, then `secret-environment-variables` |
| `R2_ACCESS_KEY_ID` | yes | `secret-environment-variables` |
| `R2_SECRET_ACCESS_KEY` | yes | `secret-environment-variables` |
| `R2_ACCOUNT_ID` | no | `secret-environment-variables`, kept with the pair above |
| `SUPABASE_URL` | no | `environment-variables` |
| `SUPABASE_ANON_KEY` | no — public by design | `environment-variables` |

`SUPABASE_URL` is the **bare origin** — `https://<ref>.supabase.co`, no path. `db.ts` appends
`/rest/v1/rpc/…` itself, so a value ending in `/rest/v1/` produces `/rest/v1/rest/v1/rpc/…`
and every RPC 404s. Nothing else in the worker reads it, so nothing catches the mistake.

Locally they belong in `worker/.dev.vars`, which `.gitignore` matches at every depth and
`scripts/forbidden-paths.ere` blocks from a force-add. Nothing auto-loads that file — pass it
explicitly with `docker run --env-file` or `deno run --env-file=`.

**Mint a separate R2 token for the worker** — Object Read **& Write** on `quarantine`,
`originals` and `public`. Read-only on `quarantine` is not enough: step 9 DELETEs the
quarantine object, so a read-only token transcodes successfully and then fails cleanup.
`request-upload` only needs `quarantine`; reusing one token gives each side the other's reach
for no reason.

Note that an R2 API token carries **one permission level across all the buckets it selects**,
so a per-bucket split — read here, write there — is not expressible in a single token. Two
tokens still buy independent revocation, which is the part worth having.

---

## Verify it locally

Everything here runs alongside the trimmed Supabase stack on 8 GB. Nothing needs 4K.

```powershell
# units: the front door, the ladder at every height including 2160, the failure split
deno test --allow-read --allow-write --allow-env worker/

# the real pipeline, real ffmpeg, ~10s
deno run --allow-read --allow-write --allow-run --allow-env `
  worker/scripts/ladder-fixture.ts --size 320x240 --kind video
deno run --allow-read --allow-write --allow-run --allow-env `
  worker/scripts/ladder-fixture.ts --size 800x600 --kind image
deno run --allow-read --allow-write --allow-run --allow-env `
  worker/scripts/ladder-fixture.ts --kind audio

# CLAUDE.md §11 gate 2 — a synthesized photograph carrying real GPS EXIF, through the real
# pipeline, with the output parsed as bytes. Also verifies its own checks are awake.
deno run --allow-read --allow-write --allow-run --allow-env `
  worker/scripts/exif-gate.ts
```

The wire — presigned range reads, streamed uploads, server-side copy — needs a real S3
implementation, so it uses the same MinIO trick `scripts/sigv4-roundtrip.ts` already does:

```powershell
docker run -d --name rma-store-minio -p 9002:9000 `
  -e MINIO_ROOT_USER=rmatestkey -e MINIO_ROOT_PASSWORD=rmatestsecret123 `
  --entrypoint sh minio/minio `
  -c "mkdir -p /data/quarantine /data/originals /data/public && minio server /data"
deno run --allow-net --allow-env --allow-read --allow-write worker/scripts/store-roundtrip.ts
docker rm -f rma-store-minio
```

**The real 4K ladder runs in CI**, inside the built image, on three seconds of generated
3840×2160 — so it is the container's ffmpeg under test, not a laptop's.

---

## Deploy

**Scaleway Serverless Containers.** Moved off Cloud Run (§12 deviation, 22 Aug 2026): the
GCP invoker service account was declined rather than accept a new class of
capability-bearing secret, and per §6 the host has no bearing on the HMAC trust boundary —
see Authentication above. Nothing in `src/` changed, which is the claim that made the move
cheap.

The image is built and pushed explicitly, because the Dockerfile lives at `worker/Dockerfile`
while needing a build context rooted at the repository so it can reach
`supabase/functions/_shared`.

```bash
REGION=nl-ams                       # see "Region" below — there is no Frankfurt
REG="rg.$REGION.scw.cloud/rma"
TAG=$(git rev-parse --short HEAD)

# one-time
scw registry namespace create name=rma region="$REGION"
docker login "rg.$REGION.scw.cloud" -u nologin --password-stdin   # paste a Scaleway secret key
scw container namespace create name=rma region="$REGION"

# build from the REPOSITORY ROOT, not from worker/
docker build -f worker/Dockerfile -t "$REG/media-worker:$TAG" .
docker push "$REG/media-worker:$TAG"

scw container container create \
  name=rma-media-worker \
  namespace-id="$NAMESPACE_ID" \
  region="$REGION" \
  image="$REG/media-worker:$TAG" \
  port=8080 \
  privacy=public \
  https-connections-only=true \
  min-scale=0 \
  max-scale=3 \
  mvcpu-limit=2000 \
  memory-limit-bytes=4294967296 \
  timeout=3600s \
  environment-variables.SUPABASE_URL="https://<ref>.supabase.co" \
  environment-variables.SUPABASE_ANON_KEY="<anon>" \
  secret-environment-variables.MEDIA_WORKER_SECRET="<value>" \
  secret-environment-variables.MEDIA_WORKER_JWT="<value>" \
  secret-environment-variables.R2_ACCOUNT_ID="<value>" \
  secret-environment-variables.R2_ACCESS_KEY_ID="<value>" \
  secret-environment-variables.R2_SECRET_ACCESS_KEY="<value>"

scw container container deploy "$CONTAINER_ID" region="$REGION"
```

Tagged by commit, never `:latest` — a rollback needs a tag that still points at the image it
pointed at yesterday.

Each value is a §6 cost control or a correctness requirement:

- `min-scale=0` — scale to zero. At ~300 items an always-on instance is the largest
  avoidable line on a grant-funded budget. **Read the deadline gap below before trusting it.**
- `max-scale=3` — the hard billing ceiling.
- `mvcpu-limit=2000` / `memory-limit-bytes` — 2 vCPU and 4 GiB. ffmpeg is CPU-bound; two
  concurrent jobs on one instance thrash and OOM, and the busy flag in `main.ts` refuses the
  second rather than relying on a platform concurrency setting.
- `privacy=public` — the HMAC is the gate, deliberately. `privacy=private` would need a
  Scaleway token in Supabase secrets, which is the trade Authentication above refuses.
- `https-connections-only=true` — the job body carries no secret, but the signature is a
  bearer-ish value and there is no reason to send it in clear.
- `secret-environment-variables.*` — never `environment-variables` for these five. The
  distinction is that secrets are write-only once set and are not returned by a describe.

**Region.** Scaleway Serverless Containers runs in `fr-par`, `nl-ams` and `pl-waw` only —
**there is no Frankfurt region on this product**, so §2's colocation with Supabase EU
(Frankfurt) is not literally available. `nl-ams` is the nearest. All three are EU, so the
data-residency posture §7 depends on is intact; what is lost is a same-city hop, which costs
latency on RPCs and nothing on correctness.

**The deadline gap — read this before relying on `min-scale=0`.**

`timeout=3600s` is Scaleway's **maximum**: the documented range is 10 seconds to 60 minutes.
`JOB_DEADLINE_MS` in `src/pipeline.ts` is **240 minutes**. The two do not meet, and Cloud
Run's 60-minute ceiling did not meet it either — so this is not a regression, but it is not
parity with the constant either.

Worse, and specific to scale-to-zero: this worker answers `202` and then transcodes with **no
request in flight**, and a container set to `min-scale=0` has "all instances terminated after
15 minutes of inactivity". If inactivity is measured by requests — which is how every
scale-to-zero HTTP platform measures it — the effective ceiling is 15 minutes, not 60. Cloud
Run answered this with `--no-cpu-throttling`; Scaleway documents no equivalent and is silent
on post-response work.

Nothing here is settled by reading more documentation. It is settled by deploying a container
that answers 202 and heartbeats for 40 minutes, and watching where the logs stop. Until that
is run, treat `min-scale=1` as the safe setting and the billing consequence as the price of
not knowing.

Four ceilings compose: daily quota bounds uploads per user, `ingest_attempts` bounds
invocations per upload, the busy flag × `max-scale` bounds parallel transcodes, and the
in-process job timeout bounds each one.

---

## Known gaps

- **A worker that accepts a job and then dies leaves the row in `processing`.** `release_ingest`
  narrows migration 0028's stuck-job gap to invocation failures; it does not close it. The
  reaper is M6, and `processing_started_at` is being recorded now so it has something to read.
- **§11 gate 2 is verified locally, not end to end.** `exif-gate.ts` puts a real APP1 GPS
  segment through the real pipeline and parses the output as bytes: gone from `public/`,
  byte-identical in `originals/`. What it does not cross is the network — a browser PUT to a
  real R2 quarantine bucket, the deployed container, and the object fetched back over the
  CDN. That last hop needs the worker deployed.
- **The image path's EXIF safety is the re-encode, not the flag.** `exif-gate.ts` found this:
  deleting `-map_metadata -1` from the argv changes nothing a derivative carries, because
  ffmpeg decodes an image to pixels and a pixel buffer has no APP1. §6 says as much — "re-encode
  every image server-side; this strips EXIF and kills polyglots in one step" — but it means the
  thing to protect is the re-encode itself. A future `-c:v copy`, added for speed, would leak
  coordinates while every argv assertion in the repository stayed green. The gate's phase 2b
  models exactly that and must keep failing.
- **Derivative uploads are buffered, not streamed, and capped at 2 GiB.** `fetch` drops a
  hand-set `Content-Length`, so a stream body goes out chunked and S3 answers 411 — found by
  `store-roundtrip.ts`, invisible to every other test. §6's worst legitimate rung is about
  1.2 GB against `--memory=4Gi`, so this holds; a larger rung would need multipart upload,
  which needs `POST`, which the presigner deliberately does not emit.
- **The base image is pinned by tag, not by digest.** Tags move.
- **HEIC depends on the base image's ffmpeg.** trixie's 7.x decodes it; an older base would
  refuse iPhone photographs as `encode_failed_image`.
