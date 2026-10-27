@echo off
chcp 65001 >nul
REM 로컬 PC에서 도로대장 시스템 실행: PostgreSQL(Docker) 시작 -> 서버 시작
REM 컨테이너 이름이 다르면 아래 CONTAINER 만 고친다.
set CONTAINER=road-ledger-pg

echo [1/2] PostgreSQL(Docker) 시작 확인 중...
docker start %CONTAINER% >nul 2>&1
if errorlevel 1 (
    echo.
    echo   !! %CONTAINER% 컨테이너를 시작하지 못했습니다.
    echo      - Docker Desktop 이 실행 중인지 확인하세요.
    echo      - 처음 설치라면 먼저 install-local.bat 을 실행하세요.
    echo.
    pause
    exit /b 1
)

echo [2/2] 서버 시작 중... (끄려면 이 창에서 Ctrl+C 를 누르거나 창을 닫으세요)
cd /d "%~dp0..\server"
if not exist node_modules (
    echo.
    echo   !! node_modules 가 없습니다. 먼저 install-local.bat 을 실행하세요.
    echo.
    pause
    exit /b 1
)
call npm start
pause
