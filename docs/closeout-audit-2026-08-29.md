# M0–M4 closeout audit — 29 Aug 2026

Walked CLAUDE.md §10's exit criteria against the **deployed** system rather than the plan.
Every line below is either a measurement taken this session or an explicit "not measured,
and here is why". Where something is claimed rather than proven, it says so.

Commit at time of audit: `f89a6f8`. Deployed staging: `nostaligia.pages.dev`,
CDN `pub-18aab56b95304deb89be2ad31e43b413.r2.dev`, Supabase `pjqvtmhizbnimqyxjbyq`
(eu-central-1), worker `rma-media-worker` in `nl-ams`.

---

## The short version

M0, M2 and M4 meet their stated exit criteria. **M1 and M3 each have exactly one criterion
that is not met on the deployed system**, and they are different in kind: M1's is unproven
(the harness exists, running it needs a credential this session did not have), M3's is
genuinely unmet (a shared link carries no preview card, because one route does not exist).

Nothing found here was silently fixed. The two things fixed this session — the mobile
navigation and the basemap — were the session's own tasks, and both are in their own commits.

---

## M0 — foundations

| Criterion | State |
|---|---|
| Cloudflare Pages + CSP/HSTS | **met.** Measured on the live origin: HSTS `max-age=31536000; includeSubDomains; preload`, CSP with no `unsafe-inline`/`unsafe-eval`, plus `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and the `Permissions-Policy` denying camera and geolocation. |
| Supabase EU project | **met.** eu-central-1. |
| Full schema + PostGIS + EDTF | **met.** 51 migrations, hosted DB current through `20260821160000`. |
| RLS policies + denial matrix in CI | **met.** 601 pgTAP assertions across 31 files, green locally and in CI. |
| gitleaks | **met.** Full history (`fetch-depth: 0`), forbidden-path check, and a rule self-test that proves the config still discriminates. |
| **Exit: no capability-bearing key reachable from the browser** | **met.** The only credentials in the served bundle are the Supabase anon key and the Turnstile *site* key, both public by construction; `frontend-auth-test.mjs` asserts this with 36 checks including an anon-key guard. Browser CSP report on the live origin shows exactly one violation, and it is the declared Google Fonts `known_violations` entry (`removed_by: M6`) — no undeclared origin. |

## M1 — the contribution lifecycle

| Criterion | State |
|---|---|
| Auth + Turnstile, `request-upload` with role-aware caps, quotas, signed URLs | **met.** All four Edge Functions are ACTIVE and answer 401 unauthenticated. |
| Processing: magic bytes, reject SVG, re-encode, EXIF strip, ladder, audio | **met.** The worker is deployed and healthy — `/healthz` 200, and an unsigned `POST /jobs` is refused 401, which is the correct healthy answer since the HMAC is the gate. |
| Approval trigger + content hash + audit log + moderation queue | **met**, covered by pgTAP. |
| **Exit: a 4K master survives intact in `originals/` while only renditions are CDN-reachable** | **NOT PROVEN.** `scripts/m1-deployed.ts` exists precisely to answer this and is committed. It needs the **legacy service-role JWT**, which is in the deployed function environment and in no local file; I did not go looking for it. Weak evidence only: `originals/*` paths 404 through the public CDN origin, which is consistent with correct bucket bindings and also consistent with the object simply not existing. **This is the one M1 line that needs a run, and the run takes ~20 minutes of deployed worker time.** |

## M2 — sharding, releases, takedown

| Criterion | State |
|---|---|
| Sharding, versioned releases, pointer flip, single-writer lock | **met.** Active release `/v/2026-08-28T21:09:59Z/`, and every shard kind §2 names returns 200: `content.json`, `index.json`, `places.json`, `feed/page-1.json`. |
| Cache headers | **met**, and they match §2 exactly: `manifest.json` `max-age=45, must-revalidate`; release shards `max-age=31536000, immutable`; prerendered item pages `max-age=300, must-revalidate`; `redactions.json` `max-age=20`. |
| **Exit: two concurrent approvals → one consistent release** | **met.** The lease + advisory lock are intact and `scripts/publish-race.sh` runs in CI. |
| **Exit: takedown removes bytes in < 1 min** | **met today, latently at risk.** Measured on a throwaway object: after the R2 delete, the CDN answered **404 at t+0s**, and no response from this origin carries `cf-cache-status`. So `r2.dev` is not edge-caching and a delete is visible immediately. **`CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` are still unset**, so §8 step 2 is a no-op — which costs nothing *while the origin is `r2.dev`* and becomes a real hole the moment a custom domain with Cloudflare caching goes in front of R2, because derivatives are served `immutable` for a year. **The gap is not live; it activates on the same day the production CDN does.** |

## M3 — the front end

| Criterion | State |
|---|---|
| Front end consumes shards; zero DB reads for a visitor | **met.** |
| History API + `content_blocks` copy + profiles + info page + XSS/bidi sweep | **met.** |
| **Exit: budget met** | **met.** 81.9 KiB brotli against §9's 150 KiB. |
| **Exit: zero `innerHTML` on user content** | **met**, asserted over the whole served tree with controls proving the patterns fire. |
| **Exit: an item URL pastes into WhatsApp with a real preview** | **NOT MET on the deployed system.** The page itself is correct: fetched from the CDN it carries `og:type`, `og:locale`, `og:url`, `og:title`, `og:description`, `og:image`, `og:image:alt` and `og:image:width` — `CDN_ORIGIN` is set, so the image is there. **But the URL people actually share is on the site origin, and `https://nostaligia.pages.dev/item/{id}/` returns the SPA shell with zero `og:` tags.** It falls through `site/_redirects` to `index.html`, renders correctly for a human, and gives a crawler nothing. A second consequence: a deleted item answers **200** there instead of 404, so a taken-down permalink stays a working-looking page. CLAUDE.md §2 already records the fix — route `/item/*` on the site origin to the R2 `public` bucket — and calls it un-provisionable until the production host exists. **That is now only half true: the staging host exists, and this is testable on it.** It is a Cloudflare route, not a code change. |

## M4 — geo

| Criterion | State |
|---|---|
| PostGIS-backed geo, decade filtering, gazetteer, pin fallback | **met.** |
| PMTiles basemap on R2 | **met this session** (`74c58b1`). 182 MB Palestine extract, z0–15, uploaded and wired. |
| Tile-failure fallback to list view | **met**, and verified for the first time now that a basemap exists to fail: 500, 404, and a CDN that ignores `Range` and returns 200 all land on the list with the "could not load the city map" line and no uncaught errors. |
| **Exit: no external tile dependency** | **met and enforced.** No tile host in the CSP, and the origin ratchet fails the build if one appears. |
| **Exit: usable on a mid-range Android with the full seed archive** | **half met, and the missing half is not M4's.** On a Pixel-5 profile against the live origin the map draws: 23 Range requests all 206, canvas 716×954, earth/landuse/roads/major-roads all present. **"With the full seed archive" cannot be tested — there is no seed archive.** The importer is M5 and the deployed archive holds 3 items with no coordinates (`index.json` reports `"cells":[]`), so nothing exercises the geo shards or the pin layer at scale. |

---

## Gaps found that are not on any milestone's list

1. **`profiles` publish trigger was three milestones stale.** 0033's WHEN clause named only
   `handle`, `display_name` and `avatar_path` — a profile's whole presence in a release when
   it was written. M3's 0044 added `bio`, `member_since` and both visibility flags to
   `profile/{handle}.json` and the clause was never widened, so since M3 a bio or visibility
   edit moved shard bytes and signalled nothing, going live only when some unrelated content
   change happened to publish. **Fixed in `aac13d2`** because withdrawal would otherwise have
   depended on it by accident; `20_publish_cron`'s assertion pinned the old behaviour and is
   now inverted with the reason recorded.

2. **`scripts/` was never type-checked.** CI runs `deno test` over `supabase/functions/` and
   `worker/`, and nothing over `scripts/`. `m1-deployed.ts` had a real type error
   (`Uint8Array<ArrayBufferLike>` vs `BufferSource`) that no job would ever have caught.
   Fixed in `99a9f63`. **The CI step is now added** — and running it for the first time found
   a *second* error, in `scripts/sigv4-roundtrip.ts`, which CI has been **executing** all
   along: `deno run` does not type-check, so the script ran fine and carried an error no job
   could report. Both are the same TypeScript 5.7 change (typed arrays became generic over
   their buffer, and the default `ArrayBufferLike` admits `SharedArrayBuffer`, which is
   neither a `BodyInit` nor a `BufferSource`).

3. **A CSP-style specificity leak in the mobile stylesheet.** `html[lang="en"]
   .wordmark__primary` (0,2,1) outranks `.masthead .wordmark__primary` (0,2,0), so the
   English wordmark kept its *desktop* 19px on every phone. Fixed in `f89a6f8`. Worth noting
   as a class: any `html[lang="en"]` rule outranks a single-class mobile override, so this
   can be hiding elsewhere.

4. **`auth.audit_log_entries` (GoTrue's own table) records IP addresses.** §7 says "Do not
   store IPs, or truncate and expire them." This is GoTrue's schema, not ours, and nothing
   in this repository writes or prunes it. **Not fixed, not in scope, and a real §7 exposure
   for a politically sensitive archive.** It wants a retention decision before launch.

5. **Auto-publish on approval is still not wired.** The trigger dispatches through vault
   entries `rma_publish_url` and `rma_publish_secret`; neither is set, so approving content
   does not publish and the archive only moves when the publisher is invoked by hand. Carried
   over from the 25 Aug handoff and unchanged.

---

## Still-open deviations, re-checked

- **Resolved since the handoff:** the Edge Functions and the worker no longer share one R2
  token — the local `.dev.vars` pair now differ, so the independent revocation
  `worker/README.md` argues for exists.
- **Still open:** `r2.dev` is the CDN origin (rate-limited, not for production), and
  `domains.site` is `PLACEHOLDER_DOMAIN`. Harmless today because nothing in the front end
  reads `origins.site`, and load-bearing for the `/item/*` route above.
- **Still open, deliberately:** Google Fonts remain in `known_violations` with
  `removed_by: M6`. The CSP blocks them on the live origin and the page falls back to system
  fonts. Do not "fix" this by widening the CSP — §9 wants a self-hosted subset, and the
  third-party font host leaks reader IPs, which for this archive is a §7 exposure.

## §11 launch gates, for reference

| Gate | State |
|---|---|
| 1 · RLS denial matrix green in CI | **passing.** |
| 2 · EXIF stripping verified on a real photo, end to end | harness written (`scripts/e2e-deployed.ts`) and it found four real defects; **needs a run to be claimed**, same credential blocker as M1. |
| 3 · One tested restore | **not started.** M5. |
| 4 · A named human on the takedown path with a stated response time | **not done.** Nothing in the repository names one. |
| 5 · Publish-age monitoring separating `held_by_operator` from `unchanged` | **not started.** The database reports the distinction (0039 and its test), and nothing consumes it — there is no monitor. M6. |
| Independent penetration test | not scheduled. |

## Two things to provision that are not code

1. **Route `/item/*` on the site origin to the R2 `public` bucket.** This is M3's unmet exit
   criterion and it is testable on staging today.
2. **Add `Range` to the R2 bucket's CORS `AllowedHeaders`.** Not blocking — measured with
   headless Chromium, current browsers safelist a simple byte range and send no preflight, so
   the map works today. An older Android WebView will preflight and get nothing, and §10's
   exit criterion is about exactly that device.

---

## Addendum — 30 Aug 2026: M1's first row was wrong

The M1 table above reads "Auth + Turnstile, `request-upload` with role-aware caps, quotas,
signed URLs — **met.** All four Edge Functions are ACTIVE and answer 401 unauthenticated."

That was measured with `curl`, and **curl does not enforce CORS or CSP**. From a browser,
uploading on the deployed site was impossible and had been since M1. Three independent
causes, each sufficient on its own, each surfacing as the same sentence — upload.js maps
every network-layer rejection to `up.err.offline`, "لا يوجد اتصال. تحقّق من الشبكة" — so
none of them named itself:

1. **`apikey` was missing from the Edge Functions' `Access-Control-Allow-Headers`.**
   upload.js and admin.js both send it; the preflight granted only `authorization,
   content-type`, so the browser refused before the request left it. **Fixed** in
   `_shared/http.ts` and deployed to `request-upload`, `complete-upload` and `takedown`;
   verified in Chromium against the live origin. `scripts/frontend-cors-test.mjs` is the
   two-way ratchet that would have caught it, and now runs in CI.
2. **`connect-src` omitted the R2 S3 endpoint.** The PUT goes to
   `<account>.r2.cloudflarestorage.com`, which the site's own CSP never allowed — the page
   blocked its own upload before CORS was consulted. **Fixed** in `config/site.json`
   (`domains.r2_s3`, `@r2_s3` in `connect-src`); it reaches the live site on the next Pages
   deploy.
3. **The `quarantine` bucket has no CORS policy at all.** An OPTIONS preflight answers 403
   with no `Access-Control-*` headers for GET, PUT and HEAD alike. **NOT fixed — needs an
   admin credential.** The R2 token in `.dev.vars` is object-scoped and answers
   `AccessDenied` to `GetBucketCors`, which is correct least privilege and also means this
   cannot be done from here. `scripts/provision-r2-cors.ts` applies it given an Admin Read
   & Write token, prints the dashboard JSON without one, and in its default mode checks the
   live bucket with no credential at all.

**Until (3) is done, uploading still fails on the deployed site**, now for one reason
instead of three.

Two notes for the record:

- **`delete-account` is not deployed.** `supabase functions list` returns four functions
  and it is not among them, though its migration (`20260829090000`) is applied. Nothing in
  this session touched it.
- **The R2 CORS item at the bottom of this document is confirmed still open** and is the
  same class of gap as (3): a preflight for `Range` against the public bucket answers 403.
  A plain GET carries `Access-Control-Allow-Origin` correctly, so reads work and only a
  preflighting client is affected, exactly as recorded. `provision-r2-cors.ts --print`
  emits the rule to merge, and deliberately never applies it — `PutBucketCors` replaces
  rather than merges, and the existing policy on that bucket cannot be read back with the
  token available.
