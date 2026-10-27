@echo off
REM Console mode (advanced). The normal way to run the program is RoadLedger.exe in the parent folder.
REM Starts DB + server + browser in this window. Options can be appended, e.g.: start.bat -AppPort 8090
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\start.ps1" %*
echo.
pause
