@echo off
REM Rollback: restores the program version kept before the last update (data is not touched).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" -Rollback %*
echo.
pause
