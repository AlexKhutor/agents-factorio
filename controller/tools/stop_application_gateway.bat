@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0application_gateway.ps1" -Command Stop -RepoRoot "%~dp0.." %*
exit /b %errorlevel%
