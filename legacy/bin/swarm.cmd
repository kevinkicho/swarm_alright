@echo off
setlocal EnableExtensions
rem Resolve install root: SWARM_HOME env, else directory above this bin\
if defined SWARM_HOME (
  set "ROOT=%SWARM_HOME%"
) else (
  set "ROOT=%~dp0.."
)
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "CLI=%ROOT%\src\cli.ts"
if not exist "%CLI%" (
  echo swarm: cannot find "%CLI%"
  echo Set SWARM_HOME to your swarm_alright repo root, or re-run scripts\install-path.ps1
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo swarm: node is not on PATH
  exit /b 1
)
node --experimental-strip-types "%CLI%" %*
exit /b %ERRORLEVEL%
