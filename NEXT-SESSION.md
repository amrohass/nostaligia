Ramallah Memory Atlas — a full M0–M4 regression audit ran on 31 Aug 2026. Read CLAUDE.md
fully first; it governs this repo and overrides your defaults.

**The audit's own report is `docs/audit-2026-08-31.md`** and it is the detailed record — one
section per milestone, every finding labelled, and the measurements behind each. This file is
only the short version and what to do next.

## Amro has to decide three things before some of this moves

1. **Custom SMTP for Supabase Auth.** Signup is blocked *right now*, and the limiter is named
   rather than guessed: `429 over_email_send_rate_limit`, "email rate limit exceeded". The cap
   is **project-wide, not per-visitor** — with Supabase's built-in sender it is a couple of
   messages an hour across everybody — so a genuine new member is refused because somebody
   else signed up in the same hour. Needs an SMTP credential and a dashboard change.
2. **GoTrue captcha is OFF.** A password grant with no captcha token, and one with a
   deliberately invalid token, both return `400 invalid_credentials` — the token is accepted
   and ignored. §6's "Turnstile on signup" is client-side only, which §5 says is not a guard.
   Needs the Turnstile **secret** in the dashboard. (The upload path is fine: `request-upload`
   verifies Turnstile server-side.)
3. **`moderation_actions` still cannot record a `content_blocks` edit** — `target_id` is
   `uuid not null`, that table is keyed `(key, locale)`. Unchanged from the 30 Aug handoff.

Still gated, untouched: the `/item/*` route on the site origin, the service-role JWT for
`scripts/m1-deployed.ts`, GoTrue IP retention, backups + a tested restore, the seed importer.

## Do these FIRST

1. `supabase migration list --linked`. It was clean at the end of this session (58
   migrations, all paired), but it has been wrong twice before while CI was green.
2. **`node scripts/pgtap-deployed.mjs --tap`** — new this session. It runs the whole pgTAP
   suite against the **hosted** database, each file in its own rolled-back transaction,
   through `supabase db query --linked` (no password needed). This exists because Docker has
   been wedged for four sessions and CI builds a *fresh* database from the same files, so a
   green CI run says nothing about the database people actually use. It proved to
   discriminate before being trusted: it reports red both for a failing assertion and for a
   file that stops short of its own `plan()`.
3. `docker version` — still down (`dockerDesktopLinuxEngine` not found). Not needed for (2).

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
- **In a JavaScript `String.replace` *replacement*, `$$` means a literal `$`.** It turned
  `$$delete …$$` into `$delete …$` in a SQL file.
- **A mechanical rewrite over SQL must be quote-aware.** `05_matrix` stores probe statements
  as dollar-quoted text, so a naive match hit the denial matrix's own data.

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
