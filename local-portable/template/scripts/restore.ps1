# 백업(backup.bat 으로 만든 폴더)을 이 폴더의 DB·업로드 파일로 복원한다.
#   restore.bat <백업폴더 경로>      예) restore.bat D:\RoadLedger-Local\data\backups\20261027_101500
# ⚠ 현재 DB 의 같은 이름 테이블이 덮어써진다. 확인 질문에 YES 를 입력해야 진행한다.
# 서버(start.bat 창)는 먼저 끄고 실행한다. 새 PC 에서는 start.bat 을 한 번 실행해 DB 를 만든 뒤 Ctrl+C 로 끄고 이 스크립트를 쓴다.
param(
    [Parameter(Position = 0)][string]$BackupDir = '',
    [switch]$Yes
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root    = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$data    = Join-Path $root 'data'
$envFile = Join-Path $root 'app\server\.env'
function Fail($m) { Write-Host "  실패: $m" -ForegroundColor Red; Remove-PgRoot; exit 1 }

if (-not $BackupDir) { Fail "백업 폴더를 지정하세요.  예) restore.bat `"$data\backups\20261027_101500`"" }
$dump = Join-Path $BackupDir 'road_ledger.dump'
if (-not (Test-Path $dump)) { Fail "$dump 가 없습니다. road_ledger.dump 가 들어 있는 백업 폴더를 지정하세요." }
if (-not (Test-Path $envFile) -or -not (Test-Path (Join-Path $data 'pgdata\PG_VERSION'))) { Fail "먼저 start.bat 을 한 번 실행해 DB 를 만든 뒤(Ctrl+C 로 끄고) 다시 실행하세요." }
try { $pgRoot = Get-PgRoot $root } catch { Fail $_.Exception.Message }
$pgBin  = Join-Path $pgRoot 'pg\bin'
$pgdata = Join-Path $pgRoot 'data\pgdata'
$pgLog  = Join-Path $pgRoot 'data\pg.log'
$kv = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
    if ($line -match '^\s*(PORT|PGPORT|PGDATABASE|PGUSER|PGPASSWORD)\s*=\s*(.*)$') { $kv[$Matches[1]] = $Matches[2].Trim() }
}
$appBusy = [bool]([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq [int]$kv.PORT })
if ($appBusy) { Fail "서버가 실행 중입니다(포트 $($kv.PORT)). start.bat 창에서 Ctrl+C 로 끈 뒤 다시 실행하세요." }

Write-Host "복원할 백업 : $BackupDir"
Write-Host "복원 대상   : 이 폴더의 DB($($kv.PGDATABASE)) 와 data\uploads"
Write-Host "현재 DB 의 기존 자료는 덮어써집니다. 복원 후에는 백업 시점의 계정·비밀번호로 로그인합니다." -ForegroundColor Yellow
if (-not $Yes) {
    $a = Read-Host '계속하려면 YES 를 입력하세요'
    if ($a -ne 'YES') { Write-Host '취소했습니다.'; Remove-PgRoot; exit 0 }
}

$st = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, 'status')
$weStarted = $false
if ($st.Code -ne 0) {
    $s = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-l', $pgLog, '-w', '-t', '90', 'start')
    if ($s.Code -ne 0) { Fail "DB 를 시작하지 못했습니다: $($s.Out)" }
    $weStarted = $true
}
$env:PGPASSWORD = $kv.PGPASSWORD
$psql = Join-Path $pgBin 'psql.exe'
# 일부 경고(소유자·존재하지 않는 객체 등)는 정상이라 종료코드가 1 이어도 결과 건수로 확인한다
$rs = RunNoPipe (Join-Path $pgBin 'pg_restore.exe') @('-h', '127.0.0.1', '-p', $kv.PGPORT, '-U', $kv.PGUSER, '-d', $kv.PGDATABASE, '--clean', '--if-exists', '--no-owner', $dump)
$n = & $psql -h 127.0.0.1 -p $kv.PGPORT -U $kv.PGUSER -d $kv.PGDATABASE -At -c "SELECT count(*) FROM road_sections" 2>$null
if ($rs.Code -ne 0) { Write-Host "  !! pg_restore 가 경고와 함께 끝났습니다(종료코드 $($rs.Code)):`n$($rs.Out)" -ForegroundColor Yellow }
Write-Host "  DB 복원 완료 — 현재 노선(구간) 수: $n" -ForegroundColor Green

$up = Join-Path $BackupDir 'uploads'
if (Test-Path $up) {
    & robocopy $up (Join-Path $data 'uploads') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Write-Host "  업로드 파일 복원 중 오류(robocopy $LASTEXITCODE)" -ForegroundColor Red } else { Write-Host "  업로드 파일 복원 완료" -ForegroundColor Green }
} else { Write-Host "  (백업에 uploads 폴더가 없어 파일 복원은 건너뜀)" }

# DB 에 들어 있는 파일 경로는 백업한 PC·폴더의 절대경로라, 이 폴더의 data\uploads 로 바꿔 줘야 파일이 열린다.
$sqlFile = Join-Path $data '.remap.sql'
[System.IO.File]::WriteAllText($sqlFile, (Get-PathRemapSql (Join-Path $data 'uploads')), (New-Object System.Text.UTF8Encoding($false)))
$env:PGCLIENTENCODING = 'UTF8'
$rm = RunNoPipe $psql @('-h', '127.0.0.1', '-p', $kv.PGPORT, '-U', $kv.PGUSER, '-d', $kv.PGDATABASE, '-q', '-f', $sqlFile)
Remove-Item $sqlFile -Force -ErrorAction SilentlyContinue
if ($rm.Code -ne 0) { Write-Host "  !! 파일 경로 보정에 실패했습니다: $($rm.Out)" -ForegroundColor Yellow } else { Write-Host "  파일 경로를 이 폴더 기준으로 보정했습니다" -ForegroundColor Green }
Remove-Item Env:PGPASSWORD, Env:PGCLIENTENCODING -ErrorAction SilentlyContinue
if ($weStarted) { $null = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-m', 'fast', '-w', 'stop') }
Remove-PgRoot
Write-Host "끝. start.bat 으로 다시 시작하세요."
