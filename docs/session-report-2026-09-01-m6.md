# Session report — 1 Sep 2026, evening: two login bugs, gate 3 closed, and M6

Six items were set for this session. All six are done. This is the record of what was
measured rather than assumed, and of the four bugs the work found in itself.

## 0 · The request-upload logging fix was still undeployed, and now is not

Checked first, as instructed. The deployed function was **v10, 29 Aug**; the logging change
was written 1 Sep and uncommitted. So: still pending, confirmed rather than assumed.

Deployed as **v11**. The client-facing response is unchanged and that is checkable in the
diff — `turnstileOk()` returns the same boolean to the same caller and `fail("turnstile_failed",
403, req)` is untouched. What changed is two `console.error` lines. An attacker still cannot
tell `invalid-input-secret` (an operator's mistake, every upload failing for everyone) from
`invalid-input-response` (one visitor, working as designed); an operator now can.

The 15 handler tests pass.

## 1 · Admin login: the dashboard sign-in never had a captcha

**Diagnosed before touching anything, as instructed, and it is the first of the two
possibilities: the sign-in request itself fails.**

The evidence, in the order it settled the question:

- **There is exactly one admin account** (`ad***@admin.com`), and its state is healthy:
  confirmed, unbanned, not deleted, not SSO, one bcrypt password, one `auth.identities` row
  for the email provider, `aud=authenticated`, and a profile row. It is **structurally
  identical to a member account that signs in successfully.**
- **Its last session and its `last_sign_in_at` are both 2026-08-30 15:06**, while a member
  signed in at 2026-09-01 14:49. So no successful password grant has happened for that
  account in two days. That rules out "sign-in succeeds but the surface never loads": a
  successful grant would have left a session row and moved the timestamp.
- **GoTrue enforces its captcha uniformly by role.** Probed live: member, moderator, a bad
  password, and a non-existent account all return the identical
  `400 captcha_failed — "(no captcha_token found)"`. So the role cannot be what GoTrue is
  refusing.
- **The deployed `/admin` page loads six modules and none of them is `turnstile.js`**, and
  it carries no `challenges.cloudflare.com` script tag at all. `admin-boot.js` called
  `AUTH.signIn(email.value, password.value)` — two arguments, so no
  `gotrue_meta_security.captcha_token`.

That is the whole bug. It was harmless for as long as the project's captcha was off, and it
locked every moderator and admin out of the dashboard from the moment it was switched on
(31 Aug) — which is exactly where the admin's last successful sign-in stops.

The last measurement closes the loop. Same account, same password, one field different:

```
no captcha_token field       400 captcha_failed  "(no captcha_token found)"
field present, token bogus   400 captcha_failed  "(invalid-input-response)"
```

`invalid-input-response` is the token being *judged*. Supplying the field is the whole
difference between "refused before the credentials are read" and "the challenge is being
evaluated" — and a real widget's token is what passes that evaluation, which today's
successful member sign-in already demonstrates through the identical code path.

### What was changed

`admin.html` loads Turnstile's `api.js` and `turnstile.js`; `admin-boot.js` mounts a widget
into the sign-in form and awaits `widget.token()` before calling `AUTH.signIn`. Two smaller
things went with it, because both are why this took a person to find:

- **`captcha_failed` was unmapped in `auth.js`**, so every occurrence of this reached the
  screen as `auth.err.generic` — "That did not go through." It has its own message now.
- **`admin-boot.js` read only `err.key`**, and `TURNSTILE` rejects with a plain `Error` whose
  `.message` is the i18n key. So "the challenge widget could not load" also rendered as the
  generic message. Both shapes are normalised now.

### Verified live, and the ceiling stated plainly

Against the deployed origin, in a real headed Chromium:

| | |
|---|---|
| Turnstile `api.js` loads on `/admin` | **yes** — `window.turnstile` is an object; the CSP admits it |
| a `.captcha` slot renders inside the form, before the submit button | **yes**, 74px tall |
| CSP violations on the page | **1**, the pre-existing declared Google-Fonts one, now also gone (see M6) |
| POSTs to `/auth/v1/token` on submit | **0** — the form waits for a token instead of posting without one |
| what the operator is told | *"تعذّر تحميل أداة التحقّق. عطّل مانع الإعلانات وأعد المحاولة."* |

Zero tokenless POSTs is the fix, observed. Before it, the click posted immediately and was
refused before the password was read.

**What automation cannot do, and is not claimed:** Turnstile does not mint a token for a
driven browser — no iframe, no callback. So the final "signed in, dashboard renders" click
is Amro's, with the harness moderator or the real admin account. Everything up to the
challenge is measured above; the challenge itself is the one step a script cannot pass.

**A note on the instruction:** it named "the harness admin account in
`scripts/e2e-deployed.ts`". There isn't one — the deployed harness has three members and
three moderators and no admin. The moderator was used instead, which exercises the same
gate: `admin-boot.js` admits `moderator` and `admin` identically.

### The rule, written down instead of remembered

Nothing in the suite could have caught this: `frontend-view-test` evaluates `admin.js`
against `admin.html`'s globals but **filters `admin-boot.js` out**, and nothing related a
sign-in call to the widget that has to feed it. `frontend-auth-test.mjs` now asserts that
every `AUTH.signIn`/`signUp` call site passes a third argument, and that every shell loading
such a module also loads `turnstile.js` and Turnstile's `api.js`. Both halves were verified
to go **red** against the original code before being kept.

## 2 · Signup ended on a closed dialog and a 3.2-second toast

The confirmation-required branch called `close()` and `UI.toast(t('auth.confirmSent'))`. The
toast lives for 3200ms and then removes itself. That is the "nothing happened" being
reported — the one moment in the flow where a new member has to be told to go somewhere else
and do something.

Replaced by a panel that stays until dismissed: a title, the address echoed back inside a
`<bdi>` (the commonest reason a confirmation never arrives is a typo in it, and it is the one
thing the member cannot re-check after the dialog closes), what to do next, and a button.

The signed-in branch gets a panel too, as instructed. Which of the two a visitor takes
depends on a project setting they cannot see, and an outcome should not vary in whether it is
announced. §9's intent-preservation is unchanged — the pending action runs from the panel's
button rather than from the close.

Verified at the live origin on a 390×844 viewport, with only the two things automation cannot
produce stubbed (a Turnstile token, and a signup that would create a real account and burn a
message against the send cap). Everything between them is the shipped code:

```
title    تفقّد بريدك          dir  rtl        button focused  yes
address  <bdi>someone@example.org</bdi>       within viewport yes
form gone yes                                 body scrolls x  no
still on screen 9 seconds later               yes
```

**One thing found and deliberately not fixed:** the handle the member types is discarded on
the confirmation-required path. `claimHandle()` runs only when signup returns a session, so a
member who confirms by email lands with 0057's placeholder `member_<hex>` instead of the name
they chose. Fixing it means persisting the handle across the confirmation round-trip, which
is untestable while the mail cap stands. Flagged, not built.

## 3 · Gate 3 is closed

Amro's ruling — the local-Docker restore is sufficient — is recorded in CLAUDE.md §11 beside
what the run proved and what it deliberately does not. `--target <ref>` remains for a wider
test, as an option rather than an obligation. No further restore work is owed for launch.

## 4 · Scratchpad hygiene, structurally

Unencrypted member data has now been found in a local scratchpad twice, from two different
sessions, both times after the fact. There were two ways in and both are closed.

**Transient writes go through one channel.** `backup.ts` had four scattered
`Deno.makeTempFile()` call sites, each removing its own file in a `finally` — correct, and
also exactly the arrangement in which *"did this run leave anything behind"* is not a
question the tool can answer. Every path is recorded as it is handed out; a sweep enumerates
and deletes them and prints what it removed. It hangs off `unload` and is synchronous,
because the five refusal paths end in `Deno.exit`, **which does not run a `finally`** — a
sweep in one would have covered the successful runs and missed every refusal, which is the
half most likely to leave a part-written file.

**`--to-dir` refuses a transient directory by name**, the way it already refuses the
repository. The header is explicit that ORIGINALS are written in the clear, and its argument
is sound — a 4 GB master cannot be AES-GCM'd in memory and inventing a chunked format here
would be worse — but it rests on *"the destination bucket being private and on R2's own
encryption at rest"*, and a temp directory is neither. That is how contributors' masters,
EXIF intact, came to sit in a directory whose whole contract is that something else sweeps it
later. A backup in a swept directory is a disclosure with a delay.

And the rule the incidents were actually about, asserted rather than remembered: **neither
tool may write a decrypted dump to a disk.** Both decrypt into memory and pipe to psql's
stdin; the self-test scans both files for a write call with a `decrypt(` in its arguments.
Its first run failed on its own control fixture, which is the check working — the fixture is
concatenated now so it cannot match itself.

`pgtap-deployed.mjs` cleans up too: it writes a rewritten copy of all 37 test files per run
and never removed them. **47 stale directories** were on this machine; they are gone, and a
run no longer adds one.

`backup.ts --selftest`: 26 assertions, was 18. `restore-verify.ts --selftest`: 25, unchanged.

A third `rma-backup` directory was then found in another session's scratchpad, and it is
**left in place and reported rather than deleted**: it holds only `.enc` files and two
manifests, `originals copied: 0`, and no email-shaped string anywhere in the manifests. That
is the artifact shape the design intends, and deleting somebody's backup copy uninvited is
not a call to make silently. It is, however, exactly the destination `--to-dir` now refuses —
the guard's first real-world example.

Separately, and reported rather than swept under the same heading: three files carrying a
live password and a session JWT for a deployed test account (`ra***@emalupe.com`, a
disposable-mailbox harness account) were found in another session's scratchpad and deleted.
Not member data, but a working credential for an account on the deployed project.

## 5 · Password reset — still flag only

No reset flow exists. `site/assets/js/` contains no call to `/auth/v1/recover`, and the
"Forgot password?" control is a stub whose entire behaviour is to toast its own label. The
endpoint is live and correctly gated. Not built, as instructed; still flagged.

Worth noting beside item 1: if Amro's admin password is simply wrong, there is no way for him
to reset it from the client. That is not what item 1 turned out to be, but it is the fallback
that does not exist.

## 6 · M6

### Fonts (F23)

Both families are self-hosted, subsetted, unicode-range split, WOFF2, `font-display: swap`.
**`known_violations` is empty for the first time** — the two Google Fonts origins were the
whole list, and the CSP this project serves has always blocked them, so on Cloudflare Pages
the archive rendered in whatever the OS had. §7 gives the other reason: a font request hands
a third party the IP of every reader of a Palestinian heritage archive.

`scripts/subset-fonts.py` generates them and verifies what §9 asks for in the same sentence.
Arabic is a shaped script: joining lives in GSUB/GPOS/GDEF, not in `cmap`, and a subsetter
asked only for codepoints will happily emit a file whose every glyph is present and whose
every word renders as disconnected letters — correct by any count, and unreadable. Nine
probes are shaped through HarfBuzz against the unsubsetted original and must match glyph for
glyph, cluster for cluster, advance for advance. A control with those tables dropped must
fail, and does. A face that does not match is not written.

**Two bugs of my own on the way**, both worth the record because both produced a confident
wrong answer:

1. The check compared a TTF original against a **WOFF2** subset. HarfBuzz cannot read WOFF2.
   All nine faces reported broken. The subsetter now emits both forms and compares like for
   like.
2. The probes were real **phrases**, which contain spaces — and U+0020 belongs to the Latin
   subset by the split. The Arabic face was being asked for a character it deliberately does
   not have, and answered `.notdef`, correctly. Probes are single words now, which loses
   nothing: Arabic does not join across a space, which is the same reason the browser can
   split the run.

`frontend-fonts-test.mjs` checks the committed output from the repository alone — no Python,
no network — by reading the WOFF2 table directory directly (the flag-byte/known-tag encoding
is decodable without decompressing the font). It found **two real defects on its first run**:

- the two subsets **both claimed U+FEFF**. Arabic Presentation Forms-B runs to U+FEFF but
  that codepoint is the byte-order mark and is not an Arabic anything; the Arabic range stops
  one short of it now.
- **three interface glyphs were covered by no face at all.** U+2715 `✕` and U+2304 `⌄` are in
  **neither family** — every close button and the viewer's scroll hint had been rendering
  from whatever font the reader's OS supplied. Now `×` and `↓`, which both families have.
  U+2190 `←` is in both and the range simply did not include it.

Nine files, 264.8 KiB total, of which the one preloaded face (Arabic 400) is 38.8 KiB. A page
transfers only the faces whose ranges match characters on it. Fonts are outside §9's 150 KB
budget by §9's own wording; first paint is **90.5 KiB of 150**.

### RTL (F24)

Zero physical side properties remain. The two survivors became `inset-inline-end` and
`text-align: end`, and each deleted an `html[lang="en"]` override that was the same behaviour
written twice — and a specificity trap besides (`html[lang="en"] .x` is (0,2,1) and outranks
any single-class rule).

`admin.backToSite` shipped `←` in **both** languages. "Back" is where the reading started,
which in Arabic is the right.

**Dates did not exist.** §9 names `Intl.DateTimeFormat('ar-PS')` and, in the same breath,
"one digit system, held consistently" — and every date on the site was the raw ISO day off
the shard, so an Arabic page rendered `٤٢` beside `2026-08-31`. `I18N.day()` formats in
`ar-PS-u-nu-arab` (stated rather than inherited, because `num()` is unconditionally
Arabic-Indic) and in **UTC**, because a day-precision string is a calendar day and the
reader's own zone would render yesterday for everyone west of Greenwich — which a diaspora
archive has.

**The slider was already right, and is now measured right**, in a real browser at two
document directions:

```
ar   docDir rtl   computed direction rtl   transform none   ArrowRight  -1
en   docDir ltr   computed direction ltr   transform none   ArrowRight  +1
```

Exact mirrors. The keyboard is the right thing to measure: a slider mirrored with
`transform: scaleX(-1)` looks correct and reverses its own arrow keys, so that transform is
banned by name in the source test.

### Monitoring (F27) and §11 gate 5

`scripts/monitor.mjs` plus `.github/workflows/monitor.yml`, on a six-hour schedule. The
workflow is deliberately **outside both Supabase and Cloudflare**: a monitor inside the
system it watches cannot report that the system is stopped, and `pg_cron` is already
unscheduled here.

**Gate 5 is discharged live, not argued.** A hold was set on the deployed pipeline; the
monitor reported `ALERT` six seconds later, naming it as an operator hold, distinct from
`unchanged`; the hold was released and it returned to `ok` (`holds_remaining: 0`,
`reason_now: unchanged`).

That first live run found a bug the self-test had not: `publish_pending()` returns
`hold_reason` and this file read `held_reason`, so **the alert named no reason at all** — and
migration 0819170000 is explicit that the column has no default precisely so a person finding
a held pipeline at 3am has something to go on. Fixed, re-proved live, and asserted.

Two design points that would be easy to get backwards, both written into the file:

- **Publish age alone is not a signal.** The cron is unscheduled, so an idle archive's
  fortnight-old release is correct. Age is only ever read together with `pending`; a hold
  alerts on sight whatever the age, which is what "fire on the first" means.
- **`unknown` is not `ok`.** A check that could not look has not said the system is healthy.
  `--require publish` turns a missing credential into a red build on the first night rather
  than a green workflow measuring nothing — which is the failure the gate exists to prevent,
  reappearing in the monitor itself.

19 self-test assertions, run in CI, no credential.

### Lighthouse on throttled 3G / mid-tier Android

Against the deployed origin at 300ms RTT, 700 kbps, 4x CPU, 412x823 @1.75. Run once before
the M6 changes and twice after, and the third run is the reason the second is not quoted
alone.

| route | run | perf | a11y | b-p | seo | FCP | LCP | TBT | CLS | transfer |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| `/` | before | 28 | 93 | 92 | 92 | 4334 | 8150 | 294 | **0.647** | 303 KiB |
| `/` | after 1 | 26 | 93 | **100** | 92 | 5651 | 11319 | 3555 | **0.028** | 582 KiB |
| `/` | after 2 | 58 | 93 | **100** | 92 | 3507 | 10642 | 175 | **0.022** | 582 KiB |
| `/map` | before | 11 | 94 | 92 | 92 | 4244 | 7084 | 1647 | **0.862** | 635 KiB |
| `/map` | after 1 | 28 | 94 | **100** | 92 | 3759 | 10430 | 7754 | **0.055** | 915 KiB |
| `/map` | after 2 | 32 | 94 | **100** | 92 | 3754 | 10308 | 1574 | **0.062** | 914 KiB |
| `/events` | before | 55 | 94 | 92 | 91 | 4343 | 6524 | 25 | 0.225 | 162 KiB |
| `/events` | after 1 | 67 | 94 | **100** | 91 | 3789 | 7277 | 0 | **0.008** | 442 KiB |
| `/events` | after 2 | 68 | 94 | **100** | 91 | 3692 | 6867 | 0 | **0.008** | 442 KiB |

**What is stable across runs, and is therefore a measurement:**

- **CLS collapsed.** 0.647 → 0.022 on the feed, 0.862 → 0.062 on the map, 0.225 → 0.008 on
  events. Google's "good" threshold is 0.1; all three were over it and all three are now well
  under. This is the defect the run was worth doing for, and it is described below.
- **Best practices 92 → 100**, on every route. That is the Google Fonts origin leaving the
  page — the one third-party request the site made.
- **Transfer +279 KiB on every route**, which is the font payload almost exactly (264.8 KiB
  across nine faces; the home page requests all nine, verified live). **This is a real cost
  and it is the price of the fix**: before, the CSP blocked Google Fonts outright, so the
  deployed site downloaded *zero* font bytes and rendered in whatever the OS had. It now
  fetches its own typeface once and caches it for a year. §9 puts fonts outside the 150 KB
  budget for exactly this reason, and first paint is 90.8 KiB of 150.

**What is NOT stable, and is therefore not a measurement.** TBT on `/` came back 294, 3555
and 175 ms across three runs of two code states, and the performance *score* moved with it
(28, 26, 58). The middle run was taken while this machine was running sixteen Chrome
processes and two other probes. `/map`'s TBT is the one figure that reproduces — 1647 and
1574 either side of the change — and that is the canvas map doing real work on a 4×-throttled
CPU. **The performance score on this hardware is not a number to act on**; CLS, transfer and
best-practices are.

**The caveat that belongs on all of it:** these are measured against a handful of published
items, not §3's ~300. `fottage/` holds 22 files. §9's budget is per-page and holds; every
judgement here about feed pagination, shard size or scroll behaviour is **provisional** until
the seed import lands.

### The CLS defect, found and fixed

Attributed with a `PerformanceObserver` rather than guessed at, because Lighthouse names a
score and not a culprit:

```
0.2418  footer.site-footer [412x26 -> 412x412]
0.1212  footer.site-footer [412x190 -> 412x87] | a.memory | a.memory
0.0888  footer.site-footer [412x330 -> 412x190] | ...
```

Two causes, one level apart, and both fixed:

1. **The cards.** The thumb `<img>` had no dimensions, so every card was zero-height until it
   decoded and then snapped to full height. The feed shard now carries `thumb_w`/`thumb_h`
   from `media_assets` — the columns already existed — and `public.js` sets them as width and
   height **attributes**, from which the browser derives the ratio and reserves the exact box
   before a byte arrives. Worst per-card shift: **0.2418 → 0.0024.**

2. **The footer.** With the feed empty for the first seconds on 3G, the footer sat *inside
   the viewport*, where it grew from 26px to 410px as its copy arrived and shifted by 0.24.
   Nothing is wrong with the footer; a shift below the fold costs nothing, and its whole
   contribution was being briefly on screen at all. `#view { min-block-size: 82svh }` holds a
   screen open for the archive before the archive arrives. `svh` rather than `vh`
   deliberately: the small viewport height does not move when a phone's URL bar hides, so the
   reservation cannot itself become the shift it is preventing.

`.memory__plate:has(> .memory__img) { min-height: 0 }` carried a comment saying it "reserves
the row before the image decodes, so a feed of lazy images does not shift the masonry".
**It reserves nothing.** The comment is why nobody looked again.

### Spend Cap (F08)

Not attempted, as instructed. It is an organization-level billing setting with no CLI or
Management API surface.

## What is left, and who owns it

| | |
|---|---|
| the final admin sign-in click | **Amro** — Turnstile will not answer a script |
| `SUPABASE_ACCESS_TOKEN` as an Actions secret | **Amro** — until then the monitor workflow fails nightly, deliberately |
| Spend Cap on | **Amro**, in the dashboard |
| gate 4: a named human on the takedown path | **Amro** — still nobody |
| the pen test | **Amro** — not scheduled |
| password-reset flow | flagged, not built |
| the handle lost on email-confirmed signup | flagged, not built |
| Edge Function error rates in the monitor | needs a Management API token with analytics scope |
