@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_child_coordination_kit.ps1" %*
exit /b %ERRORLEVEL%
