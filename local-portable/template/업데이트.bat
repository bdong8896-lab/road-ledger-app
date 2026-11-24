@echo off
REM Update: replaces the program of an already-installed RoadLedger folder with this (new) package. Keeps data and app\server\.env.
REM Usage: double-click, then type/drag the OLD install folder. Or drag that folder onto this file.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1" %*
echo.
pause
