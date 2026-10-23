# Road-ledger production backup (native PostgreSQL on Windows Server, no Docker).
# For the local Docker PC use ..\backup-db.bat instead.
#
# What it does, one timestamped folder per run under $BackupRoot:
#   1) pg_dump -Fc of the app database        -> road_ledger.dump
#   2) integrity check of that dump (pg_restore -l)
#   3) copy of server\uploads (real data only; temporary staging folders skipped)
#   4) delete backup folders older than $KeepDays
# Every step is logged to $BackupRoot\backup.log. Exit code 0 = success, 1 = failed
# (Task Scheduler shows the last result, so a failed run is visible).
#
# Usage (PowerShell, as the account that can read the app folder and write the backup drive):
#   powershell -NoProfile -ExecutionPolicy Bypass -File backup-prod.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File backup-prod.ps1 -AppDir D:\Dsmap_ROAD -BackupRoot E:\Backup\road-ledger -KeepDays 30
#
# DB connection values are read from <AppDir>\server\.env (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD).
# The password is only put in this process's environment for pg_dump and never printed or logged.
#
# Restore (check the target DB first; --clean drops existing objects):
#   & "$PgBin\pg_restore.exe" -h localhost -p <port> -U <user> -d <db> --clean --if-exists <backup>\road_ledger.dump
#   robocopy <backup>\uploads <AppDir>\server\uploads /MIR

param(
    [string]$AppDir = 'D:\Dsmap_ROAD',
    [string]$BackupRoot = 'E:\Backup\road-ledger',
    [int]$KeepDays = 30,
    [string]$PgBin = 'C:\Program Files\PostgreSQL\18\bin'
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $BackupRoot 'backup.log'

function Write-Log([string]$msg) {
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Write-Host $line
    Add-Content -Path $logFile -Value $line
}

try {
    New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

    # --- read .env (KEY=VALUE lines, ignore comments) ---
    $envFile = Join-Path $AppDir 'server\.env'
    if (-not (Test-Path $envFile)) { throw "env file not found: $envFile" }
    $cfg = @{}
    foreach ($l in Get-Content -Path $envFile -Encoding UTF8) {
        if ($l -match '^\s*#' -or $l -notmatch '=') { continue }
        $k, $v = $l -split '=', 2
        $cfg[$k.Trim()] = $v.Trim()
    }
    foreach ($k in 'PGDATABASE', 'PGUSER', 'PGPASSWORD') {
        if (-not $cfg[$k]) { throw "$k is missing in $envFile" }
    }
    $pgHost = if ($cfg['PGHOST']) { $cfg['PGHOST'] } else { 'localhost' }
    $pgPort = if ($cfg['PGPORT']) { $cfg['PGPORT'] } else { '5432' }

    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $dir = Join-Path $BackupRoot $stamp
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Write-Log "backup start -> $dir"

    # --- 1) database dump ---
    $dump = Join-Path $dir 'road_ledger.dump'
    $env:PGPASSWORD = $cfg['PGPASSWORD']
    try {
        & (Join-Path $PgBin 'pg_dump.exe') -h $pgHost -p $pgPort -U $cfg['PGUSER'] -d $cfg['PGDATABASE'] -Fc -f $dump
        if ($LASTEXITCODE -ne 0) { throw "pg_dump failed (exit $LASTEXITCODE)" }
    } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
    Write-Log ('database dump ok ({0:N1} MB)' -f ((Get-Item $dump).Length / 1MB))

    # --- 2) dump integrity: pg_restore must be able to list its contents ---
    & (Join-Path $PgBin 'pg_restore.exe') -l $dump | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'dump integrity check failed (pg_restore -l)' }
    Write-Log 'dump integrity check ok'

    # --- 3) uploads (skip temporary staging folders, same as backup-db.bat) ---
    $uploads = Join-Path $AppDir 'server\uploads'
    if (Test-Path $uploads) {
        robocopy $uploads (Join-Path $dir 'uploads') /MIR /XD bulk-import bulk-import-incoming bulk-import-tmp route-drawings-tmp route-drawings-zip-tmp _thumbs /NFL /NDL /NJH /NJS | Out-Null
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed (exit $LASTEXITCODE)" }
        Write-Log 'uploads copy ok'
    } else {
        Write-Log "uploads folder not found, skipped: $uploads"
    }

    # --- 4) prune old backups (only timestamp-named folders) ---
    $cutoff = (Get-Date).AddDays(-$KeepDays)
    Get-ChildItem -Path $BackupRoot -Directory | Where-Object { $_.Name -match '^\d{8}_\d{6}$' -and $_.LastWriteTime -lt $cutoff } | ForEach-Object {
        Remove-Item -Recurse -Force -Path $_.FullName
        Write-Log "removed old backup: $($_.Name)"
    }

    Write-Log 'backup finished OK'
    exit 0
} catch {
    Write-Log "BACKUP FAILED: $($_.Exception.Message)"
    exit 1
}
