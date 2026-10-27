@echo off
REM Road Ledger - portable local run. Double-click to start (DB + server + browser).
REM First run sets up the database and asks for an admin account. Options can be appended, e.g.: start.bat -AppPort 8090
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1" %*
echo.
pause
