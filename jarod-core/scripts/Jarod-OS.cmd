@echo off
rem Jarod-OS : l'interface (dérivée de Herald OS) posée sur le noyau de Jarod. Voir docs/JAROD-OS.md.
rem   scripts\Jarod-OS.cmd [--workspace D:\JAROD-OS] [--data <dossier>] [--real-profile] [--herald "<Jarod-OS.exe>"]
setlocal
cd /d "%~dp0..\packages\cli"
"%~dp0..\node_modules\.bin\tsx.cmd" src\gateway\launch.ts %*
exit /b %errorlevel%
