# 자료 백업: DB 덤프 + 업로드 파일 → data\backups\날짜_시각\
# DB 가 켜져 있을 때(start.bat 실행 중) 하는 것이 가장 안전하다. 꺼져 있으면 잠깐 켜서 백업하고 다시 끈다.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root    = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$data    = Join-Path $root 'data'
$envFile = Join-Path $root 'app\server\.env'
if (-not (Test-Path $envFile)) { Write-Host "  아직 한 번도 실행하지 않았습니다. 백업할 자료가 없습니다."; exit 1 }
try { $pgRoot = Get-PgRoot $root } catch { Write-Host "  $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
$pgBin   = Join-Path $pgRoot 'pg\bin'
$pgdata  = Join-Path $pgRoot 'data\pgdata'
$pgLog   = Join-Path $pgRoot 'data\pg.log'
$kv = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
    if ($line -match '^\s*(PGPORT|PGDATABASE|PGUSER|PGPASSWORD)\s*=\s*(.*)$') { $kv[$Matches[1]] = $Matches[2].Trim() }
}
$st = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, 'status')
$weStarted = $false
if ($st.Code -ne 0) {
    Write-Host "  DB 가 꺼져 있어 잠깐 켭니다..."
    $null = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-l', $pgLog, '-w', '-t', '90', 'start')
    $weStarted = $true
}
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$dest = Join-Path $data "backups\$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$env:PGPASSWORD = $kv.PGPASSWORD
& (Join-Path $pgBin 'pg_dump.exe') -h 127.0.0.1 -p $kv.PGPORT -U $kv.PGUSER -d $kv.PGDATABASE -Fc -f (Join-Path $dest 'road_ledger.dump')
$ok = ($LASTEXITCODE -eq 0)
if ($ok) {
    $up = Join-Path $data 'uploads'
    if (Test-Path $up) {
        & robocopy $up (Join-Path $dest 'uploads') /MIR /NFL /NDL /NJH /NJS /NP /XD bulk-import bulk-import-incoming bulk-import-tmp route-drawings-tmp route-drawings-zip-tmp _thumbs | Out-Null
        if ($LASTEXITCODE -ge 8) { $ok = $false }
    }
}
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
if ($weStarted) { $null = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-m', 'fast', '-w', 'stop') }
Remove-PgRoot
if ($ok) {
    Write-Host "  백업 완료: $dest"
    # 14일이 지난 백업 폴더 정리
    Get-ChildItem (Join-Path $data 'backups') -Directory | Where-Object { $_.Name -match '^\d{8}_\d{6}$' -and $_.LastWriteTime -lt (Get-Date).AddDays(-14) } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "  백업에 실패했습니다. 위 메시지를 확인하세요." -ForegroundColor Red
    exit 1
}
