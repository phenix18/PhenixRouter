@echo off
:: PhenixRouter - Desinstallation Windows. Copyright (c) 2026 Fido-labs -kcw-
setlocal
title PhenixRouter - Desinstallation
set "DEST=%LOCALAPPDATA%\PhenixRouter"
taskkill /IM phenixrouter.exe /F >nul 2>&1
del /Q "%USERPROFILE%\Desktop\PhenixRouter.lnk" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\PhenixRouter.lnk" "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PhenixRouter.lnk" 2>nul
powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('Path','User'); if($p){ [Environment]::SetEnvironmentVariable('Path',(($p -split ';' | Where-Object { $_ -and $_ -ne '%DEST%' }) -join ';'),'User') }"
rmdir /S /Q "%DEST%" 2>nul
echo Programme supprime.
choice /C ON /M "Supprimer aussi vos donnees (cles chiffrees, historique) dans %USERPROFILE%\.phenixrouter ? [O]ui / [N]on"
if errorlevel 2 goto :end
rmdir /S /Q "%USERPROFILE%\.phenixrouter" 2>nul
echo Donnees supprimees.
:end
pause
