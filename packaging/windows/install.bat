@echo off
:: PhenixRouter - Installateur Windows (par utilisateur : aucun droit administrateur requis)
:: Copyright (c) 2026 Fido-labs -kcw-
setlocal
title PhenixRouter - Installation
chcp 65001 >nul

set "SRC=%~dp0phenixrouter-win-x64.exe"
if not exist "%SRC%" set "SRC=%~dp0..\..\dist\phenixrouter-win-x64.exe"
if not exist "%SRC%" (
  echo [!] phenixrouter-win-x64.exe introuvable.
  echo     Telechargez-le depuis la page "Releases" du depot, ou construisez-le : npm run build:exe -- --target win-x64
  pause & exit /b 1
)

set "DEST=%LOCALAPPDATA%\PhenixRouter"
set "DESKTOP=%USERPROFILE%\Desktop"
set "STARTMENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

echo Installation dans %DEST% ...
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%SRC%" "%DEST%\phenixrouter.exe" >nul || (echo [!] Copie impossible - fermez PhenixRouter s'il tourne. & pause & exit /b 1)

echo Creation des raccourcis...
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; foreach($d in '%DESKTOP%','%STARTMENU%'){ $s=$w.CreateShortcut($d+'\PhenixRouter.lnk'); $s.TargetPath='%DEST%\phenixrouter.exe'; $s.Arguments='start'; $s.WorkingDirectory='%DEST%'; $s.Description='PhenixRouter - passerelle IA gratuite'; $s.Save() }"

choice /C ON /M "Lancer PhenixRouter au demarrage de Windows (en arriere-plan) ? [O]ui / [N]on"
if errorlevel 2 goto :path
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%STARTUP%\PhenixRouter.lnk'); $s.TargetPath='%DEST%\phenixrouter.exe'; $s.Arguments='start --no-browser'; $s.WorkingDirectory='%DEST%'; $s.WindowStyle=7; $s.Save()"
echo   -> demarrage automatique active.

:path
choice /C ON /M "Ajouter la commande 'phenixrouter' au PATH de votre compte ? [O]ui / [N]on"
if errorlevel 2 goto :done
powershell -NoProfile -Command "$p=[Environment]::GetEnvironmentVariable('Path','User'); if(($p -split ';') -notcontains '%DEST%'){ [Environment]::SetEnvironmentVariable('Path',($p.TrimEnd(';')+';%DEST%'),'User') }"
echo   -> PATH mis a jour (ouvrez un nouveau terminal).

:done
echo.
echo ======================================================
echo   PhenixRouter est installe.
echo   Lancez-le via le raccourci "PhenixRouter" (Bureau / menu Demarrer).
echo   Tableau de bord : http://127.0.0.1:20128
echo   Au premier lancement, notez le mot de passe et la cle API affiches.
echo   NB : l'exe n'est pas signe ; Windows SmartScreen peut demander
echo        "Informations complementaires" puis "Executer quand meme".
echo ======================================================
pause
