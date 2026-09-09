@echo off
title Ad Pilot Dashboard
cd /d "%~dp0"
echo ========================================================
echo   Launching Ad Pilot Dashboard and Secure Tunnel...
echo ========================================================
node scripts/start-all.js
pause
