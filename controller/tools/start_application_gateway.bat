@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0application_gateway.ps1" -Command Start -RepoRoot "%~dp0.." -Provider claude %*
exit /b %errorlevel%
