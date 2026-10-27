@echo off
chcp 65001 >nul
REM 다른 PC로 옮길 설치용 ZIP 만들기.  자료(DB·업로드 파일)까지 담으려면: make-package.bat -WithData
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-package.ps1" %*
echo.
pause
