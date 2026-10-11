@echo off
rem Start the QEDRank run server for the web page (Benchmark step 2, Evaluation "List runs").
rem Double-click this file and keep the window open while you use the page; closing it stops
rem the server. API keys come from your Windows user environment (scripts\set-llm-keys.ps1).
cd /d "%~dp0\.."
title QEDRank run server - keep this window open
echo QEDRank run server on http://127.0.0.1:8787  (close this window to stop it)
echo.
node qedrank\cli.js serve
echo.
echo The server has stopped. If it says "address already in use", another server window is
echo already running - use that one and close this window.
pause
