# "설치 없는" 로컬 실행 패키지(RoadLedger-Local)를 만든다 — 개발 PC 에서 실행.
#   powershell -NoProfile -ExecutionPolicy Bypass -File build-package.ps1 -PgZip <postgresql-16.x-windows-x64-binaries.zip>
# 받는 PC 에는 Docker, Node.js, PostgreSQL 설치가 필요 없다(압축을 풀고 start.bat 만 실행).
# 담는 것: node.exe(이 PC 의 것) + PostgreSQL 바이너리(EnterpriseDB 공식 ZIP) + 서버/화면 코드 + 운영용 node_modules + 실행 스크립트
# PgZip 은 https://www.enterprisedb.com/download-postgresql-binaries 의 "Windows x86-64" 16.x ZIP.
param(
    [Parameter(Mandatory = $true)][string]$PgZip,
    [string]$ProjectDir = '',
    [string]$OutDir     = '',
    [string]$Name       = 'RoadLedger-Local',
    [switch]$NoZip
)
$ErrorActionPreference = 'Stop'
# (Mandatory 매개변수와 함께 쓰면 param 기본값 안의 $PSScriptRoot 가 비는 경우가 있어 본문에서 계산한다)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent $here }
if (-not $OutDir) { $OutDir = Join-Path $here 'dist' }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Step($m) { Write-Host ""; Write-Host "[$m]" -ForegroundColor Cyan }
function Fail($m) { Write-Host "  실패: $m" -ForegroundColor Red; exit 1 }
function SizeMB($p) { [math]::Round(((Get-ChildItem $p -Recurse -File -Force | Measure-Object Length -Sum).Sum) / 1MB, 0) }

if (-not (Test-Path $PgZip)) { Fail "PostgreSQL ZIP 을 찾을 수 없습니다: $PgZip" }
$stage = Join-Path $OutDir $Name
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("rl-pg-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    Step '1/5 PostgreSQL 바이너리'
    & tar.exe -xf $PgZip -C $tmp 'pgsql/bin' 'pgsql/lib' 'pgsql/share'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $tmp 'pgsql\bin\pg_ctl.exe'))) { Fail 'ZIP 에서 PostgreSQL 파일을 꺼내지 못했습니다(올바른 windows-x64-binaries ZIP 인지 확인).' }
    Move-Item (Join-Path $tmp 'pgsql') (Join-Path $stage 'pg')
    $ver = (& (Join-Path $stage 'pg\bin\postgres.exe') --version)
    Write-Host "  $ver  ($(SizeMB (Join-Path $stage 'pg')) MB)"

    Step '2/5 Node.js 실행 파일'
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime') | Out-Null
    Copy-Item $env:ProgramFiles\nodejs\node.exe (Join-Path $stage 'runtime\node.exe') -ErrorAction SilentlyContinue
    if (-not (Test-Path (Join-Path $stage 'runtime\node.exe'))) { Copy-Item (Get-Command node).Source (Join-Path $stage 'runtime\node.exe') }
    Write-Host "  node $(& (Join-Path $stage 'runtime\node.exe') -v)"
    # Visual C++ 런타임: 받는 PC 에 없어도 돌도록 같은 폴더에 둔다(앱 로컬 배포)
    foreach ($dll in 'vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll') {
        $src = Join-Path $env:windir "System32\$dll"
        if (Test-Path $src) { foreach ($d in 'runtime', 'pg\bin') { Copy-Item $src (Join-Path $stage "$d\$dll") -Force } }
    }

    Step '3/5 서버·화면 코드'
    $app = Join-Path $stage 'app'
    & robocopy (Join-Path $ProjectDir 'server') (Join-Path $app 'server') /E /NFL /NDL /NJH /NJS /NP /XD node_modules logs uploads backups /XF .env .env.production .env.bak env.production *.log ecosystem.config.js | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "server 복사 오류(robocopy $LASTEXITCODE)" }
    # 화면은 원본(public)이 아니라 난독화본(public-dist)만 담는다 — 지금 public 을 기준으로 새로 만든다(server\build-dist.js)
    Push-Location (Join-Path $ProjectDir 'server')
    try {
        $ErrorActionPreference = 'Continue'
        & node.exe build-dist.js 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 2
        $distCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($distCode -ne 0) { Fail '난독화 빌드(build-dist.js) 실패' }
    } finally { Pop-Location }
    if (-not (Test-Path (Join-Path $ProjectDir 'public-dist\app.bundle.js'))) { Fail 'public-dist 가 만들어지지 않았습니다.' }
    & robocopy (Join-Path $ProjectDir 'public-dist') (Join-Path $app 'public-dist') /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "public-dist 복사 오류(robocopy $LASTEXITCODE)" }

    Step '4/5 운영용 node_modules (npm ci --omit=dev)'
    Push-Location (Join-Path $app 'server')
    try {
        # npm 은 경고(deprecated 등)를 stderr 로 내는데, Windows PowerShell 5.1 에서는 이것이 오류로 처리되므로 잠시 완화한다
        $ErrorActionPreference = 'Continue'
        & npm.cmd ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 3
        $npmCode = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($npmCode -ne 0) { Fail 'npm ci 실패' }
    } finally { Pop-Location }
    Write-Host "  app: $(SizeMB $app) MB"

    Step '5/5 실행 스크립트와 안내문'
    & robocopy (Join-Path $here 'template') $stage /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "template 복사 오류(robocopy $LASTEXITCODE)" }
    Copy-Item (Join-Path $here '포터블_사용법.txt') (Join-Path $stage 'README.txt') -Force

    Write-Host ""
    Write-Host "폴더 완성: $stage  (전체 $(SizeMB $stage) MB)" -ForegroundColor Green
    if (-not $NoZip) {
        $zip = Join-Path $OutDir "$Name.zip"
        if (Test-Path $zip) { Remove-Item $zip -Force }
        Push-Location $OutDir
        try { & tar.exe -a -c -f $zip $Name } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { Fail 'ZIP 만들기 실패' }
        Write-Host "ZIP 완성: $zip  ($([math]::Round((Get-Item $zip).Length / 1MB, 0)) MB)" -ForegroundColor Green
    }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
