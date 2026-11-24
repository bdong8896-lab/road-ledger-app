# 포터블 업데이트 — 새 패키지(이 폴더)의 프로그램으로 "이미 설치해 쓰던 폴더"를 교체한다.
#   · 바꾸는 것 : app\ (서버·화면), scripts\, tools\, RoadLedger.exe, README.txt, (필요하면) pg\, runtime\
#   · 그대로 두는 것 : data\ (DB·업로드 파일·백업), app\server\.env (포트·DB 비밀번호·키), app\server\logs, 지도 타일 보관(tile-cache)
#   · 교체 전에 이전 프로그램을 <설치폴더>\_update-backup\날짜_시각\ 에 보관한다(최근 2개). 문제가 생기면 -Rollback 으로 되돌린다.
# 사용: 새 패키지를 아무 곳에나 풀고 "업데이트.bat" 더블클릭 → 기존 설치 폴더(RoadLedger.exe 가 있는 폴더)를 묻는다.
#       (폴더를 "업데이트.bat" 위로 끌어다 놓아도 된다)
param(
    [Parameter(Position = 0)][string]$Target = '',
    [switch]$Yes,        # 확인 질문 없이 진행(실행 중인 프로그램도 묻지 않고 종료)
    [switch]$Rollback    # 직전 업데이트 이전 상태로 되돌린다
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = Split-Path -Parent $PSScriptRoot          # 새 패키지 폴더(이 스크립트가 든 곳의 상위)
. (Join-Path $PSScriptRoot 'common.ps1')

function Info($m) { Write-Host "  $m" }
function Ok($m)   { Write-Host "  [완료] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [주의] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host ""; Write-Host "  실패: $m" -ForegroundColor Red; Write-Host ""; exit 1 }
function Ask($q) {
    if ($Yes) { return $true }
    $a = Read-Host "  $q (Y/N)"
    return ($a -match '^\s*[yY]')
}
function PkgVer($root) {
    try { return (Get-Content (Join-Path $root 'app\server\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version } catch { return '?' }
}
function BuildTime($root) {
    $f = Join-Path $root 'app\public-dist\app.bundle.js'
    if (Test-Path $f) { return (Get-Item $f).LastWriteTime.ToString('yyyy-MM-dd HH:mm') }
    return '?'
}
# robocopy 로 폴더를 같게 만든다(/MIR). $keep 에 든 "대상 쪽 전체 경로"의 폴더·파일은 지우지도 덮지도 않는다.
function Mirror($from, $to, $keepDirs, $keepFiles) {
    $a = @($from, $to, '/MIR', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($keepDirs)  { $a += '/XD'; $a += $keepDirs }
    if ($keepFiles) { $a += '/XF'; $a += $keepFiles }
    & robocopy.exe @a | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "파일 복사 중 오류가 났습니다(robocopy $LASTEXITCODE): $from -> $to" }
}
# app 폴더용: 지킬 것을 app 기준 상대 경로로 정해 두고 "새 쪽·대상 쪽" 양쪽 경로를 모두 제외한다.
# (새 패키지에 같은 이름의 폴더가 들어 있어도 대상 쪽 내용이 지워지지 않게)
$script:KeepDirsRel  = @('server\logs', 'server\tile-cache', 'server\uploads', 'server\backups')
$script:KeepFilesRel = @('server\.env', 'server\.env.production', 'server\.env.bak')
function MirrorApp($from, $to) {
    $xd = @(); $xf = @()
    foreach ($r in $script:KeepDirsRel)  { $xd += (Join-Path $from $r); $xd += (Join-Path $to $r) }
    foreach ($r in $script:KeepFilesRel) { $xf += (Join-Path $from $r); $xf += (Join-Path $to $r) }
    Mirror $from $to $xd $xf
}
function CopyTree($from, $to, $skipDirs) {
    $a = @($from, $to, '/E', '/R:2', '/W:2', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    if ($skipDirs) { $a += '/XD'; $a += $skipDirs }
    & robocopy.exe @a | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "백업 복사 중 오류가 났습니다(robocopy $LASTEXITCODE): $from -> $to" }
}
function EnvValue($t, $key) {
    $f = Join-Path $t 'app\server\.env'
    if (-not (Test-Path $f)) { return '' }
    foreach ($line in [System.IO.File]::ReadAllLines($f, [System.Text.Encoding]::UTF8)) {
        if ($line -match "^\s*$key\s*=\s*(.*)$") { return $Matches[1].Trim() }
    }
    return ''
}
function PortBusy($port) {
    if (-not $port) { return $false }
    return [bool]([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq [int]$port })
}
# 설치 폴더 안의 프로그램(실행 관리 창, 서버, 콘솔 창 등)을 찾는다. DB(postgres)는 따로 pg_ctl 로 닫는다.
function Get-TargetProcesses($t) {
    $pre = $t.TrimEnd('\') + '\'
    Get-CimInstance Win32_Process | Where-Object {
        $_.ProcessId -ne $PID -and $_.Name -ine 'postgres.exe' -and (
            ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($pre, [StringComparison]::OrdinalIgnoreCase)) -or
            ($_.CommandLine -and $_.CommandLine.IndexOf($pre, [StringComparison]::OrdinalIgnoreCase) -ge 0))
    }
}
function Get-DbState($t) {   # 'running' | 'stopped' | 'none'
    if (-not (Test-Path (Join-Path $t 'data\pgdata\PG_VERSION')) -or -not (Test-Path (Join-Path $t 'pg\bin\pg_ctl.exe'))) { return 'none' }
    try {
        $pgRoot = Get-PgRoot $t
        $r = RunNoPipe (Join-Path $pgRoot 'pg\bin\pg_ctl.exe') @('-D', (Join-Path $pgRoot 'data\pgdata'), 'status')
        if ($r.Code -eq 0) { return 'running' } else { return 'stopped' }
    } finally { Remove-PgRoot }
}
function Stop-Target($t) {
    foreach ($p in (Get-TargetProcesses $t)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    if ((Get-DbState $t) -eq 'running') {
        try {
            $pgRoot = Get-PgRoot $t
            $null = RunNoPipe (Join-Path $pgRoot 'pg\bin\pg_ctl.exe') @('-D', (Join-Path $pgRoot 'data\pgdata'), '-m', 'fast', '-w', '-t', '60', 'stop')
        } finally { Remove-PgRoot }
    }
    foreach ($p in (Get-TargetProcesses $t)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    # 실행 관리 창이 한글 경로용으로 연결해 둔 가상 드라이브가 남아 있으면 푼다
    foreach ($line in (& subst.exe)) {
        if ($line -match '^([A-Za-z]):\\: => (.+)$' -and $Matches[2].TrimEnd('\') -ieq $t.TrimEnd('\')) { & subst.exe "$($Matches[1]):" /d | Out-Null }
    }
    Start-Sleep -Milliseconds 500
    if ((Get-DbState $t) -eq 'running' -or @(Get-TargetProcesses $t).Count -gt 0) {
        Fail "실행 중인 프로그램을 끄지 못했습니다. 기존 프로그램의 창에서 [프로그램 종료]를 누르거나 PC 를 다시 시작한 뒤 다시 실행하세요."
    }
}

Write-Host ""
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " 도로대장 시스템 — 포터블 업데이트$(if ($Rollback) { ' (되돌리기)' })" -ForegroundColor Cyan
Write-Host "========================================================" -ForegroundColor Cyan

# ---- 0. 기존 설치 폴더 정하기
if (-not $Target) {
    Write-Host ""
    Write-Host "  업데이트할 '기존 프로그램 폴더'(RoadLedger.exe 와 data 폴더가 있는 곳)를 입력하세요."
    Write-Host "  (탐색기에서 그 폴더를 이 창으로 끌어다 놓은 뒤 Enter 를 눌러도 됩니다)"
    $Target = Read-Host "  폴더"
}
$Target = $Target.Trim().Trim('"').Trim("'")
if (-not $Target) { Fail "폴더를 입력하지 않았습니다." }
if (-not (Test-Path -LiteralPath $Target -PathType Container)) { Fail "폴더를 찾을 수 없습니다: $Target" }
$t = (Resolve-Path -LiteralPath $Target).ProviderPath.TrimEnd('\')
if (-not (Test-Path (Join-Path $t 'app\server\index.js')) -and -not (Test-Path (Join-Path $t 'RoadLedger.exe'))) {
    Fail "이 폴더는 도로대장 포터블 설치 폴더가 아닙니다(app\server 도 RoadLedger.exe 도 없음): $t`n  RoadLedger.exe 가 들어 있는 폴더를 지정하세요."
}
$srcFull = (Resolve-Path -LiteralPath $src).ProviderPath.TrimEnd('\')
if ($t -ieq $srcFull) { Fail "새 패키지 폴더와 기존 설치 폴더가 같습니다. 새 ZIP 은 다른 폴더에 풀어서 실행하세요." }
if ($t.StartsWith($srcFull + '\', [StringComparison]::OrdinalIgnoreCase) -or $srcFull.StartsWith($t + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "새 패키지 폴더와 기존 설치 폴더가 서로 안에 들어 있습니다. 서로 겹치지 않는 폴더로 나누세요."
}

# 지켜야 할 것(대상 쪽 전체 경로)
$backupSkipDirs = @((Join-Path $t 'app\server\logs'), (Join-Path $t 'app\server\tile-cache'), (Join-Path $t 'app\server\uploads'), (Join-Path $t 'app\server\backups'))
# (위 백업 제외 목록: 로그·타일 보관은 용량만 크고 되돌릴 이유가 없다)
$bkRoot = Join-Path $t '_update-backup'

try {
    # =====================================================================  되돌리기
    if ($Rollback) {
        $latest = $null
        if (Test-Path $bkRoot) { $latest = Get-ChildItem $bkRoot -Directory | Sort-Object Name -Descending | Select-Object -First 1 }
        if (-not $latest) { Fail "되돌릴 업데이트 백업이 없습니다($bkRoot)." }
        Write-Host ""
        Info "대상  : $t"
        Info "되돌릴 백업: $($latest.Name)  (프로그램 $(PkgVer $latest.FullName), 현재 $(PkgVer $t))"
        Info "data(내 자료)와 app\server\.env 는 그대로 둡니다."
        if (-not (Ask "이 백업으로 되돌릴까요?")) { Info "취소했습니다."; exit 0 }
        Stop-Target $t
        MirrorApp (Join-Path $latest.FullName 'app') (Join-Path $t 'app')
        Mirror (Join-Path $latest.FullName 'scripts') (Join-Path $t 'scripts') $null $null
        foreach ($f in 'RoadLedger.exe', 'README.txt') { if (Test-Path (Join-Path $latest.FullName $f)) { Copy-Item (Join-Path $latest.FullName $f) (Join-Path $t $f) -Force } }
        Ok "되돌렸습니다. RoadLedger.exe 를 실행하세요."
        exit 0
    }

    # =====================================================================  업데이트
    foreach ($need in 'app\server\index.js', 'app\public-dist', 'scripts\start.ps1', 'pg\bin\pg_ctl.exe', 'runtime\node.exe', 'RoadLedger.exe') {
        if (-not (Test-Path (Join-Path $src $need))) { Fail "새 패키지가 온전하지 않습니다($need 없음). ZIP 을 다시 풀어 주세요: $src" }
    }
    $hasData = Test-Path (Join-Path $t 'data')
    $oldVer = PkgVer $t; $newVer = PkgVer $src

    Write-Host ""
    Info "기존 설치 폴더 : $t"
    Info "   프로그램 $oldVer  (화면 빌드 $(BuildTime $t))"
    Info "새 패키지      : $srcFull"
    Info "   프로그램 $newVer  (화면 빌드 $(BuildTime $src))"
    Info ""
    if ($hasData) { Info "그대로 두는 것: data(DB·업로드·백업), app\server\.env(포트 등 설정), 서버 로그" }
    else          { Warn "기존 폴더에 data 가 없습니다(한 번도 실행하지 않은 폴더). 프로그램만 교체합니다." }
    $port = EnvValue $t 'PORT'
    if ($port) { Info "현재 설정 포트: $port  (업데이트해도 바뀌지 않습니다)" }
    Write-Host ""
    if (-not (Ask "업데이트를 진행할까요?")) { Info "취소했습니다."; exit 0 }

    # ---- 1. 실행 중이면 끈다
    Write-Host ""; Info "[1/5] 실행 중인지 확인"
    $running = @(Get-TargetProcesses $t)
    $db = Get-DbState $t
    if ($running.Count -gt 0 -or $db -eq 'running') {
        $names = ($running | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
        Warn "기존 프로그램이 실행 중입니다($names$(if ($db -eq 'running') { ' + 데이터베이스' }))."
        if (-not (Ask "서버와 데이터베이스를 안전하게 끄고 계속할까요? (저장되지 않은 작업은 없는지 확인하세요)")) { Info "취소했습니다."; exit 0 }
        Stop-Target $t
        Ok "종료했습니다."
    } else { Ok "실행 중이 아닙니다." }

    # ---- 2. 이전 프로그램 보관
    Write-Host ""; Info "[2/5] 이전 프로그램 보관(되돌리기용)"
    $ts = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bk = Join-Path $bkRoot $ts
    New-Item -ItemType Directory -Force -Path $bk | Out-Null
    if (Test-Path (Join-Path $t 'app'))     { CopyTree (Join-Path $t 'app') (Join-Path $bk 'app') $backupSkipDirs }
    if (Test-Path (Join-Path $t 'scripts')) { CopyTree (Join-Path $t 'scripts') (Join-Path $bk 'scripts') $null }
    foreach ($f in 'RoadLedger.exe', 'README.txt') { if (Test-Path (Join-Path $t $f)) { Copy-Item (Join-Path $t $f) (Join-Path $bk $f) -Force } }
    Get-ChildItem $bkRoot -Directory | Sort-Object Name -Descending | Select-Object -Skip 2 | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Ok "보관: $bk"

    # ---- 3. 프로그램 교체
    Write-Host ""; Info "[3/5] 프로그램 교체"
    MirrorApp (Join-Path $src 'app') (Join-Path $t 'app')
    Ok "app (서버·화면)"
    $defNew = Join-Path $src 'scripts\defaults.env'
    Mirror (Join-Path $src 'scripts') (Join-Path $t 'scripts') $null @((Join-Path $t 'scripts\defaults.env'))
    if (Test-Path $defNew) { Copy-Item $defNew (Join-Path $t 'scripts\defaults.env') -Force }
    Ok "scripts"
    if (Test-Path (Join-Path $src 'tools')) { Mirror (Join-Path $src 'tools') (Join-Path $t 'tools') $null $null; Ok "tools" }
    foreach ($f in 'RoadLedger.exe', 'README.txt', '업데이트.bat', '업데이트_되돌리기.bat') {
        if (Test-Path (Join-Path $src $f)) { Copy-Item (Join-Path $src $f) (Join-Path $t $f) -Force }
    }
    Ok "RoadLedger.exe, 안내문"

    # ---- 4. DB 프로그램·Node 실행 파일(바뀐 경우에만)
    Write-Host ""; Info "[4/5] DB 프로그램·Node.js (바뀐 경우에만)"
    $oldMajor = ''
    $pgv = Join-Path $t 'data\pgdata\PG_VERSION'
    if (Test-Path $pgv) { $oldMajor = ([System.IO.File]::ReadAllText($pgv)).Trim() }
    $newMajor = ''
    try { $vt = (& (Join-Path $src 'pg\bin\postgres.exe') --version) -join ' '; if ($vt -match 'PostgreSQL\)\s+(\d+)') { $newMajor = $Matches[1] } } catch { }
    $pgExeT = Join-Path $t 'pg\bin\postgres.exe'
    if ($oldMajor -and $newMajor -and $oldMajor -ne $newMajor) {
        Warn "DB 프로그램은 교체하지 않았습니다(내 자료는 PostgreSQL $oldMajor 형식인데 새 패키지는 $newMajor 입니다). 이 업데이트에서는 문제 없습니다."
    } elseif (-not (Test-Path $pgExeT) -or (Get-FileHash $pgExeT).Hash -ne (Get-FileHash (Join-Path $src 'pg\bin\postgres.exe')).Hash) {
        Mirror (Join-Path $src 'pg') (Join-Path $t 'pg') $null $null
        Ok "pg (PostgreSQL)"
    } else { Info "pg: 같음 — 그대로" }
    $nodeT = Join-Path $t 'runtime\node.exe'
    if (-not (Test-Path $nodeT) -or (Get-FileHash $nodeT).Hash -ne (Get-FileHash (Join-Path $src 'runtime\node.exe')).Hash) {
        Mirror (Join-Path $src 'runtime') (Join-Path $t 'runtime') $null $null
        Ok "runtime (Node.js)"
    } else { Info "runtime: 같음 — 그대로" }

    # ---- 5. 점검
    Write-Host ""; Info "[5/5] 점검"
    foreach ($need in 'app\server\index.js', 'app\public-dist\app.bundle.js', 'scripts\start.ps1', 'scripts\launcher.ps1', 'RoadLedger.exe') {
        if (-not (Test-Path (Join-Path $t $need))) { Fail "교체 뒤 파일이 없습니다($need). '업데이트_되돌리기.bat' 으로 되돌린 뒤 다시 시도하세요." }
    }
    if (-not (Test-Path (Join-Path $t 'app\server\.env')) -and $hasData) { Warn "app\server\.env 가 없습니다. 처음 실행 때 새로 만들어집니다(DB 비밀번호가 data 와 맞지 않으면 시작이 안 될 수 있습니다)." }
    Ok "교체된 프로그램 $(PkgVer $t)  (화면 빌드 $(BuildTime $t))"
    $port = EnvValue $t 'PORT'
    if ($port -and (PortBusy $port)) { Warn "설정된 포트 $port 를 지금 다른 프로그램이 쓰고 있습니다. 시작이 안 되면 app\server\.env 의 PORT 를 다른 번호(예: 8090)로 바꾸세요. (바꾸면 다음 업데이트에도 유지됩니다)" }

    Write-Host ""
    Write-Host "  업데이트가 끝났습니다. 기존 폴더의 RoadLedger.exe 를 실행하세요." -ForegroundColor Green
    Write-Host "    $t\RoadLedger.exe"
    Info "문제가 생기면 '업데이트_되돌리기.bat' 으로 이전 상태로 돌아갈 수 있습니다(보관: $bk)."
    Info "새 패키지를 푼 이 폴더($srcFull)는 이제 지워도 됩니다."
} catch {
    Fail "$($_.Exception.Message)`n  기존 폴더의 이전 프로그램은 $bkRoot 에 보관되어 있을 수 있습니다. '업데이트_되돌리기.bat' 으로 되돌릴 수 있습니다. data 는 건드리지 않았습니다."
}
