@echo off
REM Automatic local install. To pass options, append them to this command.
REM Example: install-local.bat -PgPort 5434 -AppPort 8090
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-local.ps1" %*
echo.
pause
