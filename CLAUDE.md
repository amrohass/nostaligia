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
likes(user_id, post_id, created_at, UNIQUE(user_id, post_id))
saves(user_id, post_id, created_at, UNIQUE(user_id, post_id))
content_blocks(key, locale, draft, published, version, updated_by, updated_at)
reports(id, target_type, target_id, reason, reported_by, status, created_at)
moderation_actions(id, actor, action, target_type, target_id, note, created_at)
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
- Performance budget: **< 150 KB brotli** for HTML + CSS + JS + first feed page. Arabic font
  subset with `unicode-range` split, WOFF2, `font-display: swap` — and **verify shaping after
  subsetting**.
- Accessibility: viewer needs focus trap, `aria-modal`, Escape, focus restore. Required
  description field on upload (frame it as archival metadata). Respect
  `prefers-reduced-motion`.

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
**public** until all four pass. These are not iterable post-launch — each fails silently and
harms someone other than the maintainer.

1. **RLS denial matrix passes** — every mutation run as anon, member, moderator; all
   denials asserted; green in CI.
2. **EXIF stripping verified** on a real photo carrying GPS data, end to end.
3. **One restore tested** from a backup you hold yourself.
4. **A named human on the takedown path** with a stated response time.

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
