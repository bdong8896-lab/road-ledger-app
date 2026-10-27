@echo off
REM Stop the database (use this if you closed the server window instead of pressing Ctrl+C).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop.ps1"
echo.
pause
