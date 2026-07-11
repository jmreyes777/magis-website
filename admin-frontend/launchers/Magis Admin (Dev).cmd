@echo off
rem ── Magis Admin desktop launcher — DEV ─────────────────────────────
rem Starts the CRA dev server on :3001 and attaches Electron to it.
rem Keep this console open: it shows CRA + Electron logs. Closing it
rem kills the dev server.
title Magis Admin - Dev
cd /d "%~dp0.."
npm start
pause
