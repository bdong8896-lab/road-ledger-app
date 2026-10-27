@echo off
chcp 65001 >nul
REM 로컬 PC 자동 설치. 옵션을 주려면 이 파일 뒤에 그대로 붙인다.
REM 예) install-local.bat -PgPort 5434 -AppPort 8090
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-local.ps1" %*
echo.
pause
