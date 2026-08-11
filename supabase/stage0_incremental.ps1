# STAGE 0.3 — prove 0014–0015 are safe as a forward-only add-on.
#
# The claim under test: someone who already pushed 0001–0013 can apply 0014 and 0015
# on top without a reset. That matters because 0014 does ALTER TABLE ADD COLUMN
# ... GENERATED ALWAYS AS ... STORED, which rewrites a table that may already hold
# rows, and 0015 restates every privilege from `revoke all`.
#
# `supabase db reset` always applies everything, so proving the incremental case means
# hiding the later migrations, resetting, POPULATING the tables, then applying the two
# by hand and checking the generated column backfilled correctly.
#
# Run from the repo root with the local stack up:
#     pwsh -File supabase/stage0_incremental.ps1

$ErrorActionPreference = 'Stop'
$root    = Split-Path -Parent $PSScriptRoot
$migDir  = Join-Path $root 'supabase/migrations'
$holdDir = Join-Path $env:TEMP 'rma_stage0_hold'

# Everything from 0014 onward is withheld for the first reset. DERIVED, not listed:
# a hardcoded list goes stale the moment a migration is added, and the failure is
# silent — the withheld set would simply miss the new file, `db reset` would apply it
# on top of 0013, and the test would quietly stop testing what it claims to.
$boundary = '20260811091400'
$later = Get-ChildItem (Join-Path (Split-Path -Parent $PSScriptRoot) 'supabase/migrations') -Filter '*.sql' |
         Where-Object { ($_.Name -split '_')[0] -ge $boundary } |
         Sort-Object Name | Select-Object -ExpandProperty Name

function Get-DbContainer {
  $c = docker ps --filter 'name=supabase_db_' --format '{{.Names}}' | Select-Object -First 1
  if (-not $c) { throw 'No supabase_db_* container running. Run `npx supabase start` first.' }
  return $c
}

function Invoke-Sql {
  param([string]$Container, [string]$Sql, [string]$Label)
  $out = $Sql | docker exec -i $Container psql -U postgres -d postgres -v ON_ERROR_STOP=1 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL  $Label" -ForegroundColor Red
    Write-Host $out
    throw "$Label failed"
  }
  Write-Host "ok    $Label" -ForegroundColor Green
  return $out
}

function Invoke-SqlFile {
  param([string]$Container, [string]$Path, [string]$Label)
  $sql = Get-Content $Path -Raw
  return Invoke-Sql -Container $Container -Sql $sql -Label $Label
}

try {
  New-Item -ItemType Directory -Force -Path $holdDir | Out-Null
  # Captured rather than hardcoded: a literal count silently goes stale the moment a
  # migration is added, and reports a false mismatch on an otherwise clean run.
  $script:expectedCount = (Get-ChildItem $migDir -Filter '*.sql').Count

  Write-Host "`n=== withholding 0014-0020 ===" -ForegroundColor Cyan
  foreach ($f in $later) {
    Move-Item (Join-Path $migDir $f) (Join-Path $holdDir $f) -Force
  }

  Write-Host "`n=== reset to 0013 ===" -ForegroundColor Cyan
  npx --yes supabase@latest db reset
  if ($LASTEXITCODE -ne 0) { throw 'db reset to 0013 failed' }

  $db = Get-DbContainer
  Write-Host "db container: $db"

  Write-Host "`n=== populate, so 0014's ALTER runs on a non-empty table ===" -ForegroundColor Cyan
  # created_on must backfill for EXISTING rows, which is the whole point of doing this
  # before the ALTER rather than after.
  #
  # TWO rows, deliberately, because the first one on its own asserts nothing:
  #
  #   b1  2026-03-08 23:40+02  =  2026-03-08 21:40Z
  #       The 8th in UTC, the 8th in Asia/Hebron (+02, before Palestine DST starts),
  #       the 8th in Europe/Berlin. It only crosses to the 9th at >= +02:20 east,
  #       which is not a timezone in play here. This row returns the same answer
  #       whether created_on is derived in UTC or in local time, so it CANNOT FAIL
  #       and proves nothing. It is kept only as a same-day control.
  #
  #   b2  2026-03-08 00:30+02  =  2026-03-07 22:30Z
  #       UTC-derived  -> 2026-03-07
  #       local-derived -> 2026-03-08
  #       This is the row that discriminates.
  #
  # WHERE THIS ASSERTION ACTUALLY EARNS ITS KEEP — not here.
  # created_on is a STORED generated column, and Postgres already forces the issue at
  # DDL time: created_at::date is STABLE and would be rejected outright, while
  # (created_at AT TIME ZONE 'UTC')::date is IMMUTABLE and accepted. The local-time
  # bug therefore cannot exist in this column; the migration would not apply.
  # The place it CAN exist is the publish-time day-precision path (CLAUDE.md §7),
  # which formats dates in M2/M3 with no such guard. This assertion should be
  # re-pointed there when that path is built. Until then, treat it as covering the
  # generated column only — it does not cover §7's day-precision rule end to end.
  $seed = @'
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000b001', 'incr@test.local');
insert into public.profiles (id, handle) values
  ('00000000-0000-0000-0000-00000000b001', 'incr_user');
insert into public.posts
  (id, kind, title_ar, body_ar, status, created_by, location_precision, created_at)
values
  -- same-day control: 21:40Z, the 8th under every timezone in play
  ('00000000-0000-0000-0000-0000000000b1', 'media', 'قبل الترحيل', 'وصف',
   'pending', '00000000-0000-0000-0000-00000000b001', 'hidden',
   timestamptz '2026-03-08 23:40:00+02'),
  -- the discriminating row: 2026-03-07 22:30Z, i.e. the 7th in UTC, the 8th locally
  ('00000000-0000-0000-0000-0000000000b2', 'media', 'قبل منتصف الليل', 'وصف',
   'pending', '00000000-0000-0000-0000-00000000b001', 'hidden',
   timestamptz '2026-03-08 00:30:00+02');
insert into public.comments (id, post_id, body, created_by, created_at)
values
  ('00000000-0000-0000-0000-0000000000c1',
   '00000000-0000-0000-0000-0000000000b1', 'تعليق',
   '00000000-0000-0000-0000-00000000b001', timestamptz '2026-03-08 23:40:00+02'),
  ('00000000-0000-0000-0000-0000000000c2',
   '00000000-0000-0000-0000-0000000000b2', 'تعليق قبل منتصف الليل',
   '00000000-0000-0000-0000-00000000b001', timestamptz '2026-03-08 00:30:00+02');
'@
  Invoke-Sql -Container $db -Sql $seed -Label 'seed rows before ALTER' | Out-Null

  Write-Host "`n=== apply 0014 then 0015 on top ===" -ForegroundColor Cyan
  # MIGRATION HISTORY: applying a file with psql does NOT record it in
  # supabase_migrations.schema_migrations, which is how `supabase db push` decides
  # what is outstanding. Without these inserts the database ends up in a state no
  # real deployment could reach — schema at 0015, history claiming 0013 — and a
  # subsequent push would try to apply both again. Recording them keeps this test
  # faithful to the deployment path it is supposed to be modelling.
  foreach ($f in @('20260811091400_authorship.sql', '20260811091500_column_privileges.sql')) {
    Move-Item (Join-Path $holdDir $f) (Join-Path $migDir $f) -Force
    Invoke-SqlFile -Container $db -Path (Join-Path $migDir $f) -Label "apply $f" | Out-Null

    $version = ($f -split '_')[0]
    $name    = ($f -replace '^\d+_', '' -replace '\.sql$', '')
    $hist    = "insert into supabase_migrations.schema_migrations (version, name) " +
               "values ('$version', '$name') on conflict (version) do nothing;"
    Invoke-Sql -Container $db -Sql $hist -Label "record history $version" | Out-Null
  }

  Write-Host "`n=== verify the generated column backfilled ===" -ForegroundColor Cyan
  # b1 is the control and cannot fail. b2 is the assertion: 2026-03-08 00:30+02 is
  # 2026-03-07 22:30Z, so a UTC-derived created_on is the 7th and a local-derived one
  # is the 8th. If b2 reports 2026-03-08, created_on is NOT being computed at UTC.
  $check = @'
\pset tuples_only on
select 'b1 control  (21:40Z, same day either way) -> ' ||
  (select created_on from public.posts where id = '00000000-0000-0000-0000-0000000000b1') ||
  case when (select created_on from public.posts
             where id = '00000000-0000-0000-0000-0000000000b1') = date '2026-03-08'
       then '  PASS (proves nothing by design)' else '  FAIL' end;

select 'b2 discriminating (22:30Z prev day)      -> ' ||
  (select created_on from public.posts where id = '00000000-0000-0000-0000-0000000000b2') ||
  case when (select created_on from public.posts
             where id = '00000000-0000-0000-0000-0000000000b2') = date '2026-03-07'
       then '  PASS utc-derived'
       else '  FAIL local-derived' end;

select 'c2 comment discriminating                -> ' ||
  (select created_on from public.comments where id = '00000000-0000-0000-0000-0000000000c2') ||
  case when (select created_on from public.comments
             where id = '00000000-0000-0000-0000-0000000000c2') = date '2026-03-07'
       then '  PASS utc-derived'
       else '  FAIL local-derived' end;

select 'migration history rows for 0014/0015     -> ' || count(*) ||
  case when count(*) = 2 then '  PASS' else '  FAIL' end
from supabase_migrations.schema_migrations
where version in ('20260811091400', '20260811091500');
'@
  $r = Invoke-Sql -Container $db -Sql $check -Label 'created_on backfilled at UTC'
  Write-Host ($r -join "`n")

  Write-Host "`n=== verify 0015 privileges took ===" -ForegroundColor Cyan
  $priv = @'
\pset tuples_only on
select case
  when not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl, '{}'::aclitem[])) acl
    where n.nspname = 'public' and c.relkind = 'r'
      and acl.grantee = 'anon'::regrole::oid)
  then 'PASS anon holds nothing'
  else 'FAIL anon still holds a grant'
end;
'@
  $r2 = Invoke-Sql -Container $db -Sql $priv -Label 'anon grants revoked incrementally'
  Write-Host ($r2 -join "`n")
}
finally {
  Write-Host "`n=== restoring withheld migrations ===" -ForegroundColor Cyan
  Get-ChildItem $holdDir -Filter '*.sql' -ErrorAction SilentlyContinue | ForEach-Object {
    Move-Item $_.FullName (Join-Path $migDir $_.Name) -Force
  }
  Remove-Item $holdDir -Recurse -Force -ErrorAction SilentlyContinue
  $n = (Get-ChildItem $migDir -Filter '*.sql').Count
  $exp = $script:expectedCount
  $verdict = if ($n -eq $exp) { 'ok' } else { 'MISMATCH — a migration may still be in the hold dir' }
  Write-Host "migrations present: $n (expected $exp) $verdict"
}
