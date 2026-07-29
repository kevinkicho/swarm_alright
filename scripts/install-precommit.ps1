# Install repo git hooks (core.hooksPath = .githooks)
# Usage: .\scripts\install-precommit.ps1
# Uninstall: .\scripts\install-precommit.ps1 -Uninstall

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if ($Uninstall) {
  git config --unset core.hooksPath 2>$null
  Write-Host "core.hooksPath unset (hooks disabled for this repo)."
  exit 0
}

$hooks = Join-Path $root ".githooks"
if (-not (Test-Path $hooks)) {
  throw "missing $hooks"
}

git config core.hooksPath ".githooks"

# Ensure pre-commit is executable on Unix checkouts
$pre = Join-Path $hooks "pre-commit"
if (Test-Path $pre) {
  try {
    git update-index --chmod=+x .githooks/pre-commit 2>$null
  } catch {}
}

Write-Host "Installed git hooks: core.hooksPath=.githooks"
Write-Host "  pre-commit -> npm run precommit (selfcheck)"
Write-Host "Uninstall: .\scripts\install-precommit.ps1 -Uninstall"
