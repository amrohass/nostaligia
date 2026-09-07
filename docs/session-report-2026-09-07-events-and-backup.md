# Session report — 7 Sep 2026 (into the 8th): the listing, the backup, and Docker

Five items, all closed or closed as far as code can close them. Read CLAUDE.md first; §1, §3,
§6 and §7 all gained amendments today and they govern.

---

## 0. The two migrations, and the order they went in

**0062 was the blocking step and is now applied.** `supabase migration list --linked` showed
61 of 62 with `remote` empty on `20260907090000` and no drift anywhere else. Applied, then
verified against the catalogue rather than the CLI's exit code: `posts_approved_has_rights`
now reads `... OR (kind = 'event') OR ...`, and `organizers` is in `posts_details_keys`.
`39_event_submission` went from needing a `--prelude` to passing 25/25 on its own, which is
the independent confirmation that it landed.

**0063 is this session's, and it is also applied.** It was held until one question had an
answer, because the answer decided whether applying it was safe:

```sql
select kind, takedown, count(*) from posts
 where status='approved' and kind<>'event'
   and not exists (select 1 from media_assets m where m.post_id = posts.id)
```

**Zero rows.** Every approved non-event post in production already has media, so no existing
row became un-updatable and no takedown was put at risk. Had that returned anything, the
migration would have waited for Amro.

---

## 1. Events without media — the shape of it

Amro's decision, relayed: **a post may skip media only if `kind='event'`.** `media` and
`voice` require at least one `media_assets` row, unconditionally.

### Where the listing path lives, and why it is not its own endpoint

`claim_event_slot(p_draft)` is the new RPC, and the browser **does not call it directly**.
It goes through `request-upload`, which already runs auth → Turnstile → role → 0060's
confirmation check, in that order.

That was the one design decision worth arguing about, and §6 settles it: Turnstile is
required on submit. A direct RPC from the browser would have been a new write path with no
captcha in front of it, and a second Edge Function would have been a second copy of the gate
order — the day the two disagree, one of them is uncaptcha'd. So `request-upload` gained a
`media: false` branch that skips only the four gates that are about a file.

`media: false` is required to be **explicit**. Inferring the listing path from a missing mime
would mean a client that lost the field to a serialisation bug quietly filing a listing
instead of being told its upload was malformed.

### The quota is separate in both directions

`upload_quota.event_count`, charged by `claim_event_quota()`, ceiling in
`public.event_daily_limits()`: **member 10 / moderator+admin 100 per day**. Written into §6
beside the upload figures, as that section's own rule requires.

The numbers are **chosen, not derived**, and are flagged as such at the constant. They are
lower than the upload counts on purpose: an upload costs the member the effort of having a
file, a listing costs them a sentence, and what a listing actually spends is a moderator's
attention — of which there is one for the whole archive.

"Consume or bypass" is two failures and one assertion cannot see both, so both are tested: a
listing must not spend an upload, **and** a member out of listings must still be able to
upload.

### The constraint, and three things the first draft got wrong

`posts_approved_has_media` is a **constraint trigger**, not a CHECK — "has a media_assets
row" is a fact about another table. It has to be a database rule rather than an `admin.js`
one: §4 gives moderators a plain RLS UPDATE and there is no `approve_post()` RPC to put it
inside.

Three corrections, each found by running something rather than by reading:

1. **`DEFERRABLE INITIALLY DEFERRED` → `INITIALLY IMMEDIATE`.** Deferred-by-default moved
   every approval's error to commit time, left pending trigger events on `posts` (which made
   `ALTER TABLE ... DISABLE TRIGGER` fail 55006 in `37_email_confirmation`), and — worst —
   meant the trigger never fired in a pgTAP file at all, so a test could pass whether or not
   it existed. Immediate by default; the bulk importer opts in with one greppable line.
2. **`not new.takedown` in the WHEN clause.** `request_takedown`'s whole effect on this table
   is `set takedown = true`; status stays `approved` and kind stays `media`. Without the
   term, a takedown of any pre-0063 media-less post would have been **refused** — §8's one
   operation that must never be blocked, blocked by a rule about publishing. Proved
   load-bearing by mutation: removing it kills exactly assertion 12 and nothing else.
3. **`immutable` → `stable`** on `parse_event_fields`. `text::timestamptz` reads the session
   TimeZone for any input carrying no zone, and a draft is a blob a browser composed.
   IMMUTABLE would have told the planner it may fold and reuse the result across a
   `SET TimeZone`.

### The refactor, and why it was worth doing

0062 put the event-field parsing inline in `claim_upload_slot`. A second copy in
`claim_event_slot` would have been drift between the rules for an event *with* a poster and
one *without* — a difference no contributor could predict.

So `parse_event_fields` is extracted and both call it. The evidence that the extraction is
faithful is that **`39_event_submission` passes 25/25 without a single edit** — it was
written against 0062 and binds the behaviour. A suite that had to be adjusted to accept a
refactor would not be evidence of anything.

---

## 2. Docker — fixed, and the diagnosis was wrong twice before it was right

**Working. Server 29.7.2.** Not by the reinstall the plan allowed, and no reboot was needed.

The path there is worth recording because two intermediate readings were confidently wrong:

- `wsl --shutdown` completed cleanly this time (it hung last session), and Docker Desktop
  still never answered its pipe.
- **WSL2 is healthy**, proved by running a command in the distro directly (`echo ALIVE`
  returned). So the WSL reinstall in the canonical order was not indicated.
- **A wrong turn worth keeping:** `wsl -d docker-desktop -e /bin/sh` showed a 127 MB rootfs
  with no `dockerd` binary, which read as a corrupt distro. It is not — `wsl -e` lands in
  the **bootstrap namespace**, while the engine runs from a separate mount. `ps -ef` later
  showed `dockerd` running from the very path `ls` said did not exist. Do not diagnose this
  distro by looking for files in it.
- What actually fixed it: `wsl --unregister docker-desktop`, then restarting Docker Desktop
  so it rebuilt the rootfs from `docker-desktop.iso`. The distro went from 6 processes and no
  dockerd to 45 processes with dockerd running. **The 17.6 GB `docker_data.vhdx` was not
  touched** — it lives outside the distro's registered BasePath (`wsl\main`), which was
  checked in the registry before running the command.

**`docker info` still hangs to timeout even now.** `docker version`, `docker ps` and the
whole Supabase stack work. Diagnose with `docker version`, not `docker info` — the old
instruction to use `docker info` is what made this look unfixed for longer than it was.

---

## 3. Backup and restore — the first complete run

**The backup is complete for the first time:** six of six dumps, `dumps_that_could_not_run:
[]`, `completeness_gaps: []`, 4 originals copied, 0 orphans, `quarantine` never touched. Last
session managed two of six.

The exclusion list was confirmed empirically rather than from the docs, via
`supabase db dump --linked --dry-run`, which prints the real pg_dump invocation. CLI v2.115.0
excludes `auth`, `storage`, `vault`, `cron`, `extensions` **and `supabase_migrations`** —
which is exactly why the six-dump design exists.

**The restore passed every check the gate cares about**, into local Docker:

```
ok  auth.users came back
ok  every post's author exists          ← posts.created_by, the flagged failure mode
ok  roles resolve through authz_role()  ← the role/auth data
ok  audit_log is still append-only
ok  RLS is on for every table it was on for
ok  anon holds nothing
ok  PostGIS re-derives the same fuzzed point
ok  20_publish_cron 14 is RED, as a correct restore requires
ok  supabase_migrations is still absent
```

### Two defects the restore found, both in the verifier

1. **Six false alarms.** `backup.ts` stopped copying taken-down masters on 7 Sep (§8 deletes
   the bytes; the row stays as the record). `restore-verify.ts` never got the same change, so
   it reported all six as "the backup does not have it" — six failures on every run for ever,
   describing §8 working. Fixed to mirror `backup.ts`'s filter and count them on their own
   line. **Yesterday's fix landed in one script and not its pair.**
2. **A collision this session created.** `idempotentTriggers()` said "there are no CONSTRAINT
   triggers in this schema" and failed the restore if it found one, so that the day one was
   added the restore would say so. 0063 adds the first. An alarm that fires correctly on
   every future restore is a broken verifier, so constraint triggers are now made idempotent
   with their own `DROP TRIGGER IF EXISTS`; an unparseable one still refuses, because
   guessing would mean dropping the wrong trigger.

**Two caveats on what was proved.** The passphrase was a session-generated one, not Amro's —
this exercised the mechanism, not his operational backup. And the runbook names
`D:/rma-backups`; **there is no D: drive on this machine**, so `C:/rma-backups` was used and
then deleted, because encrypted member emails should not sit on an unencrypted disk beside a
passphrase in a temp directory. §11 gate 3 was already discharged on 1 Sep and none of this
reopens it.

---

## 4. `/item/*` OG tags — the prerender is NOT broken

Re-measured against the live host now the domain exists.

```
https://ramallahnostalgia.org/item/<id>/   200, 3209 bytes, ZERO og: tags   (the SPA shell)
<r2>/item/<id>/index.html                  200, 2809 bytes, FULL og: set
```

The prerendered page is there and correct: `og:title`, `og:description`, a real `og:image`
with width and height, and an `og:url` naming `ramallahnostalgia.org` — so `SITE_ORIGIN` is
set right too. **Nothing to rebuild.** The gap is the single deployment requirement CLAUDE.md
§2 has recorded since 21 Aug as "not yet provisionable": the origin must route `/item/*` to
the R2 public bucket. It is provisionable now. It is a Cloudflare route and it is Amro's.

---

## 5. §7 and IP logging

One amendment, no code. `auth.audit_log_entries` is GoTrue's and carries a dedicated
`ip_address varchar`; nothing this project owns writes to it or can turn it off.

**Measured rather than assumed: the table is EMPTY on the deployed project** — 0 rows against
17 accounts and months of sign-ins. So the deviation is written down at the *shape of the
table* rather than at an observed row, because the column exists and the platform may start
filling it without telling anyone.

---

## What is left, and it is all Amro's

Unchanged from the 7 Sep list, plus one new entry:

- **NEW: the `/item/*` route** at the Cloudflare origin. Everything else about shared links
  works; this is the last piece.
- The Cloudflare Email Routing rule for `reports@ramallahnostalgia.org`, and
  `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_PURGE_TOKEN` with a cached custom domain in front of R2.
- `SUPABASE_ACCESS_TOKEN` as a GitHub Actions secret; Spend Cap ON; the pen test; custom
  SMTP; the ~300 seed items.
