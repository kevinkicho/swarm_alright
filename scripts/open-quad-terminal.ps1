# Open Windows Terminal as a 2x2 PowerShell grid.
# Default cwd: this repo (or $env:SWARM_HOME if set).
#
# Usage:
#   .\scripts\open-quad-terminal.ps1
#   .\scripts\open-quad-terminal.ps1 -Path C:\path\to\project
#   .\scripts\open-quad-terminal.ps1 -Command "swarm watch"
#
# Double-click: open-quad-terminal.cmd

param(
  [string]$Path = "",
  # Optional: run this in every pane after open (PowerShell -NoExit -Command …)
  [string]$Command = "",
  # WT profile name. Leave empty for the default profile.
  [string]$Profile = "Windows PowerShell"
)

$ErrorActionPreference = "Stop"

function Resolve-WorkDir([string]$p) {
  if ($p) { return (Resolve-Path -LiteralPath $p).Path }
  if ($env:SWARM_HOME -and (Test-Path -LiteralPath $env:SWARM_HOME)) {
    return (Resolve-Path -LiteralPath $env:SWARM_HOME).Path
  }
  return (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
}

$workDir = Resolve-WorkDir $Path
if (-not (Test-Path -LiteralPath $workDir)) {
  Write-Error "Directory not found: $workDir"
}

function Find-WindowsTerminal {
  $cmd = Get-Command wt.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in @(
      "$env:LOCALAPPDATA\Microsoft\WindowsApps\wt.exe",
      "$env:ProgramFiles\Windows Terminal\wt.exe"
    )) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

$wtPath = Find-WindowsTerminal
if (-not $wtPath) {
  Write-Error "Windows Terminal (wt.exe) not found. Install it from the Microsoft Store."
}

# Build one wt command-line. Use `;` between wt subcommands (not PowerShell statements).
# Important: pass a SINGLE argument string to wt — Start-Process arrays break -d / splits.
function Build-WtCommandLine {
  $d = $workDir.Replace('"', '')
  $prof = ""
  if ($Profile) {
    $prof = " -p `"$Profile`""
  }

  # Each pane: optional profile + starting directory
  $pane = "$prof -d `"$d`""

  # Optional startup command for the shell inside the pane
  $run = ""
  if ($Command) {
    $escaped = $Command.Replace("'", "''")
    $run = " powershell.exe -NoExit -NoProfile -Command `"$escaped`""
  }

  # 2x2:
  #   new-tab (full)
  #   split-pane -V  → left | right (focus right)
  #   move-focus left ; split-pane -H  → TL / BL
  #   move-focus up ; move-focus right ; split-pane -H  → TR / BR
  return @(
    "new-tab$pane$run"
    "split-pane -V$pane$run"
    "move-focus left"
    "split-pane -H$pane$run"
    "move-focus up"
    "move-focus right"
    "split-pane -H$pane$run"
  ) -join " ; "
}

$wtCmdLine = Build-WtCommandLine
Write-Host "Opening Windows Terminal 2x2 in: $workDir"
Write-Host "wt: $wtPath"
Write-Host "cmd: $wtCmdLine"

# Single-string ArgumentList so -d / paths are not handed to PowerShell as commands.
Start-Process -FilePath $wtPath -ArgumentList $wtCmdLine
