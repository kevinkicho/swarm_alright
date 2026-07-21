# Install swarm + swarm-tui so they work from any PowerShell / CMD session.
# Sets user env vars:
#   SWARM_HOME  -> this repo root
#   Path        -> prepends <repo>\bin  (if not already present)
#
# Safe: never collapses existing Path entries; repairs space-glued path blobs.
#
# Usage:
#   .\scripts\install-path.ps1
#   .\scripts\install-path.ps1 -Uninstall

param(
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$binDir = Join-Path $repoRoot "bin"
$swarmCmd = Join-Path $binDir "swarm.cmd"
$tuiCmd = Join-Path $binDir "swarm-tui.cmd"

if (-not (Test-Path $swarmCmd) -or -not (Test-Path $tuiCmd)) {
  Write-Error "Missing wrappers under $binDir (expected swarm.cmd and swarm-tui.cmd)."
}

# Expand User Path into clean entries. Fixes accidental "path1 path2 path3" blobs.
function Get-UserPathEntries {
  $raw = [Environment]::GetEnvironmentVariable("Path", "User")
  $list = New-Object System.Collections.Generic.List[string]
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return [string[]]@()
  }
  foreach ($semi in $raw.Split([char]';', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    $part = $semi.Trim().Trim('"')
    if (-not $part) { continue }
    # Recover entries wrongly joined with spaces: "C:\a C:\b C:\c"
    if ($part -match ' [A-Za-z]:\\') {
      foreach ($chunk in [regex]::Split($part, ' (?=[A-Za-z]:\\)')) {
        $t = $chunk.Trim().Trim('"')
        if ($t) { [void]$list.Add($t) }
      }
    } else {
      [void]$list.Add($part)
    }
  }
  # Dedupe (case-insensitive), preserve order
  $seen = @{}
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($e in $list) {
    $key = $e.TrimEnd('\').ToLowerInvariant()
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    [void]$out.Add($e)
  }
  return [string[]]@($out.ToArray())
}

function Set-UserPathEntries([string[]]$entries) {
  # Always join with ';' only — never spaces
  $clean = @($entries | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim().Trim('"') })
  $value = $clean -join ';'
  [Environment]::SetEnvironmentVariable("Path", $value, "User")
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  if ($machine) {
    $env:Path = "$value;$machine"
  } else {
    $env:Path = $value
  }
}

if ($Uninstall) {
  [Environment]::SetEnvironmentVariable("SWARM_HOME", $null, "User")
  Remove-Item Env:SWARM_HOME -ErrorAction SilentlyContinue

  $entries = @(Get-UserPathEntries)
  $binNorm = $binDir.TrimEnd('\')
  $filtered = @($entries | Where-Object { $_.TrimEnd('\') -ine $binNorm })
  Set-UserPathEntries $filtered
  Write-Host "Removed SWARM_HOME and $binDir from user Path (other Path entries repaired/kept)."
  Write-Host "Open a new terminal for other sessions to pick this up."
  return
}

[Environment]::SetEnvironmentVariable("SWARM_HOME", $repoRoot, "User")
$env:SWARM_HOME = $repoRoot

$entries = @(Get-UserPathEntries)
$binNorm = $binDir.TrimEnd('\')
$already = $false
foreach ($e in $entries) {
  if ($e.TrimEnd('\') -ieq $binNorm) { $already = $true; break }
}

if (-not $already) {
  $newEntries = [string[]](@($binDir) + $entries)
  Set-UserPathEntries $newEntries
  Write-Host "Prepended to user Path: $binDir"
} else {
  # Still rewrite to repair any space-glued blob while keeping order
  Set-UserPathEntries $entries
  Write-Host "Already on user Path: $binDir (Path entries normalized)"
}

Write-Host "SWARM_HOME = $repoRoot"
Write-Host ""
Write-Host "Installed commands:"
Write-Host "  swarm          ->  node `$env:SWARM_HOME\src\cli.ts"
Write-Host "  swarm-tui      ->  node `$env:SWARM_HOME\src\cli.ts tui"
Write-Host ""
Write-Host "Try in this shell:  swarm help"
Write-Host "Open a NEW terminal if other apps still miss PATH."
Write-Host "Undo:  .\scripts\install-path.ps1 -Uninstall"
