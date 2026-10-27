# 도로대장 시스템 — 다른 PC(로컬) 자동 설치 스크립트
# 사용: install-local.bat 더블클릭(권장) 또는
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-local.ps1 [-AdminUser admin] [-AdminName 관리자]
#
# 하는 일: 필수 프로그램 확인 → PostgreSQL(Docker) 컨테이너 생성/기동 → 스키마 적용
#          → server\.env 생성 → npm install → 관리자 계정 생성
# 안전장치: 이미 있는 server\.env 는 -Force 없이는 덮어쓰지 않고, 이미 있는 컨테이너는
#          지우지 않고 그대로 재사용한다(데이터 보존).
param(
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [string]$Container  = 'road-ledger-pg',
    [int]   $PgPort     = 5433,
    [int]   $AppPort    = 8080,
    [string]$DbName     = 'road_ledger',
    [string]$DbUser     = 'road_ledger_app',
    [string]$DbPassword = '',
    [string]$AdminUser  = '',
    [string]$AdminPassword = '',
    [string]$AdminName  = '',
    [string]$VworldKey  = '',
    [switch]$Force,
    [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Step($n, $msg) { Write-Host ""; Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    !!  $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host ""; Write-Host "    실패: $msg" -ForegroundColor Red; exit 1 }
function RandomText($len) {
    $chars = (48..57) + (65..90) + (97..122)
    -join (1..$len | ForEach-Object { [char]($chars | Get-Random) })
}
# 네이티브 명령 실행(오류를 예외로 바꾸지 않고 종료코드만 본다)
function Run($file, $argList) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = & $file @argList 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    return [pscustomobject]@{ Code = $code; Out = ($out -join "`n") }
}

$server = Join-Path $ProjectDir 'server'
if (-not (Test-Path (Join-Path $server 'package.json'))) { Fail "server\package.json 을 찾을 수 없습니다. 프로젝트 폴더: $ProjectDir" }
$envFile = Join-Path $server '.env'

Write-Host "=========================================================="
Write-Host " 도로대장 시스템 로컬 설치"
Write-Host " 프로젝트 폴더: $ProjectDir"
Write-Host "=========================================================="

# ---------------------------------------------------------------- 1. 필수 프로그램
Step '1/6' '필수 프로그램 확인 (Node.js, Docker)'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.' }
$nodeVer = (Run 'node' @('-v')).Out.Trim()
$major = [int]($nodeVer.TrimStart('v').Split('.')[0])
if ($major -lt 18) { Fail "Node.js $nodeVer 는 너무 낮습니다. 18 이상(LTS 권장)을 설치하세요." }
Ok "Node.js $nodeVer"

$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) { Fail 'Docker 가 없습니다. Docker Desktop 을 설치하고 실행한 뒤 다시 실행하세요. (Docker 없이 PostgreSQL 을 직접 설치하려면 로컬설치_가이드.txt 의 "B. 수동 설치"를 따르세요.)' }
$di = Run 'docker' @('info')
if ($di.Code -ne 0) { Fail 'Docker 엔진에 연결할 수 없습니다. Docker Desktop 이 완전히 시작된 뒤(고래 아이콘이 멈춘 뒤) 다시 실행하세요.' }
Ok 'Docker 실행 중'

# ---------------------------------------------------------------- 2. PostgreSQL 컨테이너
Step '2/6' "PostgreSQL 컨테이너 ($Container, 포트 $PgPort)"
$exists = (Run 'docker' @('ps', '-a', '--filter', "name=^/${Container}$", '--format', '{{.Names}}')).Out.Trim()
$freshDb = $false
if ($exists -eq $Container) {
    Warn "이미 '$Container' 컨테이너가 있습니다 — 지우지 않고 그대로 사용합니다."
    $r = Run 'docker' @('start', $Container)
    if ($r.Code -ne 0) { Fail "컨테이너를 시작하지 못했습니다: $($r.Out)" }
    # 기존 컨테이너의 포트·계정은 컨테이너 설정을 따른다
    $mapped = (Run 'docker' @('port', $Container, '5432/tcp')).Out.Trim().Split("`n")[0]
    if ($mapped -match ':(\d+)$') { $PgPort = [int]$Matches[1] }
    foreach ($kv in (Run 'docker' @('inspect', '-f', '{{range .Config.Env}}{{println .}}{{end}}', $Container)).Out.Split("`n")) {
        if ($kv -match '^POSTGRES_USER=(.+)$') { $DbUser = $Matches[1].Trim() }
        if ($kv -match '^POSTGRES_DB=(.+)$') { $DbName = $Matches[1].Trim() }
        if ($kv -match '^POSTGRES_PASSWORD=(.+)$' -and -not $DbPassword) { $DbPassword = $Matches[1].Trim() }
    }
    Ok "기존 컨테이너 사용 (포트 $PgPort, DB $DbName, 사용자 $DbUser)"
} else {
    $inUse = Get-NetTCPConnection -State Listen -LocalPort $PgPort -ErrorAction SilentlyContinue
    if ($inUse) { Fail "포트 $PgPort 를 다른 프로그램이 이미 쓰고 있습니다. -PgPort 5434 처럼 다른 포트를 지정해 다시 실행하세요." }
    if (-not $DbPassword) { $DbPassword = RandomText 20 }
    $r = Run 'docker' @('run', '-d', '--name', $Container, '--restart', 'unless-stopped', '-p', "${PgPort}:5432",
        '-e', "POSTGRES_USER=$DbUser", '-e', "POSTGRES_PASSWORD=$DbPassword", '-e', "POSTGRES_DB=$DbName",
        '-v', "${Container}-data:/var/lib/postgresql/data", 'postgres:16-alpine')
    if ($r.Code -ne 0) { Fail "컨테이너 생성 실패(인터넷 연결 또는 Docker 상태를 확인하세요): $($r.Out)" }
    $freshDb = $true
    Ok "컨테이너 생성 완료 (데이터는 도커 볼륨 '${Container}-data' 에 보관)"
}

Write-Host '    DB 준비를 기다리는 중...' -NoNewline
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    # 최초 기동 때의 임시 서버(소켓 전용)에 속지 않도록 TCP(127.0.0.1)로 실제 질의가 되는지 본다
    $r = Run 'docker' @('exec', $Container, 'psql', '-h', '127.0.0.1', '-U', $DbUser, '-d', $DbName, '-At', '-c', 'SELECT 1')
    if ($r.Code -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 1; Write-Host '.' -NoNewline
}
Write-Host ''
if (-not $ready) { Fail "PostgreSQL 이 60초 안에 준비되지 않았습니다. docker logs $Container 로 원인을 확인하세요." }
Ok 'PostgreSQL 응답 확인'

# ---------------------------------------------------------------- 3. 스키마
Step '3/6' '스키마 적용 (schema.sql, gov_facility_schema.sql)'
# 호스트에 psql 이 없어도 되도록 컨테이너 안의 psql 을 쓴다. 한글 깨짐을 막기 위해
# 파일을 컨테이너로 복사해 -f 로 읽게 하고 클라이언트 인코딩을 UTF8 로 고정한다.
foreach ($f in @('schema.sql', 'gov_facility_schema.sql')) {
    $src = Join-Path $server "db\$f"
    if (-not (Test-Path $src)) { Fail "$src 가 없습니다." }
    $r = Run 'docker' @('cp', $src, "${Container}:/tmp/$f")
    if ($r.Code -ne 0) { Fail "$f 복사 실패: $($r.Out)" }
    $r = Run 'docker' @('exec', '-e', 'PGCLIENTENCODING=UTF8', $Container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', $DbUser, '-d', $DbName, '-f', "/tmp/$f")
    if ($r.Code -ne 0) { Fail "$f 적용 실패:`n$($r.Out)" }
    Run 'docker' @('exec', $Container, 'rm', '-f', "/tmp/$f") | Out-Null
    Ok "$f 적용 완료 (이미 있는 테이블은 건드리지 않음)"
}
$tables = (Run 'docker' @('exec', $Container, 'psql', '-U', $DbUser, '-d', $DbName, '-At', '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).Out.Trim()
Ok "public 스키마 테이블 $tables 개"

# ---------------------------------------------------------------- 4. .env
Step '4/6' 'server\.env 만들기'
if ((Test-Path $envFile) -and -not $Force) {
    Warn "server\.env 가 이미 있어 그대로 둡니다. (새로 만들려면 -Force, 이전 파일은 .env.bak 으로 보관)"
    # 기존 .env 의 DB 정보를 읽어 둔다(관리자 계정 생성에 같은 .env 를 쓰기 때문에 별도 작업 불필요)
} else {
    if (Test-Path $envFile) {
        Copy-Item $envFile "$envFile.bak" -Force
        Warn "기존 .env 를 .env.bak 으로 보관했습니다."
    }
    if (-not $DbPassword) {
        Fail '기존 컨테이너의 DB 비밀번호를 알아내지 못했습니다. -DbPassword 로 지정하거나, 기존 server\.env 를 그대로 쓰세요.'
    }
    $tpl = Join-Path $PSScriptRoot 'env.local.template'
    if (-not (Test-Path $tpl)) { Fail "$tpl 이 없습니다." }
    $text = [System.IO.File]::ReadAllText($tpl, [System.Text.Encoding]::UTF8)
    $map = @{
        '@@APP_PORT@@'       = "$AppPort"
        '@@PG_PORT@@'        = "$PgPort"
        '@@PG_DATABASE@@'    = $DbName
        '@@PG_USER@@'        = $DbUser
        '@@PG_PASSWORD@@'    = $DbPassword
        '@@SESSION_SECRET@@' = (RandomText 48)
        '@@VWORLD_KEY@@'     = $VworldKey
    }
    foreach ($k in $map.Keys) { $text = $text.Replace($k, $map[$k]) }
    [System.IO.File]::WriteAllText($envFile, $text, $utf8NoBom)
    Ok "server\.env 생성 (앱 포트 $AppPort, DB 포트 $PgPort)"
    if (-not $VworldKey) { Warn 'VWORLD_API_KEY 가 비어 있습니다 — 지도가 안 뜹니다. server\.env 를 열어 이 PC용으로 발급받은 키를 넣으세요. (가이드 "VWorld 키" 참고)' }
}

if (-not (Test-Path (Join-Path $server 'uploads'))) { New-Item -ItemType Directory -Path (Join-Path $server 'uploads') | Out-Null }

# ---------------------------------------------------------------- 5. npm
Step '5/6' 'Node 패키지 설치 (npm install)'
if ($SkipNpm) {
    Warn '-SkipNpm: 건너뜁니다.'
} else {
    Push-Location $server
    try {
        $hasLock = Test-Path (Join-Path $server 'package-lock.json')
        $npmArgs = if ($hasLock) { @('ci', '--no-audit', '--no-fund') } else { @('install', '--no-audit', '--no-fund') }
        Write-Host "    npm $($npmArgs[0]) 실행 중 (처음엔 몇 분 걸릴 수 있습니다)..."
        $r = Run 'npm.cmd' $npmArgs
        if ($r.Code -ne 0) { Fail "npm 설치 실패:`n$($r.Out)" }
        Ok '패키지 설치 완료'
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- 6. 관리자 계정
Step '6/6' '관리자 계정 만들기'
if (-not $AdminUser) {
    $AdminUser = Read-Host '    관리자 아이디 (기본 admin)'
    if (-not $AdminUser) { $AdminUser = 'admin' }
}
if (-not $AdminPassword) {
    $sec = Read-Host '    관리자 비밀번호 (8자 이상, 입력은 화면에 보이지 않음)' -AsSecureString
    $AdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}
if ($AdminPassword.Length -lt 8) { Fail '비밀번호는 8자 이상이어야 합니다. 다시 실행하세요.' }
if (-not $AdminName) { $AdminName = $AdminUser }
if ($SkipNpm -and -not (Test-Path (Join-Path $server 'node_modules'))) {
    Warn '-SkipNpm 이고 node_modules 가 없어 관리자 계정을 만들 수 없습니다. npm install 후 아래 명령을 직접 실행하세요:'
    Write-Host "      cd server ; node db/seed-admin.js $AdminUser <비밀번호> $AdminName"
} else {
    Push-Location $server
    try {
        $r = Run 'node' @('db/seed-admin.js', $AdminUser, $AdminPassword, $AdminName)
        if ($r.Code -ne 0) { Fail "관리자 계정 생성 실패:`n$($r.Out)" }
        Ok $r.Out.Trim()
    } finally { Pop-Location }
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " 설치 완료" -ForegroundColor Green
Write-Host "  실행   : local-setup\start-dev.bat 더블클릭"
Write-Host "  접속   : http://localhost:$AppPort"
Write-Host "  로그인 : $AdminUser / (방금 입력한 비밀번호)"
Write-Host "  백업   : local-setup\backup-db.bat"
Write-Host "==========================================================" -ForegroundColor Green
