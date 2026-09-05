# 5 Sep 2026 — deferred email confirmation, built; and the label defect fixed on the way

Two pieces of work. The first was a defect nobody had to decide anything about. The second
is the one that had been stopped at §12 since 3 Sep, and it proceeded because both questions
it was waiting on were answered: **mechanism B**, and **gate all four**.

    node scripts/pgtap-deployed.mjs --tap --prelude <0060>   38 files  695 assertions
                                                             3 red: 20_publish_cron 14/23/24,
                                                             known and unchanged since M2
    PLAYWRIGHT_DIR=… node scripts/e2e-browser.mjs           103 checks  green   (30 new)
    PLAYWRIGHT_DIR=… AXE_DIR=… node scripts/a11y-sweep.mjs   34 checks  0 failed (6 findings)
    deno test --allow-env supabase/functions/resend-confirmation/   11  green
    deno test --allow-env supabase/functions/request-upload/        22  green
    node scripts/frontend-view-test.mjs   53      node scripts/frontend-auth-test.mjs  69
    node scripts/frontend-map-test.mjs    63      node scripts/frontend-csp-test.mjs   14
    node scripts/frontend-rtl-test.mjs    12      node scripts/frontend-fonts-test.mjs 14
    node scripts/frontend-cors-test.mjs    6      node scripts/frontend-budget.mjs  104.8/150 KiB
    node scripts/privacy-shards-test.mjs  44      node scripts/mutation-pass.mjs    21 in the
                                                  catalogue: 13 KILLED, 0 SURVIVED, 8
                                                  INCONCLUSIVE until 0060 is applied (§2.9)

---

## 0 · READ THIS BEFORE DEPLOYING ANYTHING

**Migration 0060 must be applied BEFORE the Edge Functions are redeployed.** Not a
preference — an ordering:

`request-upload` gained a gate that calls `public.email_confirmed()`. Against a database
that does not have 0060 yet, PostgREST answers 404, the handler reads that as
`confirmation_check_failed` and refuses with a 502. **Every upload would break** in the
window between deploying the function and applying the migration.

It refuses rather than passing on purpose — §5 says deny by default, and a confirmation
check that could not run has not confirmed anybody. The ordering is what makes that safe:

    supabase db push                     # 0060 first
    supabase functions deploy request-upload resend-confirmation
    # then the site

The front end is the other way round and needs no ordering at all: every gate reads
`state.confirmed`, and a status RPC that 404s leaves it `null`, which passes. A browser
running today's `public.js` against a database without 0060 behaves exactly as it did
yesterday. That is deliberate and it is tested.

**And one dashboard change that is Amro's, whenever he wants it:** Authentication →
Providers → Email → turn "Confirm email" OFF. Everything here works with it either on or
off — see §2.4 — so there is no rush and no window.

---

## 1 · The label defect (commit `3ca6d5d`)

The 2 Sep sweep reported a **critical `select-name`** on the share sheet and two unlabelled
inputs beside it; the 3 Sep session scoped them into the confirmation work because they
happened to touch the same component. That work was blocked on a decision. This was not,
and the share sheet is the one screen §9 says a contributor MUST complete.

It was one defect wearing nine hats. `el('label.field__label', { text: … })` placed beside a
control is a caption: the control gets no accessible name, and clicking the words does not
move focus into it. **Five controls had no name at all** — the licence select, the
provenance box, the place search, and the admin sign-in's email and password. **Six more had
been papered over with `aria-label`**, which supplies the name and leaves the click broken;
`langPair`'s two sides announced "<label> (English)" while the words above them read
"<label> — English".

`UI.labelFor` is the fix — the same `for`/`id` pairing `public.js`'s own `field()` has always
used, hoisted into `ui.js` so `admin.js` and `admin-boot.js` can reach it, with `field()`
now going through it rather than keeping a second copy.

**The thing worth remembering, because it is a test that could not fail.** axe's `label` rule
**accepts a non-empty placeholder as an accessible name**. The admin sign-in boxes had one,
so the axe pass on that screen is green with or without the fix — measured by running the
sweep against the `label-detached` mutation. The assertion that discriminates reads
`el.labels.length`, the association itself. The sign-in screen was also a surface the sweep
had never visited: section 5 arrived with a session in `sessionStorage` and went straight
past it.

Accessible **names** are now a failure rather than a finding, everywhere the sweep runs axe.
Colour contrast is untouched and is still the whole of what it reports.

---

## 2 · Email confirmation — migration 0060 and everything around it

### 2.1 · Why the project owns the flag

Measured 3 Sep against the live project, and it is the finding the whole design turns on:
**GoTrue v2.196.0 cannot grant a session to an unconfirmed account.** The two settings are
mutually exclusive halves of what was asked for — `mailer_autoconfirm: false` returns a user
and no session; `true` returns a session and stamps `email_confirmed_at` at signup, sending
nothing. Deferred confirmation is not reachable by configuration.

So `public.email_confirmations` is the flag, shaped exactly like `user_roles` under §4:
service role only, no grant to anon or authenticated, no policy, read by RLS through
`public.email_confirmed()` — the `authz_role()` pattern, unchanged.

### 2.2 · What may set it, which is the trust boundary

We mint no token, set no expiry and write no single-use or replay logic — the part of this
§6 would least want us writing ourselves. The confirmation mail is **GoTrue's own magic
link**. Clicking it establishes a session whose `amr` records how it was obtained, and
`public.confirm_email()` stamps the flag **only** when `amr` names a mailed-link method.

`amr` is inside a token GoTrue signed. A browser cannot edit it without invalidating the
signature, and PostgREST verifies that signature before `auth.jwt()` has a value at all. A
password session asking to be confirmed is refused **by name** (`not_a_mailed_link`), and the
test asserts the row is still unconfirmed afterwards — merged into one assertion, a function
that returned a refusal and stamped anyway would pass.

`recovery` counts as a mailed link. A reset link proves mailbox control just as completely,
and refusing it would tell a member who has *just* proved it to go and prove it again.

### 2.3 · The gate RLS could not reach, and how it was nearly missed

`public.claim_upload_slot` is SECURITY DEFINER: it inserts the draft post **as its owner**,
so RLS on `posts` never evaluates on the one path a member actually uploads through. A
version of this migration that added `email_confirmed()` to `posts_insert` and stopped there
would have been green on every policy test and left the upload door open.

`posts_require_confirmed_email`, a BEFORE INSERT trigger, is what closes it. It is scoped to
sessions that have a `uid`, so the seed importer and every service-role write are untouched
— those are trusted by §6 and have no mailbox to prove.

Two things fell out of writing the test, both worth keeping:

- **The trigger answers before RLS does.** A BEFORE ROW trigger fires before the WITH CHECK
  is evaluated, so an unconfirmed post insert comes back `23514 email_unconfirmed` rather
  than a generic row-level-security violation. That is the better error to hand a client —
  and it means `posts_insert`'s own confirmation term can never be observed through an
  ordinary insert, which is how a redundant clause rots unnoticed. The test **disables the
  trigger for one statement** to ask the policy directly. "Two independent mechanisms" is a
  fact in this file rather than a claim.
- **Comments, likes and saves answer `42501`.** Two error shapes for one boundary, because
  only `posts` has a definer path. Both are recorded at the code.

### 2.4 · Why this is safe to deploy before Amro touches the dashboard

The backfill copies `auth.users.email_confirmed_at` into the new table once, so **every
account that exists today keeps working**. Until "Confirm email" is turned off, a new signup
still gets no session, clicks the mail GoTrue sends, and lands with a session whose `amr`
says it came from a link — which is exactly what `confirm_email()` wants. Both worlds work;
only the source of the mail changes.

The cost, recorded rather than discovered later: once it *is* turned off,
`auth.users.email_confirmed_at` becomes always-set and meaningless. Two flags in one
database, one of them a lie. The comment on the table is where somebody about to read the
wrong one finds that out.

### 2.5 · The resend, and the one thing it must not do

`supabase/functions/resend-confirmation`. Gate order: shape → auth → **our rate limit** →
the address → GoTrue.

- **Our limit is 60 seconds per account**, in the database, in front of the provider's cap —
  which is project-wide, so without a per-account limit one member holding a button down
  spends everybody's. It is claimed **before** the mail is sent, deliberately: the cheap
  failure is one member waiting a minute, the expensive one is a retry loop against a paid
  mail API.
- **`claim_confirmation_send()` is called with the MEMBER'S OWN token**, not the service key.
  That is also what authenticates them: PostgREST verifies the signature and derives
  `auth.uid()` itself, rather than the Edge Function reading a subject out of a token nothing
  checked. A version taking `p_user uuid` from a service-role caller would have let a forged
  JWT mail anybody.
- **The address is never accepted from the caller.** It is read from that same token *after*
  the database has accepted it — the pattern `request-upload` uses for the object key. An
  endpoint that mailed an address a browser supplied is an open relay aimed at strangers.
  The browser test asserts the request body contains no `email` key at all, and a mutation
  that adds one (correctly!) is killed.
- **The Turnstile token is forwarded, not verified here.** A Turnstile token is single-use:
  verifying it and then forwarding it would spend it twice. Measured 5 Sep against the live
  project — `POST /auth/v1/magiclink` with no captcha answers `400 captcha_failed … (no
  captcha_token found)` — so the gate is real and it is GoTrue's.

Stated plainly rather than implied: a client that skips this function and calls GoTrue
directly meets the provider's cap and not ours. This bounds the ordinary case, which is the
case that happens.

### 2.6 · The front end

- **`state.confirmed` has three values and the third is not a bug.** `true`, `false`, and
  `null` for "we have not been told". **Null passes.** A status request that failed must not
  lock a member out of contributing: the database is the boundary and will refuse them if
  they really are unconfirmed, whereas a client that guessed `false` would turn one failed
  request into an archive nobody can write to. Pinned by the `confirm-unknown-locks-out`
  mutation, because tightening it to `=== true` looks like a cleanup.
- **The screen carries the resend IN it.** A screen that says "check your email" and offers
  no way to be sent another one is a dead end for the exact member who needs it.
- **It keeps §9's promise through a second gate.** The pending action survives the
  confirmation the way it survives sign-in: press Share → confirm → the share sheet opens,
  not the archive. The one place `onSignedIn` now *waits* on the confirmation read is the
  pending intent, because that is the only action that runs without the member pressing
  anything — and it is the one where a null read would open the share sheet to somebody
  about to be refused.
- **The share sheet is gated before it is built.** Asking somebody to write an archival
  description and choose a licence and then refusing spends their effort to tell them
  something we knew when they pressed the button.
- **A confirmation link is ADOPTED, unlike a recovery link, which is held.** The difference
  is deliberate: a magic link *is* a sign-in link, and refusing to adopt it would strand the
  member on a screen saying "now go and sign in". §7's borrowed-device concern is bounded
  rather than dismissed — the refresh token lives in `sessionStorage` and dies with the tab.
  The fragment is still replaced out of the URL immediately.
- **Reporting is NOT gated.** §7 makes the removal request the control a person *in* a
  photograph reaches for, and that person has most often just made an account for that one
  purpose. A mail round trip in front of it would silence exactly who it is for. `guard()`
  stays sign-in-only; `contribute()` is the new one.

### 2.7 · The fixtures, and why thirty-five files changed

Every pgTAP file that creates an account now confirms it. That is not bookkeeping: it is the
gate working. A fixture member who could still post would mean the gate was not there.

The unconfirmed case has **one** file — `37_email_confirmation`, 26 assertions — rather than
being asserted in thirty-five others, which would be thirty-five copies of one boundary all
drifting separately.

`00_structure`'s policy-free-table ratchet went from seven to eight, which is the ratchet
doing its job: "adding a table without deciding its policy fails here rather than shipping
open."

---

## 2.8 · An incident, and the harness change it forced

A background `mutation-pass` run was killed when the session ended. Its in-memory restore
never ran — `finally` does not cover a kill — and the file it was holding,
`supabase/migrations/20260905090000_email_confirmation.sql`, was left as **23,563 NUL
bytes**: NTFS had committed the restore's new SIZE and never flushed its data. The file was
still untracked, so git had no copy of it. It was rebuilt from this session's transcript and
then **verified functionally rather than by eye** — the whole suite, against the deployed
database, with the rebuilt file as its own prelude: 38 files, 695 assertions, 3 red, and all
three are `20_publish_cron`'s known ones.

A tree-wide scan for NUL bytes found nothing else damaged. (`docs/closeout-audit-2026-08-29.md`
contains two NULs and always has — it is committed and unmodified.)

`runSource` now does three things it did not:

- the original is copied to `<file>.mutation-backup` **before** anything is mutated;
- the restore writes a temp file and **renames** it over the target, so the target is never
  a size with no data behind it;
- the restore is **read back and compared** before the backup is deleted, and a stranded
  backup makes the next run refuse to start and name the file.

Two habits fall out of it and are worth more than the code: `git add` a new file before
running anything that rewrites it, and **never run `mutation-pass` through a pipe** —
`node … | tail -40` exits with *tail's* status, which is this repository's own masked-pipe
defect class, and it hid the verdicts of an entire run.

---

## 2.9 · The mutation pass, and the eight that cannot judge yet

**13 KILLED, 0 SURVIVED.** No non-discriminating test among the ones that could run —
including all six written for 0060.

**Eight report INCONCLUSIVE, and it is a consequence of this session rather than a
weakness.** Every pgTAP fixture now confirms its accounts, so the whole suite depends on
0060 — and `runSql` runs the suite WITHOUT the migration as a prelude, because its one
prelude slot is already carrying the mutation. Against a deployed database that does not
have 0060, the clean run is red before any mutation is applied, and a test that was already
red cannot judge anything. The harness says so rather than reading it as a kill, which is
the distinction it exists to draw.

**They come back on their own the moment the migration is applied**, with no code change.
That is the normal state of any migration between commit and deploy, and `pgtap-deployed`
has the same shape — which is why the handoff now says to run it with `--prelude` until
then. The three 0060 mutations that DO judge today are the ones that pass the migration as
their own prelude explicitly, which is also why they keep working afterwards.

**One browser mutation is flaky under load.** `confirm-unknown-locks-out` reported
INCONCLUSIVE twice in a row after heavy consecutive runs and KILLED on a cold one; the
invariant is guarded. Worth knowing before reading a browser-guarded INCONCLUSIVE as a
finding: re-run it on its own first.

**And the harness told me the wrong thing while I worked that out.** Its INCONCLUSIVE
diagnostic filtered the clean run's output for pgTAP's `not ok`, which for a browser suite
matched nothing but the word "errors" inside a line reporting a *success* — so it printed a
passing assertion as the explanation of a failure, and several runs went into believing it.
It now matches the cross that `e2e-browser` and `a11y-sweep` actually use, and says plainly
when there is no failure line rather than printing whatever the filter caught.

---

## 3 · What is left, and every one of these is Amro's

1. **Apply 0060, then deploy the two functions, in that order.** §0 above.
2. **"Confirm email" OFF** in the dashboard, when he wants deferred confirmation to actually
   defer. Everything works either way until then.
3. **Custom SMTP.** Still blocking any demonstration: no confirmation mail and no reset mail
   has ever been sent or clicked on this project.
4. `SUPABASE_ACCESS_TOKEN` as a GitHub Actions secret · Spend Cap ON · **gate 4's named human
   on the takedown path** · the pen test · the production host · the ~300 seed items · the
   second R2 account's credentials.
5. **Colour contrast** — now the whole of what `a11y-sweep` reports. A palette decision with
   an owner; `--strict` gates on it the day that decision exists.

## 4 · Deliberately not done

- **Applying the migration to the deployed database.** It is a deployment, it is not
  trivially reversible, and nobody asked for it in this session. The dry-run above proves it
  applies and passes against that database inside a rolled-back transaction.
- **Turning "Confirm email" off.** Same reason, and it is a product moment rather than a
  code one.
- **Anything for the handle lost across a confirmation round-trip.** Still untestable while
  the mail cap stands, and now touching a flow that has changed underneath it.
- **The colour-contrast findings.**
