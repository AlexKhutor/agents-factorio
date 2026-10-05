@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage_isolated_workspace.ps1" %*
exit /b %ERRORLEVEL%
