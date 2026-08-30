# Prove .gitleaks.toml does what it claims — the same discipline the RLS policies get.
#
# A secret scanner is the one tool whose failure mode is silence. A config that
# matches nothing produces exactly the output of a clean repo, and the only way to
# tell them apart is to hand it something that MUST be caught and watch it catch it.
#
# Every assertion here therefore has a paired control:
#
#   · service_role keys are caught          <- and at all three base64 alignments,
#                                              not just the one that happened to be
#                                              generated first
#   · the anon key is NOT caught            <- and the CONTROL run, with the allowlist
#                                              stripped, proves it WOULD be. Without
#                                              that control, "no finding" is
#                                              indistinguishable from "never scanned",
#                                              which is how a suppression that
#                                              suppresses everything passes review.
#   · the anon carve-out cannot widen       <- the service_role assertions run with the
#                                              allowlist ACTIVE
#   · the default ruleset is still live     <- an AWS key, so a broken [extend] shows up
#                                              here rather than as a quiet gap
#   · .gitleaks.toml does not flag itself   <- it contains the markers as bare strings
#
# Note on the AWS control: it must not be AWS's own documented example key
# (AKIAIOSFODNN7EXAMPLE). Gitleaks' default allowlist ignores that one, so using it
# produces a silent non-finding and the control tests nothing. Found the hard way.
#
#     pwsh -File scripts/gitleaks-selftest.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$gl   = Join-Path $root '.tools/gitleaks.exe'
# Null-conditional (?.) is PowerShell 7 only, and Windows PowerShell 5.1 is what a
# Windows maintainer has on PATH as `powershell.exe` -- there, this line was a PARSE
# error, so the whole script died before its first assertion. CI (pwsh on ubuntu) never
# saw it. Written the long way so the self-test runs on both.
if (-not (Test-Path $gl)) {
  $cmd = Get-Command gitleaks -ErrorAction SilentlyContinue
  $gl  = $null
  if ($cmd) { $gl = $cmd.Source }
}
if (-not $gl) { throw 'gitleaks not found. Run: pwsh -File scripts/install-gitleaks.ps1' }

$work = Join-Path ([System.IO.Path]::GetTempPath()) ('gitleaks_selftest_' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $work | Out-Null

function B64Url([string]$s) {
  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s)).TrimEnd('=').Replace('+','-').Replace('/','_')
}
# A JWT with a fake signature. The signature is never validated by a scanner — shape
# is all that matters — but it is spelled out so nobody mistakes this for a live key.
function MakeJwt([string]$role, [string]$pad) {
  $hdr = B64Url '{"alg":"HS256","typ":"JWT"}'
  $pl  = B64Url ('{"iss":"supabase","ref":"pjqvtmhizbnimqyxjbyq' + $pad + '","role":"' + $role + '","iat":1754870000,"exp":2070230000}')
  "$hdr.$pl.bm90X2FfcmVhbF9zaWduYXR1cmVfdGhpc19pc19hX3Rlc3RfZml4dHVyZQ"
}

# The pad shifts the byte offset of the "role" claim, which is what moves it between
# base64 group alignments. '' / 'x' / 'xx' cover offset%3 of 2 / 0 / 1 respectively.
$align = @{ '' = 2; 'x' = 0; 'xx' = 1 }
foreach ($pad in $align.Keys) {
  $a = $align[$pad]
  Set-Content -NoNewline -Path (Join-Path $work "svc_mod$a.txt") -Value "SUPABASE_SERVICE_ROLE_KEY=$(MakeJwt 'service_role' $pad)`n"
  Set-Content -NoNewline -Path (Join-Path $work "anon_mod$a.js")  -Value "const SUPABASE_ANON_KEY = `"$(MakeJwt 'anon' $pad)`";`n"
}
# Every fixture value is ASSEMBLED, never written as a literal.
#
# The first run of this suite failed on its own source: gitleaks correctly flagged the
# sb_secret_ and AWS fixtures sitting in this file. The tempting fix is a path
# allowlist for scripts/, and it is the wrong one — it would also swallow a real key
# pasted here by accident, in a file nobody reads closely because "it's just tests".
# Splitting the literals keeps the file clean under its own scanner, with no
# suppression anywhere. Assertion 16 pins that.
$sbSecret = 'sb_' + 'secret_' + '9Xq2vLm4TzR8pKdW1nHb7Y'
$sbPub    = 'sb_' + 'publishable_' + '4TzR8pKdW1nHb7YqLm2vX'
$awsId    = 'AKIA' + '4YFAKEQ7MZ2XPLM3'
$awsSec   = 'kR8vT2xQ9pLmN4wZ' + '1cY7bF3jH6sD0aG5eU8iO2rT'

Set-Content -NoNewline -Path (Join-Path $work 'sbsecret.txt') -Value "SUPABASE_SECRET_KEY=$sbSecret`n"
Set-Content -NoNewline -Path (Join-Path $work 'sbpub.txt')    -Value "SUPABASE_PUBLISHABLE_KEY=$sbPub`n"
Set-Content -NoNewline -Path (Join-Path $work 'aws.txt')      -Value "aws_access_key_id = $awsId`naws_secret_access_key = `"$awsSec`"`n"
Copy-Item (Join-Path $root '.gitleaks.toml') (Join-Path $work 'config_selfscan.toml.txt')

# The fixture that actually decides whether this config is any good: the client config
# module M3 will commit. It carries the project URL and BOTH public keys, and it must
# be silent — a scanner that cries wolf on the one file the maintainer edits weekly is
# a scanner that gets bypassed. Its twin carries a service_role key in the same shape,
# because "the client config is allowed to hold keys" is exactly the belief under which
# the wrong key gets pasted into it.
$clientCfg = @"
export const SUPABASE_URL = 'https://pjqvtmhizbnimqyxjbyq.supabase.co';
export const SUPABASE_ANON_KEY = '$(MakeJwt 'anon' '')';
export const SUPABASE_PUBLISHABLE_KEY = '$sbPub';
"@
Set-Content -NoNewline -Path (Join-Path $work 'client_config_ok.js') -Value $clientCfg
Set-Content -NoNewline -Path (Join-Path $work 'client_config_poisoned.js') -Value `
  ($clientCfg -replace "SUPABASE_ANON_KEY = '[^']+'", "SUPABASE_ANON_KEY = '$(MakeJwt 'service_role' '')'")

# Windows PowerShell 5.1 turns ANY stderr line from a native exe into a NativeCommandError
# ErrorRecord, and with $ErrorActionPreference = Stop that TERMINATES the script -- even
# though gitleaks exited 0. gitleaks writes its INF progress lines to stderr, so every
# invocation below tripped it and the script died before assertion 1. pwsh on the CI image
# does not do this, which is why CI was green while the script could not run on a Windows
# maintainer machine at all. Every native call goes through here.
function RunGl([string[]]$glArgs) {
  $ErrorActionPreference = 'Continue'   # function-scoped; reverts on return
  & $gl @glArgs 2>$null | Out-String
}

# Run gitleaks and return a set of "file|ruleid" strings.
function Scan([string]$cfg, [string]$target) {
  if ([string]::IsNullOrWhiteSpace($target)) { $target = $work }
  # `-r -` writes the report to stdout. `-r /dev/stdout` silently produces an EMPTY
  # report on Windows, which reads exactly like a clean scan. Do not "simplify" this.
  $json = RunGl @('dir', $target, '-c', $cfg, '--no-banner', '--redact', '-f', 'json', '-r', '-', '--exit-code', '0')
  if ([string]::IsNullOrWhiteSpace($json.Trim())) { return @() }
  # PS 5.1 hands the whole JSON array down the pipeline as ONE object where PS 7
  # enumerates it, so a bare `| ForEach-Object` sees a single item and string
  # interpolation flattens every finding into one space-joined line -- which reads as
  # ONE finding named after the first file, and turns every "is caught" assertion red
  # while every "is not a finding" assertion stays green. Explicit @() forces the
  # enumeration; the Where-Object drops the lone $null that 5.1 yields for an empty
  # report where 7 yields an empty array.
  $parsed = @(ConvertFrom-Json $json) | Where-Object { $null -ne $_ }
  return @($parsed | ForEach-Object { "$([IO.Path]::GetFileName($_.File))|$($_.RuleID)" })
}

$cfg     = Join-Path $root '.gitleaks.toml'
$ctlPath = Join-Path $work 'control_no_allowlist.toml'
# Strip only the anon carve-out, keeping every rule, so the control differs from the
# real config in exactly one respect.
$lines = Get-Content $cfg
$skip = $false
$lines | ForEach-Object {
  if ($_ -match '^# ── The one carve-out') { $script:skip = $true }
  if ($_ -match '^# ── Paths')             { $script:skip = $false }
  if (-not $script:skip) { $_ }
} | Set-Content $ctlPath

$found   = Scan $cfg
$control = Scan $ctlPath

$n = 0; $bad = 0
function Assert([bool]$cond, [string]$msg) {
  $script:n++
  if ($cond) { Write-Host ("ok {0} - {1}" -f $script:n, $msg) -ForegroundColor Green }
  else       { Write-Host ("not ok {0} - {1}" -f $script:n, $msg) -ForegroundColor Red; $script:bad++ }
}

# Assertion 16 scans this repo's own scripts/ and .githooks/ — the files that must
# discuss secrets in order to test for them. Kept as a real scan rather than a promise
# in a comment, because "the test file is clean" is a claim with a short half-life.
# Routed through Scan so there is exactly ONE place that parses a gitleaks report --
# the second copy is what quietly disagreed with the first about an empty result.
$selfFindings = @(Scan $cfg (Join-Path $root 'scripts')) + @(Scan $cfg (Join-Path $root '.githooks'))
$selfFindings = @($selfFindings)

Write-Host "1..16"
foreach ($a in 0,1,2) {
  Assert ($found -contains "svc_mod$a.txt|supabase-service-role-key") `
    "service_role key at base64 alignment $a is caught by supabase-service-role-key"
}
foreach ($a in 0,1,2) {
  Assert (-not ($found | Where-Object { $_ -like "anon_mod$a.js|*" })) `
    "anon key at alignment $a is not a finding (CLAUDE.md §6 - public by design)"
}
Assert (@($control | Where-Object { $_ -like 'anon_mod*' }).Count -eq 3) `
  "CONTROL: with the carve-outs stripped, all three anon keys DO fire - they were genuinely scanned"
Assert ($found -contains 'sbsecret.txt|supabase-secret-key') `
  "sb_secret_ key is caught with no assignment keyword to lean on"
Assert (-not ($found | Where-Object { $_ -like 'sbpub.txt|*' })) `
  "sb_publishable_ key is not a finding"
Assert (@($control | Where-Object { $_ -like 'sbpub.txt|*' }).Count -ge 1) `
  "CONTROL: with the carve-outs stripped, the publishable key DOES fire (generic-api-key)"
Assert ($found -contains 'aws.txt|aws-access-token') `
  "CONTROL: the default ruleset is still active ([extend] useDefault)"
Assert (-not ($found | Where-Object { $_ -like 'config_selfscan.toml.txt|*' })) `
  ".gitleaks.toml does not flag its own base64 markers"
Assert (@($found | Where-Object { $_ -like 'svc_mod*|supabase-service-role-key' }).Count -eq 3) `
  "the carve-outs cannot widen: all three service_role keys still caught with them ACTIVE"
Assert (-not ($found | Where-Object { $_ -like 'client_config_ok.js|*' })) `
  "a realistic M3 client config (URL + anon + publishable) is silent - no false positive to train around"
Assert ($found -contains 'client_config_poisoned.js|supabase-service-role-key') `
  "...but a service_role key pasted into that SAME file is still caught"
Assert ($selfFindings.Count -eq 0) `
  "scripts/ and .githooks/ are clean under this config with NO path allowlist ($($selfFindings -join ', '))"

Remove-Item $work -Recurse -Force
if ($bad -gt 0) { Write-Host "`nFAILED $bad of $n" -ForegroundColor Red; exit 1 }
Write-Host "`nAll $n assertions passed." -ForegroundColor Green
