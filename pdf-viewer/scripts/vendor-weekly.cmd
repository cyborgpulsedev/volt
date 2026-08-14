@echo off
REM ============================================================
REM   Volt - weekly vendored-library update check
REM   Runs the full update:vendor pipeline (download -> API check
REM   -> swap -> Electron smoke gate -> commit-or-rollback) and
REM   appends a date-stamped transcript to logs\vendor-update.log
REM   next to the app, so a pdf.js regression is caught AND logged
REM   without anyone remembering to run it.
REM
REM   Registered as a Windows Scheduled Task by
REM   scripts\schedule-vendor-weekly.ps1.  Runs every Monday 09:00
REM   while you're logged on; a missed run (PC off at the scheduled
REM   time) fires at the next logon (StartWhenAvailable).
REM
REM   Manual use (no download, just reports current vs latest):
REM     scripts\vendor-weekly.cmd --dry-run
REM   Manual full run:
REM     scripts\vendor-weekly.cmd
REM ============================================================
cd /d "%~dp0.."
if not exist "logs" mkdir "logs"
set "LOG=logs\vendor-update.log"
REM If an update is already in flight (the app's background check, or another
REM run of this task), don't fight it - log and skip. The updater itself also
REM takes an exclusive lock, so two updates can never interleave file writes.
if exist "vendor\.update-pending" (
  echo %date% %time% - skipped: an update is already in progress >> "%LOG%"
  exit /b 0
)
(
  echo.
  echo ==== vendor update - %date% %time% ====
)>> "%LOG%"
REM --no-focus: the smoke gate runs headless (no window flash / focus steal).
call npm run update:vendor -- --no-focus %* >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo   exit code %RC%>> "%LOG%"
if not "%RC%"=="0" exit /b %RC%
REM Generator regression guard: edits an app file, verifies the served /sw.js
REM cache name tracks it (and the smoke fails on a stale artifact), then
REM restores. Catches a sw.js/index.html derivation regression weekly, even
REM when no vendor update is available to trigger the pipeline's own gate.
echo ---- artifact-generator regression test ---- >> "%LOG%"
call node scripts\test-artifact-regression.mjs >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo   regression exit code %RC%>> "%LOG%"
exit /b %RC%
