@echo off
setlocal
title Rate Watch Dashboard
cd /d "%~dp0"
echo ============================================
echo   Rate Watch - Booking Mobile Rate Dashboard
echo ============================================
echo.
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (echo ERROR: npm install failed ^& pause ^& exit /b 1)
  echo Installing Chromium browser - one time, about 120 MB...
  call npx playwright install chromium
  if errorlevel 1 (echo ERROR: browser install failed ^& pause ^& exit /b 1)
)
echo Starting dashboard...
echo Open: http://127.0.0.1:5180
echo Close this window to stop the dashboard.
echo.
call node server.js
if errorlevel 1 (echo ERROR: dashboard failed to start ^& pause ^& exit /b 1)
