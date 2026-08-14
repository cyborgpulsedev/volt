@echo off
REM 
REM  Volt  local PDF reader & AI editor  one-click launcher
REM  Double-click this file (or the desktop shortcut) to:
REM    1. start the local server (node serve.mjs) on http://localhost:8421
REM    2. wait until it is ready, then open your default browser
REM  Leave this window open while you use Volt; close it to stop the
REM  server (Ctrl+C works too).
REM 
setlocal
title Volt - PDF reader and AI editor
cd /d "%~dp0pdf-viewer"

set "PORT=8421"
if not "%1"=="" set "PORT=%1"
set "URL=http://localhost:%PORT%"

REM ---- sanity checks -------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   [!] Node.js was not found on PATH.
    echo       Install it from https://nodejs.org then try again.
    echo.
    pause
    exit /b 1
)
if not exist "serve.mjs" (
    echo.
    echo   [!] serve.mjs not found next to this launcher.
    echo       Make sure start-volt.cmd lives next to the pdf-viewer folder.
    echo.
    pause
    exit /b 1
)

REM ---- already running? just open the browser ------------------------
curl -s -o nul --max-time 2 "%URL%/index.html" >nul 2>nul
if not errorlevel 1 (
    echo Volt is already running at %URL%  opening browser
    start "" "%URL%"
    exit /b 0
)

echo.
echo   Starting Volt at %URL% 
echo   Waiting for the server, then opening your browser.
echo   Keep this window open while you read; close it to stop.
echo.

REM ---- open the browser once the server answers (detached) -----------
start "" powershell -NoProfile -WindowStyle Hidden -Command ^
  "$u='%URL%'; for($i=0;$i -lt 90;$i++){ try{ $r=Invoke-WebRequest -UseBasicParsing $u -TimeoutSec 1; if($r.StatusCode -eq 200){ Start-Process $u; break } }catch{}; Start-Sleep -Milliseconds 500 }"

REM ---- run the server in the foreground (logs stay visible) ----------
node serve.mjs %PORT%

echo.
echo   Server stopped. Goodbye!
timeout /t 2 /nobreak >nul
endlocal
