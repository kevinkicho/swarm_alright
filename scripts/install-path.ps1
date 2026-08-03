# Install go-swarm binary so `swarm` works from any PowerShell / CMD session.
# Sets user env:
#   SWARM_HOME  -> this repo root
#   Path        -> prepends <repo>\bin  (if not already present)
#
# Usage:
#   .\scripts\install-path.ps1
#   .\scripts\install-path.ps1 -Uninstall
#   .\scripts\install-path.ps1 -Build   # run go build first

param(
  [switch]$Uninstall,
  [switch]$Build
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$binDir = Join-Path $repoRoot "bin"
$goSwarm = Join-Path $repoRoot "go-swarm"
$srcExe = Join-Path $goSwarm "swarm.exe"
$destExe = Join-Path $binDir "swarm.exe"
$destCmd = Join-Path $binDir "swarm.cmd"

if ($Build) {
  Push-Location $goSwarm
  try {
    go build -o swarm.exe .
  } finally {
    Pop-Location
  }
}

if ($Uninstall) {
  [Environment]::SetEnvironmentVariable("SWARM_HOME", $null, "User")
  $raw = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($raw) {
    $parts = $raw.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) |
      Where-Object { $_.TrimEnd("\") -ne $binDir.TrimEnd("\") }
    [Environment]::SetEnvironmentVariable("Path", ($parts -join ";"), "User")
  }
  Write-Host "Uninstalled SWARM_HOME and removed $binDir from user Path."
  Write-Host "You can delete $binDir manually if desired."
  exit 0
}

if (-not (Test-Path $srcExe)) {
  Write-Host "Building go-swarm..."
  Push-Location $goSwarm
  try {
    go build -o swarm.exe .
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path $srcExe)) {
  Write-Error "Missing $srcExe — build failed or Go not installed."
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
Copy-Item -Force $srcExe $destExe

# thin cmd wrapper so `swarm` works without extension
@"
@echo off
"%~dp0swarm.exe" %*
"@ | Set-Content -Encoding ASCII $destCmd

[Environment]::SetEnvironmentVariable("SWARM_HOME", $repoRoot, "User")

$raw = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @()
if ($raw) {
  $entries = $raw.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() }
}
$normBin = $binDir.TrimEnd("\")
$has = $false
foreach ($e in $entries) {
  if ($e.TrimEnd("\") -eq $normBin) { $has = $true; break }
}
if (-not $has) {
  $newPath = $binDir
  if ($raw) { $newPath = "$binDir;$raw" }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  Write-Host "Prepended $binDir to user Path."
} else {
  Write-Host "Path already contains $binDir."
}

Write-Host "Installed:"
Write-Host "  SWARM_HOME=$repoRoot"
Write-Host "  $destExe"
Write-Host "  $destCmd"
Write-Host "Open a new terminal, then run: swarm help"
