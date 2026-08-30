Ramallah Memory Atlas — M5 is half built. Two items wait on Amro.

Read CLAUDE.md fully before touching anything; it governs this repo and overrides your
defaults. Then read `docs/closeout-audit-2026-08-29.md` — including both addenda, which
correct claims the audit's own tables make.

**This file replaces the 24 Aug handoff, which was describing a system that no longer
exists** (it said no worker was deployed, the write path was dead and the archive held 0
posts; all three stopped being true on 28–30 Aug).

## Where this stands in one paragraph

M0–M4 are complete and audited against the deployed system. M5 items 1–3 shipped on
30 Aug — the contributor precision control, the removal request, and the Dublin Core
export — and CI run 61 is green on all six jobs. The contribution lifecycle has been run
end to end **through a browser on the live origin**: real signup, real Turnstile, real
confirmation email, a real 4 MB photograph, `ingest_state: ready`, and every §6 bucket
invariant checked afterwards. What remains in M5 is the seed importer (needs Amro's data)
and backups + one tested restore (§11 gate 3, outlined and awaiting three decisions).

## Do these FIRST, before trusting anything below

1. `supabase migration list` — two migrations landed on 30 Aug (0052, 0053). The hosted DB
   was 26 migrations behind once before and nothing else being green implied it.
2. **Check Docker actually starts.** It was wedged for the whole 30 Aug session — `docker
   info` hung to a 124 timeout rather than erroring, and `wsl --shutdown` hung too. No
   pgTAP ran locally all session; CI was the only executor. If it is still wedged, expect
   to iterate through CI, and see "Reading CI failures" below.

## What is true as of 30 Aug 2026 — re-verify, do not trust this list

- **The upload path works from a browser.** It had never worked on the deployed site.
  Three independent causes, each sufficient alone, all surfacing as the same Arabic
  sentence (`up.err.offline`, "لا يوجد اتصال"): `apikey` missing from the Edge Functions'
  `Access-Control-Allow-Headers`; `connect-src` omitting the R2 S3 endpoint so the page
  blocked its own PUT; and the `quarantine` bucket having no CORS policy at all. All three
  fixed and verified in Chromium against the live origin.
- **Five Edge Functions ACTIVE** — `request-upload`, `complete-upload`, `publish`,
  `takedown`, and `delete-account` (deployed 30 Aug; its migration had been applied since
  29 Aug with nothing serving it).
- **R2 CORS now exists on two buckets.** `quarantine`: PUT + `content-type`, both allowed
  origins. `public`: the pre-existing GET rule merged with `HEAD`, `range` and a 3600s
  max-age, applied as a strict superset so read traffic could not regress. Verified after:
  ranged GET still 206, map still draws, `originals/` still 404 through the CDN.
  **R2 takes ~10s to propagate a bucket CORS change** — a successful PutBucketCors followed
  by a 403 preflight is propagation, not failure.
- **Bucket sizes**, measured: `originals` 4 objects / 22.1 MB; `public` 59 objects /
  176.4 MB of which **173.9 MB is the basemap**; `quarantine` 0 objects. The archive's own
  published bytes are ~2.5 MB.
- CI: 33 pgTAP files, 622 assertions. Front end: CSP 14, cors 6, auth 36, view 46, map 46,
  budget 84.6 KiB against §9's 150 KiB.

## M5 — what is left

**Seed importer** — not started, needs Amro's ~300 items. Nothing in the repo is seed data.

**Backups + one tested restore (§11 gate 3)** — outlined in full at the end of the 30 Aug
session, not built, waiting on three decisions from Amro:
  1. **Where** the self-held copy lives — second R2 under a different account / local
     encrypted disk / third-party cold storage / hybrid. Jurisdiction is a real input here,
     not a footnote (`reconciled-plan.md` F29).
  2. Whether the **cadence amendments** stand: weekly full DB + *incremental* originals
     rather than weekly-full media, plus snapshots pinned forever at pre-launch and
     immediately after the seed import — because a weekly cycle can lose the entire import.
  3. Whether the **restore target** is local Docker or a scratch Supabase project.

Three findings from that outline that will bite whoever builds it:
  - **`supabase db dump` excludes the `auth` schema by default** (also `vault`, `cron`,
    `extensions`, `storage`). A default dump restores a `posts` table whose every
    `created_by` points at a user that does not exist, and `user_roles` — where §4's
    authorization actually lives — keyed to nobody. Three dumps are needed, not one.
  - **`public` is 98.6% basemap.** The irreplaceable set is `originals/` plus Postgres.
    `quarantine` must NOT be backed up: it holds uploads that have not passed magic-byte
    validation and is purged at 30 days.
  - **`supabase db dump` mints its own temporary login role**, so a dump from a logged-in
    machine needs no database password. Headless in CI it needs the DB password or a CLI
    access token — and that token can manage the whole project. That is the local-vs-CI
    decision, and it is a security decision rather than a convenience one.

## Still gated on Amro — do not touch

1. **`/item/*` route on the site origin.** M3's unmet exit criterion. Re-measured 29 Aug:
   the site origin returns 200 with **zero** `og:` tags while the CDN copy has ten. Needs
   the production host.
2. **The service-role JWT for `scripts/m1-deployed.ts`.** M1's exit criterion is still
   unproven — a 4K master surviving in `originals/` while only renditions are CDN-reachable
   has been shown for the *image* path through a browser, not for video through the harness.
3. **GoTrue IP-log retention.** `auth.audit_log_entries` records IPs; §7 says do not store
   them. A policy decision, unmade.

## Open, not gated, and nobody has picked them up

- **The confirmation email's `redirect_to` is `http://localhost:3000`.** A real member
  confirming from their mail client lands on a host that does not exist for them. Supabase
  Auth Site URL setting, not code. Found by actually signing up.
- **Auto-publish on approval is still unwired** — vault entries `rma_publish_url` and
  `rma_publish_secret` are unset, so approving content does not publish. Manual invocation
  works. Carried since 25 Aug.
- **`CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_PURGE_TOKEN` unset**, so §8's CDN purge is a no-op.
  Harmless while the origin is `r2.dev` (no edge caching, delete visible at t+0s); becomes
  a real hole the day a custom domain with caching goes in front of R2.
- **Test data left in place deliberately**, as the evidence for the E2E run: post
  `1ad4e709-fd89-46b4-a88d-f334ac78da7d` (status `withdrawn`, set by its own author) and
  member `a12af40e-adc6-4acc-ae82-e36fa362e61f`. It could not be removed through §8's
  takedown path — that is moderator-only and correctly refused a member 403. Its derivative
  bytes are still in `public/`; only takedown deletes those.

## Reading CI failures without log access

The Actions **logs** endpoint returns 403 unauthenticated even on this public repo, and
there is no `gh` CLI here. The pgTAP step deliberately emits its diagnosis as GitHub
**annotations**, and those ARE readable:

    GET /repos/amrohass/nostaligia/actions/runs?per_page=5        → find the run id
    GET /repos/amrohass/nostaligia/actions/runs/{id}/jobs         → find the failing job id
    GET /repos/amrohass/nostaligia/check-runs/{job_id}/annotations

That is how every failure on 30 Aug was diagnosed. **Unauthenticated GitHub API is 60
requests/hour** — polling a run every 30s burns it in minutes and then you are blind for
the rest of the hour. Poll at 60s or longer.

## Credentials — a standing note

Amro pasted a Cloudflare API token and an **admin-scoped** R2 key pair into the 30 Aug chat
and decided against rotating them. They are in no repo file, no scratch file, no shell
history and no `.dev.vars`; they are in that session's transcript at
`~/.claude/projects/…/2fdc6961-….jsonl` in plaintext, and that file is not synced, not
backed up and not indexed by content. Whether shadow copies hold it could not be determined
without elevation. The R2 pair is admin-scoped — it can read and write bucket configuration,
unlike the object-scoped pair in `.dev.vars`.
