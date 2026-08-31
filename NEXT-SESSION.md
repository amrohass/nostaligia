Ramallah Memory Atlas — a full M0–M4 regression audit ran on 31 Aug 2026. Read CLAUDE.md
fully first; it governs this repo and overrides your defaults.

**The audit's own report is `docs/audit-2026-08-31.md`** and it is the detailed record — one
section per milestone, every finding labelled, and the measurements behind each. This file is
only the short version and what to do next.

## THE ONE THING TO FIX FIRST — auth is closed to everybody (31 Aug, evening)

**The Turnstile SECRET in the Supabase dashboard is not a secret the verifier recognises, so
no member can sign in, sign up or reset a password.** Captcha protection is now ON and
genuinely enforcing — that half worked, and it closes the hole the audit found — but the
verification never gets as far as judging a token:

    POST /auth/v1/token?grant_type=password   (a real account, its REAL password)
      no captcha token      → 400 captcha_failed  "(no captcha_token found)"
      invalid token         → 400 captcha_failed  "(invalid-input-secret)"
    POST /auth/v1/signup    → 400 captcha_failed  "(no captcha_token found)"
    POST /auth/v1/recover   → 400 captcha_failed  "(no captcha_token found)"

`invalid-input-secret` is Cloudflare's code for *the secret is not one we recognise*, and that
reading is measured rather than remembered — Turnstile's own siteverify, asked directly:

| what was sent | answer |
|---|---|
| a recognised (test) secret + a garbage token | `invalid-input-response` |
| a secret the verifier does not know + a garbage token | **`invalid-input-secret`** |

So a REAL token from a REAL person gets the same refusal. The most likely cause and the first
thing to check: **Supabase's captcha provider dropdown defaults to hCaptcha**, and a Turnstile
secret pasted under hCaptcha produces exactly this. Set the provider to Turnstile and re-paste
the secret from the same widget as the site key in `config/site.json`
(`0x4AAAAAAENYWuxg_BTOj47Q`).

**RE-RUN 1 Sep 2026 and the answer is unchanged.** `POST /auth/v1/token?grant_type=password`
with a REAL account and its REAL password, an invalid captcha token: `400 captcha_failed
(invalid-input-secret)`, no session issued. Signup and the wrong-password control answer the
same. The good news that comes with it: **an invalid token is genuinely REFUSED, not silently
accepted** — the hole the audit found is closed. The bad news is the one below: the secret is
still not one the verifier recognises, so a real token from a real person gets the same 400.
Nothing in the dashboard was touched from here; this is Amro's to fix.

`node scripts/captcha-probe.mjs <a-harness-email> --semantics` is the probe, committed so it
can be re-run rather than rebuilt. A working harness email is
`e2e-member-f7108f78-86d3-4162-b4e9-0c3256ec1898@mail.example.com` (it is in
`scripts/m1-gates-deployed.mjs`). It is written to be unmistakable: it signs in with a
CORRECT password, so **a success is the failure** — a session issued with a garbage token
means the token is not being checked — and `--semantics` asks siteverify for the table above
rather than quoting it. Exit 1 on anything but the state you want, which is `captcha_failed`
naming `invalid-input-response`.

**Meanwhile every deployed probe that SIGNS IN is dead**: `scripts/e2e-deployed.ts`,
`scripts/m1-gates-deployed.mjs`'s authenticated arms, and any browser probe that signs in all
go through this same password grant. `scripts/pgtap-deployed.mjs` is unaffected — it goes
through `supabase db query --linked`, not GoTrue — and so is anything signed-out, which is why
the map work below could still be verified in a real browser. **Check this before assuming a
harness failure is the harness.**

**The upload path cannot be assessed from outside and is a separate secret.**
`request-upload` reads its own `TURNSTILE_SECRET_KEY` from the Edge Function env and collapses
the verifier's answer to a boolean, so a bad secret and a bad token both surface as
`turnstile_failed`. If the dashboard secret was wrong because the wrong value was to hand,
check that one too.

## Amro has to decide one thing before some of this moves

1. **Custom SMTP for Supabase Auth.** Signup is blocked *right now*, and the limiter is named
   rather than guessed: `429 over_email_send_rate_limit`, "email rate limit exceeded". The cap
   is **project-wide, not per-visitor** — with Supabase's built-in sender it is a couple of
   messages an hour across everybody — so a genuine new member is refused because somebody
   else signed up in the same hour. Needs an SMTP credential and a dashboard change.
   (Currently masked: the captcha above refuses every signup before the mailer is reached.)
**Closed since the audit:** GoTrue captcha is no longer off (see above — it is enabled, with a
secret that does not verify); `moderation_actions` can now record a `content_blocks` edit
(0059); the map draws the extract's own Arabic names; and **two of the three gazetteer
coordinates were wrong and were corrected** — المنارة was 594 m out and رام الله التحتا was
5,756 m out, both fixed against the extract's own features and re-audited to 1 m and 0 m.
البلدة القديمة was left alone: the extract has no counterpart for it. `node
scripts/gazetteer-audit.mjs` re-runs the check whenever a place is added.

Still gated, untouched: the `/item/*` route on the site origin, the service-role JWT for
`scripts/m1-deployed.ts`, GoTrue IP retention, the seed importer.

**M5's backups are BUILT AND PROVED** (1 Sep, `scripts/backup.ts` + `scripts/restore-verify.ts`)
against the three answers: a second R2 bucket under a **different Cloudflare account**, weekly
full DB with **incremental** originals plus permanent pins at pre-launch and post-seed-import,
and a scratch Supabase project as the restore target. **§11 gate 3 is discharged** — see below.
What is still missing is provisioning rather than code: the second account's R2 credentials in
`supabase/functions/.backup.vars`, and a scratch project. Until those exist, `--to-dir` writes
the self-held copy to a disk and `--into-container` restores it into local Docker, which is
what the gate was proved with. The seed importer still needs your ~300 items — `fottage/` holds
**22 files** (5 videos, 17 photos), not ~300.

## CORRECTED — `supabase db dump` DOES emit triggers, and the restore is what proved it

The 31 Aug / 1 Sep entry here said "`supabase db dump` DOES NOT EMIT TRIGGERS", on a count of
46 in the catalogue and the string `CREATE TRIGGER` appearing zero times in the 206 KB schema
dump. **The count was right and the conclusion was wrong.** pg_dump emits every one of the 46
— as `CREATE OR REPLACE TRIGGER`, fully schema-qualified. `CREATE TRIGGER` is genuinely absent
because that is not the spelling it uses. The measurement looked for one literal string and
read its absence as the absence of the thing.

It was found the only way it could be: **by running a restore.** The trigger dump loaded after
the schema dump and collided on its first statement — `trigger "audit_log_no_truncate" for
relation "audit_log" already exists`. Nothing short of an actual restore would have said so,
which is the argument for §11 gate 3 in one line.

Kept, because a reconstruction from `pg_get_triggerdef()` is the copy that still holds if a
future CLI stops emitting them, and it costs 7 KB. What changed: it is now insurance rather
than the load-bearing part, `restore-verify.ts` rewrites it to `CREATE OR REPLACE TRIGGER` so
it loads beside the schema's own copy as a no-op, and `backup.ts`'s completeness pattern
counts **both spellings** — the old one could not see the form pg_dump actually writes.

### What the restore found that was really missing

Two gaps, both real, both fixed, and neither visible without running the restore:

**1 · the `auth.users` trigger was in no dump at all.** `users_provision_profile` (0057) is
§7's "every account gets a profile". The schema dump excludes the `auth` schema, and the
trigger dump filtered `nspname = 'public'` — so it was in neither file. A restore came back
with every account, every profile row, and no way for the *next* account to get one.
`35_provision_profile` went **9 of 12 red** against the restored database and named it. The
trigger dump now covers `public` and `auth`; the other non-internal triggers on a Supabase
database live in `cron`, `realtime` and `storage`, belong to the platform, and are left alone.

**2 · three functions came back with EXECUTE granted to PUBLIC.** `supabase db dump` emits
REVOKE/GRANT for 74 of the 77 functions in `public`. The three it omits are exactly the three
whose signature names a type in the `extensions` schema — `fuzz_location`,
`justified_precision`, `place_public`, all taking an `extensions.geography`. Their CREATE
statements are dumped in full; only their privileges are dropped. A function with no ACL
statement comes back with PostgreSQL's default, which is EXECUTE **to PUBLIC** — so a restored
database handed `anon` three functions the migrations had revoked. `16_function_grants` is the
test that said so. `backup.ts` now takes a **sixth dump**, `function_acl.sql`, reconstructing
every function's EXECUTE grants from `pg_proc.proacl`, and refuses to store a backup if any
grant carries `WITH GRANT OPTION`, which that reconstruction cannot reproduce.

A third thing was wrong in the verifier rather than the backup: its append-only check used
`update … limit 1`, which is not PostgreSQL — a syntax error dressed as an assertion, so §3's
permanent record would have read broken against a perfect restore. And its PostGIS check
called `fuzz_location(location)`; the function takes the precision too.

## §11 GATE 3 IS DISCHARGED — 1 Sep 2026

A backup taken from the deployed database, held outside the platform, restored into an empty
database, and graded by the project's own suite.

```
deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
  scripts/backup.ts --to-dir <a path outside the repo>          # BACKUP_PASSPHRASE required
deno run --allow-run --allow-env --allow-read --allow-write scripts/restore-verify.ts \
  --backup <dir>/db/<stamp> --originals <dir>/originals \
  --into-container supabase_db_pjqvtmhizbnimqyxjbyq
```

Result: 6 dumps decrypted and sha256-matched against the manifest; target wiped to 0 tables /
0 triggers / 0 auth users and asserted empty first; all 7 invariant checks green; all 5
`media_assets` originals rows resolving against the backup's own copy at the right size; and
**37 files, 669 assertions, 1 red — the one that must be red.**

Three things about that run are the reason it means anything:

- **the target is wiped and the wipe is asserted** before anything is graded. Without it every
  check below passes against the database migrations built, which is the failure mode this
  repository keeps finding in its own tests.
- **`supabase_migrations` is dropped and nothing in the backup puts it back**, so its absence
  at the END is the proof the suite ran against the restored database rather than one that
  `supabase start` rebuilt underneath. Checked last, after the suite.
- **the verdict is not the runner's exit code.** `20_publish_cron` 14 ("before the first
  release, a publish is always due") MUST be red: the restored archive has releases, because
  the backup restored them. It is in a `KNOWN_RED` list checked in both directions — a red
  outside the list fails, and an entry that comes back green fails too, because green there
  means the releases were lost. 23 and 24 are deliberately *not* in the list: they need
  `vault.secrets`, the backup does not carry live credentials, so a restore passes them as a
  fresh database does.

### Two things that path does NOT prove, and are not pretended

The target is a local Postgres container, not the scratch Supabase project of the 31 Aug
decision. So this does not exercise GoTrue serving the restored `auth` rows, nor a hosted
project's extension set coming up the same way. Both are about the platform around the
database rather than about the backup. A container was chosen because `docker exec` **cannot
reach a hosted project** — the target is safe by construction rather than by a refusal that
has to stay correct — and because relinking the CLI to a scratch project means unlinking
production on the one machine that operates production. `--target <ref>` is still there,
still refusing the production ref by name, for the day the scratch project exists.

The copy proved here was written with `--to-dir`, a **local encrypted directory**. That is a
weaker backup than the second Cloudflare account and the manifest records which kind it was,
so a restore can never mistake one for the other. The second account is still the standing
decision and still unprovisioned; nothing about `--to-dir` softens the different-account
refusal, which still applies to every R2 run.


## Do these FIRST

1. `supabase migration list --linked`. Clean at the end of the evening session — **59**
   migrations, all paired — but it has been wrong twice before while CI was green.
2. **`node scripts/pgtap-deployed.mjs --tap`** — 37 files, 669 assertions, 3 known-red (see
   below). Takes `--only <file>` for one file. It runs the whole pgTAP
   suite against the **hosted** database, each file in its own rolled-back transaction,
   through `supabase db query --linked` (no password needed). It exists because CI builds a
   *fresh* database from the same files, so a green CI run says nothing about the database
   people actually use — which is still true now that the local stack works again. It proved to
   discriminate before being trusted: it reports red both for a failing assertion and for a
   file that stops short of its own `plan()`.
3. **Docker is UP again** (server 29.7.2, 1 Sep, after six sessions down) and the LOCAL suite
   runs: **37 files, 669 tests, Result: PASS, 16 wallclock seconds.** Three things learned
   getting there, each of which cost a cycle:
   - it takes MINUTES to launch. Do not conclude it is wedged from one short wait.
   - never call bare `docker version` inside a compound command while the daemon is down —
     the CLI blocks on the named pipe and takes the whole command with it.
   - **`supabase db reset` killed the db container** (`LegacyDbSetupError` at "Initialising
     schema"), and `stop --no-backup` then LEFT THE VOLUME, so the next `start` collided on
     `schema_migrations_pkey`. What works: `stop --no-backup`, `docker volume rm` the
     `supabase_db_*` volume, then `start` — which applies all 59 migrations to a genuinely
     fresh database — then `supabase test db`.
   - **UPDATED 1 Sep: a plain `supabase start` now FAILS and takes the whole stack down with
     it.** It applies all 59 migrations, then times out on `storage-api` and `studio` health
     checks (`LegacyHealthCheckTimeoutError`) and rolls back every container and the volume —
     so a perfectly good database is destroyed by two services this work never touches. What
     works, and is what the restore was run against:

         supabase start -x storage-api,imgproxy,studio,logflare,vector,edge-runtime,realtime,supavisor,mailpit

     Same 59 migrations, same 669 green assertions, and it comes up in about a minute. On this
     run `stop --no-backup` DID remove the volume, so the `docker volume rm` step above is
     belt-and-braces rather than always required — check `docker volume ls` instead of
     assuming either way.

   **Worth knowing:** the 3 assertions that are deliberately red against the DEPLOYED database
   (`20_publish_cron` 14, 23, 24) are GREEN on a fresh one. That is the classification
   confirming itself — they describe a database that has never published and has no Vault
   entries, which is exactly what a fresh local database is. **A RESTORED database sits between
   the two:** 14 is red (it has releases, because they were restored) and 23/24 are green (the
   backup deliberately carries no Vault secrets). `restore-verify.ts` encodes exactly that and
   fails if 14 ever passes.
4. `node scripts/write-report.mjs --selftest` and `--check docs/*.md`, which CI now runs too.
5. **`node scripts/pgtap-deployed.mjs --local supabase_db_<ref>`** runs the same suite against a
   LOCAL container through `docker exec … psql`. Added 1 Sep for gate 3, because the restored
   database is reachable by neither `--linked` (that is the hosted project) nor `supabase test
   db` (which grades whatever the local stack currently holds). It implies `--tap`, so it names
   the failing assertion. Verified to discriminate: pointed at a container that does not exist
   it reports red, never green.

## What changed on 31 Aug, evening

| | |
|---|---|
| **The map has names** | It drew three labels, because `places.json` holds three rows. `mvt.js` said tile text is always "whatever the renderer baked in, usually Latin" — true of a RASTER extract, false of this one. The Palestine extract carries `name:ar` on **146 of 163 roads** in a central z14 tile, 125 of 126 POIs and every place. So the rule written to make the map Arabic-first was what kept it unnamed. The gazetteer still draws FIRST and wins every collision. Three silent bugs found on the way: the view stopped at the archive's maxZoom (15), where 992 px is four km and no street name fits — vector tiles OVERZOOM, so it goes three past, and `fit()` deliberately does not so the map never opens there; `lineAnchor` measured the longest SEGMENT, which on densely-noded OSM geometry is a few metres, so every street name failed the room test; and POI labels are landmark kinds only, because nine z15 tiles hold 1,600 named POIs whose big classes are restaurant, supermarket, cafe, pharmacy, bank. A default `name` in HEBREW script is never a fallback — a different name for the same point, not a translation. |
| **0059** | `moderation_actions.target_id` is nullable and `target_key text` carries a composite key — `content_block:page.about.title:ar`. §4's "moderation_actions AND audit_log" is finally true for a site-copy edit. **The test caught a bug in the migration itself:** it first claimed no grant was needed because 0010's grant is table-level — but 0015 revoked that and replaced it with a COLUMN LIST, so the new column was granted to nobody. Fourth instance of that bug in this schema. |
| **`scripts/write-report.mjs`** | The 31 Aug audit shipped as three concatenated copies of itself. Nothing in the repo wrote it, so this is a writer that exists: one truncating write, a loud refusal on a path that already has content, and a check that no `## ` heading appears twice — which is the half that would have caught the original, since the doubling happened inside the string before any write. CI runs `--selftest` and then `--check` over every `docs/*.md`. |

## What changed on 31 Aug

| | |
|---|---|
| **0057** | **Every account now gets a profile.** `public.profiles` was EMPTY while `auth.users` had 11 rows — no signup path had ever created one, in any milestone. Every byline read "A member", every profile shard was absent, `/u/{handle}` resolved to nothing. Trigger + backfill; placeholder handle `member_<12 hex>`; `avatar_path` stays NULL because null **is** the generated avatar. Verified live: every item now carries a real handle and all four contributor shards return 200. |
| **0058** | `profile_view` and `post_like_count` revoked from **anon**. Not drift — both were written down in `16_function_grants` — but M3 moved the public projection into a shard and these did not follow. Measured on the live API with only the public anon key: `profile_view` returned the **account UUID** and answered for accounts with **no public presence at all**, i.e. a membership oracle keyed by handle. |
| **Turnstile** | `TURNSTILE.mount().token()` had three ways to never settle: `error-callback` cleared state and walked away, `remove()` discarded waiters, and a widget that rendered and said nothing was unhandled. Upstream that is a sign-in or upload dialog stuck on "working" forever. Both failure callbacks now reject, `remove()` rejects, and `token()` has a 30 s ceiling. |
| **Auth copy** | `over_email_send_rate_limit` no longer shares a message with `over_request_rate_limit`. A first-time visitor was being told they had tried too often for a cooldown that was not theirs. |
| **Tests** | `05_matrix` gained the anti-vacuity control it never had (two empty sets are equal — an emptied `stmts` would have reported the database secure without probing one policy); its header said 256 cells and the real number is **288**. `08_upload_quota`'s "not from any claim" assertion ran with a token carrying **no claim at all**. |

## Traps this session hit, so you do not

- **`supabase db query --linked` cannot be run twice in parallel.** The CLI provisions a
  temporary login role per invocation and concurrent ones collide with
  `password authentication failed for user "cli_login_postgres"`.
- **Turnstile will not mint a token for automation.** Real headed Chromium at the live
  origin: `turnstile.render()` with the site's own key produced no iframe and called back
  neither success nor error for 45 seconds. So `request-upload`'s two ROLE caps
  (`over_size_cap`, `over_duration_cap`) are unreachable from a script — everything before
  the Turnstile gate is testable, everything after it is not.
- **The e2e harness accounts are still on the deployed project** and their password is a
  literal in `scripts/e2e-deployed.ts` (`e2e-deployed-harness-password-1`). Three members,
  three moderators, one admin. Signing in as one sends no mail and creates nothing — this is
  what made the adversarial M1/M2/M3 probes possible at all.
- **`now()` does not advance inside a transaction**, so `order by created_at desc limit 1`
  is nondeterministic between rows written in the same batch. It made a correct `before`/
  `after` audit row look like a §4 violation for ten minutes.
- **Never use `String.replace` with a string replacement to edit a document.** The
  replacement is scanned for `$$`, `$&`, `` $` `` and `$'`. `$$` turned `$$delete …$$` into
  `$delete …$` in a SQL file, and then `` $` `` — which expands to *everything before the
  match* — silently **tripled `docs/audit-2026-08-31.md`** when the replacement text happened
  to contain a `$` followed by a backtick. Use `split(anchor).join(replacement)`.
- **A mechanical rewrite over SQL must be quote-aware.** `05_matrix` stores probe statements
  as dollar-quoted text, so a naive match hit the denial matrix's own data.
- **A column-subset grant does not extend to a column added later, and nothing warns.** 0015
  replaced 0010's table-level `grant select on moderation_actions` with an explicit column
  list, so `relacl` holds only postgres and service_role and each column carries its own
  `authenticated=r`. `has_table_privilege` therefore says FALSE while `has_column_privilege`
  on an existing column says TRUE — and a column added in 0059 was granted to nobody. Check
  `pg_attribute.attacl`, not `relacl`, and add the grant in the same migration as the column.
- **A label rule above the map's own maxZoom is invisible, not deferred.** `view.maxZoom` is
  taken from the PMTiles header, so a rule written for z16 against a z15 archive never fires,
  with no error and nothing on the screen to suggest a threshold rather than a bug.
- **A restore is the only thing that tests a backup.** Both real gaps this session
  (`auth.users`'s trigger in no dump at all; three functions coming back with EXECUTE to
  PUBLIC) were invisible to every count, every completeness check and every green CI run, and
  both were named within seconds of running the project's own suite against the restored
  database. The corollary is the one that cost the time: **a completeness check that greps for
  a literal string is testing the string, not the thing.** `CREATE TRIGGER` vs
  `CREATE OR REPLACE TRIGGER` is the whole of the 31 Aug trigger finding.
- **`update … limit 1` is not PostgreSQL.** UPDATE takes no LIMIT. It parses as a syntax error
  at run time, which inside a `do $$ … exception when … $$` block looks exactly like the
  invariant under test misbehaving. Bound it with `where id in (select id from … limit 1)`.
- **A `throws_ok` with three arguments compares the MESSAGE, not the description.** The
  four-argument form is `throws_ok(sql, errcode, null, description)`; the three-argument one
  fails with "caught: 23514 …  wanted: 23514 <your description>", which reads like the
  constraint misbehaving when it is the assertion that is malformed. `07_triggers` has it
  right — copy from there.

## Known-red and deliberately so

`20_publish_cron` tests 14, 23 and 24 describe a database that has never published and has no
Vault entries. Staging has both, correctly. Documented at the assertion; making them pass
would mean deleting live `vault.secrets` rows inside a test transaction.

## Where the launch gates stand

| Gate | State |
|---|---|
| 1 · RLS denial matrix green | **passing — and now also against the deployed database**, which it never was: the file aborted on its first fixture there until this session. |
| 2 · EXIF verified on a real photo with GPS | **DISCHARGED.** Three deployed masters carry real Ramallah coordinates (31.899600, 35.204200); every derivative on the CDN is a bare `VP8 ` chunk with no EXIF, no XMP and no GPS tag name in its bytes. `scripts/exif-gate.ts` refuses to report a pass if no master had GPS to strip. |
| 3 · One tested restore | **DISCHARGED 1 Sep.** A backup taken from the deployed database, held on a disk outside the platform, restored into an emptied database, and graded by the project's own 669 assertions — see the section above for the run and for what it deliberately does not prove. |
| 4 · A named human on the takedown path | **still nobody.** The path itself is verified — 2.9 s end to end — but §11 asks for a *person* with a stated response time, and nothing in the repository names one. |
| 5 · Publish-age monitoring separating `held_by_operator` from `unchanged` | **not started.** M6. |
| Pen test | not scheduled. |

## Suggested next move

**Everything left in M5 is blocked on Amro, not on code.** In the order that unblocks the most:

1. **The Turnstile secret in the Supabase dashboard** (top of this file). Re-verified 1 Sep and
   still `invalid-input-secret`. Nobody can sign in, sign up or reset a password, and every
   deployed probe that authenticates is dead until it is fixed. Set the captcha PROVIDER to
   Turnstile — it defaults to hCaptcha — and re-paste the secret from the same widget as the
   site key in `config/site.json` (`0x4AAAAAAENYWuxg_BTOj47Q`).
2. **Custom SMTP**, so a genuine new member is not refused by a project-wide send cap.
3. **The ~300 seed items.** `fottage/` holds 22 files. The importer cannot be written against a
   shape nobody has seen, and guessing one is how a seed import gets done twice.
4. **The second Cloudflare account's R2 credentials**, into `supabase/functions/.backup.vars`.
   The backup path is proved end to end; what it writes to today is a local directory, which is
   a weaker copy than the decision calls for.

Two gates remain, and neither is code either: **gate 4** still names nobody on the takedown
path, and **gate 5** (publish-age monitoring separating `held_by_operator` from `unchanged`) is
M6. The pen test is not scheduled.
