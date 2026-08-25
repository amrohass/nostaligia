Ramallah Memory Atlas — finish the probe, then deploy the worker.

Read CLAUDE.md fully before touching anything; it governs this repo and overrides your
defaults. Then read `docs/session-report-2026-08-24.md` (what happened and why),
`worker/README.md` → Deploy and "What the heartbeat probe measured", and
`worker/scripts/probe/README.md` (how to run the two experiments).

## Where this stands in one paragraph

The staging deployment serves a **correct, live read path**: `nostaligia.pages.dev` resolves
the archive from R2, every shard 200s, the CSP is enforced and green. The **write path is
dead at one hop** — no worker is deployed anywhere, so `complete-upload` returns 503. The
archive is empty (0 posts). Two probe samples are owed before `docs/probe-results.md` can be
generated, and the generator is written and verified.

## Two things to do FIRST, before trusting anything below

1. `supabase migration list` — the hosted DB was **26 migrations behind** on 24 Aug and
   nothing else being green implied it. Two seconds, and it would have wasted an entire probe
   run: `complete_ingest` did not exist remotely, so a job would have transcoded the full
   ladder and then failed at the final RPC.
2. Start Docker Desktop **and confirm it stays up**. It failed to start once on 24 Aug
   (needed `wsl --shutdown` + restart), and it **died mid-sample later**, taking a
   90-minute encode with it. If a long sweep is planned, check the daemon is healthy first.

## Verified live on 24 Aug 2026 — re-verify, do not trust this list

- **All four Edge Functions ACTIVE** — `request-upload`, `complete-upload`, `publish`,
  `takedown`; `verify_jwt` matches `config.toml` on each; all four refuse unauthenticated.
- **`publish` works end to end** — 200, builds the release, flips `manifest.json`. Verified
  twice, second run recorded the previous release correctly.
- **Read path live** — `manifest.json`, `redactions.json`, `content.json`, `index.json`,
  `feed/page-1.json` all 200 from `https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev`
  with `Access-Control-Allow-Origin: https://nostaligia.pages.dev`.
- **Front end green** — CSP 14/14, view 46/46, budget **80.8 KiB** against §9's 150 KiB.
- **R2 11/11**, including delete-then-read-back-404.
- **`MEDIA_WORKER_JWT`** — 404 on a nonexistent RPC, 401 on a one-char corruption, so the
  check discriminates. Expires 2027-08-24.
- **Scaleway ready** — account validated, quotas cleared, `rma-media` registry AND container
  namespaces exist in `nl-ams` (container namespace-id
  `987959e9-d1cb-4ba6-b996-4e74502ac705`), docker logged in to `rg.nl-ams.scw.cloud`.
- **Worker image builds clean** — 946 MB, ffmpeg 7.1.5 on trixie, deno 2.1.4.

### Not working

- **`complete-upload`** — `MEDIA_WORKER_URL` unset → 503 `worker_not_configured`. It
  releases the ingest slot first, so it fails cleanly; it simply has nowhere to dispatch.
- **The worker** — not deployed. Blocked on the decision below.
- **Auto-publish on approval** — the trigger dispatches via vault entries `rma_publish_url`
  and `rma_publish_secret`; **neither is set**, so approving content does not publish.
  Manual invocation works (bearer = `PUBLISH_SECRET` from `supabase/functions/.dev.vars`).
- **`takedown`'s CDN purge is a no-op** — `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_PURGE_TOKEN`,
  `CDN_ORIGIN` all unset. It deletes R2 bytes and purges nothing. **§8 step 2 unsatisfied —
  this is a launch gate.**

## The decision to get from Amro at kickoff — do not guess

**How the worker runs in production.** The liveness probe settled that `min-scale=0` does
NOT survive post-response work: the instance that answered 202 was gone by minute 45, and a
different instance — cold-started seven seconds after the next request — served the report.
That removed one option and chose nothing:

- `min-scale=1` — works; bills continuously for a container idle almost all the time. §6
  calls that the largest avoidable line on a grant-funded budget, and with the ~300 launch
  items transcoded offline the real load is a handful of uploads a day.
- **Serverless Jobs** — 24 h, 6 vCPU, 16 GB, but API-triggered → a Scaleway credential in
  Supabase secrets.

**Say this part out loud to Amro:** that second option is the *same trade* that moved this
worker off Cloud Run. If a platform credential in Supabase secrets is acceptable now, then
Cloud Run's `--no-cpu-throttling` with `min-scale=0` — which solves precisely this problem
and was abandoned over precisely this objection — deserves reconsidering on the merits
rather than being treated as settled.

Whatever production becomes, **the measurement rig should be `min-scale=1` and deleted
afterwards.** §6's scale-to-zero requirement governs the production deployment, not a
temporary rig, and a few hours of an always-on instance is rounding error.

## Ordered plan

1. **Finish the probe. Two samples are owed.**
   - `حوالي ال20 دقيقة.mp4` (786 MB, 18m15s, 1920x1080) — **never completed**; Docker died
     ~65 minutes in and the output was lost. Expect roughly 1.5 h; it makes only 3 rungs
     (1440p is skipped, source height is 1080).
   - `4k.mp4` (2730x1440, 52s) — the banked figure is **CONTAMINATED**: concurrent Docker
     builds stole CPU. Re-run it. Contamination is invisible in the output; it just looks
     like a slow sample.

   Append to the existing file rather than starting over — 21 good samples are already in
   `docs/probe-samples.ndjson`. Then:
   ```bash
   deno run --allow-read --allow-write worker/scripts/probe/report.ts \
     --in docs/probe-samples.ndjson --out docs/probe-results.md \
     --host "Intel i5-4210U @ 1.70GHz (2 cores / 4 threads, 15 W, 2014)" \
     --ffmpeg "ffmpeg 7.1.5 on trixie" --commit "$(git rev-parse --short HEAD)"
   ```
   The generator is committed and verified against the 21 banked samples. **Delete the
   contaminated 2730x1440 line before regenerating**, or it will appear twice.
   **Run nothing else CPU-heavy during a sweep.**

2. **Deploy the worker as a disposable rig.** Commands are current in `worker/README.md` →
   Deploy; three corrections already landed there (namespace minimum name length,
   `memory-limit-bytes` needs `G`/`GB`, and `R2_BUCKET_PREFIX` must be in the container env
   or every signed request gets `NoSuchBucket`). Then set `MEDIA_WORKER_URL` on the function
   side. **Confirm the endpoint answers 401 to an unsigned `POST /jobs` — that is the
   correct healthy response, not a failure.**

3. **Drive one real job end to end.** `complete-upload` needs a signed-in user and a real
   Turnstile token, so the cheaper path for a measurement is to sign a job body with
   `MEDIA_WORKER_SECRET` and POST it to the worker exactly as `complete-upload` does — but
   **the row must exist in `awaiting_bytes` first**, or `complete_ingest` fails at the very
   end, after the transcode.

4. **Append the deployed numbers** to `docs/probe-results.md` as a second section. The file
   already states what it is missing — the host CPU factor and real-R2 transfer. Do not
   rewrite the container-local numbers; they are the baseline the factor is measured against.

5. **Then, and only then, the constants.** `JOB_DEADLINE_MS`, `c_ingest_lease` and
   `expect_by` are Amro's to set once real numbers exist.

## The trap that cost this session — recognise it, do not re-derive it

**Supabase now injects the NEW key formats into the reserved names.** `SUPABASE_ANON_KEY`
arrives as `sb_publishable_…` (46 chars) and `SUPABASE_SERVICE_ROLE_KEY` as `sb_secret_…`
(41), where a legacy anon JWT is 208. PostgREST parses a JWT out of `Authorization: Bearer`,
so it answered `401 PGRST301 "Expected 3 parts in JWT; got 1"`. Every `Db` method turns a
non-2xx into a throw and the handler has no try/catch, so it surfaced as a **bare 500 with
no body** — and only remotely, because a laptop still has the legacy JWT there.
**Works locally, 500s remotely, no log** is the signature. Fixed in `e422d8b`
(`serviceRoleJwt()` prefers an unreserved `SERVICE_ROLE_JWT`); `supabase secrets set`
refuses anything starting with `SUPABASE_`, which is why a code change was needed.

**How to diagnose a bare 500 fast** — this order took minutes after an hour of guessing:
call each RPC directly with the service key (all 200 → database is fine); claim and release
the lease (granted → it died before that point); then deploy a throwaway function reporting
env var **names and lengths only, never values**. That last step exposed the 41- and
46-character keys instantly. Delete it afterwards. Note `supabase functions logs` does not
exist in CLI 2.115, and the access token is not at `~/.supabase/access-token` on Windows —
its absence is a false negative; test with `supabase projects list`.

## Deviations to undo before launch

- **The Edge Functions and the worker share ONE R2 token.** The hosted functions' R2 pair was
  never valid; they were pointed at the worker's verified token to unblock. This costs the
  independent revocation `worker/README.md` argues for and over-grants `request-upload`,
  which needs quarantine write and now carries `originals` and `public` too. **Mint a scoped
  functions token and re-split before the pen test.**
- **`r2.dev` is the CDN origin** — rate-limited, not for production. Replace with a custom
  domain. `domains.site` is still `PLACEHOLDER_DOMAIN`, which is harmless: nothing in the
  front end reads `origins.site`.

## Still broken on purpose — do not "fix" it

**The fonts.** `fonts.googleapis.com` and `fonts.gstatic.com` are blocked by the CSP and
remain in `config/site.json`'s `known_violations`, `removed_by: M6`. Do **not** add them to
the CSP to make the page look right. §9 wants a self-hosted subset, and the file records the
sharper reason: Google Fonts leaks reader IPs to a third party, which for this archive is a
§7 exposure rather than a styling preference. The ratchet exists to stop that shortcut. The
page falls back to system fonts and is legible.

## Hard constraints

- Do NOT touch `JOB_DEADLINE_MS`, `c_ingest_lease`, `expect_by`, the `ESTIMATE, NOT MEASURED`
  tag, or CLAUDE.md. Those are Amro's calls once the numbers exist.
- Do not put a capability-bearing secret anywhere client-visible, and never print one to
  stdout — `scw config info` echoes the Scaleway secret key; pipe it, never echo it.
- `.dev.vars` files are git-ignored at every depth and blocked from force-add. Verify before
  writing, never commit. `PUBLISH_SECRET` was generated 24 Aug and lives in
  `supabase/functions/.dev.vars`.
- `fottage/` is git-ignored — 1.2 GB of real footage, never commit it. Two gaps in it to
  carry as caveats: **no true 3840x2160 source**, and **no audio file at all**, so the
  Opus-normalize and waveform path is entirely unmeasured.
- Smallest change that satisfies the task. Do not build M5 features while finishing this.
