@echo off
chcp 65001 >nul
REM 백업/패키지의 자료를 이 PC의 로컬 DB·uploads 로 복원.
REM 다른 백업 폴더에서 복원하려면: restore-data.bat -BackupDir D:\...\backups\20261027_101500
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restore-data.ps1" %*
echo.
pause
