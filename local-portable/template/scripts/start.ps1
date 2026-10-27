# 도로대장 시스템 포터블(설치 없는) 실행 스크립트
#  - 처음 실행: DB 초기화 → 스키마 적용 → 설정 파일 생성 → 관리자 계정 생성
#  - 이후 실행: DB 시작 → 서버 시작 → 브라우저 열기
#  - 끝낼 때: 이 창에서 Ctrl+C (DB도 함께 종료). 창을 그냥 닫으면 DB가 남으니 stop.bat 으로 끈다.
param(
    [int]$PgPort = 0,
    [int]$AppPort = 0,
    [switch]$NoBrowser,
    [string]$AdminUser = '',
    [string]$AdminPassword = '',
    [string]$VworldKey = $null
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$root    = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
$node    = Join-Path $root 'runtime\node.exe'
$server  = Join-Path $root 'app\server'
$data    = Join-Path $root 'data'
$envFile = Join-Path $server '.env'
# DB 관련 경로는 영문 경로로 쓴다(폴더 경로에 한글이 있으면 가상 드라이브로 연결 — common.ps1 참고)
try { $pgRoot = Get-PgRoot $root } catch { Write-Host ""; Write-Host "  실패: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
$pgBin   = Join-Path $pgRoot 'pg\bin'
$pgdata  = Join-Path $pgRoot 'data\pgdata'
$pgLog   = Join-Path $pgRoot 'data\pg.log'

function Info($m) { Write-Host $m }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host ""; Write-Host "  실패: $m" -ForegroundColor Red; Write-Host ""; Remove-PgRoot; exit 1 }
function RandomText($len) { $c = (48..57) + (65..90) + (97..122); -join (1..$len | ForEach-Object { [char]($c | Get-Random) }) }
function Run($file, $argList) {
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    $out = & $file @argList 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    return [pscustomobject]@{ Code = $code; Out = ($out -join "`n") }
}
function PortInUse($p) {
    $l = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return [bool]($l | Where-Object { $_.Port -eq $p })
}
function FindFreePort($start) {
    for ($p = $start; $p -lt $start + 60; $p++) { if (-not (PortInUse $p)) { return $p } }
    Fail "$start 근처에서 비어 있는 포트를 찾지 못했습니다."
}
function ReadEnv($key) {
    if (-not (Test-Path $envFile)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") { return $Matches[1].Trim() }
    }
    return $null
}

Write-Host "=========================================================="
Write-Host " 도로대장 시스템 (설치 없는 로컬 실행)"
Write-Host "=========================================================="

# ---- 0. 점검
foreach ($f in @($node, (Join-Path $pgBin 'pg_ctl.exe'), (Join-Path $pgBin 'initdb.exe'), (Join-Path $server 'index.js'))) {
    if (-not (Test-Path $f)) { Fail "필요한 파일이 없습니다: $f`n  ZIP 을 끝까지 풀었는지, 보안 프로그램이 파일을 지우지 않았는지 확인하세요." }
}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Fail "관리자 권한으로 실행되어 있습니다. PostgreSQL 은 관리자 권한으로는 실행되지 않습니다.`n  '관리자 권한으로 실행'을 하지 말고, start.bat 을 그냥 더블클릭하세요." }

# 인터넷에서 받은 ZIP 을 풀면 실행 파일에 '차단' 표시가 붙어 경고창이 뜰 수 있다 — 처음 한 번만 풀어 준다.
$unblockMark = Join-Path $data '.unblocked'
if (-not (Test-Path $unblockMark)) {
    Info "  실행 파일 차단 표시를 정리하는 중(처음 한 번)..."
    try { Get-ChildItem $root -Recurse -File -Include *.exe, *.dll, *.ps1, *.bat -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue } catch { }
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    New-Item -ItemType File -Force -Path $unblockMark | Out-Null
}

# ---- 1. 처음 실행이면 DB 만들기
$firstRun = -not (Test-Path (Join-Path $pgdata 'PG_VERSION'))
if ($firstRun) {
    Info ""
    Info "[처음 실행] 데이터베이스를 준비합니다. 1~2분 걸립니다."
    if (-not $PgPort)  { $PgPort  = FindFreePort 5433 }
    if (-not $AppPort) { $AppPort = FindFreePort 8080 }
    if (PortInUse $PgPort)  { Fail "DB 포트 $PgPort 가 이미 사용 중입니다. -PgPort 로 다른 포트를 지정하세요." }
    if (PortInUse $AppPort) { Fail "앱 포트 $AppPort 가 이미 사용 중입니다. -AppPort 로 다른 포트를 지정하세요." }

    $dbPass = RandomText 24
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $pwf = Join-Path $data '.pwfile'
    [System.IO.File]::WriteAllText($pwf, $dbPass, $utf8NoBom)
    $r = Run (Join-Path $pgBin 'initdb.exe') @('-D', $pgdata, '-U', 'road_ledger_app', "--pwfile=$pwf", '-A', 'scram-sha-256', '-E', 'UTF8', '--no-locale')
    Remove-Item $pwf -Force -ErrorAction SilentlyContinue
    if ($r.Code -ne 0) { Remove-Item -Recurse -Force $pgdata -ErrorAction SilentlyContinue; Fail "DB 초기화(initdb)에 실패했습니다:`n$($r.Out)" }
    Ok "DB 초기화"

    $conf = Join-Path $pgdata 'postgresql.conf'
    $extra = @("", "# --- 도로대장 포터블 설정", "listen_addresses = '127.0.0.1'", "port = $PgPort", "max_connections = 40", "shared_buffers = 128MB")
    [System.IO.File]::AppendAllText($conf, ($extra -join "`r`n") + "`r`n", $utf8NoBom)

    $r = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-l', $pgLog, '-w', '-t', '90', 'start')
    if ($r.Code -ne 0) { Fail "DB 를 시작하지 못했습니다:`n$($r.Out)`n  자세한 내용: $data\pg.log" }
    $env:PGPASSWORD = $dbPass
    $r = Run (Join-Path $pgBin 'psql.exe') @('-h', '127.0.0.1', '-p', "$PgPort", '-U', 'road_ledger_app', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-c', 'CREATE DATABASE road_ledger')
    if ($r.Code -ne 0) { Fail "DB(road_ledger) 생성에 실패했습니다:`n$($r.Out)" }
    $env:PGCLIENTENCODING = 'UTF8'
    foreach ($f in @('schema.sql', 'gov_facility_schema.sql')) {
        $r = Run (Join-Path $pgBin 'psql.exe') @('-h', '127.0.0.1', '-p', "$PgPort", '-U', 'road_ledger_app', '-d', 'road_ledger', '-v', 'ON_ERROR_STOP=1', '-q', '-f', (Join-Path $server "db\$f"))
        if ($r.Code -ne 0) { Fail "$f 적용에 실패했습니다:`n$($r.Out)" }
    }
    Ok "테이블 만들기(스키마 적용)"

    # VWorld 키(없어도 실행은 되지만 지도가 안 뜬다)
    if ($null -eq $VworldKey) {
        Info ""
        Info "  VWorld 지도 키를 입력하세요. 이 PC 용으로 발급받은 키(서비스 URL: http://localhost)입니다."
        $VworldKey = (Read-Host '  키 (지금 없으면 그냥 Enter — 나중에 app\server\.env 에 넣으면 됩니다)').Trim()
    }
    $envText = @"
PORT=$AppPort
HOST=127.0.0.1
PGHOST=127.0.0.1
PGPORT=$PgPort
PGDATABASE=road_ledger
PGUSER=road_ledger_app
PGPASSWORD=$dbPass
SESSION_SECRET=$(RandomText 48)
SESSION_MAX_AGE_HOURS=8
VWORLD_API_KEY=$VworldKey
VWORLD_REFERER=http://localhost/
ITS_CCTV_API_KEY=
UPLOAD_DIR=../../data/uploads
SERVE_DIR=public-dist
DWG_CONVERTER_PATH=
ADMIN_REAUTH_MINUTES=15
"@
    [System.IO.File]::WriteAllText($envFile, $envText, $utf8NoBom)
    Ok "설정 파일 만들기 (app\server\.env)"
    if (-not $VworldKey) { Warn "VWorld 키가 비어 있어 지도가 보이지 않습니다. 키를 받으면 app\server\.env 의 VWORLD_API_KEY= 뒤에 넣고 다시 실행하세요." }

    # 관리자 계정
    if (-not $AdminUser) {
        Info ""
        $AdminUser = (Read-Host '  관리자 아이디 (기본 admin)').Trim()
        if (-not $AdminUser) { $AdminUser = 'admin' }
    }
    if (-not $AdminPassword) {
        $sec = Read-Host '  관리자 비밀번호 (8자 이상, 입력은 화면에 보이지 않음)' -AsSecureString
        $AdminPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    }
    if ($AdminPassword.Length -lt 8) { Fail "비밀번호는 8자 이상이어야 합니다. start.bat 을 다시 실행하면 이어서 진행됩니다." }
    Push-Location $server
    try {
        $r = Run $node @('db/seed-admin.js', $AdminUser, $AdminPassword, $AdminUser)
        if ($r.Code -ne 0) { Fail "관리자 계정 생성 실패:`n$($r.Out)" }
        Ok $r.Out.Trim()
    } finally { Pop-Location }
    Remove-Item Env:PGPASSWORD, Env:PGCLIENTENCODING -ErrorAction SilentlyContinue
}

# ---- 2. 설정 읽기
$AppPort = [int](ReadEnv 'PORT')
$PgPort  = [int](ReadEnv 'PGPORT')
$serveDir = ReadEnv 'SERVE_DIR'
if ((Test-Path (Join-Path $root 'app\public-dist\app.bundle.js')) -and $serveDir -ne 'public-dist') {
    # 예전 버전이 만든 설정(원본 화면 public 사용)을 난독화본(public-dist)으로 바꾼다
    $txt = [System.IO.File]::ReadAllText($envFile, [System.Text.Encoding]::UTF8)
    $txt = if ($txt -match '(?m)^SERVE_DIR=') { [regex]::Replace($txt, '(?m)^SERVE_DIR=.*$', 'SERVE_DIR=public-dist') } else { $txt.TrimEnd() + "`r`nSERVE_DIR=public-dist`r`n" }
    [System.IO.File]::WriteAllText($envFile, $txt, $utf8NoBom)
}
if (-not $AppPort -or -not $PgPort) { Fail "app\server\.env 에서 PORT/PGPORT 를 읽지 못했습니다. data 폴더와 app\server\.env 를 지우면 처음부터 다시 만들 수 있습니다." }

# ---- 3. DB 가 꺼져 있으면 켜기
$st = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, 'status')
$startedPg = $false
if ($st.Code -ne 0) {
    Info "  DB 시작 중..."
    $r = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-l', $pgLog, '-w', '-t', '90', 'start')
    if ($r.Code -ne 0) { Fail "DB 를 시작하지 못했습니다:`n$($r.Out)`n  포트 $PgPort 를 다른 프로그램이 쓰고 있거나, 이 폴더를 다른 위치로 옮긴 직후일 수 있습니다. 자세한 내용: $data\pg.log" }
    $startedPg = $true
}
Ok "DB 실행 중 (포트 $PgPort)"

if (PortInUse $AppPort) {
    Fail "앱 포트 $AppPort 를 다른 프로그램이 사용 중입니다. 이미 이 프로그램이 실행 중인지 확인하세요(열려 있는 검은 창).`n  포트를 바꾸려면 app\server\.env 의 PORT 를 고치세요."
}

# ---- 4. 서버 시작 (이 창에서 계속 실행)
$url = "http://localhost:$AppPort"
Info ""
Info "  서버를 시작합니다: $url"
Info "  끝내려면 이 창에서 Ctrl+C 를 누르세요. (창만 닫으면 DB 가 남습니다 — stop.bat 으로 끄세요)"
Info ""
if (-not $NoBrowser) {
    $opener = "for(`$i=0;`$i -lt 60;`$i++){ try { `$c=New-Object Net.Sockets.TcpClient('127.0.0.1',$AppPort); `$c.Close(); break } catch { Start-Sleep 1 } }; Start-Process '$url'"
    Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile', '-Command', $opener | Out-Null
}
$env:BACKUP_ROOT = Join-Path $data 'backups'
Push-Location $server
try {
    & $node 'index.js'
} finally {
    Pop-Location
    Info ""
    Info "  서버가 종료되었습니다. DB 를 끕니다..."
    $null = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-m', 'fast', '-w', 'stop')
    Remove-PgRoot
    Info "  종료 완료."
}
