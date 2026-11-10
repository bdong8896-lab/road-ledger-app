# 운영 서버 사전 점검 — 읽기 전용(아무것도 설치·변경·삭제하지 않는다). 배포 전에 서버에서 한 번 실행하고 결과 파일을 가져온다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File preflight-server.ps1
# 결과: 화면 + 같은 폴더의 preflight-<서버이름>.txt
param([string]$AppDir = 'D:\Dsmap_ROAD', [int]$SitePort = 11800, [int]$NodePort = 3000)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$report = New-Object System.Collections.ArrayList
function Out-Line([string]$tag, [string]$text) {
    $line = '[{0}] {1}' -f $tag, $text
    [void]$report.Add($line)
    $color = switch ($tag) { 'OK' { 'Green' } 'NO' { 'Red' } 'CHECK' { 'Yellow' } default { 'Gray' } }
    Write-Host $line -ForegroundColor $color
}
function Section([string]$t) { [void]$report.Add(''); [void]$report.Add("== $t"); Write-Host ''; Write-Host "== $t" -ForegroundColor Cyan }
function Reach([string]$hostName, [int]$port) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $ar = $c.BeginConnect($hostName, $port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(4000) -and $c.Connected
        $c.Close()
        return $ok
    } catch { return $false }
}

Section '1. 시스템'
$os = Get-CimInstance Win32_OperatingSystem
Out-Line 'INFO' ("{0} / {1} / 부팅 {2}" -f $env:COMPUTERNAME, $os.Caption, $os.LastBootUpTime)
Out-Line 'INFO' ("PowerShell {0} / 실행정책 {1}" -f $PSVersionTable.PSVersion, (Get-ExecutionPolicy))
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) { Out-Line 'OK' '관리자 권한으로 실행 중' } else { Out-Line 'CHECK' '관리자 권한이 아님 — 일부 항목(IIS 설정, 서비스)이 빠질 수 있음. 관리자 PowerShell 로 다시 실행 권장' }
Out-Line 'INFO' ('IP: ' + ((Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' } | ForEach-Object { $_.IPAddress }) -join ', '))
foreach ($d in Get-PSDrive -PSProvider FileSystem) { if ($d.Used -ne $null) { Out-Line 'INFO' ("드라이브 {0}: 여유 {1} GB / 전체 {2} GB" -f $d.Name, [math]::Round($d.Free / 1GB, 1), [math]::Round(($d.Used + $d.Free) / 1GB, 1)) } }
Out-Line 'INFO' ('시간대 ' + (Get-TimeZone).Id + ' / 현재 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm'))

Section '2. Node.js'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCmd) { $nodeCmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { $null }
if ($nodePath) { Out-Line 'OK' ("node 있음: $nodePath ($(& $nodePath -v))") } else { Out-Line 'NO' 'Node.js 없음 — 키트의 node.exe(runtime\)를 쓰면 설치 불필요' }
foreach ($n in 'pm2', 'nssm') { if (Get-Command $n -ErrorAction SilentlyContinue) { Out-Line 'INFO' "$n 있음" } }
if (Test-Path (Join-Path $AppDir 'nssm\nssm.exe')) { Out-Line 'INFO' 'nssm.exe 있음(앱 폴더)' }

Section '3. IIS'
$w3 = Get-Service W3SVC -ErrorAction SilentlyContinue
if ($w3) { Out-Line 'OK' ("IIS(W3SVC) $($w3.Status)") } else { Out-Line 'NO' 'IIS 서비스 없음' }
$rw = Test-Path 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\URL Rewrite'
$arr = Test-Path 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\Application Request Routing'
if ($rw) { Out-Line 'OK' 'URL Rewrite 설치됨' } else { Out-Line 'NO' 'URL Rewrite 없음 — 설치 파일(.msi)을 USB 로 가져가야 함' }
if ($arr) { Out-Line 'OK' 'ARR(Application Request Routing) 설치됨' } else { Out-Line 'NO' 'ARR 없음 — 설치 파일(.msi)을 USB 로 가져가야 함' }
try {
    Import-Module WebAdministration -ErrorAction Stop
    foreach ($s in Get-Website) { Out-Line 'INFO' ("사이트 '{0}' {1} 경로 {2} 바인딩 {3}" -f $s.Name, $s.State, $s.PhysicalPath, (($s.Bindings.Collection | ForEach-Object { $_.protocol + ':' + $_.bindingInformation }) -join ' ')) }
    $proxy = Get-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name enabled -ErrorAction SilentlyContinue
    if ($proxy -ne $null) { Out-Line 'INFO' "ARR 프록시 사용(Enable proxy) = $proxy" }
} catch { Out-Line 'CHECK' "IIS 관리 모듈을 불러오지 못해 사이트 목록은 생략: $($_.Exception.Message)" }
$ahc = Join-Path $env:windir 'System32\inetsrv\config\applicationHost.config'
if (Test-Path $ahc) {
    $txt = Get-Content $ahc -Raw -ErrorAction SilentlyContinue
    foreach ($sec in 'requestFiltering', 'serverRuntime') {
        if ($txt -match ('<section name="' + $sec + '"[^>]*overrideModeDefault="Deny"')) { Out-Line 'CHECK' "$sec 섹션이 잠겨 있음 — web.config 의 해당 설정이 500.19 를 낼 수 있음(unlock 필요, 가이드 4번)" }
        else { Out-Line 'OK' "$sec 섹션 잠금 없음" }
    }
}

Section '4. PostgreSQL'
$pg = Get-Service | Where-Object { $_.DisplayName -like '*postgres*' -or $_.Name -like '*postgres*' }
if ($pg) { $pg | ForEach-Object { Out-Line 'OK' ("서비스 {0} ({1}) {2}" -f $_.Name, $_.DisplayName, $_.Status) } } else { Out-Line 'NO' 'PostgreSQL 서비스를 찾지 못함' }
$pgDirs = Get-ChildItem 'C:\Program Files\PostgreSQL', 'D:\Program Files\PostgreSQL' -ErrorAction SilentlyContinue
foreach ($d in $pgDirs) { $psql = Join-Path $d.FullName 'bin\psql.exe'; if (Test-Path $psql) { Out-Line 'OK' ("psql: $psql ($(& $psql --version))") } }
$pgProc = Get-Process postgres -ErrorAction SilentlyContinue
if ($pgProc) {
    $ports = Get-NetTCPConnection -State Listen -OwningProcess ($pgProc | Select-Object -First 1 -ExpandProperty Id) -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique
    Out-Line 'INFO' ('PostgreSQL 이 듣는 포트: ' + ($ports -join ', '))
}

Section '5. 포트·방화벽·기존 설치'
foreach ($p in $SitePort, $NodePort, 8080, 5432) {
    $l = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($l) { $pn = (Get-Process -Id $l.OwningProcess -ErrorAction SilentlyContinue).ProcessName; Out-Line 'INFO' "포트 $p 사용 중 — 프로세스 $pn" } else { Out-Line 'INFO' "포트 $p 비어 있음" }
}
$fw = Get-NetFirewallRule -Direction Inbound -Enabled True -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "*$SitePort*" -or $_.DisplayName -like '*RoadLedger*' }
if ($fw) { $fw | ForEach-Object { Out-Line 'INFO' ('방화벽 규칙: ' + $_.DisplayName) } } else { Out-Line 'CHECK' "포트 $SitePort 를 여는 방화벽 규칙을 못 찾음(보안팀 요청 또는 직접 등록 필요)" }
if (Test-Path $AppDir) { Out-Line 'INFO' "$AppDir 이미 있음: $((Get-ChildItem $AppDir -ErrorAction SilentlyContinue | Select-Object -First 8 -ExpandProperty Name) -join ', ')" } else { Out-Line 'INFO' "$AppDir 없음(새로 만들 예정)" }
$cert = Get-ChildItem Cert:\LocalMachine\My -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -eq 'DSMap Road Ledger' }
if ($cert) { Out-Line 'INFO' ("인증서 'DSMap Road Ledger' 있음, 만료 {0}" -f $cert.NotAfter.ToString('yyyy-MM-dd')) } else { Out-Line 'INFO' "인증서 'DSMap Road Ledger' 없음(HTTPS 를 쓸 때만 필요)" }

Section '6. 외부 접속 (서버에서)'
Out-Line 'INFO' '※ 서버가 직접 쓰는 곳: api.vworld.kr(지도 프록시), openapi.its.go.kr:9443(CCTV 목록). 아래 CDN·영상 서버는 "접속하는 PC" 가 쓰는 곳이라 서버에서의 결과는 참고용이다.'
$targets = @(
    @('api.vworld.kr', 443, '지도(VWorld) — 서버 프록시가 사용'),
    @('openapi.its.go.kr', 9443, 'CCTV 목록 API — 서버가 사용'),
    @('cdn.jsdelivr.net', 443, '화면 라이브러리(OpenLayers 등) — 접속 PC 가 사용'),
    @('unpkg.com', 443, '화면 라이브러리(turf, dxf-parser) — 접속 PC 가 사용'),
    @('cdnjs.cloudflare.com', 443, '아이콘 글꼴(Font Awesome) — 접속 PC 가 사용'),
    @('cctvsec.ktict.co.kr', 8081, 'CCTV 영상 — 접속 PC 가 사용'),
    @('dapi.kakao.com', 443, '카카오맵 — 접속 PC 가 사용')
)
foreach ($t in $targets) {
    if (Reach $t[0] $t[1]) { Out-Line 'OK' ("{0}:{1} 접속 가능 — {2}" -f $t[0], $t[1], $t[2]) } else { Out-Line 'NO' ("{0}:{1} 접속 안 됨 — {2}" -f $t[0], $t[1], $t[2]) }
}

$outFile = Join-Path $PSScriptRoot ("preflight-{0}.txt" -f $env:COMPUTERNAME)
try { [System.IO.File]::WriteAllLines($outFile, [string[]]$report, (New-Object System.Text.UTF8Encoding($true))); Write-Host ''; Write-Host "결과 저장: $outFile" -ForegroundColor Cyan } catch { Write-Host "결과 파일을 저장하지 못했습니다(USB 쓰기 방지?): $($_.Exception.Message)" -ForegroundColor Yellow }
