@echo off
REM Build the install ZIP to copy to another PC.
REM To include the data (DB dump + uploaded files):  make-package.bat -WithData
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-package.ps1" %*
echo.
pause
