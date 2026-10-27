@echo off
REM Console mode (advanced). Back up the data (DB dump + uploaded files) into the data folder, under backups.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\backup.ps1"
echo.
pause
