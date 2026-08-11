# Fetch a PINNED gitleaks into ./.tools/ — not onto PATH, not globally.
#
# Why pinned, and why repo-local:
#
#   A secret scanner's rule set changes between releases. An unpinned scanner means
#   the pre-commit hook and CI can disagree about whether a commit is clean, and the
#   direction of that disagreement is the bad one — CI going green on a version whose
#   rules are laxer than the one that ran locally. Both sides of this project read
#   GITLEAKS_VERSION from the same place (this file and .github/workflows/ci.yml,
#   kept in step by hand — see the comment in the workflow).
#
#   Repo-local because a fail-closed pre-commit hook on a machine with no gitleaks
#   blocks every commit. `.tools/` is git-ignored, so this is a bootstrap, not a
#   dependency the repo carries.
#
# The checksum is verified against the release's own checksums.txt. That file comes
# from the same origin as the binary, so this is not a supply-chain guarantee — it
# catches a truncated or corrupted download, nothing more. Stated plainly rather
# than dressed up.
#
#     pwsh -File scripts/install-gitleaks.ps1

$ErrorActionPreference = 'Stop'

$version = '8.30.1'
$root    = Split-Path -Parent $PSScriptRoot
$tools   = Join-Path $root '.tools'
$exe     = Join-Path $tools 'gitleaks.exe'

if (Test-Path $exe) {
  $have = (& $exe version 2>&1 | Out-String).Trim()
  if ($have -eq $version -or $have -eq "v$version") {
    Write-Host "gitleaks $version already present at .tools/gitleaks.exe" -ForegroundColor Green
    exit 0
  }
  Write-Host "replacing gitleaks $have with $version" -ForegroundColor Yellow
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  'x86'   { 'x32' }
  default { throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$asset = "gitleaks_${version}_windows_${arch}.zip"
$base  = "https://github.com/gitleaks/gitleaks/releases/download/v$version"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "gitleaks_$version"

New-Item -ItemType Directory -Force -Path $tools, $stage | Out-Null
$zip = Join-Path $stage $asset
$sum = Join-Path $stage 'checksums.txt'

Write-Host "downloading $asset ..."
Invoke-WebRequest -Uri "$base/$asset"                             -OutFile $zip -UseBasicParsing
Invoke-WebRequest -Uri "$base/gitleaks_${version}_checksums.txt"  -OutFile $sum -UseBasicParsing

$expected = (Select-String -Path $sum -Pattern ([regex]::Escape($asset)) |
             Select-Object -First 1).Line -split '\s+' | Select-Object -First 1
if (-not $expected) { throw "no checksum line for $asset in the release checksums file" }

$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $expected.ToLower()) {
  throw "checksum mismatch for ${asset}: expected $expected, got $actual"
}
Write-Host "sha256 ok  $actual" -ForegroundColor Green

Expand-Archive -Path $zip -DestinationPath $stage -Force
Copy-Item (Join-Path $stage 'gitleaks.exe') $exe -Force
Remove-Item $stage -Recurse -Force

$installed = (& $exe version 2>&1 | Out-String).Trim()
Write-Host "installed gitleaks $installed -> .tools/gitleaks.exe" -ForegroundColor Green

if ((git config core.hooksPath) -ne '.githooks') {
  Write-Host ''
  Write-Host 'Hooks are NOT active yet. One-time, per clone:' -ForegroundColor Yellow
  Write-Host '    git config core.hooksPath .githooks'
}
