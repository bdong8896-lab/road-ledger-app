# 화성 서버(폐쇄망, USB 반입)용 설치 키트를 만든다 — 개발 PC 에서 실행.
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\build-usb-kit.ps1 -NssmExe <nssm-2.24\win64\nssm.exe>
# 담는 것: 서버·화면(난독화 public-dist)·web.config·운영용 node_modules·PM2 오프라인본·NSSM·사전 점검 스크립트·설치 순서
# 안 담는 것: Node.js, IIS 확장(URL Rewrite/ARR) — 서버 담당이 따로 준비한다.
# server\.env.production(운영 키가 든 git 제외 파일)이 키트에 그대로 들어가므로 USB 보관에 주의한다.
param(
    [string]$OutDir = '',
    [string]$NssmExe = '',
    [string]$ProjectDir = ''
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ProjectDir) { $ProjectDir = Split-Path -Parent $here }
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $ProjectDir) '화성서버_USB키트' }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Step($m) { Write-Host ""; Write-Host "[$m]" -ForegroundColor Cyan }
function Fail($m) { Write-Host "  실패: $m" -ForegroundColor Red; exit 1 }
function SizeMB($p) { [math]::Round(((Get-ChildItem $p -Recurse -File -Force | Measure-Object Length -Sum).Sum) / 1MB, 0) }

$envProd = Join-Path $ProjectDir 'server\.env.production'
if (-not (Test-Path $envProd)) { Fail "server\.env.production 이 없습니다: $envProd" }
$envText = [System.IO.File]::ReadAllText($envProd, [System.Text.Encoding]::UTF8)
if ($envText -match '(?m)^COOKIE_SECURE\s*=\s*true') { Write-Host '  주의: .env.production 에 COOKIE_SECURE=true 가 켜져 있습니다 — HTTP 운영이면 로그인이 안 됩니다.' -ForegroundColor Yellow }
if ($envText -notmatch '(?m)^SERVE_DIR\s*=\s*public-dist') { Fail '.env.production 에 SERVE_DIR=public-dist 가 없습니다(없으면 원본 소스가 서비스됨).' }
if ($envText -match '(?m)^ITS_CCTV_API_KEY\s*=\s*<') { Write-Host '  주의: ITS_CCTV_API_KEY 가 아직 자리표시자입니다.' -ForegroundColor Yellow }

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
$app = Join-Path $OutDir 'Dsmap_ROAD'
New-Item -ItemType Directory -Force -Path $app, (Join-Path $OutDir 'tools') | Out-Null

Step '1/6 서버 코드'
# 제외: node_modules(아래에서 새로 만든다), 로그·업로드·백업, 개발용 .env/.env.bak, 이전 서버용 옛 복사본 env.production(점 없는 이름)
& robocopy (Join-Path $ProjectDir 'server') (Join-Path $app 'server') /E /NFL /NDL /NJH /NJS /NP /XD node_modules logs uploads backups tile-cache /XF .env .env.bak env.production *.log | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "server 복사 오류(robocopy $LASTEXITCODE)" }
New-Item -ItemType Directory -Force -Path (Join-Path $app 'server\uploads'), (Join-Path $app 'server\logs') | Out-Null
Write-Host "  server: $(SizeMB (Join-Path $app 'server')) MB"

Step '2/6 화면(난독화 public-dist) + web.config + 배포 문서'
Push-Location (Join-Path $ProjectDir 'server')
try {
    $ErrorActionPreference = 'Continue'
    & node.exe build-dist.js 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 2
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { Fail '난독화 빌드(build-dist.js) 실패' }
} finally { Pop-Location }
if (-not (Test-Path (Join-Path $ProjectDir 'public-dist\app.bundle.js'))) { Fail 'public-dist 가 만들어지지 않았습니다.' }
& robocopy (Join-Path $ProjectDir 'public-dist') (Join-Path $app 'public-dist') /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "public-dist 복사 오류(robocopy $LASTEXITCODE)" }
if (Test-Path (Join-Path $app 'public')) { Fail '키트에 원본 public 폴더가 들어갔습니다(들어가면 안 됨).' }
Copy-Item (Join-Path $here 'web.config') (Join-Path $app 'web.config') -Force   # IIS 사이트 물리 경로 최상위
New-Item -ItemType Directory -Force -Path (Join-Path $app 'deploy') | Out-Null
foreach ($f in 'backup-prod.ps1', '서버배포_가이드.txt') { Copy-Item (Join-Path $here $f) (Join-Path $app "deploy\$f") -Force }

Step '3/6 운영용 node_modules (npm ci --omit=dev, Windows 64비트용)'
Push-Location (Join-Path $app 'server')
try {
    $ErrorActionPreference = 'Continue'
    & npm.cmd ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 3
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -ne 0) { Fail 'npm ci 실패' }
} finally { Pop-Location }
Write-Host "  server(+node_modules): $(SizeMB (Join-Path $app 'server')) MB"

Step '4/6 PM2 오프라인본(방법 A)'
$npmGlobal = Join-Path $env:APPDATA 'npm'
if (-not (Test-Path (Join-Path $npmGlobal 'node_modules\pm2'))) { Fail "이 PC 에 PM2 가 전역 설치돼 있지 않습니다($npmGlobal)." }
$pmStage = Join-Path $env:TEMP ('rl-pm2-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path (Join-Path $pmStage 'node_modules') | Out-Null
try {
    # 전역 npm 폴더 중 pm2 관련만(electron-packager 등 다른 전역 도구는 제외). 서버의 %APPDATA%\npm 에 그대로 풀리는 구조.
    Get-ChildItem $npmGlobal -File | Where-Object { $_.Name -like 'pm2*' } | Copy-Item -Destination $pmStage
    foreach ($m in 'pm2', 'pm2-windows-startup') {
        $src = Join-Path $npmGlobal "node_modules\$m"
        if (Test-Path $src) { & robocopy $src (Join-Path $pmStage "node_modules\$m") /E /NFL /NDL /NJH /NJS /NP | Out-Null; if ($LASTEXITCODE -ge 8) { Fail "$m 복사 오류" } }
    }
    $pmZip = Join-Path $OutDir 'tools\pm2-offline.zip'
    & tar.exe -a -c -f $pmZip -C $pmStage .
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pmZip)) { Fail 'pm2-offline.zip 만들기 실패' }
    Write-Host "  pm2-offline.zip $([math]::Round((Get-Item $pmZip).Length / 1MB, 1)) MB (pm2 $(& pm2 -v 2>$null | Select-Object -Last 1))"
} finally { Remove-Item -Recurse -Force $pmStage -ErrorAction SilentlyContinue }

Step '5/6 NSSM(방법 B)'
if ($NssmExe -and (Test-Path $NssmExe)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $OutDir 'tools\nssm') | Out-Null
    Copy-Item $NssmExe (Join-Path $OutDir 'tools\nssm\nssm.exe') -Force
    Write-Host '  nssm.exe 포함'
} else { Write-Host '  -NssmExe 를 주지 않아 NSSM 은 키트에 없습니다(PM2 만 사용 가능).' -ForegroundColor Yellow }

Step '6/6 점검 스크립트·안내문·해시 목록'
Copy-Item (Join-Path $here 'preflight-server.ps1') (Join-Path $OutDir 'preflight-server.ps1') -Force
Copy-Item (Join-Path $here 'usb-kit-README.txt') (Join-Path $OutDir 'README_설치순서.txt') -Force
$manifest = New-Object System.Collections.ArrayList
foreach ($rel in 'tools\nssm\nssm.exe', 'tools\pm2-offline.zip', 'Dsmap_ROAD\public-dist\app.bundle.js', 'Dsmap_ROAD\public-dist\index.html', 'Dsmap_ROAD\server\package-lock.json', 'Dsmap_ROAD\server\index.js', 'Dsmap_ROAD\web.config') {
    $p = Join-Path $OutDir $rel
    if (Test-Path $p) { [void]$manifest.Add(('{0}  {1}' -f (Get-FileHash $p -Algorithm SHA256).Hash, $rel)) }
}
[System.IO.File]::WriteAllLines((Join-Path $OutDir 'MANIFEST.sha256.txt'), [string[]]$manifest, (New-Object System.Text.UTF8Encoding($true)))

Write-Host ""
Write-Host "키트 완성: $OutDir  (전체 $(SizeMB $OutDir) MB)" -ForegroundColor Green
Write-Host '  USB 에 폴더째 복사 → 서버에서 README_설치순서.txt 를 따른다. (.env.production 에 운영 키가 있으니 USB 관리 주의)'
