# Session report — 24 Aug 2026

What changed, what broke, what it cost to find, and what is still open. Written for whoever
picks this up next; the ordered plan lives in `NEXT-SESSION.md`.

**Headline:** the staging deployment went from *nothing served* to a **live, correct read
path**. The write path is still dead at one hop — the worker is not deployed anywhere.

---

## 1 · What this session was supposed to do

Finish everything blocking M5, ending in `docs/probe-results.md`: per-stage wall-clock
timings from real footage through the deployed worker against real R2.

**It did not end there, and the detour was correct.** Two blockers surfaced that were
invisible from the repository, and one of them would have wasted the probe entirely.

---

## 2 · The two things that were actually wrong

### 2.1 The hosted database was 26 migrations behind

Stuck at `20260812090100` (12 Aug), missing **all of M2, M3 and M4**. This was not a
front-end problem and not cosmetic:

| Missing remotely | Needed by |
|---|---|
| `complete_ingest`, `claim_upload_slot` | **the worker** |
| `acquire_publish_lease`, `publish_pending` | the publisher |
| releases, content_blocks projections, places, geo | the entire read path |

**This would have destroyed the probe.** A job would have downloaded the master,
transcoded the full ladder, uploaded every rendition — and then failed at
`complete_ingest`, which does not exist. That is the late-and-expensive failure mode this
project keeps warning itself about, and nothing in the repo would have predicted it.

*Lesson for the next run: `supabase migration list` before any end-to-end attempt.* It is
two seconds and it is not implied by anything else being green.

### 2.2 The bearer-token trap — a platform change, not a repo bug

Every call to the deployed `publish` returned a **bare 500 with no body**. Root cause: the
hosted runtime now injects the *new* key formats into the reserved names.

    SUPABASE_ANON_KEY          len 46   sb_publishable_...
    SUPABASE_SERVICE_ROLE_KEY  len 41   sb_secret_...

A legacy anon JWT is 208 characters. `_shared/http.ts` puts the service credential in
`Authorization: Bearer`, which is where PostgREST parses a JWT:

    401 PGRST301 {"message":"Expected 3 parts in JWT; got 1"}

Enumerated against the live database rather than inferred:

| apikey | bearer | result |
|---|---|---|
| legacy anon | legacy service_role | **200** |
| publishable | secret | 401 "Expected 3 parts in JWT" |
| secret | secret | 401 Invalid API key |
| secret | *(none)* | 401 Invalid API key |
| publishable | legacy service_role | **200** |

So the `apikey` header takes the new key happily — **only the bearer was ever wrong.**

**Why it hid so well.** Every `Db` method turns a non-2xx into a throw (deliberately, so a
network error can never read as "no approved posts" and flip the pointer onto an empty
archive), and `publish/handler.ts` has no try/catch. A 401 therefore became an uncaught
throw and the runtime's generic 500. And it worked perfectly on a laptop, where the env var
still holds a legacy JWT. **Works locally, 500s remotely, no log** is the signature.

The one-line fix was impossible — `supabase secrets set` refuses the reserved prefix
outright ("Env name cannot start with SUPABASE_, skipping") — so `serviceRoleJwt()` now
prefers an unreserved `SERVICE_ROLE_JWT` and falls back to the reserved name, keeping local
and CI correct where a legacy JWT is still injected.

---

## 3 · The measurement that did land: `min-scale=0` is dead

`worker/README.md` asked for one experiment. It was run.

A throwaway container at `min-scale=0`, answering `202` and then heartbeating every 30 s for
40 minutes with nothing in flight — the same shape `main.ts` uses:

    triggered  15:20:40Z  ->  202 {"boot":"e3dcf3f9","accepted":true}
    /report    16:05:31Z  ->  200 {"boot":"fe1f646a","booted_at":"16:05:38Z",
                                   "accepted_at":null,"beat_count":0}

The instance that took the job **was gone**. What answered was a different instance, cold-
started seven seconds after the request arrived. **Post-response work is not safe at
`min-scale=0`.**

Two design choices worth reusing: the probe kept beats in memory and served them from
`/report` rather than shipping to Cockpit, because an empty Loki result cannot distinguish
"the instance died" from "the log pipeline lagged" — the exact distinction being measured.
And every beat carried a wall-clock gap, so a *freeze* would have been legible as a huge gap
rather than looking identical to termination.

Two honest limits, recorded rather than smoothed: it proves the instance was gone by minute
45, **not** that it died at 15; and it cannot separate termination from a freeze it never
woke from — though for a job under a deadline those have the same consequence.

---

## 4 · System state

### Working — verified end to end

- **`publish`** — 200, builds the release tree, writes the shards, flips `manifest.json`.
  Ran twice; the second correctly recorded the previous release.
- **The read path** — `manifest.json`, `redactions.json`, `content.json`, `index.json`,
  `feed/page-1.json` all 200 from the r2.dev origin with
  `Access-Control-Allow-Origin: https://nostaligia.pages.dev`.
- **The site** — `nostaligia.pages.dev` serves the real CSP with the bucket in
  `connect-src`, `archiveBase` resolves, anon key populated. Front-end checks green:
  CSP 14/14, view 46/46, budget **80.8 KiB** against §9's 150 KiB.
- **R2** — 11/11, including the delete-then-read-back-404 assertion.
- **`MEDIA_WORKER_JWT`** — 404 on a nonexistent RPC, 401 on a one-character corruption, so
  the check discriminates rather than passing by accident.

### Gated correctly, untested past the gate

- **`request-upload`** — every dependency is now present (real Turnstile secret, working R2
  credentials, quota/slot RPCs). No successful call was ever made through it: that needs a
  signed-in user *and* a genuine Turnstile token from a browser.
- **`takedown`** — carries the `serviceRoleJwt()` fix, so the `publish` failure will not
  recur there. Untested with a real moderator token.

### Not working

- **`complete-upload`** — `MEDIA_WORKER_URL` is unset, so every authenticated call returns
  **503 `worker_not_configured`**. It releases the ingest slot first, so it fails cleanly
  rather than stranding rows — but it cannot dispatch, because there is no worker.
- **The worker** — not deployed. Blocked on the execution-model decision below.
- **Auto-publish on approval** — the DB trigger dispatches via vault entries
  `rma_publish_url` and `rma_publish_secret`. Neither is set, so approving content does not
  trigger a publish. Manual invocation works.

### Degraded, deliberately or otherwise

- **`takedown`'s CDN purge is a no-op** — `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_PURGE_TOKEN`
  and `CDN_ORIGIN` are all unset, so it deletes R2 bytes and purges nothing. **§8 step 2 is
  not satisfied, and that is a launch gate.**
- **Prerendered pages have no `og:image`** — `CDN_ORIGIN` unset, treated by the code as a
  deliberate degradation rather than guessing a host. Moot at `posts: 0`.
- **The fonts stay blocked, on purpose.** See §6.

**The archive is empty — 0 posts.** What is live is a correctly functioning site with
nothing in it.

---

## 5 · The probe

21 of 22 samples measured; the 18m15s clip was still encoding when this was written.

Run **inside the built worker image** so the ffmpeg is the one that ships, pinned with
`--cpuset-cpus=0,1` so `host_cpus` reads 2 and every record states its own shape.
`--cpuset-cpus` and not `--cpus`: the latter is a CFS quota, so ffmpeg's thread
auto-detection still sees every core and spawns that many threads to share a fraction of
one — which measures thrash, not a 2-vCPU instance.

Early figures, all real footage:

| sample | source | total | ×source |
|---|---:|---:|---:|
| 51 s, 1080x1920, 4 rungs | 51 s | 427.5 s | 8.4× |
| 86 s, 1080x1920, 4 rungs | 86 s | 593.5 s | 6.9× |
| 52 s, 2730x1440, 4 rungs | 52 s | 1009 s | 19.4× *(contaminated — re-run pending)* |

That 8.4× vs 6.9× spread at identical resolution and rung count is **content dependence** —
precisely what synthetic `testsrc` cannot show, and why §6 names the testsrc-to-real-footage
factor the dominant estimated term.

**Four caveats that must travel with these numbers:**

1. **Not the deployed worker.** Same image, different CPU.
2. **Not real R2.** `LocalStore` over a temp dir; network transfer is unmeasured and
   additive.
3. **Not fast hardware.** Host is an **i5-4210U** (2 cores, 15 W, 2014). These are a
   conservative **upper** bound, not a floor.
4. **Two gaps in the sample set** — no true 3840x2160 source (less damaging than it sounds:
   §6 never makes a 2160p rendition, so the rung count is identical; what is missing is
   decode cost), and **no audio file at all**, so the Opus-normalize and waveform path is
   entirely unmeasured. A voice note is §7's most identifying medium and its ingest cost is
   unknown.

**One process lesson, learned the hard way:** the 2730x1440 sample was contaminated by
concurrent Docker builds for the Scaleway work. The contamination is **invisible in the
output** — it just looks like a slow sample. Do not run anything CPU-heavy during a sweep.

---

## 6 · Deviations to undo before launch

- **The Edge Functions and the worker now share ONE R2 token.** The hosted functions' R2
  key pair was never valid; rather than block, they were pointed at the worker's verified
  token. This costs the independent revocation `worker/README.md` argues for, and it
  over-grants `request-upload`, which needs quarantine write and now carries `originals` and
  `public` too. **Mint a scoped functions token and re-split before the pen test.**
- **`r2.dev` is the CDN origin.** Rate-limited, and Cloudflare says not for production.
  Replace with a custom domain.
- **The fonts are blocked and must stay blocked.** `fonts.googleapis.com` and
  `fonts.gstatic.com` remain in `known_violations`, `removed_by: M6`. Do **not** add them to
  the CSP to make the page look right: §9 wants a self-hosted subset, and the sharper reason
  is that Google Fonts leaks reader IPs to a third party, which for this archive is a §7
  exposure and not a styling preference. The ratchet exists to stop that shortcut.

---

## 7 · The decision waiting on Amro

**How the worker runs in production.** The probe removed `min-scale=0` and chose nothing:

- `min-scale=1` — works; bills continuously for a container idle almost all the time. §6
  calls that the largest avoidable line on a grant-funded budget, and with the ~300 launch
  items transcoded offline the real load is a handful of uploads a day.
- **Serverless Jobs** — 24 h, 6 vCPU, 16 GB, but API-triggered → a Scaleway credential in
  Supabase secrets.

**The part worth saying out loud:** that second option is the *same trade* that moved this
worker off Cloud Run. If a platform credential in Supabase secrets is acceptable now, then
Cloud Run's `--no-cpu-throttling` with `min-scale=0` — which solves precisely this problem
and was abandoned over precisely this objection — deserves reconsidering on the merits
rather than being treated as settled.

Whatever production becomes, **the measurement rig should be `min-scale=1` and should be
deleted afterwards.** §6's scale-to-zero requirement governs the production deployment, not
a temporary rig.

---

## 8 · Commits

| | |
|---|---|
| `44058c1` | CDN host and anon key wired; the site goes live |
| `e422d8b` | `serviceRoleJwt()` — the bearer-token fix; hosted publish returns 200 |
| `6804d64` | README: the heartbeat result, plus three deploy commands corrected against a real run |

Also applied but not in a commit: 26 database migrations, and the function secrets
(`MEDIA_WORKER_SECRET`, `R2_BUCKET_PREFIX`, `SITE_ORIGIN`, `UPLOAD_ALLOWED_ORIGINS`,
`PUBLISH_SECRET`, `SERVICE_ROLE_JWT`, and the R2 key pair).

A temporary `envprobe` function was deployed to read env var **names and lengths only, never
values** — it is what exposed the 41- and 46-character keys immediately. It has been deleted
and its endpoint 404s.
