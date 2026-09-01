Ramallah Memory Atlas — handoff. Read CLAUDE.md fully first; it governs this repo and
overrides your defaults.

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
3. `supabase migration list --linked`. 59 migrations, all paired at the end of this session.
4. **`node scripts/pgtap-deployed.mjs --tap`** — 37 files, 669 assertions, 3 known-red.
5. The rest of the suite, all green at the end of this session:
   ```
   node scripts/frontend-csp-test.mjs      14    node scripts/frontend-fonts-test.mjs   14
   node scripts/frontend-auth-test.mjs     48    node scripts/frontend-rtl-test.mjs     12
   node scripts/frontend-view-test.mjs     46    node scripts/monitor.mjs --selftest    19
   node scripts/frontend-map-test.mjs      63    node scripts/frontend-budget.mjs   90.8/150 KiB
   node scripts/frontend-cors-test.mjs      6
   deno test supabase/functions/publish/   96    deno run … backup.ts --selftest        26
   deno test … request-upload/             15    deno run … restore-verify.ts --selftest 25
   ```

---

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
4. **Gate 4: a named human on the takedown path** with a stated response time. Still nobody.
   The path itself is verified end to end at 2.9 s.
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
| 4 · A named human on the takedown path | **still nobody.** Amro. |
| 5 · Publish-age monitoring separating `held_by_operator` from `unchanged` | **DISCHARGED 1 Sep.** Proved live: a hold was set on the deployed pipeline, the monitor reported ALERT six seconds later naming it an operator hold, and returned to ok when released. |
| Pen test | not scheduled. Amro. |

---

## Flagged, not built

- **No password-reset flow exists.** `site/assets/js/` contains no call to `/auth/v1/recover`;
  the "Forgot password?" control is a stub that toasts its own label. The endpoint is live and
  correctly gated. **No decision from Amro on priority.** Worth noting beside the admin-login
  fix: if a password is ever actually wrong, there is no way to reset it from the client.
- **A signup that needs email confirmation loses the handle the member typed.** `claimHandle()`
  runs only when signup returns a session, so a member who confirms by email lands with 0057's
  placeholder `member_<hex>` instead of the name they chose. Fixing it means persisting the
  handle across the confirmation round-trip, which is untestable while the mail cap stands.
- **Edge Function error rates are not collected.** The monitor reports them `unknown` rather
  than skipping them. Needs a Management API token with analytics scope.

---

## New this session — what to know before touching it

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

## Traps this session hit, so you do not

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
