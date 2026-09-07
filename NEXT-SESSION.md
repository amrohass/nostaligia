Ramallah Memory Atlas — handoff. Read CLAUDE.md fully first; it governs this repo and
overrides your defaults.

---

## 7 Sep 2026 — the newest session, read this part first

**One thing must be applied before the front end is trusted: migration `0062`.** Same rule
as 0060 — **migration FIRST, then the front end.** Reversed, an event submission still 500s
exactly as it does today; in the right order, an event sent from the old front end is
refused by name instead. 0062 is `20260907090000_event_submission.sql`; it is **not applied
to the deployed database yet**.

**Events were never submittable.** The share sheet has had an "event" button since M3 and it
could never have worked: `claim_upload_slot` never set `event_starts_at`, so
`posts_event_needs_a_start` raised inside a SECURITY DEFINER function and reached the browser
as a 500. Pressing "event" also changed three icons and nothing else — the form underneath
stayed the photograph's. 0062 + the sheet's `applyKind()` fix that. D6 stands: no new table,
no new stream, and `39_event_submission` asserts the absence of a `public.events` table as
loudly as it asserts the new behaviour.

**Three bug reports, and only two were bugs.** The admin queue rendered a placeholder because
`mapRow()` computed `previewUrl`/`thumbUrl` from M1 and **nothing ever read them** — no RLS
involved, the object returns 200 and the CSP already admitted it. The handle showed
`member_<hex>` because the INSERT→PATCH fix is correct and deployed but only fires at signup,
so all 16 existing accounts hold 0057's placeholder and the profile editor never wrote
`handle` — there is a rename control now. **The map's list was not broken**: deployed CSS and
JS are byte-identical to the tree, and a real browser renders 2/3/4/5/6 columns at
390/800/1200/1440/1920. Assets ship `max-age=14400`, so a browser that loaded the page before
the deploy serves the old layout for four hours. **A hard reload was the whole fix.**

**Two defects found while verifying, both of which were hiding coverage:**
`18_publishable_posts` asserted `redacted_post_ids()` held exactly one id; production has
six, and its scalar subquery raised 21000 — which did not fail an assertion, it **aborted the
file**, so all 17 of its assertions silently stopped running (the suite read 715 of 732
planned). And the refusal-map test's migration pointer was hand-maintained with a comment
saying to repoint it; it finds the newest definition now, and immediately reported all eight
of 0062's new refusals as unmapped, which is what it is for.

**Docker is wedged and the database backup cannot be taken.** The process starts, the WSL
`docker-desktop` distro reports `Running`, and the daemon's pipe never answers. `--selftest`,
the `originals/` sync, `triggers.sql` and `function_acl.sql` all work; `schema`, `data`,
`auth`, `roles` and `restore-verify` are blocked. **`supabase db dump --linked --schema
public` does NOT need Docker; the same command without `--schema` does** — worth knowing on
the retry. This does **not** reopen §11 gate 3, which was discharged against a real restore
on 1 Sep. See `docs/backup-runbook.md`.

**Amro's backup destination changed to a local encrypted disk** (7 Sep), which also settles
the flagged CI-token question: a GitHub runner cannot write to his disk, so the weekly run is
a scheduled task on his machine and the project-wide management token never has to exist in
CI at all.

**Cross-checks, both different from what was expected.** `redirect_to` is **not** hardcoded
to localhost anywhere in shipping code — password reset uses `location.origin + '/reset'`,
and the confirmation mail sends **no `redirect_to` at all**, so its landing is governed
solely by the Supabase **Site URL** dashboard setting (Amro's to confirm; unreadable from
here). The vault entries **are** set and auto-publish works — the monitor reports `ok
publish`, 13 releases that day.

Incidental: production's CSP blocks the Cloudflare Web Analytics beacon
(`static.cloudflareinsights.com`), so that analytics data is not being collected.

---

**The 5 Sep session's report is `docs/session-report-2026-09-05-confirmation.md`.** Read
its §0 before deploying anything: **migration 0060 must be applied BEFORE the Edge Functions
are redeployed**, or every upload breaks in the window between the two. The front end needs
no ordering — it degrades to today's behaviour against a database without 0060, deliberately
and testably.

That session did two things. It fixed the form-labelling defect (`UI.labelFor`, commit
`3ca6d5d`) — the critical `select-name` on the share sheet, two unlabelled inputs beside it,
and two more on the admin sign-in that nothing had ever looked at. And it **built deferred
email confirmation**, which had been stopped at §12 since 3 Sep: Amro answered both open
questions on 5 Sep — **mechanism B**, and **gate all four**.

**The 3 Sep session's report is `docs/session-report-2026-09-03-auth.md`** — the password
reset that shipped (where a Supabase reset link ACTUALLY lands, and the §7 hold that must
not be "fixed"), and §2's measurement of why "signed in AND unconfirmed" is not reachable by
configuration in this GoTrue, which is what 0060 is built on.

**The 2 Sep session's report is `docs/session-report-2026-09-02-testing.md`** — the
authenticated-E2E blocker removed, the mutation pass, the privacy suite, where the time
actually goes, the 300-item load test, and the two §9 accessibility defects that were fixed.
Read it before touching any test in this repository.

**The 1 Sep evening session's report is `docs/session-report-2026-09-01-m6.md`** — the two
login bugs and how each was diagnosed rather than guessed, gate 3's closure, the structural
scratchpad fix, and all of M6 with its measurements. This file is the short version and what
to do next.

**Earlier records, still accurate:** `docs/audit-2026-08-31.md` (the M0–M4 regression audit),
`docs/session-report-2026-09-01.md` (the Turnstile secret resolved, `secret-consistency.mjs`,
the first two sets of unencrypted data removed).

---

## M6 IS COMPLETE. M5 and M6 are both done except for what only Amro can do.

Every M6 item is built, tested and deployed. §11 **gate 5 is discharged** — proved live
against the deployed pipeline, not argued.

| M6 item | state |
|---|---|
| F23 font subsetting + shaping check | **done.** Self-hosted, unicode-range split, HarfBuzz-verified. `known_violations` is EMPTY for the first time. |
| F24 RTL pass incl. slider direction | **done.** Zero physical side properties; slider direction measured in a real browser. |
| F27 monitoring + budget alerts (gate 5) | **done.** `scripts/monitor.mjs` + `.github/workflows/monitor.yml`. Alert proved to fire on a real hold. |
| Lighthouse on throttled 3G / mid-tier Android | **done**, and it found a real CLS defect that is now fixed. |
| F08 Spend Cap | **not settable from here.** Amro, in the dashboard. |

---

## Do these FIRST

1. **`node scripts/secret-consistency.mjs`** — the pre-flight for the drift class that has
   caused three outages. Seconds, no argument, prints group letters and never a digest.
2. **`node scripts/monitor.mjs`** — new. Publish age (gate 5), storage against §2's
   thresholds, and §9's budget, against the deployed system. `--selftest` needs no
   credential. **`unknown` is not `ok`** — a check that could not look says so.
3. `supabase migration list --linked`. **62 migrations in the repo. 0060 and 0061 ARE now
   applied** (verified 7 Sep: every row `local == remote`, no drift). **0062 is NOT** — it
   is this session's, and its order against the front end is the strict one: **migration
   first**. Note that applying 0061 **dispatched a publish**, because seeding a `published`
   block fires `bump_publish_revision('content')`; that was wanted and has happened.
4. **`node scripts/pgtap-deployed.mjs --tap`** — **40 files, 732 assertions**. **Until 0062
   is applied it must be run with it spliced in as a prelude**, or `39_event_submission`
   fails on a function that does not exist yet:

   ```
   node scripts/pgtap-deployed.mjs --tap \
     --prelude supabase/migrations/20260907090000_event_submission.sql
   ```

   That is **3 red, all three known**: `20_publish_cron` 14/23/24 as always, and nothing
   else. After 0062 is applied, drop the `--prelude` and it is the same 3.
   The prelude is spliced INSIDE each file's own transaction and rolled back with it, so
   this writes nothing to the deployed database.

   **It was 715 of 732 until 7 Sep and the gap was not visible as a failure.**
   `18_publishable_posts` raised 21000 on a scalar subquery and *aborted*, so its 17
   assertions stopped being counted rather than going red. If that total is ever short
   again, look for a file that died before `finish()` — not for a red line.
5. **The testing suites added 2 Sep.** They need `node scripts/harness-bootstrap.mjs --all`
   once (it writes `.harness.vars`, git-ignored) and a scratch `node_modules` holding
   `playwright` + `axe-core` for the two browser ones:
   ```
   node scripts/harness-bootstrap.mjs --status        live / stale, per role
   node scripts/e2e-authenticated.mjs            61   1 known-red: takedown 207, see below
   PLAYWRIGHT_DIR=… node scripts/e2e-browser.mjs 103  green
   node scripts/privacy-shards-test.mjs          44   green
   node scripts/mutation-pass.mjs                21   13 KILLED, 0 SURVIVED, 8 INCONCLUSIVE
                                                     until 0060 is applied — see the report's
                                                     §2.9; PLAYWRIGHT_DIR needed for the three
                                                     browser ones, and re-run a browser-guarded
                                                     INCONCLUSIVE on its own before believing it
   PLAYWRIGHT_DIR=… AXE_DIR=… node scripts/a11y-sweep.mjs  34, 0 failed, 6 findings
   node scripts/perf-probe.mjs                        measurement, no pass/fail
   deno run -A scripts/load-test-300.ts               measurement, no pass/fail
   ```
6. The rest of the suite, all green at the end of this session:
   ```
   node scripts/frontend-csp-test.mjs      14    node scripts/frontend-fonts-test.mjs   14
   node scripts/frontend-auth-test.mjs     70    node scripts/frontend-rtl-test.mjs     12
   node scripts/frontend-view-test.mjs     53    node scripts/monitor.mjs --selftest    19
   node scripts/frontend-map-test.mjs      63    node scripts/frontend-budget.mjs  113.4/150 KiB
   node scripts/frontend-cors-test.mjs      6    node scripts/frontend-nav-test.mjs     80
   node scripts/frontend-admin-test.mjs    16
   deno test supabase/functions/publish/   96    deno run … backup.ts --selftest        31
   deno test … request-upload/             22    deno run … restore-verify.ts --selftest 25
   deno test … resend-confirmation/        11
   ```

   `frontend-admin-test.mjs` is new on 7 Sep and is the only thing in this repository that
   RENDERS `admin.js`. It exists because nothing else could see the defect it covers: a URL
   computed since M1 and never read is not a syntax error and not a missing global, so the
   source scans were green through it and `frontend-view-test` only ever proved the file
   *evaluates*. It takes a rendered tree.

---

---

## Three things the 2 Sep session found

1. **`e2e-authenticated.mjs`'s one red is real and is Amro's.** Takedown answers **207
   `objects_remain`**, not 200, because `CLOUDFLARE_PURGE_TOKEN` is unset — §8's CDN purge
   is a no-op. The bytes and the prerendered page ARE deleted; the CDN is not purged. An
   earlier draft of that check asserted `res.ok`, which is TRUE for 207 and went green.

2. **Nothing is cached at a CDN edge.** The bucket is served over its `r2.dev` DEVELOPMENT
   URL: no `cf-cache-status`, no `age` on an object marked immutable for a year, and a
   repeat fetch only 9% faster than a cache-busted one. §2's "Browser → CDN → media" is at
   present "Browser → bucket" for every visitor. This makes the production custom domain a
   performance item, not only a §2 one.

3. **The network dominates, so do NOT upgrade the Supabase plan.** ~80 ms transport floor
   against ~37 ms of database work on the slowest query. Numbers in §4 of the report.

## What is left, and every one of these is Amro's

**Nothing on this list is blocked on code.**

1. **Sign in to `/admin` in a real browser.** The dashboard sign-in had no captcha widget and
   is fixed and deployed; every step up to the challenge is verified live. Turnstile will not
   mint a token for automation, so the final click is a person's. Use the real admin account
   or a harness moderator (`e2e-moderator-a4ef7ef7-…@mail.example.com`, password
   `e2e-deployed-harness-password-1`) — the gate admits moderator and admin identically.
2. **`SUPABASE_ACCESS_TOKEN` as a GitHub Actions secret.** Settings → Secrets and variables →
   Actions. Until it exists the monitor workflow **fails every night, deliberately** — see
   below.
3. **Spend Cap ON.** Organization → Billing → Cost Control. §6 names it as one of four cost
   layers and no launch gate covers it, so nothing else will catch it being off.
4. ~~**Gate 4: a named human on the takedown path.**~~ **DISCHARGED 6 Sep** — Amro, 48
   hours, in-platform reports plus `reports@ramallahnostalgia.org`. The path itself was
   already verified end to end at 2.9 s. **Two things of his are now hard preconditions for
   public launch, both in `docs/takedown-runbook.md` §7:** create the Cloudflare Email
   Routing rule for that address once the domain is Active (it is published copy the moment
   0061 applies, and bounces until the rule exists), and set `CLOUDFLARE_ZONE_ID` /
   `CLOUDFLARE_PURGE_TOKEN` in the *same change* that puts a cached custom domain in front
   of R2. F29's co-maintainer break-glass is still unmet and is recorded as such.
5. **The pen test.** Not scheduled. §11: the public launch date is set after it.
6. Custom SMTP, the ~300 seed items, the second Cloudflare account's R2 credentials — all
   unchanged and all still Amro's. (Deliberately off this session's list.)

---

## Why the monitor workflow failing every night is CORRECT

`.github/workflows/monitor.yml` runs `node scripts/monitor.mjs --require publish` every six
hours. Without `SUPABASE_ACCESS_TOKEN` the publish check reports `unknown`, and `--require`
turns that into a **failed job and an email**.

That is deliberate and it is the point. Without `--require`, a runner with no credential
reports `unknown`, `unknown` is not an alert, the workflow goes green every night, and gate
5's monitor is "running" while measuring nothing — which is the exact failure the gate exists
to prevent, reappearing inside the monitor. Adding the secret is what makes it green.

---

## §11 launch gates

| Gate | State |
|---|---|
| 1 · RLS denial matrix green | **passing**, in CI and against the deployed database. |
| 2 · EXIF verified on a real photo with GPS | **DISCHARGED.** |
| 3 · One tested restore | **DISCHARGED 1 Sep.** Amro ruled the local-Docker target sufficient; CLAUDE.md §11 records the standard so it is not re-argued. No further restore work is owed. The ONGOING cadence is a separate thing and is blocked on Docker — `docs/backup-runbook.md`, and it does not reopen this gate. |
| 4 · A named human on the takedown path | **DISCHARGED 6 Sep.** Amro, 48 hours, two intake paths. `docs/takedown-runbook.md` + migration 0061. **Two of his own items must land before public launch** — the email alias and the purge token; see the runbook §7. |
| 5 · Publish-age monitoring separating `held_by_operator` from `unchanged` | **DISCHARGED 1 Sep.** Proved live: a hold was set on the deployed pipeline, the monitor reported ALERT six seconds later naming it an operator hold, and returned to ok when released. |
| Pen test | not scheduled. Amro. |

---

## Flagged, not built

- ~~**No password-reset flow exists.**~~ **BUILT 3 Sep** (`afa616b`), after Amro asked for it
  directly — request dialog, `/reset` landing with four distinct refusals, and an account
  panel on `/me`. What is still his: custom SMTP, so no reset mail has ever been sent or
  clicked, and one optional dashboard line adding `<origin>/reset` to the Auth redirect
  allowlist (without it the link lands at the site root, which is handled and tested).
- ~~**Deferred email confirmation is stopped at §12.**~~ **BUILT 5 Sep** — migration 0060,
  `resend-confirmation`, and the client half. Amro answered both questions that day:
  mechanism B (autoconfirm plus a project-owned flag, stamped only from a session whose
  `amr` names a mailed link) and "gate all four" (posts, uploads, comments, likes/saves).
  Reporting is deliberately NOT gated — §7's removal request is the control a person *in* a
  photograph reaches for. What is still his: apply the migration, deploy the functions in
  that order, and turn "Confirm email" off when he wants it to actually defer.
- ~~**A signup that needs email confirmation loses the handle the member typed.**~~
  **CLOSED 7 Sep, in both halves.** The parked-handle path (sessionStorage across the
  confirmation round trip) shipped in `edda228`; it is best-effort by construction and a link
  opened on another device still keeps the placeholder. What that could never fix is every
  account that ALREADY had one — `claimHandle()` only ever runs at signup, so all 16 accounts
  on the deployed database, Amro's included, held `member_<hex>` with no way to change it,
  while `signup.err.handleTaken` had been telling members to "change it from your page" since
  M3. **The profile editor writes `handle` now.** No migration: 0004 grants
  `update (handle, display_name)` and 0017's `profiles_update` restricts it to
  `id = auth.uid()`, both live since 11 Aug.
- **Edge Function error rates are not collected.** The monitor reports them `unknown` rather
  than skipping them. Needs a Management API token with analytics scope.
- **Colour contrast, and it is the whole of what `a11y-sweep` still reports.** 9 elements on
  `/`, 6 on `/map`, 3 on `/events` and `/reset`, 16 on the dashboard — `.wordmark__secondary`,
  `.memory__gloss`, `.site-footer__mark-sub`, `.rail__sub`, `.rail__exit`. Repainting a colour
  system is a design decision with an owner, and `--strict` gates on it the day that decision
  exists. The form-labelling half of that list was closed on 5 Sep; this is the rest.

---

## New in the 1 Sep session — what to know before touching it

### The monitor (`scripts/monitor.mjs`)

Two design points that are easy to get backwards, both written into the file:

- **Publish age alone is not a signal.** The cron is unscheduled (§2's amendment), so an idle
  archive's fortnight-old release is *correct*. Age is only ever read together with `pending`.
  A hold alerts on sight whatever the age — that is what "fire on the first" means.
- **`unknown` is not `ok`.** A check that could not reach its source has not said the system
  is healthy. Collapsing the two is how a monitor comes to be trusted for something it never
  measured.

To exercise the alert yourself: insert a row into `public.publish_hold` (it needs `reason` and
`held_by`, both NOT NULL and both without defaults, deliberately), run the monitor, then
`delete from public.publish_hold where id`. Do it inside a trap so the delete always runs.

### The fonts (`scripts/subset-fonts.py`)

A one-off generator, **not a build step** — the `.woff2` files are committed like the basemap
archive. Nothing in CI or the publisher runs it. Re-run it only to change a typeface:

```
python -m pip install fonttools brotli uharfbuzz
python scripts/subset-fonts.py --src <dir with the OFL TTFs from google/fonts>
```

It **refuses to write a face whose Arabic stops shaping** — nine words through HarfBuzz
against the unsubsetted original, with a control that must fail. `frontend-fonts-test.mjs` is
the CI half and needs no Python: it reads the WOFF2 table directory directly.

### The RTL browser probe

`PLAYWRIGHT_DIR=<node_modules> node scripts/rtl-browser-probe.mjs`. Not in CI (needs
Playwright and Chromium). Run it when the slider or its stylesheet changes.

### Lighthouse

`PLAYWRIGHT_DIR=… LIGHTHOUSE_DIR=… node scripts/lighthouse-probe.mjs [origin]`. Takes several
minutes for three routes — run it in the background.

---

## Traps the 2 Sep session hit, so you do not

- **GoTrue's captcha does NOT cover `grant_type=refresh_token`.** That is what unblocked
  every authenticated test. `scripts/lib/harness-auth.mjs` holds the reasoning.
- **Playwright's `route()` takes a STRING as a GLOB**, and `?` is a single-character
  wildcard — so `token?grant_type=password` intercepts nothing. Use a RegExp for any URL
  with a query string. The only symptom was `AUTH.user()` staying null.
- **`turnstile.js` assigns `window.TURNSTILE`**, so a non-writable stub makes the module
  throw and never finish. The stub must be an accessor with a swallowing setter.
- **A mutation must break the MECHANISM, not the data.** `mutation-pass.mjs`'s prelude lands
  before the test's fixtures, so an `UPDATE` over existing rows is a no-op that reports a
  false SURVIVED. Redefine the function; do not rewrite the rows.
- **`save_content_block` reports refusal in the BODY with HTTP 200.** A status-code
  assertion on it says the opposite of the truth.
- **`document.body` is `isConnected`.** A focus-restore fallback guarded only on
  `isConnected` never fires.
- **Time a build warm, and take a median.** A single cold `buildShards()` call reported
  11,891 ms for 300 items — V8 optimisation, not an algorithm. The warm median is 44 ms.
- **Synthetic fixtures compress far better than real prose.** Calibrate against the live
  archive's own ratio or the budget number is fiction.
- **Bash's PATH broke mid-session** (`head`, `python` not found). PowerShell kept working;
  use `git commit -F <file>` there, because a message with `->` in it is parsed as a switch.

## Traps earlier sessions hit, so you do not

- **A `/route` argument in Git Bash becomes `C:/Program Files/Git/…`.** Prefix with
  `MSYS_NO_PATHCONV=1`. (Already in the memory; hit again anyway.)
- **`execFileSync('supabase', …)` is ENOENT on Windows.** It is a `.cmd` shim; go through a
  shell, as `pgtap-deployed.mjs` does.
- **ESM ignores `NODE_PATH`.** A repo script that needs a scratch-installed package has to
  take a directory and `import(pathToFileURL(...))`. And Playwright is CommonJS, so a dynamic
  import puts its named exports on `.default`.
- **HarfBuzz cannot read WOFF2.** Shape the uncompressed form. Comparing a TTF original to a
  WOFF2 subset reports every face broken and looks like a subsetting bug.
- **A shaping probe must stay inside the range the face declares.** A phrase contains spaces,
  U+0020 is in the *Latin* subset, and the Arabic face correctly answers `.notdef`. Single
  words lose nothing: Arabic does not join across a word boundary.
- **`Deno.exit` does not run a `finally`.** A cleanup that must cover refusal paths belongs on
  an `unload` listener, which fires on both — and must therefore be synchronous.
- **A self-scanning source check will match its own control fixture.** `backup.ts`'s
  plaintext-write scan failed on its own test string; the fixture is concatenated now.
- **A comment can be the bug.** `.memory__plate:has(> .memory__img) { min-height: 0 }` carried
  a comment saying it "reserves the row before the image decodes". It reserves nothing, and
  the claim is why nobody looked again while the feed measured CLS 0.57.
- **`supabase db query --linked` still cannot be run twice in parallel** (colliding temporary
  login roles).
- **Turnstile still will not answer a script.** Unchanged, and it is why the last click of the
  admin sign-in is a person's.

---

## Known-red and deliberately so

`20_publish_cron` tests 14, 23 and 24 describe a database that has never published and has no
Vault entries. Staging has both, correctly. A *restored* database sits between the two: 14 is
red (releases came back with the backup) and 23/24 are green (the backup carries no Vault
secrets). `restore-verify.ts` encodes exactly that and fails if 14 ever passes.

## Local stack, when you need it

```
supabase start -x storage-api,imgproxy,studio,logflare,vector,edge-runtime,realtime,supavisor,mailpit
supabase test db
```

A plain `supabase start` FAILS and takes the whole stack down with it — it applies all 59
migrations, times out on `storage-api` and `studio` health checks, and rolls back every
container and the volume. The `-x` list is required, not optional. It takes about a minute.
