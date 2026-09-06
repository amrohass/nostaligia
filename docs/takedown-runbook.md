# Takedown runbook — Ramallah Memory Atlas

**Status: this document discharges CLAUDE.md §11 launch gate 4.** It is the operational
half; the public half is the "Request removal" section on the info page, seeded by migration
`0061` (`supabase/migrations/20260906090000_removal_copy.sql`).

Governance decided by Amro, 6 Sep 2026. Nothing in this file may be changed without him.

---

## 1. The commitment

| | |
|---|---|
| **Named human** | **Amro**, sole maintainer. Personally, not a team address that resolves to nobody. |
| **Response time** | **48 hours** from a request arriving, in either intake path. |
| **What 48 hours means** | A person has looked and answered. It is **not** a promise that every request is granted, and it is not a promise that the bytes are gone by then — when a request *is* granted the bytes go in minutes (§3), and when it is refused the requester gets a reason inside the same window. |

`reconciled-plan.md`'s Q6 recommended 24 hours. 48 is the maintainer's call, and it is also
the number the archive has **already published twice** — `page.contact.body` and
`page.support.body` both promise a reply within 48 hours. One commitment across the whole
site, not three that drift.

The public copy names **"Amro"** and the role ("the archive's custodian" / «القيّم على
الأرشيف»), not a full legal name. Publishing a surname on a politically sensitive archive is
a §7 decision that belongs to Amro alone; if he wants it published, it is a dashboard edit to
`page.removal.body` in both locales and no code change.

---

## 2. Intake — two paths, and why there must be two

### Path 1 · In-platform report control

A signed-in member opens a memory, presses **⚑ Report**, and chooses **"Removal request"**
in the *What are you asking for?* select. That writes a `reports` row with `kind='removal'`
(migration `0053`), and an `after insert` trigger writes `audit_log` action
`removal.requested`.

The request text is deliberately **not** copied into `audit_log` — `reports_audit_removal()`
records that a request exists, not what somebody said about their own circumstances into a
table every moderator can read forever and §3 forbids rotating.

**Where it lands:** `/admin` → **Reports** panel. The query orders `kind.desc,
created_at.desc`, so `removal` sorts above `abuse` and a removal request is at the top of the
queue rather than in date order among reports.

### Path 2 · reports@ramallahnostalgia.org

For a **third-party requester** — a subject, a family, a rights holder — who cannot sign in.

**This path is not a convenience, and it is why gate 4 was not dischargeable by path 1
alone.** §4 puts every member capability behind the sign-in gate, and the report control
lives inside the viewer. Migration `0053` widened *who may file* a removal request ("the
person with the strongest claim to have a photograph removed is frequently NOT its uploader.
They are the person in it") — but it did not widen *who can reach the form*. Somebody who has
never had an account has no route to it at all. Without an email path the archive asks the
exact population §7 exists to protect to create an account, hand over an email address, and
accept its terms, before it will listen to them ask to be removed from it.

F21 ("consent, licensing, **third-party subjects** undefined") is not closed until an
unauthenticated stranger can reach a human. That is this address.

The same asymmetry was already resolved the same way from the other side: 5 Sep's amendment
to §4 leaves **reporting** as the one member capability *not* gated on a confirmed address,
"because a mail round trip in front of it would silence exactly who it is for."

> **⚠ The alias does not exist yet.** It is published copy that will bounce until the
> Cloudflare Email Routing rule is created. See §7.

### Filing a path-2 request into the record

Mail carries no `reports` row and therefore no `audit_log` entry, so the archival record
would be missing every request from the population that most needs one. **After replying,
file it:** open the memory while signed in as Amro and use the same ⚑ **Report → Removal
request** control, with a reason of the form `email intake <date> — <requester, as much as
they consented to be identified by>`. That produces the `removal.requested` audit row the
in-platform path produces automatically.

Do not paste the requester's own words into that field beyond what is needed to identify the
request. `reports.reason` is visible to every moderator under RLS, and this is a §7 exposure
that would be created by diligence.

---

## 3. The operational steps

`§8: On takedown: (1) delete/rename the object in R2 immediately, (2) purge the CDN path,
(3) add the ID to the short-TTL redactions.json that clients filter against, (4) write an
audit row.`

**All four are already implemented and run in a single request.** There is no manual R2
console work in the normal path — doing it by hand would perform step 1 and silently skip
2, 3 and 4.

**How to run it:** `/admin` → **Archive** panel → the row → **Take down** → a dialog that
**requires a reason** → confirm. That posts to `POST {supabase}/functions/v1/takedown`.

What happens inside, in order:

| # | §8 step | Where | Note |
|---|---|---|---|
| 0 | mark | `public.request_takedown()` (`0036`) | Role-checked (§4: moderator/admin), sets `posts.takedown`, and its trigger writes **both** `moderation_actions` and `audit_log` with the reason. Returns the object list. |
| 1 | delete the bytes | `takedown.ts` → `R2Sink.remove()` | **The prerendered `item/{id}/index.html` goes first**, before any media. It is the one object with a human audience — the URL that was pasted into a group chat. Then every `media_assets` row: public derivatives **and** the archival master in `originals/`. |
| 2 | purge the CDN | `cdn.ts` → `CloudflarePurger` | Public paths only, plus the item page. Chunked at 30 URLs per call. |
| 3 | `redactions.json` | `takedown.ts` | Rewritten **from the database**, not appended to — an append drifts the moment a takedown lands mid-publish, and that file is what clients trust to hide things. `max-age=20, must-revalidate`. |
| 4 | audit row | done at step 0 | Permanent. §3: never deleted, never rotated. |

### Why the mark comes before the bytes

`0036`'s header sets out the two half-done states, and they are not equally bad:

- **bytes deleted, not marked** — the archive still lists the item, its media 404s, every
  visitor sees a broken card, and it stays that way until somebody notices.
- **marked, bytes not deleted** — the item is gone from redaction-filtered clients and from
  the next release, and the bytes sit at an unguessable v4 path that nothing links to.
  Recoverable by retrying, invisible in the meantime.

So: mark, then delete, then report exactly which deletions failed.

### Why none of this waits for a publish

§8: *"Takedown latency must never be bounded by the publish cycle."* Nothing above touches
the publisher, the single-writer lease, or a release. The next publish drops the item from
the shards **as a formality** — by then the bytes have been gone for minutes. Measured end to
end at **2.9 s** against the deployed system.

The one thing a publish does *not* undo: a **rollback does not restore a prerendered page**
(§2's amendment), which is correct here — a taken-down item's page must not come back.

### Reading the response — 200 is not the only success-shaped answer

| Status | Meaning | Do |
|---|---|---|
| **200** | Every part happened. | Tell the requester it is done. |
| **207** | The post **is** marked and hidden, and some part of the removal did **not** complete. `reason` names which: `objects_remain`, `cdn_not_purged`, `redactions_not_written`. | **Do not tell the requester the photograph is gone.** Read `failed[]`, fix, re-run. Re-running is safe — `request_takedown` answers `already_taken_down` with `ok:true`. |
| 403 | `forbidden` — not moderator or admin. | Wrong account. |
| 404 | `unknown_post` | Wrong id. |

`res.ok` **is true for 207.** An earlier draft of the E2E check asserted `res.ok` and went
green on a partial takedown; the dashboard has two distinct strings (`ar.takenDown` vs
`ar.takenDownPartial`) for the same reason. Telling a moderator "done" while a cached copy is
still served is worse than an error, because the next thing they do is tell a contributor
their photograph is gone.

### If the requester is the contributor

They do not need any of this. `posts_update` lets an author set `status='withdrawn'`
themselves, and the ledger records it as the author's act rather than a moderator's. But
**withdrawal leaves the bytes in the bucket** — only the path above deletes them. If they
want the files gone, run the takedown.

---

## 4. ⚠ Current caveat — step 2 is a no-op today

`CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` are **unset** in the takedown function's
environment. `cloudflareFromEnv()` returns `null`, `CloudflarePurger.purge()` answers
`{purged: false, reason: "not_configured"}`, and the request comes back **207** rather than
200. This is the one known-red assertion in `scripts/e2e-authenticated.mjs`.

**Harmless today, and only today.** The bucket is served over its `r2.dev` **development**
URL, which is not edge-cached: there is no `cf-cache-status` and no `age` on an object marked
immutable for a year, and a deletion is visible at t+0. Nothing is holding a copy to purge.

**It stops being harmless the moment a custom domain fronts R2.** Derivatives are served
`max-age=31536000, immutable`, so from that moment deleting the object from R2 evicts nothing
the edge already holds — a taken-down photograph would stay retrievable at its original URL
for **up to a year** by anyone with the link, which is exactly the population a takedown is
usually about. The item page is `max-age=300`, so it self-heals in five minutes; the media
does not.

> **Hard precondition: set `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN` in the same
> change that puts a cached custom domain in front of R2. Not after. Never launch public
> with the domain live and the purge unconfigured.**
>
> Verify by running a takedown and asserting **200**, not 207. The function reports the purge
> honestly and always has — a silent skip would give the same green tick for a complete
> removal and for one that leaves the file served from a hundred edge locations.

---

## 5. Handover — if Amro is unavailable

**Today there is no second human, and this file will not pretend otherwise.**
`reconciled-plan.md` F29 asks for "co-maintainer break-glass access". That half is **not
met**: one person holds every credential, and a takedown is a moderator-or-admin capability
enforced in RLS that no runbook can route around.

**The break-glass, as it actually stands:** the only action that closes a takedown without
Amro is granting the `moderator` role to a second account, which requires admin access to the
Supabase project. So the whole of break-glass reduces to *who can reach the Supabase and
Cloudflare logins*, and that is a sealed-credential decision Amro owes himself before public
launch — a second admin account held by a named person he trusts, or a sealed envelope with a
documented opening condition. **Until one exists, the honest statement is that the 48-hour
commitment is bounded by one person's availability**, and a foreseeable absence longer than
48 hours should be met by pausing new public submissions rather than by letting the clock run
unanswered.

Interim, and cheap: the intake never goes dark even when the actor does. Path 1 queues in
`reports` and path 2 queues in a mailbox, both durably. What is at risk in an absence is the
*response*, not the *record*.

---

## 6. Verifying this document is still true

| Claim | Check |
|---|---|
| The removal section exists, in both languages, with both intake paths named | `supabase test db` → `38_removal_copy` (11 assertions) |
| Every slug on the info page has copy | `supabase test db` → `24_content_blocks` assertion 13 |
| Takedown deletes bytes, purges, redacts and audits | `deno test -A supabase/functions/takedown/` |
| The path works end to end against the deployed system | `node scripts/e2e-authenticated.mjs` — the takedown assertion. **200 once §4 is resolved; 207 until then.** |
| A member cannot trigger a takedown | `supabase test db` → `05_matrix` (`posts.takedown` takes no UPDATE grant from `authenticated`, `0036`) |

Against the deployed database, before `0061` is applied, splice it in as a prelude — it runs
inside each test file's own transaction and is rolled back with it, so this writes nothing:

```
cat supabase/migrations/20260905090000_email_confirmation.sql \
    supabase/migrations/20260906090000_removal_copy.sql > /tmp/prelude.sql
node scripts/pgtap-deployed.mjs --tap 38_removal_copy --prelude /tmp/prelude.sql
```

**The check with no copy of the migration in it.** `38_removal_copy`'s last assertion holds a
*copy* of `0061`'s two order statements, because they are statements in a file and not a
function anything can call — so editing the migration's guards without editing the test
leaves it green on logic that is no longer deployed. Concatenating the migration onto itself
closes that, and must stay green:

```
cat supabase/migrations/20260905090000_email_confirmation.sql \
    supabase/migrations/20260906090000_removal_copy.sql \
    supabase/migrations/20260906090000_removal_copy.sql > /tmp/twice.sql
node scripts/pgtap-deployed.mjs --tap 38_removal_copy --prelude /tmp/twice.sql
```

Assertion 10 (*exactly once*) is the only one that catches a double-append: `= any` is still
true of a duplicated slug, and `array_position` returns the first match, so the placement
check passes over `…,support,removal,donate,removal` as well. Proved by mutation on 6 Sep —
breaking the four regex guards and applying twice turns assertion 10 red and nothing else.

**After the migration is applied and a release has published**, the render is the last check
and it is a person's: open `/page/removal` in Arabic and in English and read it. The section
must appear between "Help & support" and the donation ask, as four paragraphs in each
language, with the address legible in both. Before the deploy, the same thing is checkable
without a browser by driving the published blocks through the real `archive.js`
(`ARCHIVE.pages()`), which is how it was verified on 6 Sep.

---

## 7. Open, and Amro's

1. **Create the Cloudflare Email Routing rule for `reports@ramallahnostalgia.org`**, once the
   domain is Active, forwarding to a real inbox he reads. **The address is published copy the
   moment migration `0061` is applied — until the rule exists it bounces.** Do not launch
   public before the alias is live.
2. **Set `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_PURGE_TOKEN`** in the same change that puts a
   cached custom domain in front of R2 (§4).
3. **Decide the break-glass** (§5): a second admin, or a sealed credential with a documented
   opening condition.
4. **Decide whether the public copy carries a surname** (§1).
