@echo off
REM Console mode (advanced). Stops the database if it was left running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\stop.ps1"
echo.
pause
