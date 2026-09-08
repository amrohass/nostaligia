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
| **Where** | A **local encrypted disk** he holds — the BitLocker-protected system disk for now, an encrypted external disk later (Amro, 8 Sep 2026). Set once as `BACKUP_DEST_DIR` in `backup.vars`; the later swap is that one line (§7). | Was "a second R2 bucket under a different Cloudflare account" (31 Aug). |
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
| **`backup.vars`, outside every repository** | Holds all three values: `BACKUP_DEST_DIR`, `BACKUP_PASSPHRASE`, `BACKUP_DEST_ENCRYPTED`. See below. |
| **A destination outside the repo and outside temp** | `backup.ts` refuses both by name — encrypted member data must not land in the working tree or a scratch directory that gets swept. |
| **A destination on an ENCRYPTED volume** | Refused without an explicit affirmation. See below. |

### Where the passphrase lives, and why it is not in this repository

```
Windows   %APPDATA%\rma-backup\backup.vars
POSIX     $XDG_CONFIG_HOME/rma-backup/backup.vars   (else ~/.config/rma-backup/backup.vars)
```

`KEY=VALUE`, one per line, same shape as `.dev.vars`:

```
BACKUP_DEST_DIR=…
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

### The destination is a CONFIG VALUE, and that is the whole point

`BACKUP_DEST_DIR` in the file above is where backups go. Amro's decision, 8 Sep 2026: **the
destination is configuration, not a path typed into a command.** No script, no scheduled
task and no command in this file names a disk.

It is worth being explicit about why, because the alternative looks harmless. The path used
to be spelled out in four places — the weekly command, the scheduled-task registration, and
both pinned snapshots — and a disk swap that has to find all four is a swap that
half-happens. The two pinned snapshots are the ones nobody runs weekly, so they are exactly
the ones that would go on naming a disk that is no longer attached, and they are the two
copies that are **never pruned**. A stale path there is not a stale command; it is the
permanent record written to nowhere.

`--to-dir <path>` still exists and still overrides the config, for a one-off rehearsal
against some other directory. What it will **not** do is fall back: `--to-dir` with nothing
after it, or with another flag after it, is refused rather than quietly answered with the
configured destination. A run that writes member data somewhere other than where the
operator just asked is the wrong kind of helpful.

`restore-verify.ts` is not a second copy of this. Its `--backup` takes a full path down to
one dated snapshot, chosen per restore — an argument about *which copy is being proved*,
not a second destination setting.

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

> **STATUS, 8 Sep 2026 (second entry) — the destination is DECIDED; the volume is not yet
> encrypted, and that step is Amro's to run.** The decision, relayed: **BitLocker on `C:`
> for now**, moving to an encrypted external disk later — a one-line change, see §7.
>
> Measured on the machine this evening, not assumed:
>
> * **`C:` is still unencrypted.** BitLocker `BootStatus` is `0`, the
>   `HKLM\SOFTWARE\Policies\Microsoft\FVE` policy key is absent, and `BDESVC` is
>   `Stopped/Manual`. Three consistent unprivileged signals; `manage-bde` and
>   `Get-BitLockerVolume` still answer *Access denied* without elevation, so this is not an
>   authoritative read — but nothing disagrees with it.
> * **`D:` still does not exist.** The only fixed volume is `C:` (465 GB NTFS).
> * **`backup.vars` does not exist yet**, in either location. The 7–8 Sep runs used a
>   session-generated passphrase: that proved the mechanism and is not an operational
>   backup. The passphrase in the real file must be one only Amro holds.
> * **No scheduled task is registered.** Nothing on this machine runs `backup.ts` weekly.
> * **CI is clean and should stay that way.** The only secret any workflow references is
>   `SUPABASE_ACCESS_TOKEN`, and it belongs to `monitor.yml` (§11 gate 5). No backup
>   credential exists in CI, which is the whole reason the destination is local.
>
> So a real run still refuses — and note *which* refusal, because it is the stronger one.
> Setting `BACKUP_DEST_ENCRYPTED=yes` today unblocks nothing: with the destination on `C:`
> it produces the **contradiction** refusal instead — *affirmed as encrypted, on the system
> drive, boot volume demonstrably unprotected*. Confirmed by running it, 8 Sep. **That is
> the check working, and it is not to be forced.** `BACKUP_DEST_ENCRYPTED=yes` does not go
> into the file until BitLocker actually reports protection on (§8).
>
> `--dry-run` exercises everything except the writes and needs none of the three values.

> **STATUS, 9 Sep 2026 — LIVE. This supersedes every status note above it.**
>
> `BootStatus` reads `1` after the restart, with `BDESVC` running and the FVE policy present:
> **all three signals agree for the first time**, so `BACKUP_DEST_ENCRYPTED=yes` is set on
> evidence rather than on assertion. The 8 Sep entry's `0` was the truthful answer about a
> volume that had not been encrypted yet — the restart is what started it.
>
> * **Destination:** `C:\Users\DELL\rma-backups`. See "Why the profile and not the drive root".
> * **First real backup:** six of six dumps, four originals (11,094,944 bytes), no orphans,
>   no completeness gaps. Every dump was then independently decrypted and every sha256 matched
>   the manifest — so the generated passphrase is known to work rather than assumed to.
> * **Weekly task:** registered, and **proven by running it**, which is the whole reason the
>   next three sections exist.
>
> Two things remain Amro's: the recovery key is escrowed to a Microsoft account (§8), and the
> pre-boot credential can silently skip a run.

Weekly, once `BACKUP_DEST_DIR` names a path on an encrypted volume:

```
deno run --allow-run --allow-net --allow-env --allow-read --allow-write \
  scripts/backup.ts
```

**No destination on the command line, and no `BACKUP_PASSPHRASE=` prefix.** Both come from
`backup.vars` (§3) — a passphrase on a command line is a passphrase in shell history, and a
destination on a command line is a destination in four places.

### Registering the weekly task

Not registered by anything in this repository, deliberately — a task that writes member data
on a timer should be created by the person who owns the disk. Once the destination exists,
from an ordinary (non-elevated) PowerShell:

```powershell
$repo = "C:\Users\DELL\Desktop\amro\HK TECH\RAMALLAH MEMORY"
$taskArgs = '--allow-run --allow-net --allow-env --allow-read --allow-write ' +
            '"' + $repo + '\scripts\backup.ts"'
$action  = New-ScheduledTaskAction -Execute "deno.exe" -Argument $taskArgs -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 3am
Register-ScheduledTask -TaskName "RMA weekly backup" -Action $action -Trigger $trigger `
  -Description "Ramallah Memory Atlas — weekly DB dump + originals sync (docs/backup-runbook.md)"
```

(`$taskArgs`, not `$args`: `$args` is a PowerShell automatic variable, and assigning to it
is the kind of thing that works at a prompt and behaves differently the day this block is
pasted inside a function.)

Then confirm it is really there, because a task that failed to register looks identical to
one that was never attempted — and because a registration command's exit status is not the
same claim as a registered task:

```powershell
Get-ScheduledTask -TaskName "RMA weekly backup" | Select-Object TaskName,State
```

### …and that confirmation is still not enough. RUN it. (9 Sep 2026)

`State: Ready` was true of a task that could never have worked. Registered exactly as the
block above says, the first run failed instantly with `LastTaskResult = 2147942402` —
`0x80070002`, **file not found**: Task Scheduler does not resolve `deno.exe` from the user
`PATH` the way an interactive shell does, even for a task running as that user. It would have
failed at 3am every Sunday and said so nowhere.

So the registered task differs from that block in two deliberate ways:

* **`-Execute` is deno's ABSOLUTE path**, from `(Get-Command deno).Source`. This breaks if
  deno is reinstalled into a differently-named WinGet package directory — so if the task ever
  starts failing `0x80070002` again, that is the first thing to check.
* **the action is a wrapper script**, `%LOCALAPPDATA%\rma-backup\run-backup.cmd`, which `cd`s
  to the repo, runs the command, and appends stdout+stderr to
  `%LOCALAPPDATA%\rma-backup\run.log`. An inline `cmd /c … > log` was tried first and logged
  nothing at all, because Task Scheduler's argument quoting ate the redirection. The wrapper
  exists so there is exactly one log and no quoting to get wrong. **It names no destination**
  — that stays in `backup.vars`, so the one-line disk swap below is untouched.

The check that actually settles it, and the only one that would have caught any of this:

```powershell
Start-ScheduledTask -TaskName "RMA weekly backup"
# wait for State to leave Running, then:
(Get-ScheduledTaskInfo -TaskName "RMA weekly backup").LastTaskResult   # 0, and nothing else
Get-Content "$env:LOCALAPPDATA\rma-backup\run.log" -Tail 40
```

`LastTaskResult` of `267009` means still running and `267011` means never run. Neither is
success, and both are easy to misread as one.

### The task runs only while Amro is logged on

`Register-ScheduledTask` without `-User`/`-LogonType` produced `LogonType=Interactive`: the
task runs **only when DELL is logged on**. With the pre-boot credential (§8), that is the
second of two independent ways a Sunday passes with no backup and no complaint. `-LogonType
S4U` would lift it; left as registered because it changes how a job holding member data
authenticates, and that is Amro's call.

There is a third way to skip silently, and it is the prerequisite table's first row: **Docker
Desktop must be running at 3am.** Four of the six dumps are `pg_dump` in a container, and on
9 Sep the daemon was down and had to be restarted by hand before the first backup could run.
A Sunday where Docker is not up produces the four-of-six failure exactly.

**Nothing alerts on any of the three.** Each run writes a manifest under its own timestamp, so
the whole check is: newest directory under `BACKUP_DEST_DIR\db\` older than 8 days means a
backup did not happen.

### Why the profile and not the drive root

`C:\Users\DELL\rma-backups`, not `C:\rma-backups` — the path the 7 Sep rehearsal used and
which no longer exists. Three reasons, all checked rather than assumed:

* a directory in the profile inherits per-user ACLs. Verified: `SYSTEM`, `Administrators`,
  `DELL` — no `Users`, no `Everyone`. These dumps carry every member's email address;
* it is **not** a OneDrive Known-Folder-Move target. `Desktop`, `Documents` and `Pictures` all
  still point at plain profile paths on this machine, but a destination under any of them
  would be one settings change away from uploading member data to consumer OneDrive;
* the scheduled task runs as DELL and reads the passphrase from `%APPDATA%`, so a destination
  in the same profile is the one that stays reachable when the task's environment is not a
  login shell.

**Two directories under `db\` are debris from the failed task runs of 9 Sep** —
`2026-09-08T21-44-45Z` and `2026-09-08T21-51-35Z`, four files each and no manifest. They are
not restorable and nothing reads them; delete them when convenient.

### The bug the task run found: `supabase db query` has three output shapes

Written down because it invalidated every previous verification of this script, and nothing
about it was visible from inside a session.

`supabase db query` picks its output format by sniffing its environment — `--agent auto` is
the CLI's default:

| environment | output |
|---|---|
| an AI agent is detected | an OBJECT: `{boundary, rows, warning}`, the warning being a prompt-injection notice aimed at the agent |
| no agent, no `--output-format` | a **box-drawn table**, for a human |
| `--output-format json` | a bare **array** of row objects |

`backup.ts` had three call sites and all three read `.rows` off the object. **Every
verification of this script had been run from inside Claude Code**, so the agent shape was
the only one it had ever been shown. Run by Task Scheduler — or by Amro at his own prompt —
the CLI prints the table, and:

* `triggers.sql` and `function_acl.sql` die with *"query returned nothing parseable"*
  **after four dumps have already been written and encrypted**: a backup four-sixths
  complete, exiting 1;
* worse, `count()` — which feeds the completeness check — swallowed the failure with
  `json ? … : 0` and returned **0**. Every count being zero means the check compares the dump
  against nothing and passes. `"completeness_gaps": []` was not a finding; it was silence.

Fixed by REQUESTING the format (`--output-format json` at all three call sites) instead of
inheriting it, accepting **both** JSON shapes, and making `count()` throw rather than return a
silent zero. Seven self-test assertions cover the three shapes and the ways each fails.

The lesson is this project's oldest one in a new place: **a tool that behaves differently when
an agent is watching cannot be verified by an agent watching it.** The only thing that found
this was running the scheduled task and reading its exit code.

The two permanent snapshots — **these are never pruned**:

```
… scripts/backup.ts --pin pre-launch
… scripts/backup.ts --pin post-seed-import
```

These two needed it most. They are run once each, years apart, and they are **never
pruned** — a stale path there is not a stale command, it is the permanent copy written to a
disk that is no longer attached.

Rehearse anything with `--dry-run` first; it writes nothing and still reports every number.

Verify a restore (needs Docker, and refuses the production ref by name). The flags are
`--backup` and `--into-container`, not `--from` — the older spelling in earlier drafts of
this file refuses with a usage message rather than doing anything:

```
deno run -A scripts/restore-verify.ts \
  --backup <BACKUP_DEST_DIR>/db/<stamp> \
  --into-container supabase_db_<ref>
```

This one names a disk, and it is not a second copy of the destination config: it points at
**one dated snapshot**, a choice made per restore. There is nothing for a config value to
say about which copy is being proved.

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

---

## 7. When the encrypted external disk arrives — the one line that changes

**One line, in one file, and nothing else:**

```
%APPDATA%\rma-backup\backup.vars      BACKUP_DEST_DIR=E:\rma-backups
```

That is the entire swap. Specifically, none of the following need touching, and if a future
session finds itself editing one of them for a disk change, the config value has been
bypassed somewhere and that is the bug:

| | |
|---|---|
| `scripts/backup.ts` | No path in it. `resolveDestDir` reads `BACKUP_DEST_DIR`. |
| `scripts/restore-verify.ts` | Never knew the destination; takes one snapshot path per restore. |
| The scheduled task | Registered with **no destination argument**. It picks up the new value on its next run. |
| `%LOCALAPPDATA%ma-backupun-backup.cmd` | The wrapper added 9 Sep. It names the repo and the log and **no destination** — deliberately, so it did not become a second place a disk is written down. |
| The weekly and pinned commands in §4 | None of them names a disk. |
| CI | Runs `--selftest` only. It has never had a destination or a credential. |

Two things that **do** change with the disk, and neither is this file's to guess:

1. **The old destination is not migrated.** The dumps already on `C:` stay where they are
   until somebody moves or deletes them. They are AES-256-GCM and safe to move as opaque
   bytes (§1), so copying the directory across is the whole migration — but nothing does it
   automatically, and a `db/` tree left behind on `C:` is member data still sitting there.
2. **`BACKUP_DEST_ENCRYPTED=yes` still has to be true of the new disk.** It is an
   affirmation about a *volume*, and the volume changed. `backup.ts` cannot catch this one:
   its only machine-checkable case is the system drive (§3), and an external disk is outside
   what BitLocker's boot status describes. Re-affirming is a decision, not a formality.

---

## 8. Enabling BitLocker on `C:` — Amro's to run, and why it cannot be automated

Amro's decision, 8 Sep 2026: **BitLocker on `C:` for now.** This section is the procedure,
kept here so it is not re-derived.

**It is not scriptable from a session, and the reason is the recovery key.** Enabling
BitLocker needs elevation, and it produces a 48-digit recovery password that is the last
thing standing between a dead TPM and a lost disk. That key must never enter this
repository, `backup.vars`, a terminal scrollback that gets captured, or a session
transcript. So the enabling is done by hand, by the person who will store the key.

### The route to use: the wizard

The wizard is preferred over `manage-bde -on` for one reason — it has an explicit *back up
your recovery key* step offering a file or a printout, whereas `manage-bde -on C:
-RecoveryPassword` prints the key to the console, which is exactly the place it should not
be.

1. Start → search **"Manage BitLocker"** (Control Panel → System and Security → BitLocker
   Drive Encryption).
2. Under **Operating system drive (C:)** → **Turn on BitLocker**.
3. **Back up the recovery key.** Choose *Save to a file* (onto a USB stick or another
   machine — Windows will refuse to save it onto `C:` itself) or *Print*. Then put it where
   the other credentials live. Not in this repository, not in `backup.vars`, not in a chat.
4. **Choose "Encrypt entire drive", not "used disk space only."** This is the one place the
   default is wrong for this machine: `C:\rma-backups` held six unencrypted dumps of member
   data on 7 Sep and was deleted. Deleting a file does not clear its sectors, and
   used-space-only leaves exactly those sectors unencrypted.
5. Encryption mode: **New encryption mode (XTS-AES)** — this is a fixed drive, not a
   removable one.
6. Run the BitLocker **system check** when offered, and restart.

Encryption then continues in the background for a while. **Protection turns on at the
restart, not at 100%** — but let it finish before the first real backup regardless, because
a conversion in progress is a machine doing heavy disk work and the backup writes GBs.

### There is no TPM on this machine — confirmed 8 Sep 2026

Not hypothetical any more. `HKLM\SOFTWARE\Policies\Microsoft\FVE` carries
`EnableBDEWithNoTPM = 1` and `UseAdvancedStartup = 1`, so the policy route below is the one
that was taken, and **`C:` will ask for a startup password or USB key at every boot.**

**This collides with §4's scheduled task, and the collision is not theoretical.** A machine
that stops at a pre-boot prompt is a machine where an unattended restart — a Windows update
at 3am, a power cut, a crash — leaves it sitting there, and the weekly backup silently does
not run. Nothing reports that: the task's *next run time* passes, no process starts, and no
alert exists for a backup that did not happen. §11 gate 5's monitor watches publish age, not
this.

Two honest options, and it is Amro's call:

* **Accept it, and check.** The disk is the thing being protected; a pre-boot credential is
  the price of no TPM. Then the weekly cadence needs a *did it actually run* check — the
  manifest in `BACKUP_DEST_DIR` carries a timestamp per run, so "newest `db/` stamp is older
  than 8 days" is the whole test.
* **Get a TPM-backed machine for this** later, and treat the current one as interim.

What must NOT happen is discovering it the month a restore is needed.

### If the wizard says there is no TPM

Then it needs a policy change first — `gpedit.msc` → Computer Configuration →
Administrative Templates → Windows Components → BitLocker Drive Encryption → Operating
System Drives → **Require additional authentication at startup** → Enabled → tick *Allow
BitLocker without a compatible TPM* — and every boot will then ask for a password or a USB
key.

**Say so before doing that, because it interacts badly with §4's scheduled task.** A machine
that stops at a BitLocker prompt on boot is a machine where an unattended restart means the
weekly backup silently does not run. TPM state could not be read from this session
(`Get-Tpm` returns blanks and the `Win32_Tpm` CIM class answers *Access denied* without
elevation), so it is unknown rather than absent — check it with `tpm.msc`, or elevated
`Get-Tpm`.

### Confirming it worked

Unprivileged, and these are the three this project actually checks:

```powershell
(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\BitLockerStatus' -Name BootStatus).BootStatus  # want 1
Get-Item 'HKLM:\SOFTWARE\Policies\Microsoft\FVE' -ErrorAction SilentlyContinue                            # may stay absent
(Get-Service BDESVC).Status
```

`BootStatus = 1` is the one that matters: it is what `backup.ts` reads, unprivileged, to
refuse the contradiction described in §3. The FVE policy key stays absent when BitLocker is
turned on through the wizard rather than by policy — **its absence is not evidence against
encryption**, which is why the three signals were only ever read together and never
individually.

Authoritative, from an **elevated** prompt:

```
manage-bde -status C:
```

Want `Conversion Status: Fully Encrypted` and `Protection Status: Protection On`. That
output is safe to share: it names the *types* of key protector (TPM, Numerical Password),
never their values.

**`BootStatus` stays `0` between turning BitLocker on and the restart that begins
conversion.** That is not the check failing; it is the boot volume genuinely not being
protected yet. The way to tell *configured but not started* from *never configured* is the
event log, which is readable **without elevation**:

```powershell
Get-WinEvent -LogName 'Microsoft-Windows-BitLocker/BitLocker Management' -MaxEvents 10 |
  Where-Object Id -ne 4122 | Select-Object TimeCreated,Id,Message | Format-List
```

Event **769** = encryption will occur at the next restart. Event **775** = a key protector
was created. Event **828** = the recovery key was escrowed (and *where* to). Event **4122**
is routine DMA noise and appears daily; ignore it.

**Only then** does `BACKUP_DEST_ENCRYPTED=yes` go into `backup.vars`. If the signals
disagree with each other, stop — do not set it to get past a refusal.

### Where the recovery key went, recorded because it is a threat-model fact

On 8 Sep 2026 it was backed up **to Amro's Microsoft account** (event 828). That is a
legitimate choice and in some ways the safer one — an escrowed key cannot be lost in a house
move, which is the failure mode that actually destroys disks. It is written down because it
changes who can reach the archive's data at rest: **the key that unlocks a disk holding every
member's email address is recoverable by whoever can sign into that Microsoft account.** So
that account's MFA is now part of this system's security posture, in the same way the
Cloudflare account is.

If a second, offline copy is wanted as well, `manage-bde -protectors -get C:` (elevated)
prints the recovery password — and printing it to a console is exactly what §8 avoids, so do
that at a physical machine and not through anything that records a transcript.
