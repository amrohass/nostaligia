# CLAUDE.md — Ramallah Memory Atlas (ذاكرة رام الله)

Governance file for Claude Code. Read fully before any change. If a request conflicts with
anything here, STOP and ask. If anything here is ambiguous, ask rather than guess.

**Status:** pre-launch build. Internal target 16 Aug 2026. Public launch date is NOT set —
it is gated on an independent penetration test (see §11).

**This file supersedes all earlier plans.** Any prior instruction specifying Firebase,
Firestore, geohash-as-source-of-truth, MapLibre, or a then-and-now wipe viewer is VOID.

---

## 1. The system

A bilingual (Arabic-first, RTL) community heritage platform for Ramallah. Residents and
diaspora contribute and browse photos, video, voice notes, and events, pinned to place and
era on a map. Content is user- and admin-submitted; **everything user-submitted is reviewed
before it is public.** Browsing is open; all engagement requires sign-in.

- **Amended 30 Aug 2026 — COMMENTS ARE THE ONE EXCEPTION, and it is the only one.** A
  comment is published the moment it is written; a post is not, and nothing about this
  reaches posts, media, events or profiles. Migration 0054 is where it lives.
  The reason is not a change of mind about review. Review of comments was never happening
  and structurally could not: 0019 pinned an insert to `pending` and gave a moderator the
  UPDATE that lifts it, and **no screen was ever built that calls it** — `admin.js` has a
  queue, an archive register, events, places, members, reports and copy, and no comments
  panel. So the real choice was between a comment box that silently discards and one that
  works. Every comment written on the deployed system before this date was invisible from
  the moment it was submitted, to everyone including its author's readers.
  **What does NOT change:** sign-in is still required, you may still only comment on an
  approved and non-taken-down post, `created_by` is still stamped by trigger, bidi stripping
  (§6) still runs before the row lands and is now the ONLY filter between a hostile string
  and a shard, and the Turnstile and rate limits on the write path are untouched.
  **Moderation becomes reactive:** §4's "view / delete comments" is unchanged, a moderator
  still hides or removes any comment, and `reports` still takes a member's flag. What is
  gone is prior restraint on a remark — not the ability to act on one.
  One cost, recorded rather than discovered later: a published comment bumps the CONTENT
  revision, and §2's amendment says content is never throttled, so a comment now costs an
  archive rebuild where §6's hour floor bounds a like. The single-writer lease is what keeps
  that from being a storm — a concurrent dispatch is answered `held` without building
  anything, and 0042's follow-up collects the rest — so N comments in a window cost roughly
  one release, not N. If that stops being true the answer is §2's deferred incremental diff,
  not a throttle that would make a comment appear an hour after it was written.

Scale: ~300 items at launch, low thousands within a year. Tens of thousands of users
worldwide. Read-dominated. Solo maintainer. Grant-funded — predictable low cost is a
requirement, not a preference.

### Three public surfaces
1. **Media grid** — endless browsable grid opening into a full-screen immersive viewer with
   comments; vertical snap-scroll moves between items.
2. **Map** — Ramallah basemap + decade slider; geolocated items as cards that expand over a
   dimmed map, with a clear way back.
3. **Events** — same grid language, for Ramallah events.

Plus: profiles, an info page (About / Contact / Support / Donate), and an admin dashboard.

---

## 2. Architecture — locked

| Layer | Choice |
|---|---|
| Hosting | **Cloudflare Pages** (NOT GitHub Pages) |
| Media | **Cloudflare R2** — buckets: `quarantine/` (private), `originals/` (restricted), `public/` (CDN) |
| Database | **Supabase Postgres, EU / Frankfurt region** |
| Auth | Supabase Auth, **email + password only** |
| Geo | **PostGIS** `geography(Point,4326)` + GiST. Geohash is a derived publish-time shard key ONLY |
| Basemap | **PMTiles** (Palestine extract) on R2. NEVER the public OSM tile endpoint |
| Media processing | **One containerised worker for all media** (added M1, 12 Aug 2026 — see §6) |
| Front end | **Vanilla JS** — no framework, no build step beyond the publish script |
| Routing | **History API** (NOT hash routing) |
| Read path | Static sharded JSON releases on CDN. **Zero database reads for public visitors** |

`amrohass/nostaligia` is the **staging/testing** repo. Production host and domain are not yet
provisioned — use `PLACEHOLDER_DOMAIN` and keep every origin/CSP/CORS value in one config
module so it is a one-file change later.

### Read path
Browser → CDN → `manifest.json` (TTL 30–60 s) → active release → `feed/page-N.json`,
`geo/{cell}.json`, `decade/{d}.json`, `item/{id}.json` (all immutable, `max-age=31536000`)
→ media from R2 via CDN. Per-item pages are prerendered HTML with OG tags; the SPA hydrates
after first paint. Client filters against a short-TTL `redactions.json`.

- **Amended 21 Aug 2026 — what a release contains, as built in M3.** Three shard kinds
  join the four above, all inside `/v/{ts}/` and immutable with it: `content.json` (the
  published half of `content_blocks`, §9's single source of truth for copy),
  `profile/{handle}.json` (the PUBLIC projection of a profile — §7's visibility map is
  applied at publish time, so a hidden list is an empty list in the file rather than data
  the browser is asked to be discreet about), and `index.json` (which decades and geo cells
  this release actually has, so the front end carries no hardcoded list of either).
  Published comment BODIES now travel inside `item/{id}.json`, because §9 names comments
  among the things that read from shards and 0015 grants `anon` nothing — a comment a
  visitor cannot get from a shard is a comment they cannot read.

- **Amended 21 Aug 2026 — M4 adds one shard and one object beside the tree.** The shard is
  `places.json`, the confirmed gazetteer, immutable inside `/v/{ts}/` like the rest. It
  exists because the basemap below is rendered WITHOUT its label layers, so every name on
  the map is a row a moderator typed rather than whatever an extract's renderer baked in —
  which is the only way an Arabic-first archive gets an Arabic-first map, and it puts the
  map's text through §9's "all content comes from the store" like every other string.

  - **Amended 31 Aug 2026 — the paragraph above was half right, and the half that was
    wrong made the map look unnamed.** `places.json` stands exactly as described: it is the
    confirmed gazetteer, it is a shard, and it is drawn FIRST so a moderator's name wins
    every collision. What does not stand is "rendered WITHOUT its label layers". That rule
    was written for a *raster* extract, where names are baked into the pixels in one
    language and no styling recovers them. This archive is vector, chosen for exactly that
    reason, and a vector tile carries name attributes per language: the deployed Palestine
    extract carries `name:ar` on 146 of the 163 roads in a central z14 tile, on 125 of 126
    POIs, and on every place. So the rule produced the opposite of what it wanted — three
    gazetteer rows meant three labels, and Ramallah rendered as a city nobody had named.
    `map.js` now draws the extract's own `name:ar` / `name:en` beneath the gazetteer.
    Three things fixed in the same breath, recorded because each was silent:
    **(a)** a default `name` in HEBREW script is never used as a fallback — it is a
    different name for the same point, not a translation, and an Arabic-first archive of
    Ramallah must not label its map in Hebrew wherever a settlement carries no `name:ar`.
    The feature keeps its geometry and gets no label. One line in `labelText`, and a
    judgement rather than a mechanism, so it is marked as one;
    **(b)** the view stopped dead at the archive's own maxZoom (15), a scale at which no
    street name has room to be written. Vector tiles OVERZOOM — the same tile drawn larger,
    not a new one fetched — so the view now goes three levels past it. `fit()` deliberately
    does not, so the map never OPENS inside the overzoom range;
    **(c)** POI labels are restricted to landmark kinds. Nine z15 tiles over the centre
    carry 1,600 named POIs whose largest classes are restaurant, supermarket, cafe, pharmacy
    and bank — drawing them all turns a heritage archive into a business directory that is
    out of date the year it ships.
    Bidi stripping (§6) runs on every string that comes off a tile, for the same reason it
    runs on ingest. No glyph atlas and no font is fetched: canvas's own text engine shapes
    the Arabic, which is why `font-src 'self'` is untouched by any of this.
  The object is the basemap itself: one `.pmtiles` archive in the `public` bucket, named by
  `basemap.path` in `config/site.json` and read with HTTP **Range** requests. It is not part
  of a release and does not move with one — it changes when somebody rebuilds the extract,
  which is a deliberate act a year apart, not a publish.

- **Amended 21 Aug 2026 — the prerendered item pages are the one thing written outside a
  release.** §9's `item/{id}/index.html` is written at the ROOT of the public bucket, not
  under `/v/{ts}/`, and the reason is the feature: it is the URL somebody pasted into a
  group chat, and resolving it must not require reading `manifest.json` first. Three
  consequences, all deliberate:
  **(a)** they are rewritten in place on every publish, so they carry `max-age=300,
  must-revalidate` rather than the release tree's year;
  **(b)** they are written AFTER the pointer flip and a failure among them does not fail
  the release — the archive is correct without a preview card, and holding the pointer
  hostage to one would be the wrong thing to be strict about;
  **(c)** nothing about the next release removes a stale one, so `unpublishable_post_ids()`
  (0046) names the posts that must LOSE a page — withdrawn, rejected after approval, edited
  past their approval hash. Takedown does not wait for that: §8's path deletes the page
  itself, in the same request as the bytes.
  A **rollback does not undo them**, and that is accepted rather than hidden: there is no
  per-release copy to flip back to, the content on them is approved either way, and the
  next successful publish rewrites every one.

- **Amended 21 Aug 2026 — M4's basemap: vector, ours to draw, and two things to provision.**
  §2 fixes PMTiles on R2 and voids MapLibre; §9 forbids a build step. So the renderer is
  three files in this repository and no dependency: `pmtiles.js` (header, directories, one
  tile, over Range requests), `mvt.js` (geometry only), `map.js` (a canvas). All three are
  loaded on demand, so they are outside §9's first-load budget by construction.
  **Vector rather than raster, decided 21 Aug 2026.** Raster would be ~150 lines of client
  code instead of ~900, and it was refused for two reasons: no ready-made raster extract of
  Palestine exists, so the maintainer would have to run a rendering toolchain; and a raster
  tile has its labels baked into the pixels in one language, which for this archive is the
  wrong language. Vector tiles are geometry, and the names come from `places.json`.
  Two things must be provisioned and neither is code:
  **(a)** the extract — one `pmtiles extract` against the public Protomaps planet build,
  bounded to Palestine, uploaded to `public/`, and its path set in `config/site.json`. Until
  then `basemap.path` is empty and `/map` renders as the list, which is M4's own stated
  fallback rather than a broken state;
  **(b)** the CDN in front of R2 must pass **Range** requests through and allow the `Range`
  header in CORS. A server that answers a range request with the whole file is refused by
  `pmtiles.js` rather than sliced — quietly downloading a multi-megabyte archive on a phone
  to read 127 bytes is the failure the whole format exists to avoid, and it must not be the
  thing that "works".

- **Amended 21 Aug 2026 — one deployment requirement, not yet provisionable.** The site
  origin must route `/item/*` to the R2 `public` bucket, or a shared link falls through
  `site/_redirects` to the SPA shell and renders correctly for a browser while carrying no
  OG tags for a crawler. Once that route exists, a link to an item the archive no longer
  has answers 404 from R2 rather than reaching the SPA — which is the correct answer for a
  takedown and is why the page is deleted rather than replaced with a tombstone. That is a Cloudflare route, not a code change, and it cannot be
  made until the production host exists. The publisher also needs `SITE_ORIGIN` in its
  environment — `env("SITE_ORIGIN")` throws rather than defaulting, because a preview card
  that resolves to the wrong host is worse than one that fails loudly. It lives in
  `config/site.json` under `function_env`; the generator prints the `supabase secrets set`
  line.

### Write path
Signed-in user → `request-upload` Edge Function (auth + daily quota + declared type/size +
Turnstile) → signed URL → `quarantine/` → processing function (magic-byte validation, reject
SVG, re-encode image / transcode video / normalize audio → EXIF destroyed) → derivative to
`public/`, original to `originals/` → `posts` row inserted `status='pending'` under RLS →
moderation queue → approval → trigger records approver + content hash + audit row.

### Publish
Debounced cron (2–5 min) → **single writer via advisory lock** → rebuild only changed shards
into `/v/{ISO-ts}/` → validate → **atomically flip the `manifest.json` pointer**. Rollback =
flip back. Takedown does NOT wait for this (§8).

**The single-writer lock is what prevents races — not the cron.** Do not remove it.

- **Amended 19 Aug 2026 — "rebuild only changed shards" is the deferred target, not current
  behaviour.** Every release rewrites every shard: `releaseFiles()` in
  `supabase/functions/publish/release.ts` builds all of them and `publish()` puts all of
  them — ~325 objects at 300 items, on every release. The incremental diff is not written.
  §6's one-hour counter floor exists to bound what that costs until it is. Reinstate the
  diff when the archive passes 1,500 items, the publish rate passes 100 releases/day, or
  `/v/` passes 5 GB; at that point it and release pruning are one piece of work.
  **Updated 21 Aug 2026:** M3 roughly doubles that object count. Every release now also
  writes one prerendered HTML page per publishable post at the bucket root, plus one
  profile shard per contributor, `content.json` and `index.json` — so ~325 objects at 300
  items becomes ~660, and a publish additionally issues one DELETE per post that was once
  approved and no longer is. The thresholds above are unchanged and are still the trigger;
  what changed is how quickly they arrive.

- **Amended 20 Aug 2026 — the trigger is the moderation action, not a clock. The cron is
  deferred, not built.** A change to publishable content dispatches the publisher directly,
  from inside `public.bump_publish_revision()`; `pg_cron`'s `rma-publish` job is
  unscheduled. Everything after the trigger is unchanged, and that is the point — **the
  single-writer lock is still what prevents races, and this amendment does not touch it.**
  Restoring the clock is one `cron.schedule` line, written out in
  `supabase/migrations/20260820140000_publish_on_approval.sql`; both extensions stay
  installed so it stays a line.
  Two consequences, recorded because neither announces itself:
  **(a)** only the *content* branch dispatches, so baked like and comment counts now go live
  with the next content change rather than within §6's one-hour floor — the floor remains a
  ceiling, never a freshness promise, and restoring the cron restores hourly counters.
  **(b)** a publish claims the lease and *then* reads the archive, so a change committing in
  between is not in that release and its own dispatch is refused `held`. With no next tick
  to collect it, `release_publish_lease` takes the claim-time revision and asks once more if
  it moved. That follow-up is load-bearing, not an optimisation: without it, per-approval
  publishing silently loses every change that lands mid-build.

---

## 3. Data model

Single `posts` table with a `kind` enum. **Do not split by type** — one feed, one moderation
queue, one comment model; splitting turns every feed read into a UNION.

```
profiles(id uuid PK → auth.users, handle text UNIQUE, display_name, avatar_path,
         bio, visibility jsonb, role_cache, created_at)
   -- handle is user-chosen, NOT a legal name. role is NOT here (§4).

posts(id, kind enum('media','voice','event'), title_ar/en, body_ar/en,
      date_earliest date, date_latest date,
      date_precision enum('day','month','year','decade','circa'),
      decade smallint GENERATED,
      location geography(Point,4326), location_precision enum('exact','street','area','hidden'),
      location_public geography(Point,4326),   -- fuzzed; NEVER expose raw location
      location_source enum('user','admin'), place_id → places,
      event_starts_at, event_ends_at, venue_ar/en,     -- kind='event'
      details jsonb,
      status enum('pending','approved','rejected','withdrawn'),
      takedown boolean DEFAULT false,
      license text, provenance text,          -- where did this come from
      consent jsonb, author_label enum('member','moderator','admin'),
      content_hash text, approved_by, approved_at,
      created_by, created_at, updated_at)

media_assets(id, post_id → posts,
             role enum('master','rendition','thumb','poster'),
             rendition enum('2160p','1440p','1080p','720p','480p') NULL,  -- role='rendition'
             storage_path, bucket enum('originals','public'),
             mime, bytes, width, height, duration_s, bitrate_kbps, sort_order)
   -- One post → one master (originals/) + N renditions (public/) + thumb + poster.
   -- NEVER serve a row with bucket='originals' through the public CDN path.

places(id, name_ar/en, aliases text[], location geography, geohash, unconfirmed bool)
comments(id, post_id, body, lang, status, created_by, created_at)
   -- status DEFAULTS TO 'published' and the insert trigger stamps 'published' (0054,
   -- 30 Aug 2026) — §1's review exception. 'pending' remains in the enum and is now
   -- unreachable on the write path; 'hidden' and 'removed' are moderator decisions and are
   -- the whole of comment moderation. Do not restore prior review here without building the
   -- queue screen that was always missing.
likes(user_id, post_id, created_at, UNIQUE(user_id, post_id))
saves(user_id, post_id, created_at, UNIQUE(user_id, post_id))
content_blocks(key, locale, draft, published, version, updated_by, updated_at)
reports(id, target_type, target_id, reason, reported_by, status, created_at)
moderation_actions(id, actor, action, target_type, target_id, target_key, note, created_at)
   -- target_id is NULLABLE (0059, 31 Aug 2026) and target_key carries the composite key of a
   -- target that is not keyed by uuid, as "<type>:<key>" — content_blocks is (key, locale),
   -- which is why §4's "moderation_actions AND audit_log" was unmet for a site-copy edit
   -- until then. A row must still name a target: exactly what the old NOT NULL was for.
audit_log(id, actor, action, target_type, target_id, before jsonb, after jsonb, created_at)
releases(id, path, created_at, active bool)
upload_quota(user_id, day date, count, bytes, PRIMARY KEY(user_id, day))
```

**Audit rows are permanent** — never deleted, never rotated. They are part of the archival
record and required for grant reporting. (User asked for 30-day retention; permanent is the
floor, not a cap.)

Dates are **EDTF-lite** — heritage photos are "sometime in the 60s". Never force a single
date. `decade` is generated from `date_earliest` for the slider.

Seed the archive via a **bulk importer** (JSON → Postgres). ~300 items land right before
launch. Content is data-first, not hand-entered.

---

## 4. Roles and permissions

Three roles. **Role lives in a JWT claim set by a `SECURITY DEFINER` function or an
access-token hook — NEVER in a user-writable column.** `profiles.role_cache` is display-only
and must never be trusted for authorization.

| Capability | member | moderator | admin |
|---|:--:|:--:|:--:|
| Browse public content | ✓ | ✓ | ✓ |
| Like / save / comment | ✓ | ✓ | ✓ |
| Submit content (→ pending) | ✓ | ✓ | ✓ |
| Approve / reject content | | ✓ | ✓ |
| Review reports | | ✓ | ✓ |
| Delete content | | ✓ | ✓ |
| View / delete comments | | ✓ | ✓ |
| Publish own content labeled "moderator" | | ✓ | ✓ |
| Edit site copy (`content_blocks`) | | | ✓ |
| Manage users / roles | | | ✓ |
| Trigger takedown | | ✓ | ✓ |

Every moderator and admin action writes to `moderation_actions` AND `audit_log` with actor,
target, timestamp, and before/after state. No privileged action may bypass this.

---

## 5. Trust boundary — the core rule

**The browser is hostile. This includes `admin.js`.** Assume the attacker has your client
JS, your anon key, and a free account.

- Authorization lives in **RLS policies and Edge Functions. Nowhere else.**
- Deny by default. An explicit policy per (table × operation). `WITH CHECK` on every
  INSERT/UPDATE.
- The sign-in gate and the admin UI are **UX only** — never a guard.
- `admin.js` **stays in this repo**, dynamically imported on moderator/admin login. Do not
  build a separate admin site. Hiding client code is not security.
- Unapproved content must be **unreadable** by non-moderators at the policy level, not hidden
  in the client.
- **Edit-after-approval trigger:** any UPDATE to content columns resets `status` to
  `'pending'` and clears `approved_by`/`approved_at`. Record `content_hash` at approval; the
  publisher refuses rows whose hash ≠ approved hash.

---

## 6. Security hard-rules — NON-NEGOTIABLE

Written after a real compromised-key incident (~24,000% billing spike).

- **No capability-bearing credential ever reaches the client.** The Supabase anon key is
  designed to be public and is not the concern; the service-role key, any third-party API
  key, and any admin credential are. Service-role key lives only in CI secrets or Edge
  Function env.
- `.env*` git-ignored from commit #1. `gitleaks` in pre-commit and CI.
- **Uploads:** signed URL from an Edge Function only, after auth + per-user daily quota +
  declared type/size. Validate by **magic bytes, not extension**. **Reject SVG.** Re-encode
  every image server-side — this strips EXIF and kills polyglots in one step.
- **Video — preservation and delivery are SEPARATE paths. Never conflate them.**
  - **Masters: 4K accepted.** The uploaded master is stored untouched in `originals/`
    (restricted, never CDN-fronted, never served to a browser by default). This is the
    archival copy and the thing an institutional partner would want on deposit.
  - **Caps are role-aware:**
    | Uploader | Max size | Max duration |
    |---|---|---|
    | member | 200 MB | 3 min |
    | moderator / admin | 4 GB | 20 min |
    Enforce in `request-upload` from the JWT role claim — never from a client-declared value.
  - **Delivery ladder** (all H.264 + AAC, faststart, each with a poster):
    **1440p ~8 Mbps · 1080p ~5 Mbps · 720p ~2.5 Mbps · 480p ~1 Mbps**
    Player selects by viewport and connection; default to 1080p on desktop, 720p on mobile,
    and step down on a slow connection. Never auto-serve the top rung to a phone.
  - **4K is not streamed.** The master is available as an explicit **download of the
    original**, sign-in gated and rate-limited (a repeatedly downloaded multi-GB file is a
    real abuse vector). Do not put originals behind the public CDN path.
  - Generate a thumbnail and a poster frame for every video at ingest.
  - **Seed videos are transcoded OFFLINE** with local `ffmpeg`; upload the derivatives
    directly. Do not build the automated pipeline for the ~300 launch items — build it only
    for ongoing member uploads.
  - Transcoding a 4K master will exceed a standard Edge Function timeout. Use a
    longer-running worker. Do not use a per-minute-billed streaming
    service — it reintroduces unbounded usage billing.
  - **Amended 12 Aug 2026 — the worker handles ALL media, not just video.** This bullet
    originally said "for the video path only". That carve-out does not survive contact
    with the other two formats: audio normalization needs ffmpeg, which an Edge Function
    does not have, and a member may upload 200 MB, which will exhaust a Deno isolate
    before a WASM decoder finishes. Splitting by format would mean two codec toolchains
    to harden and a per-format size cap this file does not define. So the Edge Function
    orchestrates and the worker decodes — image, audio and video alike.
    The worker is a plain container with no host-specific SDK, so **which host runs it is
    a deployment choice, not an architectural one.** It must scale to zero: at ~300 items
    an always-on instance is the largest avoidable line on a grant-funded budget.
  - **Per-job wall-clock deadline** (set in M1, approved 20 Aug 2026): a single ingest job
    may occupy a worker for at most **240 minutes**, after which it starts no further
    ffmpeg invocation and is failed as the uploader's problem. It lives in
    `JOB_DEADLINE_MS` in `worker/src/pipeline.ts`; change it there and here together.
    This is a cost ceiling in the same family as the daily quotas — a wedged decoder on a
    scale-to-zero container bills for as long as it runs.
    It is NOT the per-invocation watchdog (`JOB_TIMEOUT_MS` in `worker/src/main.ts`, 25
    min). Both exist and neither substitutes for the other: the watchdog kills ONE hung
    ffmpeg, this refuses to start more work once the job as a whole has run too long. A
    video that makes six invocations, none of them hung and all of them slow, trips this
    and never trips the watchdog.
    Derived from a two-point measurement of the real ladder at 3840x2160 in CI
    (45 min extrapolated for §6's 20-minute master), then multiplied for a 2-vCPU
    container, for real footage against lavfi's testsrc, for the 4 GB transfer, and for
    safety. **The testsrc-to-real-footage factor is an ESTIMATE, not a measurement, and it
    is the dominant term.** It is marked as such at the constant and stays marked until a
    one-off probe against the deployed worker replaces it.
    Two things derive from this number and are deliberately **not written** until that
    probe lands: `public.reap_stale_ingests()`'s staleness threshold `c_ingest_lease`, and
    the `expect_by` field in `complete-upload`'s 202. The second is a client-facing
    contract, so it ships once at the real figure rather than being published and
    corrected.
- **Audio:** Opus/AAC mono 48–64 kbps.
- **XSS:** `textContent` only, or DOMPurify. Every `innerHTML` / `insertAdjacentHTML` /
  `outerHTML` on user content is a defect.
- **Bidi:** strip U+202A–202E and U+2066–2069 on ingest. Render user strings in `<bdi>`.
- **Cost ceiling, four layers:** media egress structurally $0 on R2; Supabase Spend Cap ON;
  per-user daily quotas enforced **in the database**; Cloudflare WAF rate limits + Turnstile
  on signup and submit. Budget alerts are a fifth layer and the least trustworthy.
  - **Daily quota figures** (this spec originally named none; set in M1, approved
    12 Aug 2026): **member 20 uploads / 1 GiB · moderator + admin 200 uploads / 40 GiB.**
    Sized off the per-file caps above — a member's day admits five 200 MB uploads, a
    moderator's admits ten 4 GB masters. They live in `public.upload_daily_limits()`;
    change them there and here together. This is a cost ceiling, not a fairness
    mechanism: raise it only against an actual R2 and Supabase bill.
  - **Publish counter floor** (set in M2, approved 19 Aug 2026): likes and comments
    republish the archive **at most once an hour**; content changes are never throttled.
    Every release rewrites every shard, so an unthrottled counter signal exceeds this
    ceiling on its own. It lives in `public.publish_pending()`; change it there and here
    together.
- CSP with no `unsafe-inline`, plus HSTS, via Cloudflare `_headers`.
- Lifecycle rule purging rejected/orphaned objects after 30 days.

If a task would put a capability-bearing secret anywhere client-visible, **STOP and ask.**

---

## 7. Privacy and contributor safety

This archive is politically sensitive. The **aggregate** is more dangerous than any single
item: one identity plus full contribution history plus precise coordinates plus timestamps
is a de-anonymization vector.

- **Identity:** `handle` is user-chosen and mandatory; avatar is mandatory but **defaults to
  a generated avatar**. Handle and avatar are always public. Everything else on a profile
  (bio, contributions, comments) is governed by `profiles.visibility` — owner sees all on
  their own profile; others see only what is marked public.
- **Emails are never published.** Not in profiles, not in snapshots, not in exports.
- **Public timestamps are day-precision.** Never expose exact submission times publicly.
- **Location fuzzing is default-on** for anything domestic. Publish `location_public`, never
  `location`. `location_precision: 'hidden'` publishes no coordinates at all.
- **Provenance and consent captured at upload**, including the right to withdraw and a
  per-item license. Ask "where did this come from" — a contributor granting a license they
  do not hold is how heritage archives acquire liability.
- **Amended 21 Aug 2026 — the precision a contribution lands with follows the SOURCE of the
  coordinate** (M4, `claim_upload_slot` in migration 0049): a place chosen from the
  gazetteer publishes `exact`, a dropped pin publishes `street`. Not symmetry — a gazetteer
  point is already public in `places.json`, so snapping it protects nobody while moving the
  item off the landmark it is a photograph of, whereas a pin is a coordinate nobody curated
  and most plausibly a home. Saying nothing still means `hidden`, so "fuzzing is default-on"
  is unchanged. **M5 still owns the contributor-facing precision control**; this is only
  what happens before anyone has said otherwise, and a moderator can change either.
- Do not store IPs, or truncate and expire them.
- Voice notes are the most identifying medium here — a voice is biometric. Treat voice
  contributions with the same care as faces.

---

## 8. Takedown

Takedown latency must **never** be bounded by the publish cycle.

On takedown: (1) delete/rename the object in R2 immediately, (2) purge the CDN path,
(3) add the ID to the short-TTL `redactions.json` that clients filter against, (4) write an
audit row. The next scheduled publish removes it from the shards as a formality — the bytes
are already gone.

- **Amended 21 Aug 2026 — step 1 includes the prerendered page.** `request_takedown`
  returns `media_assets` rows and knows nothing about §9's `item/{id}/index.html`, so until
  M3 a takedown deleted every derivative and the archival master and left the whole item
  legible — as HTML, at the exact URL people had been sharing. It is deleted first now,
  before the media, because it is the one object with a human audience: the derivatives are
  reachable only by someone who already has a direct URL. It is purged and counted like any
  other object, so a page that will not delete makes the takedown report `objects_remain`
  rather than success.

A named human owns the takedown path with a stated response time. This is a launch gate.

---

## 9. Front end

- **Vanilla JS.** No framework. Extend the existing patterns: `el()`/`mount()` DOM helpers,
  the `I18N` module (`t(key)`, `toggle()`, ar/en), the data/content store, the `UI` module.
- **History API routing** with real per-item URLs. The publish step emits
  `item/{id}/index.html` with full OG/Twitter tags and the content in HTML. A diaspora
  archive spreads on WhatsApp — a blank preview card is a growth failure, not a polish issue.
- **All content comes from the store**, never hardcoded in views. Page copy, cards, events,
  comments, and the info page all read from `content_blocks`/shards so the dashboard is the
  single source of truth.
- **Arabic-first RTL.** CSS logical properties only (`ms-`, `me-`, `ps-`, `pe-`,
  `inset-inline`) — never left/right. Every string through `I18N` with `ar` and `en` keys.
  `Intl.DateTimeFormat('ar-PS')`. One digit system, held consistently.
  **The decade slider must run right-to-left in Arabic.**
- **Mobile is a faithful echo of desktop**, not a reduced version.
- **The sign-in gate always preserves intent** — the pending action and its item survive the
  auth round-trip and the user returns exactly where they were.
- Reuse `tokens.css`. Never hardcode a color.
- **Amended 21 Aug 2026 (M4) — `/map` is the map, and the list under it is not a lesser
  view.** It is three things at once: §10's stated tile-failure fallback, the accessible
  equivalent of a canvas no screen reader can read, and what a visitor sees while tiles are
  still arriving. It is always rendered. The decade bar became the slider §9 asks for, and
  the **RTL slider direction is still M6's** — a range input follows the document's `dir`
  and nothing here overrides it either way.
  Three ways the map does not draw, and only two of them say so on the screen: an
  unreadable archive and a module that would not load are reported; a basemap that was
  never provisioned is not, because it has nothing to apologise for.

- **Amended 21 Aug 2026 — Leaflet and the public OSM tile endpoint are gone, and `/map` was
  a list until M4.** §2 forbids that endpoint outright and the CSP has blocked `unpkg`
  since M0, so the map rendered a blank panel on every deployment that actually served the
  policy. M3 removed both, deleted their two `known_violations` entries, and pointed
  `/map` at the `geo/{cell}.json` shards §2 already defines, filtered by decade — which is
  M4's own stated fallback ("tile-failure fallback to list view"). M4 adds the PMTiles
  basemap on top of it rather than replacing it, and the decade bar is the control M4's
  slider becomes. The RTL slider direction is still M6's.
- Performance budget: **< 150 KB brotli** for HTML + CSS + JS + first feed page. Arabic font
  subset with `unicode-range` split, WOFF2, `font-display: swap` — and **verify shaping after
  subsetting**.
- Accessibility: viewer needs focus trap, `aria-modal`, Escape, focus restore. Required
  description field on upload (frame it as archival metadata). Respect
  `prefers-reduced-motion`.
- **Added 21 Aug 2026 — a member can see what happened to their own upload.** Until M3
  there was no surface anywhere telling a contributor that the worker had refused their
  file: the item simply never appeared, which is indistinguishable from a moderator
  rejecting it in silence. `/me` now lists the member's own submissions from
  `posts_full()`, with the state derived from `status` and `ingest_state` together and the
  worker's own failure reason where there is one (0009 grants a member their own
  `ingest_error` for exactly this).
  It says which state, and deliberately says **nothing about when**. §6 holds `expect_by`
  until a one-off probe against the deployed worker replaces the estimated factor in
  `JOB_DEADLINE_MS`, and says that number ships once at the real figure rather than being
  published and corrected — so the screen was built without it and gains the line when the
  probe lands.

---

## 10. Milestones

Build in order. **Stop at the end of each and report what to run to verify.** Do not build
ahead.

| M | Contents | Exit criteria |
|---|---|---|
| M0 | Cloudflare Pages + CSP/HSTS; Supabase EU project; full schema + PostGIS + EDTF; RLS policies; **RLS denial matrix in CI**; gitleaks | Matrix green; no capability-bearing key reachable from the browser |
| M1 | Auth + Turnstile; `request-upload` + **role-aware caps** + quotas + signed URLs; processing (magic bytes, reject SVG, re-encode, EXIF strip, **video ladder 1440/1080/720/480 + poster**, audio normalize); approval trigger + content hash; audit log; moderation queue in `admin.js` | Full contribution lifecycle works; every unauthorized variant is refused; a 4K master survives intact in `originals/` while only renditions are CDN-reachable |
| M2 | Sharding; versioned releases + pointer flip + single-writer lock; debounced cron; `redactions.json` + takedown; publish-time counter baking | Two concurrent approvals → one consistent release; killed build never visible; takedown removes bytes in < 1 min |
| M3 | Front end consumes shards; History API + prerendered item pages with OG tags; `content_blocks` drive all copy; profiles + visibility; info page with deep-linked sections; XSS + bidi sweep | Item URL pastes into WhatsApp with a real preview; budget met; zero `innerHTML` on user content |
| M4 | PostGIS-backed geo; decade slider filtering; place-name autocomplete → gazetteer resolution → drag-to-confirm pin fallback; PMTiles basemap on R2; tile-failure fallback to list view | Map usable on a mid-range Android with the full seed archive; no external tile dependency |
| M5 | Location precision + fuzzing; consent/license/provenance capture; removal-request control; seed importer; export job (JSON + CSV, Dublin Core field names); backups + **one tested restore** | A restore succeeds from your own copy |
| M6 | Font subsetting; RTL pass incl. slider direction; monitoring (publish age, function errors, storage/egress, budget); Spend Cap ON; Lighthouse on throttled 3G / mid-tier Android | Performance budget met on a real regional-profile device; every alert fires in test |

---

## 11. Launch gates

The system may be **built** and **internally deployed** without these. It may not be
**public** until all five pass. These are not iterable post-launch — each fails silently and
harms someone other than the maintainer.

1. **RLS denial matrix passes** — every mutation run as anon, member, moderator; all
   denials asserted; green in CI.
2. **EXIF stripping verified** on a real photo carrying GPS data, end to end.
3. **One restore tested** from a backup you hold yourself.
4. **A named human on the takedown path** with a stated response time.
5. **Publish-age monitoring separates a held pipeline from an idle one** — an operator hold
   left set stops the archive as silently as a broken cron, so the alert must report
   `held_by_operator` distinctly from `unchanged` and fire on the first.

Plus: an independent penetration test is scheduled, executed, and its findings triaged.
**The public launch date is set after the pen test, not before.**

Everything else — features, polish, performance tuning — iterates after launch.

---

## 12. How to work

- Outline the plan and wait for confirmation before large changes.
- Smallest change that satisfies the task. Never build a later milestone early.
- After each change, state exactly what to run to verify locally.
- Write the RLS test alongside the policy, not after.
- When something here is ambiguous or blocks you, **ask**.
