@echo off
REM Start the Road Ledger system on this PC: PostgreSQL (Docker) first, then the server.
REM If your container has a different name, change CONTAINER below.
set CONTAINER=road-ledger-pg

echo [1/2] Starting PostgreSQL (Docker container %CONTAINER%) ...
docker start %CONTAINER% >nul 2>&1
if errorlevel 1 goto :no_container

cd /d "%~dp0..\server"
if not exist node_modules goto :no_modules

echo [2/2] Starting the server. Press Ctrl+C or close this window to stop it.
call npm start
pause
exit /b 0

:no_container
echo.
echo   ERROR: could not start the container "%CONTAINER%".
echo   - Make sure Docker Desktop is running (wait until it has fully started).
echo   - On a new PC, run install-local.bat first.
echo.
pause
exit /b 1

:no_modules
echo.
echo   ERROR: server\node_modules is missing. Run install-local.bat first.
echo.
pause
exit /b 1
