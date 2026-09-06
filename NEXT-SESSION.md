Ramallah Memory Atlas — handoff. Read CLAUDE.md fully first; it governs this repo and
overrides your defaults.

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
3. `supabase migration list --linked`. **61 migrations in the repo; 0060 AND 0061 are NOT
   applied to the deployed database** (verified 6 Sep: 59 remote, 61 local). 0060's order
   against the Edge Functions is in the 5 Sep report's §0 and is the strict one. 0061 is
   copy only — no schema, no function, no ordering constraint — but note that applying it
   **dispatches a publish**, because seeding a `published` block fires
   `bump_publish_revision('content')`. That is wanted: it is how the new section goes live.
4. **`node scripts/pgtap-deployed.mjs --tap`** — 39 files, 706 assertions. **Until 0060 and
   0061 are applied it must be run with both spliced in as a prelude** — every fixture
   confirms its accounts (0060), and `38_removal_copy` reads copy that only 0061 seeds. The
   flag takes ONE file, so concatenate them:

   ```
   cat supabase/migrations/20260905090000_email_confirmation.sql \
       supabase/migrations/20260906090000_removal_copy.sql > /tmp/prelude.sql
   node scripts/pgtap-deployed.mjs --tap --prelude /tmp/prelude.sql
   ```

   That is 3 red, all three known: `20_publish_cron` 14/23/24 as always, and nothing else.
   After both migrations are applied, drop the `--prelude` and it is the same 3.
   The prelude is spliced INSIDE each file's own transaction and rolled back with it, so
   this writes nothing to the deployed database — including 0061's copy.
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
   node scripts/frontend-auth-test.mjs     69    node scripts/frontend-rtl-test.mjs     12
   node scripts/frontend-view-test.mjs     53    node scripts/monitor.mjs --selftest    19
   node scripts/frontend-map-test.mjs      63    node scripts/frontend-budget.mjs  104.8/150 KiB
   node scripts/frontend-cors-test.mjs      6
   deno test supabase/functions/publish/   96    deno run … backup.ts --selftest        26
   deno test … request-upload/             22    deno run … restore-verify.ts --selftest 25
   deno test … resend-confirmation/        11
   ```

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
| 3 · One tested restore | **DISCHARGED 1 Sep.** Amro ruled the local-Docker target sufficient; CLAUDE.md §11 records the standard so it is not re-argued. No further restore work is owed. |
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
- **A signup that needs email confirmation loses the handle the member typed.** `claimHandle()`
  runs only when signup returns a session, so a member who confirms by email lands with 0057's
  placeholder `member_<hex>` instead of the name they chose. Fixing it means persisting the
  handle across the confirmation round-trip, which is untestable while the mail cap stands.
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
