Ramallah Memory Atlas — a five-bug pass landed on 30 Aug. Read CLAUDE.md fully first; it
governs this repo and overrides your defaults. §1 gained an amendment on 30 Aug that you
must read before touching comments.

**This file replaces the earlier 30 Aug handoff, whose "what is true" list was right about
almost everything and wrong about the one thing it named as a root cause.**

## The thing to unlearn from the last handoff

It said *"auto-publish on approval is still unwired — vault entries `rma_publish_url` and
`rma_publish_secret` are unset"*. **Both were set, on 28 Aug.** The dispatch was firing
correctly and the publisher was answering **401 unauthorized**, because the vault's copy of
the secret and the Edge Function's `PUBLISH_SECRET` were different strings. `pg_net` records
every dispatch in `net._http_response`, and two 401s were sitting there — which is where a
minute of looking would have found it, and where you should look first next time.

**The general lesson, which cost most of this session: NEXT-SESSION.md's stated causes are
hypotheses.** Two of five bugs had a different cause than the one written down, and one had
no cause at all because it was already fixed.

## Do these FIRST

1. `supabase migration list --linked`. On 30 Aug the hosted database was **three migrations
   behind** (0051 account_deletion, 0052 precision_control, 0053 removal_requests) while CI
   was green on all six jobs and the handoff described all three as shipped. **CI proves
   nothing about the hosted database** — it builds a fresh one from the same files. They are
   applied now; check again anyway.
2. `docker version`. Wedged all of 29–30 Aug. It now *errors* rather than hanging
   (`dockerDesktopLinuxEngine` not found) which is progress, but the daemon is not running
   and no pgTAP has run locally in three sessions. CI is the only executor.
3. `supabase db query --linked -f some.sql` **works and is the fastest tool here** — it goes
   through the Management API as `postgres`, needs no database password, and takes a file
   (multi-line SQL as an argument gets mangled). Every diagnosis below came from it. You can
   simulate PostgREST exactly:

       begin;
       set local role authenticated;
       set local request.jwt.claims = '{"sub":"<uuid>","role":"authenticated"}';
       <the statement>
       rollback;

   That reproduces an RLS or privilege refusal in about four seconds instead of a CI cycle.

## What the five bugs actually were

| # | Reported | Actual cause |
|---|---|---|
| 1 | auto-publish never fires | vault secret ≠ function `PUBLISH_SECRET`; 401 on every dispatch |
| 2 | uploads land no bytes | **not reproducible** — see below |
| 3 | admin text edits refused | `ON CONFLICT DO UPDATE` needs SELECT on a column 0015 withholds |
| 4 | comments need moderation | true, and the moderation screen never existed |
| 5 | map has no labels | `public.places` had zero rows; the renderer was fine |

**1 · The publish secret was rotated** (openssl, 64 hex) into all three places that must
agree: the hosted Edge Function env, `vault.secrets.rma_publish_secret`, and
`supabase/functions/.dev.vars`. CI's lifecycle job uses its own literal and is unaffected.
Verified: `select public.publish_tick('manual')` → `net._http_response` 200 → pointer flipped.
Auto-publish then fired unprompted twice more that session from ordinary content changes.

**2 · Uploading works and the report could not be reproduced.** The most recent upload
(30 Aug 14:58) went `post.create → ingest.processing → ingest.complete` in seven seconds,
put 1,833,101 bytes in `originals/` at exactly the declared size, two derivatives in
`public/` reachable over the CDN, and the master 404 through it. All three of the 29–30 Aug
causes were re-tested **through Chromium** and hold: the `request-upload` preflight passes
with `apikey`, the CSP does not block the R2 S3 host, and the quarantine bucket answers a
PUT preflight 204 with the right `Access-Control-Allow-*`.
**One trap worth keeping:** a browser `fetch` PUT at R2 *without a signature* fails with
"No 'Access-Control-Allow-Origin' header is present", which reads exactly like broken bucket
CORS. It is not — R2's **error** responses carry no CORS headers, so an unsigned probe always
looks like a CORS failure. Preflight the OPTIONS separately to tell them apart.
The only failure in the record is post `97ab9dc1` (29 Aug 15:18), `awaiting_bytes` with no
`ingest.processing` — a slot claimed and bytes never delivered, **dated before** the CORS and
CSP fixes. It will sit there forever because `reap_stale_ingests()` is one of the three things
§6 holds until the deployed-worker probe lands.
**What could not be tested:** a full signed upload from a browser. That needs a member
password and a real Turnstile token, and neither is available headlessly.

**3 · `INSERT … ON CONFLICT DO UPDATE SET draft = excluded.draft`** — which is what PostgREST
sends for `Prefer: resolution=merge-duplicates` — requires SELECT on `draft`, because
`EXCLUDED` is the target's rowtype. 0015 withholds exactly that column, so every Save and
every Publish on the copy screen failed `42501` **before RLS ran**, and had since M3. Do not
follow Postgres' own HINT: `content_blocks_select` is `using (true)`, so granting SELECT on
`draft` would hand every unpublished paragraph to every signed-in member. 0055 adds
`save_content_block()` instead, mirroring the read-side accessor. `34_content_block_save`
asserts the upsert stays refused and says why beside it.
**`posts` was fine** — an admin edit succeeds and §5's trigger resets `status` to `pending`
rather than refusing. There is also no post-text editor in `admin.js` to refuse it.

**4 · Comments now publish on insert** (0054), overriding §1 for comments only, recorded in
§1 and §3 in the same commit. **`pending` was not a queue, it was a hole:** no comments panel
was ever built in `admin.js`, so no comment written since M1 could ever become visible. Three
places said `pending` — the column default, 0014's authorship trigger and 0019's policy — and
**the trigger is the one that decides**. Changing only two produces a comment box that refuses
every comment, which is how it was caught.

**5 · The gazetteer was empty.** `places.json` was `{"items":[],"total":0}`, so the map drew
geometry and no text — by design, since §2 renders the basemap without its own label layers.
Three Ramallah entries were seeded through `save_place` and both locales verified in Chromium.
They are a floor, not a gazetteer; Dashboard → Places owns them.

## Found on the way, NOT fixed, and worth a decision

- **`public.profiles` is EMPTY while `auth.users` has 11 rows.** No signup path — client or
  trigger — has ever created a profile. So §7's "handle is user-chosen and mandatory, avatar
  mandatory" is unimplemented, every public byline renders as "A member", every
  `profile/{handle}.json` shard is absent, and `/u/{handle}` resolves to nothing. The
  `reserved_handles` table exists, so the design was there and the flow was not. This is real
  M3 work, not a bugfix, which is why it was left.
- **`moderation_actions` cannot record a `content_blocks` edit.** Its `target_id` is
  `uuid not null` and that table's key is `(key, locale)`. 0055 writes `audit_log` only
  (its `target_id` is nullable and `target_type` is text, by 0010's design) and says so.
  §4 asks for both tables. The fix is either a synthetic uuid that joins to nothing or
  relaxing the not-null — a governance change, so it is yours.
- The confirmation email's `redirect_to` is still `http://localhost:3000`.
- `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_PURGE_TOKEN` still unset, so §8's CDN purge is a no-op.
  Harmless on `r2.dev`; a real hole the day a cached custom domain goes in front.

## Still gated on Amro — do not touch

1. **`/item/*` route on the site origin.** M3's unmet exit criterion; needs the production host.
2. **The service-role JWT for `scripts/m1-deployed.ts`.** M1's exit criterion is unproven for
   the video path.
3. **GoTrue IP-log retention.** `auth.audit_log_entries` records IPs; §7 says do not store them.
4. **Backups + one tested restore** (§11 gate 3) — outlined, not built, waiting on three
   decisions: where the self-held copy lives, whether the cadence amendments stand, and
   whether the restore target is local Docker or a scratch project. `supabase db dump`
   excludes `auth`, `vault`, `cron`, `extensions` and `storage` by default — three dumps are
   needed, not one.
5. **Seed importer** — needs Amro's ~300 items. Nothing in the repo is seed data.

## Credentials — a standing note

The previous handoff recorded a Cloudflare API token and an admin-scoped R2 key pair sitting
in a 30 Aug transcript, unrotated by decision. Still true. Additionally, on 30 Aug a `grep`
for `PUBLISH_SECRET` printed the old `.dev.vars` value into a transcript; that secret was
rotated in the same session and the printed value is dead. **`.dev.vars` holds live secrets —
grep it for names, never for values** (`sed -E 's/=.*/=<redacted>/'`).
