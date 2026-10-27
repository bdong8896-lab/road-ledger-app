@echo off
REM Restore a backup / package data into this PC's local DB and uploads folder.
REM To restore from another backup folder: restore-data.bat -BackupDir D:\...\backups\20261027_101500
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-data.ps1" %*
echo.
pause
