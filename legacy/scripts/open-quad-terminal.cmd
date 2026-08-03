@echo off
setlocal
REM Double-click launcher for open-quad-terminal.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-quad-terminal.ps1" %*
