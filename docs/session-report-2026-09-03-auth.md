# 3 Sep 2026 — password reset shipped; deferred email confirmation stopped at §12

Two pieces of work, in the order they were asked for. The first is built, tested and
committed. The second is a **new product decision** and this report is where it stops for
approval, as §12 requires — no code was written for it.

    node scripts/frontend-auth-test.mjs                    69 assertions   green  (21 new)
    PLAYWRIGHT_DIR=… node scripts/e2e-browser.mjs          73 checks       green  (34 new)
    PLAYWRIGHT_DIR=… AXE_DIR=… node scripts/a11y-sweep.mjs 24 checks       0 failed, 7 findings
    node scripts/mutation-pass.mjs recovery                2 mutations     both KILLED
    node scripts/frontend-{csp,view,cors,map,fonts,rtl}-test.mjs          all green
    node scripts/frontend-budget.mjs                       99.3 / 150 KiB brotli
    node scripts/build-site-config.mjs --check             green

---

## 1 · Password reset — built

`site/assets/js/` had no call to `/auth/v1/recover`. "Forgot password?" toasted its own
label and did nothing else, from M1 until today, against an endpoint that was live and
correctly gated the whole time.

### The request half

A third mode of `openAuth()` rather than a fourth overlay — it needs the same shell, the
same Turnstile mount, the same single-use-token reset after a failure and the same
"a panel replaces the form" ending, and a second copy of all four is a second copy to get
wrong. The widget is mounted and waited on; the token is asserted to reach the wire.

The confirmation panel **persists until dismissed** and matches this week's signup panel —
same `.dialog--gate` shell, same `<bdi>`-wrapped echo of the address. It says the same
thing whether or not the address has an account, which is a §7 constraint rather than a
simplification: GoTrue answers `200` either way, and a screen that said "no such member"
would turn a public form into a way of asking the archive who contributes to it.

Reachable from two places, both going through the same dialog: the sign-in form's
"Forgot password?", and a new **Account and security** panel on `/me` — which is the
surface item 2's resend button was asked to join. It is kept apart from the profile edit
panel above it on purpose: that one governs what other people see (§7's visibility map),
this one is the account itself and nobody else sees any of it.

The signed-in control still sends a link rather than offering an in-place password change.
A live session is not proof that the person at the keyboard owns the mailbox, and on §7's
shared and borrowed devices that distinction is the whole reason to send one.

### The landing half, and where it actually lands

The mail does **not** link to this site. It links to GoTrue's own `/auth/v1/verify`, which
consumes the one-time token server-side and then `302`s to a redirect target with the
resulting session in the URL **fragment** — `#access_token=…&type=recovery` — or, when the
token is spent or stale, `#error=…&error_code=otp_expired`.

Which target it `302`s to is **Amro's Auth configuration, not this repository's**: it is
the `redirect_to` we ask for if his allowlist admits it, and the project's Site URL
silently otherwise. So both landings are handled and both are tested:

- `/reset` — what we ask for, `location.origin + '/reset'`, computed per request.
- the site root — where it goes if the allowlist has not been widened. The fragment is read
  wherever it lands and the visitor is moved to `/reset`.

**No redirect or callback URL is hardcoded anywhere.** A repo-wide grep for
`redirect_to` / `redirectTo` / `emailRedirectTo` / `site_url` finds only the runtime
`location.origin` expression and the tests that assert it; `supabase/config.toml` declares
no `site_url` and no `additional_redirect_urls`. There is nothing to keep in sync with the
dashboard. Sending a value the allowlist rejects is not an error either — GoTrue falls back
to Site URL rather than refusing — so this degrades to the tested path instead of breaking.

The fragment is **replaced out of the URL** the moment it is read. A session in an address
bar survives into history, into a screenshot, and into whatever the next person to open the
tab scrolls back through.

### The §7 decision, and the one worth keeping

A recovery link *is* a full session, and the official Supabase SDK adopts it on landing.
This one **holds** it instead — nothing emitted, nothing in `sessionStorage`,
`AUTH.isSignedIn()` false — until the password is actually set. §7's contributors are on
shared and borrowed devices, and a link opened on one of those must not leave a live
session behind for whoever opens the tab next, whether or not a password was ever set.

That is one line from being "fixed" by somebody making the reload work, and nothing about
the screen would look different afterwards. So it is pinned in the mutation catalogue
(`recovery-adopts-on-landing`) rather than commented, and the mutation is killed.

### Four states on `/reset`, and none of them is a dead end

| state | what it shows |
|---|---|
| `set` | a live link is held — two labelled password boxes, length and match checked locally |
| `done` | the password is set and the session is now real; continue into the archive, signed in |
| `dead` | the link was refused, or died between landing and submitting — with a new-link action |
| `bare` | `/reset` with no link at all: typed, bookmarked, or reloaded after the fragment was consumed |

It renders **before** the archive-error branch in `render()`. A member locked out of their
account has to be able to reset a password on a day the CDN is having one, and nothing on
the screen reads a shard.

The `dead` screen has two headings and the difference is what we actually know. A fragment
that names itself `type=recovery`, or that landed on `/reset`, is a reset link and is called
one. A bare error fragment at the site root could equally be an expired signup confirmation,
so it is called "this link" — the same two ways out either way, and neither is a claim the
fragment did not make.

### Four refusals, four messages

Merged into one generic failure, these are four different next actions behind a sentence
that suggests none of them. They are pinned as a **set** so a later tidy-up cannot collapse
any two back together.

| refusal | message |
|---|---|
| `captcha_failed` | the human check did not complete — try again |
| `over_request_rate_limit` | you have asked too often — wait a little |
| `over_email_send_rate_limit` | **we** could not send the reset link — our limit, not something you did |
| dead link (`otp_expired`, `session_not_found`, 401/403 on `PUT /user`) | expired or already used — ask for a new one |

`same_password` is a fifth, and it is the one a member meets by doing the obvious thing.

`over_email_send_rate_limit` gets its own **noun** as well as its own message. The existing
string says "confirmation email", which on a screen where somebody is waiting for a *reset
link* reads as having been sent to the wrong place. This is the assertion that **survived
its own mutation** on the first attempt — "the limit is ours" is true of both strings, so
the check tested the pre-existing signup wording and said nothing about this screen. It is
rewritten to pin the noun, and the mutation now fails it.

### Verified scriptably

- **73 browser checks**, driving the real page against the live shards: the request POSTs
  and carries a Turnstile token and `redirect_to`; the panel persists past 6 s; a recovery
  fragment at the site root renders the form and rewrites the URL to `/reset` with the
  session stripped; the link is held and `sessionStorage` is empty; both inputs carry a real
  `<label for>`; too-short and mismatched are refused **without a request**; a valid one
  `PUT`s `/auth/v1/user` with `Bearer <recovery token>`; and only then is the member signed
  in, with the masthead agreeing without a reload.
- **`GET /reset` answers 200 with the SPA shell on the deployed staging origin**
  (`nostaligia.pages.dev`), not only on the dev server — so History API routing carries the
  landing route in production, verified rather than assumed.
- **The live `/auth/v1/recover` refuses a request with no `captcha_token`**
  (`400 captcha_failed`), so the widget is not optional there either.
- 69 unit assertions, two mutations killed, `/reset` added to the a11y sweep — where its
  only findings are the same masthead/footer colour-contrast items already open on `/`,
  `/map` and `/events`. It contributes none of its own.

### Needs Amro's manual click-through

1. **A real reset email, end to end.** Custom SMTP is still not configured and the
   project-wide send cap is the live state, so no reset mail has been sent or clicked by
   anybody. Every layer either side of the mail is exercised; the mail itself is not.
2. **The captcha round-trip on `/recover`.** Turnstile will not mint a token for
   automation — that ceiling is permanent. The harness stubs the *client* token; the server
   still verifies, and the live endpoint's refusal above is the proof that it does. The one
   real challenge is a person's.
3. **One dashboard decision, optional and his:** whether to add `<site origin>/reset` to
   Auth → URL Configuration → Redirect URLs. If he does, the link lands on the screen built
   for it. If he does not, it lands at the site root and the visitor is moved to `/reset`
   anyway — tested, and the reason nothing here is blocked on him.

---

## 2 · Deferred email confirmation — Step A, and this is the stop

**No code was written.** §12: the mechanism is not something to guess between.

### What this project's GoTrue actually does

Every line below is measured against the live project today, not read off a doc.

| measurement | result |
|---|---|
| `GET /auth/v1/settings` | `mailer_autoconfirm: false`, `external.email: true`, `external.anonymous_users: false`, `disable_signup: false` |
| `GET /auth/v1/health` | GoTrue **v2.196.0** |
| grants on `auth.users` to `anon` / `authenticated` / `public` | **NONE** |
| a `public` SECURITY DEFINER function reading `auth.users.email_confirmed_at` | **works** (defined and called in a rolled-back transaction) |
| the column's spread on this project | 15 users — 14 confirmed, 1 not |
| `POST /auth/v1/resend` | exists, and is **captcha-gated** |
| the Turnstile secret behind that gate | now answers `invalid-input-response`, not `invalid-input-secret` — **the secret is recognised**, updating the 31 Aug finding |
| a real access token's claims | `aal, amr, app_metadata, aud, email, exp, iat, is_anonymous, iss, phone, role, session_id, sub, user_metadata` |
| `amr` on a mailed-link session | `[{"method":"otp","timestamp":…}]` |
| `auth.jwt() -> 'amr'` read from SQL under an impersonated session | **readable** |
| INSERT policies to change | `posts` 1, `comments` 1, `likes` 1, `saves` 1 |

### The finding

**"Session granted AND unconfirmed" is not a state this GoTrue produces.** The two settings
are mutually exclusive halves of what Amro asked for, and neither gives both:

- **`mailer_autoconfirm: false` — today.** `/signup` returns a user and **no session**
  (`auth.js` already has that branch). `email_confirmed_at` is meaningful, and GoTrue owns
  the mail, the token, the expiry and `/resend`. **Requirement 1 is impossible.**
- **`mailer_autoconfirm: true`.** `/signup` returns a session — and GoTrue stamps
  `email_confirmed_at` **at signup** and sends no confirmation at all. Requirement 1 works;
  requirements 2–5 have no flag to key on and no mail to resend. `/resend type=signup`
  becomes inert.

So this cannot be reached by configuration. It needs either a different signup shape or a
project-owned verification flag — which is the §12 decision, and the reason this stops here.

One thing is true of **all** the options and is worth saying before any of them: every one
depends on working outbound mail. Custom SMTP is still not configured. Whichever is
approved, I can build and unit-test it, but "a member clicked the link and the flag
flipped" is not something I can demonstrate until SMTP exists.

### Option A · anonymous sign-in, then convert

Enable `anonymous_users`. Signup calls `/signup` with no credentials → a real session
immediately, `is_anonymous: true` in the JWT (a claim the database can read — measured).
Then `PUT /user {email, password}` converts the account. GoTrue keeps ownership of the mail,
the token, the expiry and the resend, and the flag stays `email_confirmed_at`.

**Why I am not recommending it.** On conversion GoTrue routes the address through its
email-**change** flow, which means `auth.users.email` may stay NULL until the link is
clicked. If it does: an unconfirmed member who closes the tab **cannot sign in and the
account is unrecoverable** — §7 puts the refresh token in `sessionStorage`, which dies with
the tab. It would also break the password reset above, and `state.account.email`.

I could not measure this, because anonymous sign-ins are off and turning them on is Amro's.
**This option must not be chosen without measuring that first**, on a scratch project rather
than on this one.

### Option B · autoconfirm ON, a project-owned flag, GoTrue still does the mailing — recommended

Turn "Confirm email" off so signup returns a session. Then:

**Where the flag lives.** `public.email_confirmations(user_id primary key references
auth.users, confirmed_at timestamptz, last_sent_at timestamptz)` — **no grant to `anon` or
`authenticated`, no policy, service role only**, exactly the shape `user_roles` already has
for role under §4. RLS reads it through `public.email_confirmed()`, a SECURITY DEFINER
`stable` function with `set search_path = ''` — the direct analogue of `authz_role()`, and
the pattern this schema already uses and tests.

**How it is set, and why it cannot be self-written.** The confirmation mail is **GoTrue's
own magic link** (`POST /auth/v1/magiclink`, captcha-gated). We mint no tokens, set no
expiry and write no single-use or replay logic — the part of this that §6 would least want
us to write ourselves. Clicking the link establishes a session whose `amr` says `otp`. A
SECURITY DEFINER RPC stamps `confirmed_at` **only when the current session's `amr` shows a
mailed-link method** and the caller owns the row. A password session cannot stamp it, and
`amr` is inside a signed token that a browser cannot forge or edit. That is the trust
boundary, and it is the same one §4 already draws: the browser is hostile, including
`admin.js`, and the only things it may assert are the ones inside a signature.

**What it costs, stated rather than discovered later.** `auth.users.email_confirmed_at`
becomes always-set and meaningless — two flags in one database, one of them a lie. That has
to be commented at the table, or somebody will read the wrong one. Plus: one table, one
accessor, one RPC, one rate-limited resend Edge Function, and a landing route.

**And one consequence that belongs to Amro, not to the code.** With confirmations off, an
unconfirmed account can **squat somebody else's address** — sign up as `victim@example.com`,
get a session, and block the real owner from registering. The squat exists today too, but
today the squatter gets no session at all. Under this option they get one, and what they can
do with it is exactly the question in Step B below.

### Option C · decline requirement 1

Keep confirmations on. Signup keeps ending on today's panel, no new trust boundary, no new
code. Stated as the baseline the two options above are being chosen against.

### Step B — asked, not answered, and not built

Comments publish the moment they are written (§1's 30 Aug amendment; migration 0054), and
there is no moderation queue screen for them — that amendment is explicit that review of
comments was never happening and structurally could not. So an unconfirmed account
commenting is a **live spam path with no prior restraint in front of it**, and bidi
stripping is the only filter between a hostile string and a shard. Likes and saves feed
published counts.

**My recommendation is to gate comments and likes/saves behind confirmation too**, alongside
posts and uploads. The squatting note above is the sharpest form of the argument: under
Option B an unconfirmed session on somebody else's address would otherwise be able to
publish text under it.

This changes the RLS policy surface — four INSERT policies rather than one — so per the
brief it needs an explicit answer from Amro before anything is built. **Still open.**

### What Step C would be, once a mechanism is approved

Recorded so the approval is of something specific, not of a direction:

- `posts` INSERT policy refuses an unconfirmed caller; the RLS test is written alongside the
  policy, not after (§12).
- `request-upload` refuses **before** issuing a signed URL, from the server-side flag. Its
  gate order already reads the authoritative role from the database rather than the claim
  (gate 4), so the confirmation check belongs in the same call — never from a
  client-declared value.
- The blocked-upload dialog gets the resend action **in it**, not described.
- Same component, same change: the unlabelled `<select>` and two unlabelled inputs the
  2 Sep sweep flagged (`docs/session-report-2026-09-02-testing.md` §6). Small, scoped, no
  new deps — and the `select-name` violation is `critical` on the one screen a contributor
  must complete.
- The resend is rate-limited **by us**, independently of the provider cap, and
  `over_email_send_rate_limit` keeps its own message.
- I18N ar/en, RTL, logical properties, `tokens.css`; the prompt persists until dismissed;
  intent survives the round-trip (§9); the UI reflects confirmed state with no manual reload.

---

## 3 · What is still Amro's

Unchanged from 1 Sep except where noted.

1. **Approve or redirect the mechanism above.** Nothing on item 2 proceeds without it.
2. **Answer Step B** — gate comments and likes/saves behind confirmation, or not.
3. **Custom SMTP.** Now blocking two things rather than one: signup confirmation, and any
   demonstration of the reset link that shipped today.
4. Optional, and only an improvement: add `<site origin>/reset` to the Auth redirect
   allowlist.
5. `SUPABASE_ACCESS_TOKEN` as a GitHub Actions secret · Spend Cap ON · Gate 4's named human
   on the takedown path · the pen test · the production host · the ~300 seed items · the
   second R2 account's credentials.

## 4 · Deliberately not done

- **Any code for item 2.** §12, and the brief, both say stop at the mechanism.
- **Any milestone work.**
- The colour-contrast findings, which remain a design decision with an owner.
