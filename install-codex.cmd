@echo off
setlocal
cd /d "%~dp0"
node scripts\setup.mjs
if errorlevel 1 goto done
node scripts\install-plugin.mjs
:done
pause
