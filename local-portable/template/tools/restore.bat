@echo off
REM Console mode (advanced). Restore a backup made by backup.bat.  Usage: restore.bat "<backup folder that contains road_ledger.dump>"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\restore.ps1" %*
echo.
pause
