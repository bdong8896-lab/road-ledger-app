# 다른 PC에 설치하기 위한 "깨끗한 설치용 ZIP"을 만든다.
# 사용: make-package.bat 더블클릭, 또는
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-package.ps1 [-WithData]
#
# 포함: server(코드·vendor·db 스크립트), public, local-setup, README.md
# 제외: node_modules, server\.env 계열(비밀번호·키), uploads 안의 파일, 로그, 백업, .git, deploy(서버 배포용)
# -WithData : 이 PC의 DB 덤프와 업로드 파일을 local-setup\data 에 함께 담는다(실제 자료가 들어가므로
#             보안 규정에 맞게 취급할 것. 받는 PC에서는 restore-data.bat 로 복원).
param(
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [string]$OutDir     = (Join-Path $PSScriptRoot 'dist'),
    [string]$Container  = 'road-ledger-pg',
    [switch]$WithData
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "    실패: $m" -ForegroundColor Red; exit 1 }

$stamp = Get-Date -Format 'yyyyMMdd_HHmm'
$name  = "road-ledger-local_$stamp"
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "$name\road-ledger-app"
if (Test-Path (Split-Path $stage)) { Remove-Item -Recurse -Force (Split-Path $stage) }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Write-Host "[1/3] 파일 모으는 중..."
function Copy-Tree($rel, $xd, $xf) {
    $src = Join-Path $ProjectDir $rel
    if (-not (Test-Path $src)) { Fail "$src 가 없습니다." }
    $dst = Join-Path $stage $rel
    $rc = @($src, $dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD') + $xd + @('/XF') + $xf
    & robocopy @rc | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "$rel 복사 중 오류(robocopy 종료코드 $LASTEXITCODE)" }
}
Copy-Tree 'server' @('node_modules', 'logs', 'uploads') @('.env', '.env.production', '.env.bak', 'env.production', '*.log')
Copy-Tree 'public' @() @()
Copy-Tree 'local-setup' @('dist', 'data') @()
Copy-Item (Join-Path $ProjectDir 'README.md') $stage -Force
# 빈 uploads 폴더만 만들어 둔다
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'server\uploads') | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $stage 'server\uploads\.gitkeep') | Out-Null
Ok '코드 파일 복사 완료'

Write-Host "[2/3] 자료 포함 여부: $(if ($WithData) { '포함(-WithData)' } else { '미포함(코드만)' })"
if ($WithData) {
    $data = Join-Path $stage 'local-setup\data'
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $envFile = Join-Path $ProjectDir 'server\.env'
    if (-not (Test-Path $envFile)) { Fail 'server\.env 가 없어 DB 접속정보를 읽을 수 없습니다.' }
    $kv = @{}
    foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
        if ($line -match '^\s*(PGDATABASE|PGUSER|PGPASSWORD)\s*=\s*(.*)$') { $kv[$Matches[1]] = $Matches[2].Trim() }
    }
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    docker exec -e "PGPASSWORD=$($kv.PGPASSWORD)" $Container pg_dump -U $kv.PGUSER -d $kv.PGDATABASE -Fc -f /tmp/pkg.dump
    if ($LASTEXITCODE -ne 0) { Fail 'pg_dump 실패 — Docker 와 컨테이너 상태를 확인하세요.' }
    docker cp "${Container}:/tmp/pkg.dump" (Join-Path $data 'road_ledger.dump')
    docker exec $Container rm -f /tmp/pkg.dump
    $ErrorActionPreference = $old
    & robocopy (Join-Path $ProjectDir 'server\uploads') (Join-Path $data 'uploads') /MIR /NFL /NDL /NJH /NJS /NP `
        /XD bulk-import bulk-import-incoming bulk-import-tmp route-drawings-tmp route-drawings-zip-tmp _thumbs | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "uploads 복사 오류(robocopy $LASTEXITCODE)" }
    Ok 'DB 덤프와 업로드 파일 포함'
}

Write-Host "[3/3] ZIP 만드는 중..."
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
# bsdtar(Windows 10 이상 기본 내장)는 한글 파일명을 UTF-8 로 정확히 담는다
Push-Location (Split-Path $stage)
try {
    & tar.exe -a -c -f $zip 'road-ledger-app'
    if ($LASTEXITCODE -ne 0) { Fail 'tar 로 ZIP 을 만들지 못했습니다.' }
} finally { Pop-Location }
Remove-Item -Recurse -Force (Split-Path $stage)

$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ""
Write-Host "완료: $zip  ($mb MB)" -ForegroundColor Green
Write-Host "이 ZIP 을 새 PC 로 옮겨 풀고, local-setup\install-local.bat 을 실행하세요."
if ($WithData) { Write-Host "자료 복원: 설치 후 local-setup\restore-data.bat 실행" -ForegroundColor Yellow }
