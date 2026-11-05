@echo off
setlocal
cd /d "%~dp0"
node scripts\setup.mjs --remove
pause
