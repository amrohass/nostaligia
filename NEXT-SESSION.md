Ramallah Memory Atlas — deployed-worker measurements, and the execution-model decision.

Read CLAUDE.md fully before touching anything; it governs this repo and overrides your
defaults. Then read `worker/README.md` — its Deploy section and the new "What the heartbeat
probe measured" block were rewritten on 24 Aug and carry the live decision.

## Where this stands

The staging deployment is **live and working end to end on the read path**. What is missing
is the write path's last hop: the worker is still not deployed anywhere.

## Verified state (checked live 24 Aug 2026 — re-verify, do not trust this list)

DONE, and verified rather than assumed:

- **All four Edge Functions deployed and ACTIVE** — `request-upload`, `complete-upload`,
  `publish`, `takedown`. `verify_jwt` matches `supabase/config.toml` on each (publish
  `false`, the other three `true`). Unauthenticated POSTs get 401 from the gateway on the
  three verified ones.
- **The hosted database is current.** 26 migrations were applied on 24 Aug; it had been
  stuck at `20260812090100` since 12 Aug, missing all of M2/M3/M4. `supabase migration list`
  now shows no gap. **This had nothing to do with the front end and would have broken the
  probe too** — `complete_ingest` and `claim_upload_slot` did not exist remotely, so a job
  would have transcoded fully and then failed at the final RPC.
- **`publish` works from the deployed function**, returns 200, writes the release tree and
  flips the pointer. It was 500ing; see "The bearer-token trap" below, which is now fixed
  and committed (`e422d8b`).
- **The read path is live.** `manifest.json`, `redactions.json`, `content.json`,
  `index.json` and `feed/page-1.json` all 200 from
  `https://pub-18aab56b95304deb89be2ad31e43b413.r2.dev`, with
  `Access-Control-Allow-Origin: https://nostaligia.pages.dev` present.
- **The site serves the real CSP and the real config.** `nostaligia.pages.dev` is on
  Cloudflare Pages, `archiveBase` resolves to the r2.dev bucket, and the anon key is
  populated. Front-end checks green: CSP 14/14, view 46/46, budget 80.8 KiB against §9's
  150 KiB.
- **R2 connectivity, 11/11**, including the assertion NEXT-SESSION previously asked for:
  `store.remove()` treats 404 as success, so every delete is followed by a read-back that
  must itself 404. Put, ranged GET, server-side copy quarantine → originals with content
  checked on the far side, put to public, delete of all three.
- **`MEDIA_WORKER_JWT` verified live** — 404 on a nonexistent RPC while a one-character
  corruption 401s, so the check discriminates rather than passing by accident. Expires
  2027-08-24.
- **Scaleway account is validated** and both quotas cleared. Registry namespace
  `rma-media` and container namespace `rma-media` exist in `nl-ams`
  (namespace-id `987959e9-d1cb-4ba6-b996-4e74502ac705`). Docker is logged in to
  `rg.nl-ams.scw.cloud`.
- **The worker image builds clean** — `docker build -f worker/Dockerfile .` from the repo
  root, 946 MB, ffmpeg 7.1.5 on trixie, deno 2.1.4. Docker Desktop must be started manually
  and may need a `wsl --shutdown` and restart; it failed to start once on 24 Aug.

## The two traps that cost this session, so they do not cost the next one

**1. The bearer-token trap — fixed, but understand it before touching auth.**
The hosted runtime now injects the NEW key formats into the reserved names:
`SUPABASE_ANON_KEY` arrives as `sb_publishable_…` (46 chars) and
`SUPABASE_SERVICE_ROLE_KEY` as `sb_secret_…` (41 chars), where a legacy anon JWT is 208.
`_shared/http.ts` puts the service credential in `Authorization: Bearer`, which is where
PostgREST parses a JWT — so it answered `401 PGRST301 "Expected 3 parts in JWT; got 1"`.
Every `Db` method turns a non-2xx into a throw, and `publish/handler.ts` has no try/catch,
so this surfaced as a **bare 500 with no detail**, and only remotely: on a laptop
`SUPABASE_SERVICE_ROLE_KEY` is the legacy JWT, so it published fine there.
`serviceRoleJwt()` now prefers an unreserved `SERVICE_ROLE_JWT` and falls back to the
reserved name. `supabase secrets set` **refuses** anything starting with `SUPABASE_`
("Env name cannot start with SUPABASE_, skipping"), which is why a code change was needed.
The `apikey` header takes the publishable key happily — only the bearer was ever wrong.

**2. A bare 500 from an Edge Function tells you nothing. Do not guess at it.**
What worked, in order, and it took minutes rather than the hour of hypothesising before it:
call each RPC directly with the service key (all 200 → database is fine); claim and release
the publish lease (granted → it dies before claiming); then deploy a throwaway function that
reports env var **names and lengths only, never values** — which is what exposed the 41- and
46-character keys immediately. Delete that function afterwards; it was `envprobe` and it is
gone.

## Known deviations, both deliberate, both must be undone before launch

- **The Edge Functions and the worker now share ONE R2 token.** The hosted functions' R2
  key pair was never valid; rather than block, they were pointed at the worker's verified
  token. This costs the independent revocation `worker/README.md` argues for, and it
  over-grants `request-upload`, which needs quarantine write and now carries `originals` and
  `public` too. **Mint a scoped functions token and re-split before the pen test.**
- **`r2.dev` is the CDN origin.** Rate-limited, and Cloudflare says not for production. It
  is the TESTING value; a custom domain replaces it before launch. `domains.site` is still
  `PLACEHOLDER_DOMAIN` and that is harmless — nothing in the front end reads `origins.site`.

## Still broken, deliberately

**The fonts.** `fonts.googleapis.com` and `fonts.gstatic.com` are blocked by the CSP and
remain in `config/site.json`'s `known_violations`, `removed_by: M6`. Do **not** add them to
the CSP to make the page look right. §9 wants a self-hosted subset and the file records the
sharper reason: Google Fonts leaks reader IPs to a third party, which for this archive is a
§7 exposure rather than a styling preference. The ratchet exists to stop exactly that
shortcut. The page falls back to system fonts and is legible.

## The one decision to get from Amro at kickoff — do not guess

**How the worker runs in production.** The heartbeat probe settled that `min-scale=0` does
NOT survive post-response work: the instance that answered 202 was gone by minute 45, and a
different instance — booted seven seconds after the next request — served the report. That
removed one option and did not choose between the survivors:

- `min-scale=1` — works, bills continuously for a container idle almost all the time. §6
  calls this the largest avoidable line on a grant-funded budget, and with the ~300 launch
  items transcoded offline the real load is a handful of uploads a day.
- **Serverless Jobs** — 24h, 6 vCPU, 16 GB, but API-triggered, which puts a Scaleway
  credential in Supabase secrets.

Put this to Amro directly: that second option is the *same trade* that moved the worker off
Cloud Run. If a platform credential in Supabase secrets is acceptable now, then Cloud Run's
`--no-cpu-throttling` with `min-scale=0` — which solves this exact problem and was abandoned
over this exact objection — deserves reconsidering rather than being treated as settled.

Whatever is chosen for production, **the measurement rig below should be `min-scale=1` and
should be deleted afterwards.** §6's scale-to-zero requirement governs the production
deployment, not a temporary rig, and a few hours of an always-on instance is rounding error.

## Ordered plan

1. **Deploy the worker as a disposable rig.** Commands are current in
   `worker/README.md` → Deploy, and three corrections already landed there (namespace name
   minimum length, `memory-limit-bytes` needs `G`/`GB`, and `R2_BUCKET_PREFIX` must be in
   the container env or every signed request gets `NoSuchBucket`). Then set
   `MEDIA_WORKER_URL` on the function side. **Confirm the endpoint answers 401 to an
   unsigned `POST /jobs` — that is the correct healthy response, not a failure.**
2. **Drive one real job end to end.** `complete-upload` needs a signed-in user and a
   Turnstile token, so the cheaper path for a measurement is to sign a job body with
   `MEDIA_WORKER_SECRET` and POST it directly to the worker, exactly as `complete-upload`
   does — but the row must exist in `awaiting_bytes` first or `complete_ingest` fails at the
   very end, after the transcode.
3. **Append the deployed numbers to `docs/probe-results.md`.** That file already states what
   it is missing: the Scaleway CPU factor and real-R2 transfer. Add them as a second
   section; do not rewrite the container-local ones.
4. **Then, and only then, the constants.** `JOB_DEADLINE_MS`, `c_ingest_lease` and
   `expect_by` are Amro's to set once real numbers exist.

## Hard constraints

- Do NOT touch `JOB_DEADLINE_MS`, `c_ingest_lease`, `expect_by`, the `ESTIMATE, NOT MEASURED`
  tag, or CLAUDE.md. Those are Amro's calls once the numbers exist.
- Do not put a capability-bearing secret anywhere client-visible, and do not print secrets to
  stdout — `scw config info` echoes the Scaleway secret key; pipe it, never echo it.
- `.dev.vars` files are git-ignored at every depth and blocked from force-add. Verify before
  writing, never commit. `PUBLISH_SECRET` was generated on 24 Aug and lives in
  `supabase/functions/.dev.vars`; the DB-triggered publish path additionally needs the same
  value in `vault.decrypted_secrets` as `rma_publish_secret`, plus `rma_publish_url` —
  **neither is set**, so auto-publish on approval does not fire yet. Manual invocation works.
- `fottage/` is git-ignored. 1.2 GB of real footage; never commit it.
- Smallest change that satisfies the task. Do not build M5 features while finishing this.
