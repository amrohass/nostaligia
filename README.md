# ذاكرة رام الله · Ramallah Memory Atlas

A bilingual (Arabic-first, RTL) community heritage platform for Ramallah. Residents and
diaspora contribute and browse photographs, video, voice notes and events, pinned to place
and era on a map. Everything user-submitted is reviewed before it is public.

**[CLAUDE.md](CLAUDE.md) is the governing document.** It supersedes this file and every
earlier plan. Where the two disagree, CLAUDE.md wins and this file is out of date.

**Status:** pre-launch. Internal target 16 Aug 2026. The public launch date is *not* set —
it is gated on an independent penetration test (CLAUDE.md §11).

---

## Where the build is

Milestones run in order and nothing is built ahead. See CLAUDE.md §10 for the full table.

| M | Contents | State |
|---|---|---|
| **M0** | Pages + CSP/HSTS · Supabase EU · schema + PostGIS + EDTF · RLS · denial matrix in CI · gitleaks | **in progress** — items 0–3 of 7 done |
| M1 | Auth · `request-upload` · processing · approval lifecycle · moderation queue | not started |
| M2 | Sharding · versioned releases · single-writer lock · takedown | not started |
| M3 | Front end on shards · History API · prerendered item pages · XSS/bidi sweep | not started |
| M4 | PostGIS geo · decade slider · PMTiles basemap | not started |
| M5 | Fuzzing · consent/licence · seed importer · export · tested restore | not started |
| M6 | Font subsetting · RTL pass · monitoring · Lighthouse | not started |

### M0 progress

| # | Item | State |
|---|---|---|
| 0 | `.gitignore`, `.env*` excluded from commit #1 | done |
| 1 | Full schema — 12 tables, PostGIS, EDTF, generated `decade`, media ladder, indexes | done, **unapplied** |
| 2 | Edit-after-approval trigger, content hash, post audit trail | done, **unapplied** |
| 3 | Role plumbing — `user_roles`, `authz_role()`, access-token hook, role audit trail | done, **unapplied** |
| 4 | RLS policies + column privileges on every table, with structural tests | done, **unapplied, unrun** |
| 5 | RLS denial matrix (pgTAP) wired into CI | not started |
| 6 | gitleaks in pre-commit and CI | not started |
| 7 | Cloudflare Pages `_headers` — CSP without `unsafe-inline`, HSTS | not started |

**Unapplied** means the SQL is written and reviewed but has not been run against any
database. **Unrun** means the same for the test suite. See
[Applying migrations](#applying-migrations).

**M0 exits when** the denial matrix is green in CI and no capability-bearing key is
reachable from the browser.

---

## Architecture

Locked in CLAUDE.md §2. Summarised here so the repo explains itself.

| Layer | Choice |
|---|---|
| Hosting | Cloudflare Pages |
| Media | Cloudflare R2 — `quarantine/` (private), `originals/` (restricted), `public/` (CDN) |
| Database | Supabase Postgres, EU / Frankfurt |
| Auth | Supabase Auth, email + password only |
| Geo | PostGIS `geography(Point,4326)` + GiST. Geohash is a derived publish-time shard key only |
| Basemap | PMTiles (Palestine extract) on R2 — never the public OSM tile endpoint |
| Front end | Vanilla JS, no framework, no build step beyond the publish script |
| Routing | History API |
| Read path | Static sharded JSON on CDN. **Zero database reads for public visitors** |

Public visitors never touch Postgres. They read `manifest.json` → a versioned release →
`feed/`, `geo/`, `decade/`, `item/` shards, all immutable and long-cached. The database
serves contributors, moderators and the publisher.

The staging/testing repo is `amrohass/nostaligia`. The production domain is not yet
provisioned — every origin lives behind `PLACEHOLDER_DOMAIN` in one config module.

---

## Repository layout

```
CLAUDE.md                  governing document — read first
README.md                  this file

supabase/
  config.toml              CLI config + access-token hook (local stack only)
  migrations/              ordered, applied in filename order
    …090100_extensions     PostGIS into `extensions`
    …090200_helpers        touch_updated_at, visibility + handle validation
    …090300_enums          13 types
    …090400_profiles       profiles, reserved handles
    …090500_places         gazetteer
    …090600_posts          the single kind-discriminated content table
    …090700_media_assets   master / rendition / thumb / poster
    …090800_engagement     comments, likes, saves
    …090900_content_blocks editable site copy
    …091000_governance     reports, moderation_actions, audit_log, releases, upload_quota
    …091100_indexes        24 indexes, mostly partial
    …091200_approval       edit-after-approval, content hash, post audit
    …091300_roles          user_roles, authz_role(), JWT hook, role audit

index.html                 public shell
admin.html                 back-office shell
assets/css/tokens.css      palette, type, radii, shadows
assets/css/atlas.css       public components
assets/css/admin.css       back-office components
assets/js/i18n.js          AR/EN strings, numerals, direction
assets/js/data.js          seed content (pre-backend)
assets/js/store.js         content store — the seam a backend replaces
assets/js/ui.js            DOM helpers, icon set, toast, focus trap
assets/js/public.js        public app
assets/js/admin.js         back-office app
```

---

## The database

### Data model

One `posts` table with a `kind` enum (`media` · `voice` · `event`). Not split by type —
splitting turns every feed read into a UNION and gives you three moderation queues.

Dates are **EDTF-lite**: a range (`date_earliest`, `date_latest`) plus a `date_precision`,
because heritage photographs are "sometime in the 60s" and forcing a single date invents
information. `decade` is a generated column driving the slider.

Locations are doubled: `location` is the truth and is **never published**;
`location_public` is the fuzzed point the publisher writes into shards.
`location_precision = 'hidden'` publishes no coordinates at all.

Media splits preservation from delivery. One post has one master in `originals/`
(4K accepted, never CDN-fronted) and N renditions in `public/` (1440p / 1080p / 720p /
480p) plus a thumb and a poster.

### Rules enforced by the database, not by application code

The browser is hostile and an Edge Function can be bypassed by a leaked key. These are
refused by Postgres itself:

- **An approved post carries its approver, approval time and content hash.** Not a
  nullable convention — a CHECK constraint.
- **An approved post carries a licence and provenance.** A contributor granting a licence
  they do not hold is how heritage archives acquire liability.
- **`role = 'master'` if and only if `bucket = 'originals'`.** A master cannot be written
  into the public bucket, or a rendition into originals, by any caller.
- **SVG is refused** at the column, behind the magic-byte check at ingest.
- **`audit_log` is append-only.** UPDATE, DELETE and TRUNCATE are refused by trigger for
  every role including `service_role` and the table owner.
- **Two releases cannot both be active** — a partial unique index makes it
  unrepresentable, which is the database half of the publisher's single-writer lock.
- **Editing approved content returns it to the queue** — see below.
- **`profiles.role_cache` cannot be written from a browser**, by column privilege rather
  than by policy, so the rule binds moderators and admins too.

### Approval and the content hash

`post_content_hash()` is the single definition of what "content" means. The
edit-after-approval trigger, the hash stamped at approval and the publisher's M2 check all
read that one definition, so they cannot drift apart.

- Editing an approved post resets it to `pending` and erases the approval record.
- A moderator therefore **cannot edit and re-approve in one statement** — re-approval is a
  separate act, because whoever approves must have seen the final text.
- Media is inside the hash but does *not* reset status: swapping the image behind an
  approved post makes the publisher refuse it, while backfilling a 480p rendition months
  later does not un-approve the item.

### Column privileges — why RLS alone is not enough

**RLS is row-level. §7's threat model is columnar.** If a caller can read a row, RLS hands
them every column of it, so

```sql
select location, created_by, created_at from posts where status = 'approved';
```

returns precise coordinates, the author→post mapping and exact submission times in one
request. §7 names that exact aggregate — identity plus contribution history plus
coordinates plus timestamps — as the de-anonymization vector. The shard design hides it
from the website; PostgREST does not care about the website, and §5 says to assume the
attacker holds the anon key and a free account.

The model, applied uniformly in `…091500_column_privileges.sql`:

| role | SELECT |
|---|---|
| `anon` | **nothing, on any table.** §2 already says public visitors cause zero database reads, so the grant was never load-bearing. Removing it closes the class instead of patching column by column — a column added in M4 cannot leak by being forgotten. |
| `authenticated` | only what is safe for a signed-in **stranger**, because `moderator` and `admin` are not database roles and a column grant binds every signed-in user identically. |
| narrower | owner-only fields, moderator views and visibility-gated fields go through `SECURITY DEFINER` accessors. |

Withheld from `posts`: `location` (§7 publish `location_public`, never `location`),
`created_by` (the author→post mapping, readable even when a member marks contributions
private), `created_at` (exact submission times — `created_on` carries the day, which is
all §7 allows), `consent` (can name people who are not users of this site), plus
`approved_by`, `content_hash` and `updated_at`.

Write privileges follow the same rule: a column that must not be forgeable is **not
granted**, and a trigger sets it. `created_by`, `author_label`, `approved_by`,
`approved_at` and `content_hash` are unwritable from a browser by every role — a member
cannot badge their own post as coming from the archive team, and a moderator cannot forge
who approved what.

Accessors: `posts_full()` (own posts, or everything for a moderator),
`profile_view(handle)` (visibility-aware, returns `member_since` as a year),
`content_blocks_draft()` (admin only), `post_like_count(id)` (counts without exposing who
liked what).

### The read matrix for posts

| viewer | approved, live | own pending | others' pending | own rejected / withdrawn | others' rejected / withdrawn |
|---|:--:|:--:|:--:|:--:|:--:|
| anon | — (no grant) | — | — | — | — |
| member | ✓ | ✓ | — | ✓ | — |
| moderator / admin | ✓ | ✓ | ✓ | ✓ | ✓ |

Two cells are deliberate decisions rather than consequences. **Authors see their own
pending work** — you cannot ask someone to wait for review and then hide what they
submitted. **Moderators get a blanket read on everything pending**, because §4 grants
approve/reject and that is unimplementable without it; what makes it accountable is that
every moderator action is audited, not that the read is narrow. Withdrawn content stays
visible to moderators for the same reason: a withdrawal is a request a human has to
service.

### Roles

Three roles: `member`, `moderator`, `admin` (CLAUDE.md §4).

| | source of truth | read by |
|---|---|---|
| `public.user_roles` | yes | nothing directly — no browser grant, no policy |
| `public.authz_role()` | derived | **RLS policies** |
| `app_metadata.user_role` in the JWT | derived | Edge Functions, admin-UI affordances |
| `profiles.role_cache` | no | display only |

RLS reads the table rather than the JWT claim deliberately. A JWT is a snapshot: revoke
someone's moderator role and their existing token still says `moderator` until it
refreshes. The table costs one indexed lookup and has no such window. The claim still
exists because Edge Functions run before any RLS evaluation and `request-upload` needs
role-aware caps from it.

Every write to `user_roles` — grant, change, revoke, even re-affirmation — writes to both
`audit_log` and `moderation_actions` by trigger. On the table, not in the calling code, so
an Edge Function, a psql session and a future admin screen all leave identical evidence.

---

## Working on this

### Applying migrations

The Supabase CLI runs from npx; Docker is **not** needed to push to a remote project.

```powershell
npx supabase link --project-ref pjqvtmhizbnimqyxjbyq
npx supabase db push
```

`link` asks for the database password. It goes to the CLI, never into a file — `.env*` is
git-ignored either way, and no capability-bearing credential belongs in this repo.

Docker **is** needed for the local stack and the pgTAP suite (item 5):

```powershell
npx supabase start        # local Postgres + Auth
npx supabase test db      # the RLS denial matrix
npx supabase stop
```

### After the first push

The access-token hook must be enabled by hand until `supabase config push` is safe (M1):

> Dashboard → Authentication → Hooks → Customize Access Token (JWT) Claims → Postgres →
> `public.custom_access_token_hook`

Nothing in M0's authorization depends on it — policies read `authz_role()`, which goes to
the table. Leaving the hook off degrades M1, never M0.

### Serving the front end

Static, no build step:

```powershell
npx serve .
```

### Conventions

- **Never build a later milestone early.** Stop at the end of each and report what to run.
- **Write the RLS test alongside the policy**, not after.
- **Smallest change that satisfies the task.** Ask rather than guess.
- Every origin, domain and CSP value lives in one config module so the production domain
  is a one-file change later.

---

## The front end

Vanilla JS, three globals loaded in order: `I18N` → `DATA` → `Store` → `UI` → app. Two
shells rather than 23 pages — the design's screens are the same chrome with different
content.

`assets/js/store.js` is the seam. It copies `data.js` on first run, keeps the working set
in `localStorage`, and hands every view the same records the dashboard edits. Attaching
the real backend means reimplementing that API and nothing else; no view touches `DATA` or
`localStorage` directly.

### Bilingual

Arabic and English are **one screen set, not two builds**. The language sets
`<html lang/dir>`, every string comes from `i18n.js`, and layout uses CSS logical
properties (`inset-inline-start`, `border-inline-end`, …) so the LTR mirror falls out of
the same rules. Arabic is the default.

- Toggle with `EN` / `ع`, or link directly with `?lang=en`. The choice persists.
- Arabic renders Arabic-Indic numerals with the `٬` thousands separator. `I18N.year()`
  exists because years are labels, not quantities, and must never be grouped
  (`٢٠٢٤`, not `٢٬٠٢٤`).
- Every title carries a gloss in the other language, running in its own direction but
  flush with the page's reading edge — the `.gloss-line` class.

### Known departures from CLAUDE.md

The front end predates the governing document. These are **expected** and are scheduled;
they are listed so nobody mistakes them for the intended design.

| What | Where | CLAUDE.md | Fixed in |
|---|---|---|---|
| Hash routing (`#/archive`, `#/m/<id>`) | `public.js`, `admin.js` | §2 History API, real per-item URLs | M3 |
| Public OSM tile endpoint | `public.js`, `admin.js` | §2 PMTiles on R2, never OSM | M4 |
| Leaflet + Google Fonts from CDNs | both shells | §9 self-hosted subset fonts | M6 |
| Google / Apple sign-in buttons | `public.js` | §2 email + password only | M1 |
| `html:` prop → `innerHTML` on records | `ui.js` and 3 admin call sites | §6 every one is a defect | M3 |
| Inline `style` attributes (48 sites) | `ui.js` `el()` | §6 CSP without `unsafe-inline` | M0 item 7 |
| Role vocabulary (contributor/editor/partner/narrator) | `data.js`, `i18n.js` | §4 exactly three roles | M3 |
| No `handle`; "Full name" field | `store.js`, `i18n.js` | §3 handle is mandatory, not a legal name | M1 |
| Member emails in seed and admin UI | `data.js`, `admin.js` | §7 emails are never published | M1 |
| Client-authoritative unmoderated writes | `store.js` | §5 unapproved content unreadable at the policy level | M3 |

### Accepted, not scheduled

**A moderator may approve their own submission.** §4 grants "publish own content labeled
*moderator*" explicitly, so this is a separation-of-duties gap the project accepts
deliberately — a solo maintainer with a small team cannot require a second pair of eyes on
everything. A gap that cannot be closed is instead made queryable: approval by the author
writes `post.status.approved.self` rather than `post.status.approved`, so

```sql
select * from public.audit_log where action = 'post.status.approved.self';
```

is the review query. This is an acceptance, not an oversight, and not something a later
milestone removes.

Two smaller notes: `i18n.js` labels `decade.2010` as `العشرينيات` ("the twenties"), which
is the 2020s; and the whole front end carries a single `decade` integer where the schema
carries an EDTF-lite range.

### Notes on the original design doc

- **No photographs.** Every media well uses the hatched-gradient placeholder with a
  monospace caption — the honest reading, since the archive has no digitised material yet.
- **Mobile masthead is terracotta.** The doc sets the wordmark on it to olive, which lands
  at roughly 1.6:1; it is set in cream here instead. That is the one knowing departure
  from the drawing.
- **Numerals.** The doc mixes Arabic-Indic and Latin digits in Arabic screens. This build
  settles on Arabic-Indic throughout, except where the token is inherently Latin-script:
  the SLA chip, month abbreviations, coordinates and email addresses.
- Turn 1 of the doc was superseded by turn 2, which is marked FINAL, so only turn 2 is
  built.

---

## Launch gates

The system may be built and internally deployed without these. It may not be **public**
until all four pass (CLAUDE.md §11).

1. RLS denial matrix passes — every mutation as anon, member, moderator; all denials
   asserted; green in CI.
2. EXIF stripping verified on a real photograph carrying GPS data, end to end.
3. One restore tested from a backup held by the maintainer.
4. A named human on the takedown path, with a stated response time.

Plus an independent penetration test, scheduled, executed and its findings triaged. **The
public launch date is set after the pen test, not before.**
