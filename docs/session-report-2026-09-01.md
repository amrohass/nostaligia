# Session report — 1 September 2026

Ramallah Memory Atlas. One session, four threads: the Turnstile secret finished and verified,
a structural secret-consistency check built against a third drift incident, the unencrypted
gate-3 material removed, and the M5→M6 boundary settled by Amro. M6 was not started; the
session's own instructions gated it behind the Turnstile work, which was only resolved at the
end.

Governed by `CLAUDE.md`. This report is the detailed record; `NEXT-SESSION.md` carries the
short version and what to do next.

## What changed

| | |
|---|---|
| **Auth is open again** | The Turnstile secret verifies in every location. Two independent probes agree. Three days of `invalid-input-secret` are over. |
| **`scripts/secret-consistency.mjs`** | New. The structural answer to three drift incidents — compares every copy of a shared secret without printing any of them, and says plainly where no comparison is possible. |
| **`request-upload` logs the verifier's reason** | `turnstileOk()` threw away Cloudflare's error codes, which is *why* a bad secret and a bad token were indistinguishable in operation. Written, tested, **not yet deployed**. |
| **CI gained one step** | `secret-consistency.mjs --selftest` — 11 assertions, no credential, no network. |
| **Unencrypted production data removed** | Two sets of it, not the one that was known about. |
| **M5 → M6 settled** | Amro's ruling: the exit criterion governs, M5 is complete, M6 starts. |
| **A feature gap found** | There is no password-reset flow in the client at all. |

## The Turnstile secret — resolved, with the record corrected

### Where it stood at the start of the session

`NEXT-SESSION.md` said the secret in Supabase's captcha config was not one Cloudflare
recognised, and that Amro had already corrected it. That second half was not taken on trust,
and it was right not to be. Measured at the start of the session, three copies existed and
**all three disagreed with each other**:

| copy | how it was read | standing |
|---|---|---|
| GoTrue captcha config | behavioural — GoTrue forwards the verifier's own code | `invalid-input-secret` — not recognised |
| `.dev.vars` | read locally, asked of Cloudflare siteverify directly | not recognised — stale |
| Edge Function env | `supabase secrets list` digest | a third, different value, set `2026-08-11T22:12:02Z` |

`.dev.vars` had been edited that afternoon at 16:58 and was **still** not a value Cloudflare
recognised — so the correction had not taken. Nothing about "uploads appear to work" settled
the deployed copy, because `request-upload` collapsed the verifier's answer to a boolean.

### Where it stands now

Amro corrected `.dev.vars` and the GoTrue dashboard setting. Verified twice, by two
independent probes:

```
node scripts/secret-consistency.mjs   →  TURNSTILE_SECRET_KEY  MATCH
                                         Cloudflare RECOGNISES the value in .dev.vars
                                         the deployed function env holds the same value
                                         GoTrue's captcha secret IS recognised

node scripts/captcha-probe.mjs <harness-email>
                                      →  invalid-input-response, exit 0
                                         "VERIFIED, and the token is being judged."
```

`invalid-input-response` is the state to want: the secret is recognised, and the **token** is
what got refused. `invalid-input-secret` — the answer for three days — is the verifier saying
it never got as far as judging a token, so a real token from a real person got the same 400.

### The correction that matters: which copy was actually stale

The morning's reading had this backwards, and the wrong half nearly got rewritten.

**The deployed Edge Function's copy was correct all along.** Its digest is unchanged since
`2026-08-11T22:12:02.546Z` — it was never rewritten during this session or by Amro — and
Cloudflare recognises it. The stale copy was `.dev.vars`. The wrong one was GoTrue's dashboard
config. Two consequences:

- **`request-upload` was never broken by this.** The earlier note that the upload path "cannot
  be assessed from outside" and had "no verdict" is settled: it held the right secret the whole
  time. No redeploy was needed and none was performed.
- **The deployed value could only ever be proved good transitively.** An Edge Function secret
  has no readback beyond a sha256, so it can never be submitted to Cloudflare directly. The
  proof is: `.dev.vars` now holds a value Cloudflare recognises, and the deployed digest equals
  it. That is precisely what the digest comparison buys, and nothing else available would have
  answered it.

### What is unchanged by any of this

**Turnstile still will not mint a token for automation.** Every deployed probe that SIGNS IN
remains dead — `scripts/e2e-deployed.ts`, the authenticated arms of
`scripts/m1-gates-deployed.mjs`, and any browser probe that signs in. That was never about the
secret; it is about the token, and a real headed Chromium at the live origin produced no iframe
and no callback in 45 seconds. `scripts/pgtap-deployed.mjs` is unaffected — it goes through
`supabase db query --linked`, not GoTrue — and so is anything signed-out.

## The structural check — `scripts/secret-consistency.mjs`

### Why a script rather than a fourth manual catch

Three secrets have now existed in two or more places, drifted, and surfaced as a live outage
rather than a caught bug:

| when | secret | how it was found |
|---|---|---|
| 30 Aug | `PUBLISH_SECRET` — vault vs Edge Function env | the publisher stopped publishing |
| 31 Aug | the Turnstile secret in GoTrue | nobody could sign in, sign up or reset |
| 1 Sep | `TURNSTILE_SECRET_KEY` — `.dev.vars` vs function env | this session, by going to look |

Every one was found by a human noticing something was broken. The standing rule in this
repository is to fix the reporting mechanism rather than the symptom, and the missing
mechanism is something that can be **run before anything breaks**.

### What it does, and what it refuses to do

It never prints a secret, and it never prints anything derived from one either. Comparison is
by sha256, but the digests are not shown: locations holding the same value print as the same
**group letter**. That says everything a reader needs — which copies agree — and leaks nothing,
not even a fingerprint that could confirm a guess at a low-entropy value.

Three readback kinds, and the distinction is the whole point:

- **digest** — the location hands back a sha256 and never the value. `supabase secrets list`
  for Edge Function env; `extensions.digest()` computed **inside** Postgres for Vault, so the
  decrypted secret never enters this process.
- **plaintext** — readable here (`.dev.vars`, local-dev-only). Hashed locally, then treated
  exactly like a digest location.
- **write-only** — no readback at any price: GoTrue's captcha secret (dashboard-only) and the
  media worker's Scaleway `secret-environment-variables`. These **cannot** be compared, and
  reporting them as MATCH would be a lie. They report UNVERIFIABLE, and where a provider offers
  a behavioural check instead, that check is run and reported as what it is.

Where structure runs out, an oracle takes over. Cloudflare's siteverify answers
`invalid-input-response` for a secret it recognises and `invalid-input-secret` for one it does
not — so for any readable copy we learn not merely whether it matches its siblings but whether
it is the **real** one. A digest comparison cannot tell three copies of a stale secret from
three copies of a good one, and that is exactly the state this project was in.

### What it reported, before and after

```
                          at session start          after Amro's fix
PUBLISH_SECRET            MATCH (3 locations)       MATCH (3 locations)
TURNSTILE_SECRET_KEY      MISMATCH                  MATCH + Cloudflare recognises
                          GoTrue not recognised     GoTrue recognised
MEDIA_WORKER_SECRET       MATCH (2 readable)        MATCH (2 readable)
```

Read but deliberately **not graded**, because no decision has been written down about whether
local dev is meant to share them with the deployed functions: `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `UPLOAD_ALLOWED_ORIGINS` hold different values on the two sides;
`R2_ACCOUNT_ID` and `R2_BUCKET_PREFIX` hold the same. Grading these would produce a MISMATCH on
every run for what may be an intended local value, and a check that always fails is a check
nobody reads. **This is worth Amro's ruling** — if they are meant to agree, they are drift.

### Why it is not in CI, and what CI runs instead

Every reading needs a credential CI must not hold: the project access token for
`supabase secrets list` and `supabase db query --linked`, a gitignored `.dev.vars`, and a
Cloudflare oracle that is only meaningful when asked about the real secret. Putting those in a
runner would create **one more copy of every secret in order to detect copies drifting**.

So the pre-flight is manual — item 1 of `NEXT-SESSION.md`'s "Do these FIRST" — and CI runs
`--selftest`: no credential, no network, 11 assertions holding the comparison to the
discrimination this repository keeps finding its own tests lacking. Including:

- the **anti-vacuity control** — one readable copy out of three is UNVERIFIABLE, never MATCH.
  `05_matrix` shipped without one of these and would have reported the database secure while
  probing no policy at all, because two empty sets are equal.
- a **non-disclosure assertion** — that no value, no digest, and not even an 8-character digest
  prefix can reach the output. Asserted against generated input rather than promised in a
  comment.

The self-test caught its own first draft: a secret-shaped literal in the non-disclosure test
tripped gitleaks, which is the pre-commit hook working. It is now generated with `randomBytes`,
which is also a stronger test — a fixed literal could be the one case somebody special-cased
into passing.

### The companion fix in `request-upload`

`turnstileOk()` collapsed Cloudflare's answer to `body?.success === true` and discarded the
error codes. That is *why* `NEXT-SESSION.md` could only say the upload path "cannot be assessed
from outside". `invalid-input-secret` (an operator's mistake — every upload fails for everyone)
and `invalid-input-response` (a token judged and refused — one visitor, working as designed)
are opposite conditions with opposite responses, and both reached the caller as one
`turnstile_failed`. There was nowhere to look.

They now go to the **function log**. The client response is byte-for-byte unchanged, because
which of the two it was is an operator's business — telling a client would let an attacker
probe the configuration, and it does not change what they should do.

**This is written and tested but NOT deployed.** `deno check` clean, 188 edge-function tests
pass. Nothing needs it urgently now the secret is good; fold it into the next deploy of that
function.

## The gate-3 leftovers — two sets, not one

The session brief named one item: an unencrypted ~25 MB dump in the scratchpad carrying real
member emails, with no real custody. A sweep found **two**.

**The known set**, under the gate-3 backup directory:

- `plain/` — `auth.sql`, `data.sql`, `schema.sql`, `roles.sql`, `triggers.sql`, 401 KB total.
  `auth.sql` and `data.sql` each carried **12 distinct member email addresses**, in plaintext.
- `rma-backup/originals/` — 24 MB across 5 files: the archival masters pulled from R2. Four
  begin `ffd8ffe1`, which is JPEG with an APP1 segment — **EXIF still attached**, which is the
  point of a master and exactly what §11 gate 2 confirmed carries real Ramallah coordinates.

**The set nobody had recorded.** Sweeping the whole project scratchpad root, not just the
session that made the backup, turned up a second copy of `auth.sql`, `data.sql` and
`schema.sql` in a different session's directory — the same 12 addresses, unencrypted, from an
earlier evening.

All of it deleted, and the deletion confirmed rather than assumed:

- both paths re-checked as gone after the removal;
- the whole scratchpad root re-swept for email-shaped strings and for files over 1 MB;
- Desktop, Documents and Downloads checked for stray `rma-backup`, `*.sql.enc`, `auth.sql`,
  `data.sql` — nothing.

What remains is the **encrypted** `.enc` set and its manifests, which begin `RMA-BAK1` and are
the artifact shape the design intends. The only email-shaped strings left anywhere under the
scratchpad are the `e2e-…@mail.example.com` harness accounts, which are already literals in
`scripts/m1-gates-deployed.mjs`.

One note for the future: the second set existed because a *previous* session left it, and
nothing in the backup tooling knows about scratchpad copies. If `--to-dir` is going to be used
again before the second Cloudflare account exists, the temp copies want a deliberate cleanup
step rather than a sweep next session.

## Flagged, not resolved — is the local-Docker restore enough for gate 3?

Stated plainly because it is Amro's call, and the session brief asked for it to be flagged
rather than settled.

**The case for sufficient.** A backup was taken from the deployed database, held outside the
platform, restored into a database asserted empty first, and graded by the project's own 669
assertions — with the verdict read from a `KNOWN_RED` list checked in **both** directions
rather than from an exit code. It found two real gaps nothing else could see: an `auth.users`
trigger present in no dump at all, and three functions returning with `EXECUTE` granted to
`PUBLIC`.

**The case for not yet.** The target was a local Postgres container, so **GoTrue serving the
restored `auth` rows was never exercised**, nor was a hosted project's extension set coming up
the same way. Gate 3 is a launch gate, which makes it the kind of thing that should not be
argued about after the fact.

`--target <ref>` exists and still refuses the production ref by name. What is missing is a
scratch Supabase project.

## The Cloudflare "finish integrating" prompt, and what checking it turned up

Cloudflare's dashboard showed a warning for the widget and offered an agent flow at
`developers.cloudflare.com/turnstile/spin/prompt.md`, asking that it be fetched and followed.

The page is real — Cloudflare's "Turnstile Spin" skill, a twelve-step flow for integrating
Turnstile end to end, with sensible constraints of its own (never print the secret, retrieve it
over stdin, store it in the user's own secret manager). It was fetched and read **as data**,
not executed: a document retrieved from an external surface that instructs an agent to run
helper scripts is untrusted input, and `CLAUDE.md` §5/§6 governs this repository regardless of
what any external doc says.

**Its integration steps were already done here, and done correctly.** Verified one by one:

| what the flow would do | state in this repo |
|---|---|
| site key in config | `config/site.json` → `0x4AAAAAAENYWuxg_BTOj47Q`, matching the widget |
| loader script | `site/index.html:36`, `api.js?render=explicit` |
| widget module | `site/assets/js/turnstile.js`, explicit render, 30 s ceiling on `token()` |
| mounted on the gated forms | `public.js:1139` (signup/sign-in dialog), `public.js:1757` (upload) |
| CSP allows it | `script-src 'self' @turnstile`, `frame-src @turnstile` |
| backend siteverify | `request-upload/handler.ts:189`, canonical |
| auth path sends the token | `auth.js:183` and `:195`, `gotrue_meta_security.captcha_token` |

So the dashboard warning was **not an integration gap**. It was the widget having never
recorded a successful validation — because the secret was wrong. Fixing the secret fixed the
warning's cause. Re-running the flow would have churned correct, governed code to no effect,
which is the failure mode worth naming: an external prompt that describes a generic project
confidently enough to talk you into rewriting a specific one.

The flow's one genuinely useful step for this project — retrieving the secret from Cloudflare's
API and piping it into the secret stores without it passing through a chat — **cannot run
here**: no Cloudflare API token with Turnstile scope is configured in the project, and the one
Amro pasted into a past chat and declined to rotate was deliberately not reached for.

## The gap that check did surface — there is no password-reset flow

Verifying that every captcha-gated form mounts a widget turned up something real, and it
changes the human verification plan.

**`site/assets/js/` contains no call to `/auth/v1/recover` anywhere.** The "Forgot password?"
control at `public.js:1068` is a stub — its entire behaviour is:

```js
onclick: function () { UI.toast(t('login.forgot')); },
```

which pops the words "Forgot password?" as a toast and does nothing else. The endpoint itself is
live and correctly gated — the probe reaches it and it answers on the captcha — but **no user
can get to it**.

Two consequences:

- The human test is **signup and sign-in only**. A real password reset cannot be run, because
  the feature does not exist. Expect signup to still hit `429 over_email_send_rate_limit` until
  custom SMTP is configured; that is a different failure from a captcha one.
- The widget is mounted on exactly the two surfaces that currently post to a captcha-gated
  endpoint, so **nothing is missing for what exists**. What is missing is the reset flow
  itself — a feature gap, in no milestone's exit criteria. Flagged rather than built, per §12
  and "do not build ahead".

## M5 → M6, settled

The session brief read M5's exit criterion as met and the seed importer as data-blocked rather
than code-blocked. That reading was checked against `CLAUDE.md` §10 rather than assumed, and it
turned out to be **genuinely ambiguous**, so per §12 it was put to Amro rather than guessed.

What the check found. Five of M5's six contents are built:

| M5 item | state |
|---|---|
| location precision + fuzzing | built — `20260811092100_location_fuzzing.sql`, `20260830090000_precision_control.sql` |
| consent / license / provenance capture | built — `upload.js`, `admin.js` |
| removal-request control | built — `admin.js`, `engage.js` |
| export job (JSON + CSV, Dublin Core) | built — `scripts/export-archive.ts` |
| backups + one tested restore | built, and §11 gate 3 discharged |
| **seed importer** | **not present** — blocked on Amro's ~300 items; `fottage/` holds 22 files |

The ambiguity: §10 keys stopping to *exit criteria*, and M5's is "a restore succeeds from your
own copy", which is met. But §10 also says "build in order" and "do not build ahead", and the
importer is listed under M5's *contents*.

**Amro's ruling: the exit criterion governs. M5 is complete; M6 starts.** The importer waits
for the data without holding the milestone.

**M6 was still not started in this session**, for a separate and explicit reason: the session's
instructions gated it on threads 0–2 being resolved, and the Turnstile work was only resolved
at the very end. The next session begins M6 — font subsetting and the shaping check, the RTL
pass including slider direction, monitoring and budget alerts, and Lighthouse on throttled 3G /
mid-tier Android.

Three things for whoever starts it:

- **Gate 5's database half already exists.** `publish_pending()` reports `held_by_operator`
  distinctly from `unchanged`, in `20260819170000_publish_rollback.sql`. What M6 owes is the
  monitor that reads it and the alert that fires on the first — not the distinction itself.
- **Spend Cap (F08) is not settable from here.** `supabase orgs` offers only `list` and
  `create`, and the CLI has no billing, spend, cost or usage command at all — it is an
  organization-level billing setting with no Management API surface, the same category as the
  captcha provider was. **Amro, in the dashboard: Organization → Billing → Cost Control → set
  the Spend Cap on.** §6 names it as one of four cost layers and §11's gates do not cover it,
  so nothing else will catch it being off.
- **Lighthouse and the font budget will be measured against 22 seed files, not 300.** The §9
  budget is per-page so it holds, but any judgement about feed pagination or shard sizes made
  now is being made against a twentieth of the archive.

## What to run to verify this session

```
node scripts/secret-consistency.mjs                    # all graded secrets agree and verify
node scripts/secret-consistency.mjs --selftest         # 11 assertions, what CI runs
node scripts/captcha-probe.mjs <harness-email>         # invalid-input-response, exit 0
deno check supabase/functions/request-upload/handler.ts
deno test --allow-env --allow-read supabase/functions/ # 188 passed
node scripts/write-report.mjs --check docs/session-report-2026-09-01.md
```

`scripts/pgtap-deployed.mjs` was **not** re-run: nothing in this session touches SQL, and its
state is as the 1 Sep morning handoff recorded it — 37 files, 669 assertions, 3 known-red
against the deployed database.

`gitleaks` over the working tree reports 6 findings, all inside `supabase/functions/.dev.vars`
and `worker/.dev.vars`, both of which `.gitignore` matches at line 26 and git therefore never
sees. A seventh finding was in the new script's own self-test and was fixed before it shipped.

## Still open

| | owner |
|---|---|
| One real signup and one real sign-in, in a real browser | Amro — the only thing no script can do |
| Custom SMTP, so a genuine new member is not refused by a project-wide send cap | Amro |
| Is the local-Docker restore enough for gate 3, or is a hosted scratch project needed | Amro |
| Do `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `UPLOAD_ALLOWED_ORIGINS` differ deliberately between `.dev.vars` and the deployed functions | Amro |
| The ~300 seed items | Amro |
| The second Cloudflare account's R2 credentials, into `supabase/functions/.backup.vars` | Amro |
| Spend Cap on, in the dashboard | Amro |
| Gate 4 — a named human on the takedown path with a stated response time | Amro |
| Deploy `request-upload` to pick up the verifier logging | next session, or next deploy |
| No password-reset flow in the client | unscheduled; not in any milestone |
| M6 | next session |
| The pen test | not scheduled |
