@echo off
chcp 65001 >nul
echo [1/2] PostgreSQL(Docker) 상태 확인 중...
docker start road-ledger-pg
echo [2/2] 서버 시작 중... (끄려면 이 창을 그냥 닫으세요 — Ctrl+C 대신 X 버튼 권장)
cd /d "%~dp0server"
call npm start
pause
