# Backup runbook — Ramallah Memory Atlas

**Status: CLAUDE.md §11 launch gate 3 is already DISCHARGED** (1 Sep 2026, and §11 records
the standard so it is not re-argued: *"No further restore work is owed for launch."*). This
document is not the gate. It is the **ongoing cadence** that keeps the archive recoverable
after launch, which the gate does not cover — a gate is passed once, and a backup is a habit.

Governance decided by Amro, 7 Sep 2026. Nothing in this file may be changed without him.

---

## 1. The three decisions

| | Decision (7 Sep 2026) | Changed from |
|---|---|---|
| **Where** | A **local encrypted disk** he holds. | Was "a second R2 bucket under a different Cloudflare account" (31 Aug). |
| **Cadence** | **Weekly** full database + incremental `originals/`, plus **two snapshots pinned forever**: one pre-launch, one immediately after the seed import. | unchanged |
| **Restore into** | A **local Docker** container. | unchanged in practice — §11 already ruled the local container sufficient. |

The destination change retires an outstanding item rather than adding one: the second
Cloudflare account was never provisioned, and it was the last thing standing between this
project and a backup it actually holds.

### What the local disk costs, stated rather than discovered later

It is a **weaker copy** than a second account: same building, same disk, no geographic
separation. A fire, a theft or a failed drive takes the archive and its backup together.
The manifest records `"kind": "dir"` on every run so a restore can never mistake one kind of
copy for the other, and `backup.ts` still carries the working R2 path — with its
different-account refusal intact — so taking the 31 Aug decision again is a flag rather than
a rewrite.

**If that separation is later wanted, the answer is not this script.** Copy the encrypted
directory somewhere else — the dumps are already AES-256-GCM at rest and safe to move as
opaque bytes.

---

## 2. Why this is NOT a GitHub Action, and why that is a relief

A GitHub runner cannot write to Amro's disk. That is not an obstacle to route around; it is
what *"a backup you hold yourself"* means. **The weekly run is a scheduled task on his own
machine.**

It also settles a question that was open and uncomfortable. A headless/CI dump needs a
Supabase access token — a credential that can manage the entire project — sitting in CI
secrets. With the destination local, **that token never has to exist in CI at all.** The
security decision that was flagged for Amro's ruling does not need to be taken.

---

## 3. Prerequisites

| | |
|---|---|
| **Docker Desktop RUNNING** | Non-negotiable, see §6. Four of the six dumps are `pg_dump` inside a container. |
| **`BACKUP_PASSPHRASE`** | Amro's, held by him, **never** stored beside the backup. |
| **A destination outside the repo and outside temp** | `backup.ts` refuses both by name — encrypted member data must not land in the working tree or a scratch directory that gets swept. |

### The passphrase is the credential that kills you twice

Lost, the dumps are landfill. Stored next to the backup, it is not protection. `backup.ts`
does the two things a script can: it refuses to run without one, and it **decrypts what it
just wrote before reporting success** — so a passphrase that does not work is found on the
day of the backup, not the day of the restore.

---

## 4. The commands

Weekly:

```
BACKUP_PASSPHRASE=… deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
  scripts/backup.ts --to-dir D:/rma-backups
```

The two permanent snapshots — **these are never pruned**:

```
… scripts/backup.ts --to-dir D:/rma-backups --pin pre-launch
… scripts/backup.ts --to-dir D:/rma-backups --pin post-seed-import
```

Rehearse anything with `--dry-run` first; it writes nothing and still reports every number.

Verify a restore (needs Docker, and refuses the production ref by name):

```
deno run -A scripts/restore-verify.ts --from D:/rma-backups/db/<stamp>
```

---

## 5. What is copied, and what is deliberately not

| | |
|---|---|
| `originals/` | **Always**, incrementally. The only irreplaceable bytes in the system. |
| The basemap | **Once.** ~174 MB of the 176 MB `public` bucket, rebuilt from Protomaps about yearly — copying it weekly is ~99% of the transfer for ~0% of the risk. |
| `public/` otherwise | **No.** Renditions re-derive from originals, the release tree re-derives from Postgres. Recorded as an accepted cost, not waved away: for 300 items that is hours of worker time and a real bill. |
| `quarantine/` | **Never.** Unvalidated uploads that have not passed magic-byte validation. Copying them copies the one thing §6 refuses to trust. |
| `vault`, `cron` | **Never.** The vault holds the publisher's dispatch secret. A backup carrying live credentials has widened the blast radius rather than narrowed it. They are re-set by hand on a restored project, and `restore-verify.ts` says so rather than leaving it to be discovered. |

**Six dumps, not one.** `supabase db dump` excludes the `auth` schema's structure by
default, and a restore that loses it produces a `posts` table whose every `created_by`
points at a user that does not exist — *and it looks like a successful restore*. The
`auth.users` provisioning trigger is in no `pg_dump` output at all; that gap was found by an
actual restore and by nothing else.

### Taken-down masters are skipped, and the run says so

§8 deletes the bytes on takedown immediately; the `media_assets` row stays as the permanent
record of what was removed. So a taken-down post leaves a row naming an object that is
*correctly* gone.

Until 7 Sep 2026 the backup counted every one of those as **"an object the DATABASE names
and the BUCKET does not match … an archive problem"** — six of the nine on the deployed
system, every one of them §8 working exactly as designed. That is an alert that cries wolf,
growing by one line per takedown for ever, so that the day a *real* missing master appears
it arrives in a list already full of false ones. They are now excluded from the copy and
**counted on their own line**, because a value dropped without saying so is this project's
own recurring defect.

---

## 6. Known blocker, 7 Sep 2026 — Docker

**Docker Desktop is wedged on Amro's machine and the database backup cannot be taken until
it is fixed.** The process starts and the WSL `docker-desktop` distro reports `Running`, but
the daemon's named pipe never answers: every `docker info` hangs to timeout, and
`supabase db dump --linked` returns `LegacyDockerRunError … open //./pipe/dockerDesktopLinuxEngine`.

What that does and does not block, measured rather than assumed:

| | |
|---|---|
| `--selftest`, both scripts | **Works.** 26 + 25 assertions green. |
| `--dry-run`, the R2 and manifest halves | **Works.** |
| `originals/` sync | **Works** — it is presigned HTTP, no container. |
| `triggers.sql`, `function_acl.sql` | **Work** — plain SQL queries. |
| The other four dumps | **Blocked.** `schema`, `data`, `auth`, `roles`. |
| `restore-verify.ts` | **Blocked.** |

So a run today produces an `originals/` copy and two of six dumps, and `backup.ts` refuses
to store an incomplete dump outside `--dry-run` — which is correct: a partial database
backup that looked like a whole one is the failure this whole file exists to prevent.

One thing worth knowing when this is retried: `supabase db dump --linked --schema public`
**does not** need Docker, while the same command without `--schema` does. That asymmetry is
why "the CLI needs Docker" is too coarse a statement to debug from.

**This does not reopen §11 gate 3.** The gate was discharged against a real restore on
1 Sep. What is blocked is the ongoing cadence, which is a launch-adjacent habit rather than
a launch gate.
