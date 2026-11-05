@echo off
setlocal
cd /d "%~dp0"
node scripts\setup.mjs
if errorlevel 1 echo Setup failed. See the message above.
pause
