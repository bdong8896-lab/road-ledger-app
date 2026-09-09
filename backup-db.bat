@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM Road-ledger backup: Docker Postgres dump plus uploads folder copy.
REM Run this file directly, or register it in Windows Task Scheduler for
REM a daily automatic backup. Output goes under backups, one timestamped
REM folder per run, containing road_ledger.dump (custom-format pg_dump,
REM restore with pg_restore) and uploads (copy of gov-facility-files,
REM routes, road-issues, etc). Ephemeral staging folders such as
REM bulk-import and route-drawings-tmp are excluded on purpose, they
REM only hold in-progress uploads, not real data.
REM
REM Restore, reference only, check the target DB before running this:
REM   docker cp road_ledger.dump road-ledger-pg:/tmp/restore.dump
REM   docker exec road-ledger-pg pg_restore -U road_ledger_app -d road_ledger --clean --if-exists /tmp/restore.dump

REM ===== edit only this section if needed =====
set CONTAINER=road-ledger-pg
set BACKUP_ROOT=%~dp0backups
set KEEP_DAYS=14
REM ==============================================

for /f "usebackq tokens=1,2 delims==" %%A in ("%~dp0server\.env") do (
    if "%%A"=="PGDATABASE" set PGDATABASE=%%B
    if "%%A"=="PGUSER" set PGUSER=%%B
    if "%%A"=="PGPASSWORD" set PGPASSWORD=%%B
)
if "%PGDATABASE%"=="" (
    echo Could not read PGDATABASE/PGUSER/PGPASSWORD from server\.env
    goto :error
)

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set STAMP=%%I
set DAY_DIR=%BACKUP_ROOT%\%STAMP%
mkdir "%DAY_DIR%" 2>nul

echo [1/3] Backing up database...
docker exec -e PGPASSWORD=%PGPASSWORD% %CONTAINER% pg_dump -U %PGUSER% -d %PGDATABASE% -Fc -f /tmp/road_ledger_backup.dump
if errorlevel 1 goto :error
docker cp %CONTAINER%:/tmp/road_ledger_backup.dump "%DAY_DIR%\road_ledger.dump"
if errorlevel 1 goto :error
docker exec %CONTAINER% rm -f /tmp/road_ledger_backup.dump

echo [2/3] Backing up uploaded files...
robocopy "%~dp0server\uploads" "%DAY_DIR%\uploads" /MIR /XD bulk-import bulk-import-incoming bulk-import-tmp route-drawings-tmp route-drawings-zip-tmp /NFL /NDL /NJH /NJS
if %errorlevel% GEQ 8 goto :error

echo [3/3] Cleaning up old backups...
forfiles /p "%BACKUP_ROOT%" /d -%KEEP_DAYS% /c "cmd /c if @isdir==TRUE rmdir /s /q @path" 2>nul

echo.
echo Backup complete: %DAY_DIR%
exit /b 0

:error
echo.
echo Backup failed - see the messages above.
exit /b 1
