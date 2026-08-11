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
| **M0** | Pages + CSP/HSTS · Supabase EU · schema + PostGIS + EDTF · RLS · denial matrix in CI · gitleaks | **complete** — 8/8 items, exit criteria met, CSP/HSTS verified live |
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
| 1 | Full schema — 15 tables, PostGIS, EDTF, generated `decade`, media ladder, indexes | **applied, verified** |
| 2 | Edit-after-approval trigger, content hash, post audit trail | **applied**, tests pending |
| 3 | Role plumbing — `user_roles`, `authz_role()`, access-token hook, role audit trail | **applied**, tests pending |
| 4 | RLS policies + column privileges on every table, with structural tests | **applied, 26/26 green** |
| 4a | Location fuzzing derived in-database; jsonb key allowlists + size ceilings | **applied, verified** |
| 5 | Full denial matrix + `SECURITY DEFINER` per-function tests, wired into CI | **done, 162/162 green** |
| 6 | gitleaks in pre-commit and CI, with a rule self-test | **done, 16/16 green** |
| 7 | `_headers` — CSP without `unsafe-inline`, HSTS, one config module | **done, 14/14 green** |

All 23 migrations apply cleanly and deterministically on PostgreSQL 17.6 (Supabase local),
from scratch and incrementally onto a populated database. **All eight M0 items are built
and green in CI**, across three jobs: secrets, frontend, database.

**M0's exit criteria are met.** The denial matrix is green in CI — and the database job now
gates on the assertion *count*, derived by summing every `plan(N)`, because `supabase test
db` exits 0 when it runs nothing. No capability-bearing key is reachable from the browser.

### Hosting — resolved

The site is served by **Cloudflare Pages** at `nostaligia.pages.dev`, Git-connected to
`main`. Framework preset None, no build command, output directory **`site/`** — declared in
[wrangler.toml](wrangler.toml) rather than the dashboard, so the deployed tree is
config-as-code. Only `site/` is served; `supabase/`, `scripts/`, `config/` and the docs are
unreachable by construction. CLAUDE.md §2 forbids a build step and `_headers` must sit at the
output root, which is now `site/_headers`, where the generator writes it.

`_headers` is a Cloudflare Pages feature that **GitHub Pages ignores entirely**, so for a
while the CSP and HSTS in this repository were correct, tested, and applied to nothing. That
gap is not visible from the repository or from CI — only a response from the live origin
settles it, which is what
[scripts/verify-deployed-headers.mjs](scripts/verify-deployed-headers.mjs) exists to do:

```
node scripts/verify-deployed-headers.mjs https://nostaligia.pages.dev
```

It rebuilds the expected policy from `config/site.json` — not by parsing `_headers`, so a
hand-edited `_headers` is caught too — and compares every header against the live response.
The URL is an argument, never a constant: a `*.pages.dev` host is not an origin this project
commits to, and hardcoding it would be the same mistake as hardcoding it in the app.

| | GitHub Pages | Cloudflare Pages |
|---|---|---|
| CSP | **absent** | present, byte-identical to the generated policy |
| HSTS | `max-age=31556952` (GitHub's own) | `max-age=31536000; includeSubDomains; preload` |
| nosniff · XFO · Referrer · COOP · CORP · Permissions | all absent | all present, exact |
| verifier | **8 of 10 failed** | **12 of 12 passed** |

Still open before the old deployment can be retired: a real custom domain, DNS, replacing
`PLACEHOLDER_DOMAIN`/`PLACEHOLDER_CDN_DOMAIN` and regenerating, then retiring GitHub Pages —
which is **still live, still serving with no CSP, and still serving the repository root**.
`wrangler.toml` scopes the *Cloudflare* deployment to `site/`; GitHub Pages ignores that file
entirely, so `CLAUDE.md`, `supabase/` and `scripts/` stay public there until it is retired.
HSTS `preload` should be *submitted* last, once the final domain is
settled; serving the directive is harmless until then, but the list is painful to unwind.

### Headers and CSP

[config/site.json](config/site.json) is the single source for every origin, CSP value and
CORS value — CLAUDE.md §2 asks for exactly that, so pointing the project at a real domain
is a one-file change. Both consumers are **generated**, never hand-edited:

```
config/site.json
      └── node scripts/build-site-config.mjs ──┬── _headers            (Cloudflare Pages)
                                               └── assets/js/config.js (window.CONFIG)
```

CI runs the generator with `--check` and fails on any diff, so "one config module" is a
property of the repository rather than a note in a README. The generator also refuses to
emit a policy containing `'unsafe-inline'` or `'unsafe-eval'` — that assertion is what
survives someone loosening the config to get a page working.

**The one code change the CSP required.** `style-src 'self'` blocks the `style` attribute,
and it makes no difference whether markup or script wrote it — so `el()`'s
`setAttribute('style', …)` had to go. Property writes through CSSOM are not covered by the
policy, because CSP governs what the *document declares*, not what script computes. The
helper uses `setProperty()` rather than `node.style[prop] = v` because this codebase sets
custom properties (`toneStyle()` emits `--p1`/`--p2`) and camelCase assignment cannot reach
those.

**The external-origin ratchet.** The prototype still loads Leaflet from unpkg, tiles from
the public OSM endpoint, and fonts from Google. All four origins are blocked by this CSP,
and CLAUDE.md already forbids all four — §2 says *NEVER the public OSM tile endpoint*, §9
wants a self-hosted subset font. They are recorded in `known_violations` with the milestone
that removes each, and [scripts/frontend-csp-test.mjs](scripts/frontend-csp-test.mjs)
asserts the set found in the code is **exactly** the set declared: a new third-party origin
fails the build, and so does a stale entry, so the list cannot quietly describe the past.

Nothing breaks today, because `_headers` is inert on GitHub Pages. Everything breaks the
moment the site moves to Cloudflare Pages — deliberately. That is what makes M4 and M6
unable to ship without doing what CLAUDE.md already requires.

**What was deliberately not fixed.** The gazetteer map builds its pins with inline `style`
attributes inside a Leaflet `divIcon`, which this CSP blocks. It is left alone: that map is
already dead under this policy (Leaflet and its tiles are both blocked), M4 replaces it with
PMTiles on R2, and restyling it now would fix nothing while building M4 early. The
`innerHTML` usage across `public.js`/`admin.js` is untouched for the same reason — CSP does
not block it, and the XSS sweep is M3.

### Secret scanning

`gitleaks` runs in two places, and they are not equivalent.

| | pre-commit hook | CI job |
|---|---|---|
| scope | staged changes only | **full history, every ref** (`fetch-depth: 0`) |
| bypass | `git commit --no-verify` | none from a developer machine |
| standing | fast local signal | **the authority** |

Setup, once per clone — hooks are deliberately not installed by cloning:

```
pwsh -File scripts/install-gitleaks.ps1      # pinned 8.30.1 into .tools/ (git-ignored)
git config core.hooksPath .githooks
pwsh -File scripts/gitleaks-selftest.ps1     # 16 assertions
```

**Where the default rules were wrong for this project.** CLAUDE.md §6 draws a line
gitleaks does not: the anon key is public by design, the service-role key is the thing
that caused the billing incident. The stock `jwt` rule flags both identically. Left
alone, that becomes a false positive on the one file the maintainer edits weekly — and
an unresolved false positive in a pre-commit hook is how someone learns to type
`--no-verify`.

So [.gitleaks.toml](.gitleaks.toml) names the dangerous key as its own rule and carves
the public ones out of the broad rules they trip. A JWT payload is base64, so
`"role":"service_role"` is not searchable as text; its encoding depends on the claim's
byte offset, giving **three** stable forms. All six markers (three service-role, three
anon) are derived in the config's header comment and verified against generated tokens
at each alignment.

**Every carve-out has a paired control**, because a suppression that suppresses
everything reads exactly like a clean scan:

- the service-role assertions run with the carve-outs **active**, so a carve-out that
  widened would fail them;
- a control run with the carve-outs **stripped** proves the anon and publishable
  fixtures do fire — otherwise "no finding" and "never scanned" are the same output;
- an AWS key proves `[extend] useDefault` is still live.

Two things this cost, both worth recording:

- The first AWS control used `AKIAIOSFODNN7EXAMPLE`. Gitleaks' default allowlist
  ignores AWS's own documented example key, so the control silently tested nothing.
- The self-test's own fixtures were flagged by the scanner on first run — correctly.
  The fix is that every fixture value is now **assembled at runtime**, not written as a
  literal. A path allowlist for `scripts/` would have been easier and wrong: it would
  also swallow a real key pasted into a file nobody reads closely. Assertion 16 scans
  `scripts/` and `.githooks/` and requires zero findings **with no path allowlist**.

**The path guard is not a duplicate of the content scan.** `.gitignore` excludes
`.env*`, but `git add -f` overrides `.gitignore`, and a force-added `.env` holding
innocuous-looking values passes a content scan cleanly. Both the hook and CI check
paths against the single shared pattern file
[scripts/forbidden-paths.ere](scripts/forbidden-paths.ere) — one file, because two
hand-kept copies of a security regex drift, and drift is silent in the direction that
matters.

The hook **fails closed** when gitleaks is absent rather than skipping: a hook that
silently does nothing is worse than no hook, because it manufactures the belief that
scanning happened. It also distinguishes `--exit-code 2` (a secret was found) from any
other non-zero exit (gitleaks itself failed and nothing was scanned) — both block, but
they are not the same event and must not be reported as if they were.

### The test suite

`npx supabase test db` — 162 assertions, 8 files. CI runs it on every push
([.github/workflows/ci.yml](.github/workflows/ci.yml)) and gates on `pg_prove`'s TAP
parsing, never a psql exit code: **psql exits 0 even when a pgTAP assertion fails.**

| file | what it pins |
|---|---|
| `00_structure` | RLS on every table; no policy reads `role_cache`; anon holds no grant anywhere; `authenticated` has no table-level SELECT on posts; the four §7 columns unreadable; approval columns unwritable; exactly four policy-free tables; every definer function pins `search_path`; sensitive definer functions unreachable |
| `01_posts_rls` | the posts read matrix and write denials, per role |
| `02_location_and_shape` | fuzzing on INSERT *and* UPDATE incl. the `exact → hidden` downgrade; jsonb allowlists and byte ceilings |
| `03_schema_constraints` | every CHECK from both directions — EDTF, events, the media ladder, one-active-release |
| `04_definer_functions` | exact row sets per role for every callable definer function |
| `05_matrix` | 4 roles × 15 tables × 4 operations = **240 cells**, each `allow` / `empty` / `deny` |
| `06_attacks` | forged columns, escalation, handle forging, `originals/` leakage |
| `07_triggers` | edit-after-approval sweep, hash stability, audit permanence, role logs, service-role paths |

[supabase/harness_probe.sql](supabase/harness_probe.sql) is run by CI *before* the suite
and is not part of it — it contains a deliberate failure. It proves the harness can
distinguish pass from fail, and that `SET LOCAL ROLE` actually takes effect. Without that
second check every denial assertion would run as superuser and pass without testing
anything.

### Requirements carried into later milestones

Decisions taken during M0 that must be honoured elsewhere. Recorded here because the
reasoning is M0's and the implementation is not.

| # | Requirement | Milestone |
|---|---|---|
| R1 | **The moderation queue must visually flag any submission with `location_precision = 'exact'`**, so publishing a precise coordinate is reviewed as a decision rather than accepted as a default. The schema deliberately does *not* gate this — `exact` is legitimate for a public landmark — so the control is editorial, not structural. | M1 |
| R2 | The day-precision timestamp assertion in `stage0_incremental.ps1` covers the generated column only. Postgres already forces that case (`created_at::date` is STABLE and would be rejected at DDL time). The place a local-time bug can actually occur is the **publish-time** day-precision path, which has no such guard — re-point the assertion there. | M2/M3 |
| R3 | CI must gate on `pg_prove`'s TAP parsing, never on a psql exit code: psql exits 0 even when a pgTAP assertion fails. | M0 item 5 |

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

config/site.json           SINGLE source for every origin / CSP / CORS value
_headers                   GENERATED — Cloudflare Pages headers (inert on GitHub Pages)
assets/js/config.js        GENERATED — window.CONFIG

.gitleaks.toml             secret-scanning rules; header comment derives the base64 markers
.gitattributes             LF on hooks/sh/sql — a CRLF shebang fails on the Linux runner
.githooks/
  pre-commit               staged scan + forbidden-path guard; fails closed
scripts/
  install-gitleaks.ps1     pinned 8.30.1 + sha256 into .tools/ (git-ignored)
  gitleaks-selftest.ps1    16 assertions, every carve-out paired with a control
  forbidden-paths.ere      ONE copy of the path patterns, read by both hook and CI
  build-site-config.mjs    config/site.json -> _headers + config.js; --check gates CI
  frontend-csp-test.mjs    14 assertions: CSSOM styling + the external-origin ratchet
  verify-deployed-headers.mjs  fetches a live deployment; proves headers are SERVED
.github/workflows/ci.yml   three jobs: secrets · frontend (headers/CSP) · database

supabase/
  config.toml              CLI config + access-token hook (local stack only)
  migrations/              23 files, applied in filename order
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
    …091200_approval_trig  edit-after-approval, content hash, post audit
    …091300_roles          user_roles, authz_role(), JWT hook, role audit
    …091400_authorship     created_on generated columns, stamping triggers
    …091500_column_privs   revoke all, then re-grant per column — the §7 layer
    …091600_accessors      the definer functions the browser is allowed to call
    …091700_rls_identity   profiles, places
    …091800_rls_content    posts, media_assets, content_blocks
    …091900_rls_engagement comments, likes, saves
    …092000_rls_governance reports, moderation_actions, audit_log
    …092100_location_fuzz  location_public derived in-database, never client-supplied
    …092200_jsonb_shape    details/consent key allowlists and byte ceilings
    …092300_media_visible  can_read_post_media() — see "Two Postgres rules", below
  tests/                   8 files, 162 assertions, run by `npx supabase test db`
  harness_probe.sql        NOT in tests/ — contains a deliberate failure, by design
  stage0_incremental.ps1   proves 0014–0015 apply forward-only onto a populated database

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
- **`location_public` is derived, never written.** A trigger computes it from
  `location` + `location_precision` for *every* writer including the service role and the
  bulk importer, and the column is not in any grant. Fuzzing is **grid snapping**, not
  jitter: jitter re-rolled per write leaks the true point to anyone who can average
  several observations, while snapping destroys the information outright. `street` snaps
  to 0.001° (~100 m), `area` to 0.01° (~1 km), `hidden` publishes nothing. `exact`
  publishes the true point and must be chosen — the column default is `hidden`.
- **`details` and `consent` accept only allowlisted keys**, with size ceilings. `details`
  is readable by any signed-in user, so an unconstrained blob there would walk straight
  past every column privilege; adding a key now requires a migration, which forces the
  question "may a stranger read this?" to be asked in a diff.
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

### Two Postgres rules this schema was built around the hard way

Both were found by running the tests, not by reading the docs, and both produce failures
that look like success.

**An RLS policy referencing *another* table's columns is evaluated with the caller's
privileges on that table.** A policy referencing its *own* table's columns is exempt —
which is why `posts_select` reads `posts.created_by` happily even though no browser role
can SELECT it. `media_assets_select` cross-referenced `posts.created_by` and therefore
failed with `permission denied for table posts` for **every** role, including admin. Media
was unreadable by the whole site. The fix (`0023`) moves the check into a `SECURITY
DEFINER` helper. The failure mode is the dangerous kind: a denial matrix is written to see
denials, so a suite could record that cell as "correctly denied" while measuring a broken
policy.

**`BYPASSRLS` is not a grant.** `service_role` is exempt from row policies but holds no
table privilege of its own. This Supabase version's default privileges give new tables in
`public` only `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) — no DML — so after
`revoke all … from anon, authenticated` and explicit re-grants to `authenticated`,
`service_role` had **no read or write access to any of the fifteen tables**. Nothing in the
browser-facing suite would ever have noticed. It would have surfaced as M1's Edge Functions
failing, M2's publisher reading nothing, and M5's importer refusing to run. `0015` now
grants it explicitly.

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
