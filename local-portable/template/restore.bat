@echo off
REM Restore a backup made by backup.bat.  Usage: restore.bat "<backup folder that contains road_ledger.dump>"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restore.ps1" %*
echo.
pause
