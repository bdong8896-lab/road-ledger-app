@echo off
REM Back up the data (DB dump + uploaded files) into the data folder, under backups, one folder per run.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\backup.ps1"
echo.
pause
