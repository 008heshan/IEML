# Deploy the freshly built ieml.exe to the Desktop, and PROVE it is the same file.
#
# WHY THIS SCRIPT EXISTS (real incident, 2026-09-13):
#   The user double-clicked the Desktop launcher to test the fixes, but that file
#   was built at 09-12 22:12 -- older than every fix of that day. So "I fixed it"
#   and "the user sees it unfixed" were both true at once.
#
#   The root cause was not a mistake, it was the FLOW:
#   `pnpm desktop:build` only writes to src-tauri/target/release/.
#   The Desktop copy had been made by hand once and was never updated again.
#   Whenever "what I built" and "what the user runs" live in two places,
#   they will drift. This script closes that gap.
#
# NOTE: this file is deliberately ASCII-only. PowerShell 5.1 reads .ps1 files as
#   ANSI when they carry no BOM, which mangles non-ASCII text (that broke the
#   first two versions of this script). Non-ASCII paths are built at runtime
#   from code points instead of being written literally here.
#
# Usage (after a build):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\env\deploy-desktop.ps1

$ErrorActionPreference = 'Continue'

# Repo root = two levels up (this script lives in tools/env/). Resolve it explicitly
# and fail loudly if it is wrong: after the tools/ reorganization this line silently
# pointed at tools/src-tauri/... and the only symptom was "build output not found".
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'src-tauri'))) {
  Write-Output "ERROR: repo root does not look right: $repoRoot"
  Write-Output "       (expected to find src-tauri there -- did the script move?)"
  exit 1
}

$src = Join-Path $repoRoot 'src-tauri\target\release\ieml.exe'
$src = [System.IO.Path]::GetFullPath($src)

# 'IEML ' + U+542F U+52A8 U+5668  ("IEML <launcher>" in Chinese)
$launcherName = 'IEML ' + [char]0x542F + [char]0x52A8 + [char]0x5668
$dst = Join-Path (Join-Path $env:USERPROFILE 'Desktop') ($launcherName + '.exe')

if (-not (Test-Path -LiteralPath $src)) {
  Write-Output "ERROR: build output not found: $src"
  Write-Output "       run 'pnpm desktop:build' first"
  exit 1
}

# (1) Stop a running copy -- Windows will not let us overwrite a running exe.
$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -eq $launcherName -or $_.ProcessName -eq 'ieml'
}
if ($running) {
  $ids = ($running | ForEach-Object { $_.Id }) -join ', '
  Write-Output ("stopping running copy (PID {0})" -f $ids)
  $running | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
}

# (2) Copy
Copy-Item -Path $src -Destination $dst -Force
if (-not (Test-Path -LiteralPath $dst)) {
  Write-Output "ERROR: copy failed, nothing at $dst"
  exit 1
}

# (3) Verify with a hash -- "it looks copied" is not evidence.
$h1 = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
$h2 = (Get-FileHash -LiteralPath $dst -Algorithm SHA256).Hash
$f1 = Get-Item -LiteralPath $src
$f2 = Get-Item -LiteralPath $dst

Write-Output ""
Write-Output ("built   : {0,10:N0} bytes  {1}" -f $f1.Length, $f1.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Output ("desktop : {0,10:N0} bytes  {1}" -f $f2.Length, $f2.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
Write-Output ("sha256  : {0}" -f $h1)

if ($h1 -ne $h2) {
  Write-Output ""
  Write-Output "FAIL: the two files differ -- the Desktop copy is NOT the fresh build, do not test with it"
  exit 1
}
Write-Output ""
Write-Output "OK: the Desktop launcher is byte-identical to the fresh build -- safe to double-click"
exit 0
