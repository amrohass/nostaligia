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
| **`backup.vars`, outside every repository** | Holds `BACKUP_PASSPHRASE` and `BACKUP_DEST_ENCRYPTED`. See below. |
| **A destination outside the repo and outside temp** | `backup.ts` refuses both by name — encrypted member data must not land in the working tree or a scratch directory that gets swept. |
| **A destination on an ENCRYPTED volume** | Refused without an explicit affirmation. See below. |

### Where the passphrase lives, and why it is not in this repository

```
Windows   %APPDATA%\rma-backup\backup.vars
POSIX     $XDG_CONFIG_HOME/rma-backup/backup.vars   (else ~/.config/rma-backup/backup.vars)
```

`KEY=VALUE`, one per line, same shape as `.dev.vars`:

```
BACKUP_PASSPHRASE=…
BACKUP_DEST_ENCRYPTED=yes
```

`supabase/functions/.backup.vars` still works and is still git-ignored, and it is **no longer
where the passphrase belongs**. Git-ignoring was never the property that mattered: a working
tree gets cloned to a second machine, copied into a scratch directory for a restore
rehearsal, and — the case that actually happened on 7 Sep 2026 — read back into a session
transcript by a tool that was only trying to explain why a run failed. None of those are
commits, and `.gitignore` stops none of them. Outside the tree, none of them reach it.

Precedence is in-repo file → out-of-repo file → environment, so the out-of-repo value wins
over a stale `.backup.vars` somebody left behind, and a one-off run can still override with
an environment variable without editing anything.

**Never pass the passphrase on a command line.** It goes into shell history and into any
transcript of the session. The file is the mechanism; the environment override exists for
automation that already holds the value.

### The destination must be on an encrypted volume, and the tool asks

`BACKUP_DEST_ENCRYPTED=yes` is Amro's affirmation that the `--to-dir` destination sits on an
encrypted volume. Without it the run **refuses before writing anything**.

This exists because of a specific mistake. On 7 Sep 2026 a restore rehearsal wrote six dumps
— every member's email address among them — to `C:\rma-backups` on a machine with no disk
encryption, with the passphrase in a scratch directory beside them. The dumps were
AES-256-GCM, and that is exactly the argument that would have made the next one a disclosure.

**Why an affirmation rather than a check.** There is no reliable unprivileged way to ask
Windows whether an arbitrary path is on an encrypted volume: `Get-BitLockerVolume` and the
`Win32_EncryptableVolume` CIM class both answer *Access denied* without elevation, and a
weekly scheduled task that needs administrator rights only to read a flag is a worse trade
than one explicit line. What the tool *can* read unprivileged is BitLocker's boot status in
the registry, and it uses it for one thing only: refusing a **contradiction** — an
affirmation of `yes` on a path that lives on the system drive, on a machine whose boot volume
is demonstrably unprotected. That is the 7 Sep mistake exactly. An external disk is outside
what that status describes, so a destination off the system drive rests on the affirmation
alone rather than being refused on evidence that does not apply to it.

### The passphrase is the credential that kills you twice

Lost, the dumps are landfill. Stored next to the backup, it is not protection. `backup.ts`
does the two things a script can: it refuses to run without one, and it **decrypts what it
just wrote before reporting success** — so a passphrase that does not work is found on the
day of the backup, not the day of the restore.

---

## 4. The commands

> **STATUS, 8 Sep 2026 — the weekly run cannot be scheduled yet, and this is Amro's to
> resolve.** Measured on his machine, not assumed:
>
> * **`D:` does not exist.** The only fixed volume is `C:` (465 GB NTFS). Every command
>   below naming `D:/rma-backups` is aspirational until a disk is attached.
> * **`C:` is not encrypted.** BitLocker `BootStatus` is `0`, no BitLocker policy is
>   configured, the `BDESVC` service is stopped, and no third-party full-disk-encryption
>   product is installed. (`manage-bde` and `Get-BitLockerVolume` both need elevation and
>   answer *Access denied*, so this is inference from three consistent unprivileged signals
>   rather than an authoritative read — but they all point the same way.)
> * **No scheduled task is registered.** Nothing on this machine runs `backup.ts` weekly.
> * **CI is clean and should stay that way.** The only secret any workflow references is
>   `SUPABASE_ACCESS_TOKEN`, and it belongs to `monitor.yml` (§11 gate 5). No backup
>   credential exists in CI, which is the whole reason the destination is local.
>
> So there is no acceptable destination today. `--dry-run` exercises everything except the
> writes and needs neither value; a real run refuses. **The decision is which encrypted
> volume this writes to** — an encrypted external disk, or BitLocker enabled on `C:` — and
> it is not one to work around.

Weekly, once an encrypted destination exists:

```
deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
  scripts/backup.ts --to-dir D:/rma-backups
```

No `BACKUP_PASSPHRASE=` prefix: it comes from `backup.vars` (§3), because a passphrase on a
command line is a passphrase in shell history.

### Registering the weekly task

Not registered by anything in this repository, deliberately — a task that writes member data
on a timer should be created by the person who owns the disk. Once the destination exists,
from an ordinary (non-elevated) PowerShell:

```powershell
$repo = "C:\Users\DELL\Desktop\amro\HK TECH\RAMALLAH MEMORY"
$args = '--allow-run --allow-net --allow-env --allow-read --allow-write ' +
        '"' + $repo + '\scripts\backup.ts" --to-dir D:\rma-backups'
$action  = New-ScheduledTaskAction -Execute "deno.exe" -Argument $args -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
Register-ScheduledTask -TaskName "RMA weekly backup" -Action $action -Trigger $trigger `
  -Description "Ramallah Memory Atlas — weekly DB dump + originals sync (docs/backup-runbook.md)"
```

Then confirm it is really there, because a task that failed to register looks identical to
one that was never attempted:

```powershell
Get-ScheduledTask -TaskName "RMA weekly backup" | Select-Object TaskName,State
```

The two permanent snapshots — **these are never pruned**:

```
… scripts/backup.ts --to-dir D:/rma-backups --pin pre-launch
… scripts/backup.ts --to-dir D:/rma-backups --pin post-seed-import
```

Rehearse anything with `--dry-run` first; it writes nothing and still reports every number.

Verify a restore (needs Docker, and refuses the production ref by name). The flags are
`--backup` and `--into-container`, not `--from` — the older spelling in earlier drafts of
this file refuses with a usage message rather than doing anything:

```
deno run -A scripts/restore-verify.ts \
  --backup D:/rma-backups/db/<stamp> \
  --into-container supabase_db_<ref>
```

It **wipes the target and asserts it empty** before grading, so the container must be a
scratch one. The production ref is refused by name.

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

## 6. ~~Known blocker, 7 Sep 2026 — Docker~~ RESOLVED 8 Sep 2026

**Docker works. Server 29.7.2, all six dumps run, and a full restore has been graded against
this project's own suite.** No reinstall and no reboot were needed. What fixed it:
`wsl --unregister docker-desktop`, then restarting Docker Desktop so it rebuilt the distro
rootfs from `docker-desktop.iso`. The 17.6 GB `docker_data.vhdx` is outside the distro's
registered BasePath (`wsl\main`) and survived.

**Two diagnostic traps, because both cost real time and both are still true:**

* **`docker info` hangs to timeout even on a healthy daemon.** `docker version` and
  `docker ps` answer instantly. The check named in the original blocker below is the one
  check that cannot distinguish working from broken here.
* **Do not judge the distro by looking for files in it.** `wsl -d docker-desktop -e sh`
  lands in the *bootstrap* namespace: it shows a 127 MB rootfs and no `dockerd` binary while
  `dockerd` is running from that exact path.

The original text is kept below because its last paragraph — the `--schema public`
asymmetry — is still the useful part.

---

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
