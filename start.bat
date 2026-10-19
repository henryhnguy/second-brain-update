@echo off
rem Double-click launcher for Windows: starts the app on http://localhost:4173
rem and opens the browser once it answers. Data stays in .\data.
setlocal
cd /d "%~dp0"

rem Already running? Just open it.
curl -s -o nul --max-time 2 http://127.0.0.1:4173/api/v1/health
if not errorlevel 1 (
  start "" http://localhost:4173
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies, this runs once...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not defined SB_DATA_DIR set "SB_DATA_DIR=%~dp0data"

rem Give Next a head start, then open the browser in a separate window.
start "" cmd /c "timeout /t 10 >nul & start http://localhost:4173"

echo Starting Second Brain on http://localhost:4173
echo Press Ctrl+C to stop.
call npm run dev

echo.
echo The server stopped. Press any key to close.
pause >nul
