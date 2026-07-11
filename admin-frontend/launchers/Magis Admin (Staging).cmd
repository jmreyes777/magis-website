@echo off
rem ── Magis Admin desktop launcher — STAGING ─────────────────────────
rem Opens Electron directly against https://magis-admin-staging.onrender.com
rem No local build/server needed. The console carries Electron logs
rem (power events, wake reconnects); it is minimized by the shortcut.
title Magis Admin - Staging
cd /d "%~dp0.."
npm run electron:staging
pause
