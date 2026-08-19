# The media ingestion worker

The container that turns a quarantined upload into derivatives. CLAUDE.md §6, amended
12 Aug 2026: **one worker for all media** — image, audio and video alike — because the Edge
Function has no ffmpeg and a 200 MB upload exhausts a Deno isolate before a WASM decoder
finishes.

It is a plain container with no host-specific SDK, so **which host runs it is a deployment
choice, not an architectural one**. The commands below use Cloud Run because it scales to
zero; nothing in `src/` knows that.

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

Cloud Run IAM would be stronger, and is not used, deliberately: it would require the Edge
Function to mint a Google OIDC token, which means a **GCP service-account key in Supabase
secrets** — a new capability-bearing credential in a new place, which §6 argues against more
strongly than it argues for IAM. Signature rejection costs one HMAC and no I/O, and
`--max-instances` bounds what a flood can spend.

**Outbound** — a JWT asserting `role: media_worker`, minted out of band. The worker never
holds the signing secret, so a full compromise yields a token that can call two functions,
not the ability to mint `service_role`.

---

## Secrets

Never in this repository, never in the Dockerfile, never a build arg.

| name | capability-bearing | where it comes from |
|---|:--:|---|
| `MEDIA_WORKER_SECRET` | yes | Secret Manager → `--set-secrets`; the same value in Supabase Function secrets |
| `MEDIA_WORKER_JWT` | yes | `scripts/mint-worker-jwt.ts`, then Secret Manager |
| `R2_ACCESS_KEY_ID` | yes | Secret Manager |
| `R2_SECRET_ACCESS_KEY` | yes | Secret Manager |
| `R2_ACCOUNT_ID` | no | Secret Manager, kept with the pair above |
| `SUPABASE_URL` | no | `--set-env-vars` |
| `SUPABASE_ANON_KEY` | no — public by design | `--set-env-vars` |

Locally they belong in `worker/.dev.vars`, which `.gitignore` matches at every depth and
`scripts/forbidden-paths.ere` blocks from a force-add.

**Mint a separate R2 token for the worker** — read on `quarantine`, write on `originals` and
`public`. `request-upload` only needs write on `quarantine`; reusing one token gives each
side the other's reach for no reason.

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

`--source` is not usable here: it looks for a Dockerfile at the root of the build context,
and this one lives at `worker/Dockerfile` while needing a context rooted at the repository so
it can reach `supabase/functions/_shared`. So the image is built and pushed explicitly.

```bash
REGION=europe-west3
REPO="$REGION-docker.pkg.dev/$PROJECT_ID/rma"
TAG=$(git rev-parse --short HEAD)

# one-time
gcloud artifacts repositories create rma --repository-format=docker --location="$REGION"
gcloud auth configure-docker "$REGION-docker.pkg.dev"

# build from the REPOSITORY ROOT, not from worker/
docker build -f worker/Dockerfile -t "$REPO/media-worker:$TAG" .
docker push "$REPO/media-worker:$TAG"

gcloud run deploy rma-media-worker \
  --image "$REPO/media-worker:$TAG" \
  --region "$REGION" \
  --min-instances=0 \
  --max-instances=3 \
  --concurrency=1 \
  --cpu=2 --memory=4Gi \
  --timeout=3600 \
  --execution-environment=gen2 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --set-env-vars "SUPABASE_URL=https://<ref>.supabase.co,SUPABASE_ANON_KEY=<anon>" \
  --set-secrets "MEDIA_WORKER_SECRET=media-worker-secret:latest,\
MEDIA_WORKER_JWT=media-worker-jwt:latest,\
R2_ACCOUNT_ID=r2-account-id:latest,\
R2_ACCESS_KEY_ID=r2-access-key-id:latest,\
R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest"
```

Tagged by commit, never `:latest` — a rollback needs a tag that still points at the image it
pointed at yesterday.

Each flag is a §6 cost control or a correctness requirement:

- `--min-instances=0` — scale to zero. At ~300 items an always-on instance is the largest
  avoidable line on a grant-funded budget.
- `--max-instances=3` — the hard billing ceiling.
- `--concurrency=1` — ffmpeg is CPU-bound; two jobs on one instance thrash and OOM.
- `--no-cpu-throttling` — **required**, because the job runs after the 202. It governs CPU on
  a live instance, not whether idle instances persist, so it does not conflict with
  scale-to-zero.
- `--region europe-west3` — Frankfurt, matching the Supabase region (§2).

Four ceilings compose: daily quota bounds uploads per user, `ingest_attempts` bounds
invocations per upload, `concurrency × max-instances` bounds parallel transcodes, and the
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
