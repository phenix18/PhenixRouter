@echo off
:: PhenixRouter - lancement depuis les sources (necessite Node.js 20.9+). Copyright (c) 2026 Fido-labs -kcw-
title PhenixRouter
where node >nul 2>&1 || (echo Node.js 20.9+ requis : https://nodejs.org & pause & exit /b 1)
node "%~dp0bin\phenixrouter.js" start %*
pause
