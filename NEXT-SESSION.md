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

`node scripts/captcha-probe.mjs <a-harness-email> --semantics` is the probe, committed so it
can be re-run rather than rebuilt. It is written to be unmistakable: it signs in with a
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

## Amro has to decide two things before some of this moves

1. **Custom SMTP for Supabase Auth.** Signup is blocked *right now*, and the limiter is named
   rather than guessed: `429 over_email_send_rate_limit`, "email rate limit exceeded". The cap
   is **project-wide, not per-visitor** — with Supabase's built-in sender it is a couple of
   messages an hour across everybody — so a genuine new member is refused because somebody
   else signed up in the same hour. Needs an SMTP credential and a dashboard change.
   (Currently masked: the captcha above refuses every signup before the mailer is reached.)
2. **The gazetteer's Al-Manara row is about 600 m south of Al-Manara.** Found by verifying the
   new map labels against the extract, and it is content rather than code so it has not been
   touched. OpenStreetMap puts دوار المنارة at **31.90494, 35.20442** — two independent
   features in the extract agree to five decimals — and `places` says **31.8996, 35.2042**.
   `map.js`'s own default centre (31.9038, 35.2034) is 160 m from OSM's and 473 m from the
   row's. It matters beyond the label: §7's 21 Aug amendment publishes a gazetteer choice as
   `exact`, so an item pinned to Al-Manara is published 600 m from where it was taken. One
   `update public.places set location = …` when you say so.

**Closed since the audit:** GoTrue captcha is no longer off (see above — it is enabled, with a
secret that does not verify), and `moderation_actions` can now record a `content_blocks` edit
(0059).

Still gated, untouched: the `/item/*` route on the site origin, the service-role JWT for
`scripts/m1-deployed.ts`, GoTrue IP retention, backups + a tested restore, the seed importer.

**M5 has not started and is waiting on you, not on the code.** The seed importer needs your
~300 items; backups + one tested restore (§11 gate 3) needs three answers that have now been
asked for across three sessions — where the self-held copy lives (jurisdiction is a real input
for this archive, not a footnote), whether the cadence amendments stand (weekly full DB plus
*incremental* originals, and snapshots pinned forever at pre-launch and immediately after the
seed import, because a weekly cycle can lose the whole import), and the restore target (local
Docker or a scratch Supabase project — Docker has been wedged for five sessions, which makes
this less hypothetical than it sounds).

## Do these FIRST

1. `supabase migration list --linked`. Clean at the end of the evening session — **59**
   migrations, all paired — but it has been wrong twice before while CI was green.
2. **`node scripts/pgtap-deployed.mjs --tap`** — 37 files, 669 assertions, 3 known-red (see
   below). Takes `--only <file>` for one file. It runs the whole pgTAP
   suite against the **hosted** database, each file in its own rolled-back transaction,
   through `supabase db query --linked` (no password needed). This exists because Docker has
   been wedged for four sessions and CI builds a *fresh* database from the same files, so a
   green CI run says nothing about the database people actually use. It proved to
   discriminate before being trusted: it reports red both for a failing assertion and for a
   file that stops short of its own `plan()`.
3. `docker version` — still down (`dockerDesktopLinuxEngine` not found). Not needed for (2).
4. `node scripts/write-report.mjs --selftest` and `--check docs/*.md`, which CI now runs too.

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
| 3 · One tested restore | **not started.** M5, and gated on Amro's three decisions. |
| 4 · A named human on the takedown path | **still nobody.** The path itself is verified — 2.9 s end to end — but §11 asks for a *person* with a stated response time, and nothing in the repository names one. |
| 5 · Publish-age monitoring separating `held_by_operator` from `unchanged` | **not started.** M6. |
| Pen test | not scheduled. |

## Suggested next move

M5, or the two dashboard decisions above — which are worth doing first, because (1) is
currently stopping anyone from making an account at all.
