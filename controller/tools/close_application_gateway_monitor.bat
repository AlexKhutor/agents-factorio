@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0application_gateway.ps1" -Command CloseMonitor -RepoRoot "%~dp0.." %*
exit /b %errorlevel%
