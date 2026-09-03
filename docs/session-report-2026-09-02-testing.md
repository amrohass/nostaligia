# Testing-coverage session — 2 Sep 2026

Closing the gap that let six sessions of UI defects reach Amro before CI did. Six pieces of
work, all six done. **Nothing was built ahead; no milestone was started.**

New scripts, and what to run:

```
node scripts/harness-bootstrap.mjs --all      once, or when a token goes stale
node scripts/harness-bootstrap.mjs --status   live / stale, per role
node scripts/e2e-authenticated.mjs            61 checks   1 known-red (see §1)
PLAYWRIGHT_DIR=… node scripts/e2e-browser.mjs 39 checks   green
node scripts/privacy-shards-test.mjs          44 checks   green
node scripts/mutation-pass.mjs                11 mutations, 11 killed
node scripts/perf-probe.mjs                   measurement, no pass/fail
PLAYWRIGHT_DIR=… AXE_DIR=… node scripts/a11y-sweep.mjs   23 checks, 0 failed, 6 findings
deno run -A scripts/load-test-300.ts          measurement, no pass/fail
```

`PLAYWRIGHT_DIR` / `AXE_DIR` are a scratch `node_modules` with `playwright` and `axe-core`
in it — §9 forbids a build step and this repo has no `package.json`, so they stay outside.

---

## 1 · The structural blocker is gone

**GoTrue's captcha guards the PASSWORD grant. It does not guard the REFRESH grant.**
Measured 2 Sep against the deployed project, with a real harness account and its real
password:

```
POST /auth/v1/token?grant_type=password        400 captcha_failed (no captcha_token found)
POST /auth/v1/token?grant_type=refresh_token   200, a real session
```

So a harness holding a refresh token mints access tokens indefinitely and never meets a
challenge. `scripts/lib/harness-auth.mjs` keeps one per role in a git-ignored
`.harness.vars` (blocked from force-add by `forbidden-paths.ere`, same pattern as
`.dev.vars` and `.backup.vars`), exchanges it, **persists the rotation**, and fails with a
`re-authenticate manually` message naming the exact command rather than failing silently.

Rotation is not optional: GoTrue returns a new refresh token on every exchange and the old
one is good only inside a grace window. A harness that does not write back works once and
then fails days later looking like a broken test.

**Nothing about the deployed Turnstile configuration changed.** The site key, the secret and
the protection setting are untouched; a human still meets a challenge and the server still
verifies one. Cloudflare's always-pass test secret was **not** used — that would disable the
bot gate for every real visitor to close a test gap, and it is the hole the 31 Aug audit
closed.

**The harness admin the project never had.** Until now the only admin was `admin@admin.com`,
a real person's account, so every admin-only capability in §4 was untested or borrowed an
identity. `--all` creates `e2e-admin-…@mail.example.com`, confirmed, and grants it `admin`
through the CLI's postgres connection — `user_roles` has no grant to `authenticated` by
design (0013), so this cannot go through PostgREST even with a service key.

### What the new coverage found

| | |
|---|---|
| `e2e-authenticated.mjs` | 61 checks. **1 failing, and it is real:** takedown answers **207 `objects_remain`**, not 200, because `CLOUDFLARE_PURGE_TOKEN` is unset — §8's CDN purge is a no-op. Gated on Amro; already on the 29 Aug list. |
| `e2e-browser.mjs` | 39 checks, green. Signup confirmation panel (persists 6 s, dismissible, echoes the address in a `<bdi>`), member sign-in landing, **the admin dashboard actually rendering**, and §9's sign-in-gate intent preservation. |

The admin test uses **no test doubles at all**: it seeds a real refresh token into
`sessionStorage['rma.refresh']` the way a returning moderator's browser holds one, and the
page restores the session, calls the real `authz_role()`, fetches `admin.js` and renders
against the real database. That is the shape of test that would have caught the two-day
silent breakage.

The intent test watches the **network**, not the DOM. The UI is optimistic about a like, so
a filled heart satisfies a DOM assertion while nothing reaches PostgREST. It asserts the
`POST /rest/v1/likes` and then deletes the row again.

---

## 2 · Mutation pass — 11 of 11 killed

Six non-discriminating tests have been found in this repository and **every one of them by
accident**. `scripts/mutation-pass.mjs` breaks eleven named invariants one at a time and
checks the suite goes red. SQL mutations ride in on a new `--prelude` hook in
`pgtap-deployed.mjs`, spliced after each file's own `begin;` so they live and die inside the
transaction it already rolls back.

**Result: no non-discriminating test found**, including all five this session was asked to
check — the RLS denial matrix, the function-grants matrix, the bidi strip, the EXIF gate and
the budget assertion.

Two things had to be got right before that answer meant anything, and both are recorded at
the code:

- **The first run reported two SURVIVED and both were my own mutations being no-ops.** The
  prelude lands after `begin;` but *before* the test inserts its fixtures, so a mutation
  written as an `UPDATE` over existing rows touches nothing the test will look at.
  `update posts set location_public = location` rewrote six real rows; the test then created
  a fresh fixture, the trigger fuzzed it correctly, and the file passed. The rule: **mutate
  the mechanism, never the data.**
- **The EXIF mutation moved from `scripts/exif-gate.ts` to `worker/src/ladder.ts`.** The gate
  script needs R2 and a real photograph, so the only thing runnable against a mutated copy is
  `deno check` — which passes whatever the assertion inside says. That mutation could never
  be killed, and an unkillable mutation is worse than none: a permanent false SURVIVED trains
  everyone to ignore the findings list.

---

## 3 · Privacy boundary — 44 checks, none vacuous

§7's properties are all enforced somewhere and all have unit tests. What nothing had was a
test of the **artefact**: the shards on the CDN, fetched with no credential, checked against
the database's own raw values.

Green, and specifically:

- **no raw coordinate in any published file** — checked against the real stored precision
  (`31.904572` vs the published `31.905`), across every shard kind and every prerendered page;
- **every published coordinate traces** to a `location_public` or a gazetteer row;
- `location_precision='hidden'` publishes **none at all**;
- **no email, email-shaped string, auth user id, or time-of-day timestamp** anywhere;
- **no bidi control** — plus a positive control that `strip_bidi()` removes all nine;
- **`profiles.visibility` from three vantage points**, in rolled-back transactions whose
  rollback is itself asserted.

Non-vacuity is the whole difficulty and is handled explicitly: "no raw coordinate appears"
passes trivially against an archive with none, so the ground truth is read **first** and the
run refuses to report a pass without something to look for. Every refusal is paired with the
positive control proving the same call *can* succeed.

**One thing learned rather than assumed:** a signed-out visitor **cannot call `profile_view`
at all** — 0058 revokes it from `anon` on purpose, and `public.js` only calls it when signed
in. So the assertion is the refusal; testing for a null return would have been testing a path
that does not exist.

---

## 4 · Where the time actually goes

Measured from Palestine against the deployed system. **The network dominates and it is not
close.**

```
transport floor to Supabase      ~80 ms   the cheapest round trip observed
slowest database call            117 ms   authz_role(), called on every page load
  of which db work               ~37 ms   (32%)
public read path, cold           128 ms   zero database — §2 holds
Edge Function cold-start penalty ~0–478 ms  (varies; reported apart from warm)
worst single observation         651 ms   cold DNS/TLS — what a first-time visitor feels
```

**Do not upgrade the plan on this evidence.** A bigger instance shrinks the ~37 ms and leaves
the ~80 ms exactly where it is. The levers are fewer round trips per screen, and serving
bytes from an edge near the visitor.

### The largest finding is not a latency number

**The bucket is served over its `r2.dev` development URL, and nothing is cached at an edge.**
Two independent readings: no `cf-cache-status` and no `age` on an object marked
`immutable, max-age=31536000`, and a repeat fetch only **9 % faster** than a cache-busted one
— within noise of no cache at all. Cloudflare does not cache `r2.dev` and does rate-limit it.

So §2's "Browser → CDN → media" is at present **"Browser → bucket"** for every visitor, on
every shard and every thumbnail. Attaching a custom domain with a cache rule is what makes
§2 true. That is blocked on the production host, which is already on Amro's list — but it is
now a *performance* reason as well as a §2 one.

Lighthouse's score is deliberately unused: 3555 ms vs 175 ms TBT on identical code twenty
minutes apart cannot support a decision.

---

## 5 · Load test — both provisional judgments hold

`FEED_PAGE_SIZE = 24` and `GEO_PRECISION = 5` were both set against 22 items and both say so.

| | 300 items | 1,500 items (§2's own threshold) |
|---|---|---|
| feed pages | 13 | 63 |
| `feed/page-1.json` | 9.3 KiB raw, **2.3 KiB compressed** | unchanged |
| §9 headroom | 58.2 KiB after 91.8 KiB static | same |
| geo cells | 4, busiest 70 items | 4, busiest 334 |
| largest geo shard | **30.3 KiB** | **145.0 KiB** |
| objects per release | ~627 | ~3,077 |
| `buildShards()` warm | 44 ms (0.15 ms/item) | 72 ms (0.05 ms/item) |

**Both hold.** The number to watch is the busiest geo cell: it is the whole map in one
request and grows linearly. At 1,500 items it is 145 KiB. `shards.ts` already names precision
6 as the one-line alternative — 32 cells, busiest 66 items — at the cost of one extra request
per pan.

Nothing touched a database. Every figure is a pure function of the rows, so the real
production shard builder is imported and run over synthetic rows in memory — a stronger
guarantee than a throwaway database, not a shortcut around one. Every row is titled
`SYNTHETIC`.

**Two measurement errors caught, either of which would have been reported as a finding:**

- the first run timed **one cold call** and reported **11,891 ms** for 300 items, which reads
  as a quadratic publisher. A scaling sweep came back 50→1881, 100→658, 200→62, 400→1643 —
  non-monotonic, so it was never measuring the algorithm. Warm median is 44 ms.
- **the synthetic compression ratio flatters.** Ten distinct titles and one repeated word
  compress far harder than archival prose (9.3 KiB → 1.0 KiB). The live archive's own page is
  fetched, its real ratio measured (24 %), and the synthetic page re-costed at that. **2.3 KiB
  is the honest number** and it is the one the verdict uses.

---

## 6 · Accessibility — §9's six, and two were broken

All six were implemented and **none had ever been verified**. Both defects are fixed.

**FOCUS RESTORE was not happening.** Closing the viewer left focus on `<body>` — the top of
the page, with the whole feed to tab through again. The cause is invisible from `trapFocus`:
the archive re-renders on the route change to `/item/{id}`, so by the time the trap is
installed the card the reader activated is already detached and `activeElement` has fallen
back to `<body>`. `release()` then focused a detached node, silently a no-op.

My **first attempt at that fix changed nothing** and the reason is recorded at the code: it
tested `previous.isConnected`, and `<body>` *is* connected, so the fallback never ran.
Excluding `document.body` is the whole fix.

**THE DESCRIPTION FIELD WAS NOT REQUIRED.** §9 asks for a "required description field on
upload (frame it as archival metadata)". The framing was done — *what do you remember of this
moment* — and the requirement was not, so an entry could be filed with a photograph and no
account of what it is.

The sweep's own assertion was wrong first too: it stamped the opener and asserted the
identical node returned, which no correct implementation can satisfy across a re-render. It
asserts the `href` now.

### Findings outside §9's six — reported, not fixed

`--strict` gates on these once somebody owns the decision.

| where | what |
|---|---|
| `/`, `/map`, `/events` | **colour contrast**, 9 / 6 / 3 elements — `.wordmark__secondary`, `.memory__gloss`, `.site-footer__mark-sub` |
| admin dashboard | **colour contrast**, 16 elements — `.rail__sub`, `.rail__exit` |
| upload dialog | **critical: a `<select>` with no accessible name**, plus two unlabelled inputs |

The upload dialog is the one screen a contributor *must* complete, so its `select-name` is
the finding here most worth attention. Repainting a colour system is a design decision with
an owner, which is why none of this was changed.

---

## What is still Amro's

Unchanged from 1 Sep, plus one new reason for an existing item.

1. **Sign in to `/admin` in a real browser.** Still a person's click — but the dashboard is
   now proved to render end to end against the real database by `e2e-browser.mjs` §3.
2. **`SUPABASE_ACCESS_TOKEN` as a GitHub Actions secret.**
3. **Spend Cap ON.**
4. **Gate 4 — a named human on the takedown path.** Still nobody.
5. **The pen test.** Not scheduled.
6. **The production host / custom domain.** Now also the single largest performance lever
   (§4 above) and what unblocks `CLOUDFLARE_PURGE_TOKEN`, which is why takedown reports 207.
7. Custom SMTP, the ~300 seed items, the second R2 account's credentials.

## Deliberately not done

- **Cloudflare's always-pass Turnstile secret on the deployed project.** Asked for explicitly
  and refused: it would disable the bot gate for every real visitor.
- **The colour-contrast and form-labelling fixes.** New scope; §12 says the smallest change
  that satisfies the task.
- **Any milestone work.** All six items are testing.
