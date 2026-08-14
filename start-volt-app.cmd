@echo off
rem ================================================================
rem  Volt - desktop app launcher (Electron)
rem  Opens Volt in its own app window - no browser tab, no server
rem  console needed. First run downloads the Electron runtime
rem  (~110 MB, one time only).
rem
rem  NOTE: keep this file ASCII-only. cmd.exe's block parser breaks
rem  on parentheses inside parenthesized if/else blocks, so echo
rem  lines in blocks must never contain ( ) characters.
rem
rem  Every failure path routes through :showError below, which pops a
rem  native Windows error dialog (scripts\show-error.ps1) - a failed
rem  start is never a silently closing console window.
rem ================================================================
setlocal
cd /d "%~dp0pdf-viewer"

where node >nul 2>nul
if errorlevel 1 (
  echo Volt needs Node.js to run. Install it from https://nodejs.org
  call :showError "Volt needs Node.js to run. Install it from https://nodejs.org" "Volt - cannot start"
  exit /b 1
)

if not exist "node_modules\electron" (
  echo First run: downloading Volt's desktop runtime, Electron...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Could not install Electron. Check your internet connection and try again.
    call :showError "Could not install Electron. Check your internet connection and try again." "Volt - cannot start"
    exit /b 1
  )
)

if not exist "node_modules\electron\dist\electron.exe" (
  echo Downloading the Electron binary...
  node node_modules\electron\install.js
  if errorlevel 1 (
    echo Could not download Electron. Check your internet connection and try again.
    call :showError "Could not download Electron. Check your internet connection and try again." "Volt - cannot start"
    exit /b 1
  )
)

rem Make double-clicking a .pdf open it in Volt. Idempotent and safe:
rem backs up the previous association, never overrides a later change,
rem and can be undone with register-volt-file-assoc.ps1 -Revert.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\register-volt-file-assoc.ps1" -Silent >nul 2>nul

npx electron .
if errorlevel 1 (
  echo Volt closed unexpectedly.
  call :showError "Volt closed unexpectedly (exit code %errorlevel%)." "Volt - unexpected exit"
  exit /b 1
)

exit /b 0

rem ================================================================
rem  Pop a native error dialog (scripts\show-error.ps1) with the
rem  given message and title, then exit with code 1. Called from
rem  every failure path above so a failed launch is always visible.
rem ================================================================
:showError
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\show-error.ps1" "%~1" "%~2" >nul 2>nul
exit /b 1
