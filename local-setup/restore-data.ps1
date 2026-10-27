# 백업(또는 make-package -WithData 로 담은 자료)을 이 PC의 로컬 DB·uploads 에 복원한다.
# 사용: restore-data.bat 더블클릭(기본: local-setup\data), 또는
#   powershell -NoProfile -ExecutionPolicy Bypass -File restore-data.ps1 -BackupDir D:\...\backups\20261027_101500
#
# ⚠ 복원은 현재 DB 의 같은 이름 테이블을 덮어쓴다(pg_restore --clean). 반드시 실행 전에 확인 질문에 답해야 진행한다.
param(
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [string]$BackupDir  = (Join-Path $PSScriptRoot 'data'),
    [string]$Container  = 'road-ledger-pg',
    [switch]$Yes
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "    실패: $m" -ForegroundColor Red; exit 1 }

$dump = Join-Path $BackupDir 'road_ledger.dump'
if (-not (Test-Path $dump)) { Fail "$dump 가 없습니다. -BackupDir 로 백업 폴더(road_ledger.dump 가 들어 있는 곳)를 지정하세요." }
$envFile = Join-Path $ProjectDir 'server\.env'
if (-not (Test-Path $envFile)) { Fail 'server\.env 가 없습니다. 먼저 install-local.bat 으로 설치하세요.' }
$kv = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
    if ($line -match '^\s*(PGDATABASE|PGUSER|PGPASSWORD)\s*=\s*(.*)$') { $kv[$Matches[1]] = $Matches[2].Trim() }
}

Write-Host "복원할 백업 : $BackupDir"
Write-Host "복원 대상   : 컨테이너 $Container / DB $($kv.PGDATABASE)  +  server\uploads"
Write-Host "현재 DB 의 기존 자료는 덮어써집니다." -ForegroundColor Yellow
if (-not $Yes) {
    $a = Read-Host '계속하려면 YES 를 입력하세요'
    if ($a -ne 'YES') { Write-Host '취소했습니다.'; exit 0 }
}

$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
docker start $Container | Out-Null
docker cp $dump "${Container}:/tmp/restore.dump"
if ($LASTEXITCODE -ne 0) { Fail '덤프를 컨테이너로 복사하지 못했습니다.' }
# 일부 경고(소유자·존재하지 않는 객체 등)는 정상이라 종료코드 1 이어도 결과를 확인한다
docker exec -e "PGPASSWORD=$($kv.PGPASSWORD)" $Container pg_restore -U $kv.PGUSER -d $kv.PGDATABASE --clean --if-exists --no-owner /tmp/restore.dump
$code = $LASTEXITCODE
docker exec $Container rm -f /tmp/restore.dump | Out-Null
$ErrorActionPreference = $old
$n = (docker exec $Container psql -U $kv.PGUSER -d $kv.PGDATABASE -At -c "SELECT count(*) FROM road_sections") 2>$null
if ($code -ne 0) { Write-Host "    !! pg_restore 가 경고와 함께 끝났습니다(종료코드 $code). 위 메시지를 확인하세요." -ForegroundColor Yellow }
Ok "DB 복원 완료 — 현재 노선(구간) 수: $n"

$up = Join-Path $BackupDir 'uploads'
if (Test-Path $up) {
    & robocopy $up (Join-Path $ProjectDir 'server\uploads') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "uploads 복원 오류(robocopy $LASTEXITCODE)" }
    Ok 'uploads 복원 완료'
} else {
    Write-Host '    (백업에 uploads 폴더가 없어 파일 복원은 건너뜀)'
}

# DB 에 들어 있는 파일 경로는 백업한 PC·폴더의 절대경로라, 이 PC 의 server\uploads 로 바꿔 줘야 파일이 열린다.
# 예전 경로가 어디든 "uploads\" 뒤의 부분은 같으므로 그 앞부분만 교체한다.
$newUploads = (Join-Path $ProjectDir 'server\uploads').TrimEnd('\').Replace("'", "''")
$targets = @(
    @('route_files', 'stored_path'), @('route_files', 'converted_path'),
    @('gov_facility_files', 'stored_path'), @('road_issue_files', 'stored_path'), @('road_ledger_files', 'stored_path'),
    @('bulk_import_file_changes', 'stored_path'), @('bulk_import_file_changes', 'converted_path'), @('bulk_import_file_changes', 'trash_path'),
    @('section_trash_files', 'original_path'), @('section_trash_files', 'trash_path')
)
$remap = ($targets | ForEach-Object {
    "UPDATE $($_[0]) SET $($_[1]) = '$newUploads' || '\' || substring($($_[1]) from '(?i)[\\/]uploads[\\/](.*)$') WHERE $($_[1]) ~* '[\\/]uploads[\\/]';"
}) -join "`n"
$tmpSql = Join-Path $env:TEMP 'rl-remap.sql'
[System.IO.File]::WriteAllText($tmpSql, $remap, (New-Object System.Text.UTF8Encoding($false)))
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
docker cp $tmpSql "${Container}:/tmp/remap.sql" | Out-Null
docker exec -e "PGPASSWORD=$($kv.PGPASSWORD)" -e PGCLIENTENCODING=UTF8 $Container psql -q -U $kv.PGUSER -d $kv.PGDATABASE -f /tmp/remap.sql
$remapCode = $LASTEXITCODE
docker exec $Container rm -f /tmp/remap.sql | Out-Null
$ErrorActionPreference = $old
Remove-Item $tmpSql -Force -ErrorAction SilentlyContinue
if ($remapCode -ne 0) { Write-Host '    !! 파일 경로 보정에 실패했습니다(복원은 끝났지만 일부 파일이 열리지 않을 수 있음).' -ForegroundColor Yellow } else { Ok '파일 경로를 이 PC 의 server\uploads 기준으로 보정' }
Write-Host ''
Write-Host '복원 끝. 서버를 다시 시작한 뒤 로그인하세요(계정도 백업의 것으로 바뀌었습니다).' -ForegroundColor Green
