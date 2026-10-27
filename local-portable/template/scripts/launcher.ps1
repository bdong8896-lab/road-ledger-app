# 도로대장 시스템 — 실행 관리 창 (RoadLedger.exe 가 이 스크립트를 숨김 창으로 실행한다)
#  [서버 시작] [서버 종료] [브라우저에서 열기] [백업] [복원] [프로그램 종료]
#  실제 DB·서버 실행은 start.ps1(숨김 프로세스)이 맡고, 이 창은 상태를 보여 주고 버튼으로 다룬다.
#  -SelfTest : 창을 띄워 시작→상태확인→종료를 자동으로 돌려 보고 화면을 PNG 로 저장한다(개발자용 시험).
param(
    [switch]$SelfTest,
    [int]$PgPort = 0,
    [int]$AppPort = 0,
    [string]$ShotDir = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class RlDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[void][RlDpi]::SetProcessDPIAware()
[System.Windows.Forms.Application]::EnableVisualStyles()

$nodeExe  = Join-Path $root 'runtime\node.exe'
$data     = Join-Path $root 'data'
$envFile  = Join-Path $root 'app\server\.env'
$pidFile  = Join-Path $data 'server.pid'
$logOut   = Join-Path $data 'server.out.log'
$logErr   = Join-Path $data 'server.err.log'
$startPs1 = Join-Path $PSScriptRoot 'start.ps1'
$appTitle = '도로대장 시스템'

# ------------------------------------------------------------------ 도우미
function ReadEnvValue($key) {
    if (-not (Test-Path $envFile)) { return $null }
    foreach ($line in [System.IO.File]::ReadAllLines($envFile, [System.Text.Encoding]::UTF8)) { if ($line -match "^\s*$key\s*=\s*(.*)$") { return $Matches[1].Trim() } }
    return $null
}
function ReadDefaults {
    $d = @{}; $f = Join-Path $PSScriptRoot 'defaults.env'
    if (Test-Path $f) { foreach ($line in [System.IO.File]::ReadAllLines($f, [System.Text.Encoding]::UTF8)) { if ($line -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $d[$Matches[1]] = $Matches[2].Trim() } } }
    return $d
}
function PortListening([int]$p) {
    if ($p -le 0) { return $false }
    return [bool]([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $p })
}
function GetWorker {
    if (-not (Test-Path $pidFile)) { return $null }
    $id = 0; if (-not [int]::TryParse(([System.IO.File]::ReadAllText($pidFile)).Trim(), [ref]$id)) { return $null }
    $p = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'powershell') { return $p }
    return $null
}
function GetOurNode { return @(Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $nodeExe }) }
function Pump { [System.Windows.Forms.Application]::DoEvents() }
function WaitMs([int]$ms) { $t = [Diagnostics.Stopwatch]::StartNew(); while ($t.ElapsedMilliseconds -lt $ms) { Pump; Start-Sleep -Milliseconds 40 } }
function Info($text, $icon = 'Information') {
    if ($SelfTest) { Write-Host "   [알림창] $($text -replace "`r?`n", ' / ')"; return 'OK' }   # 자체 시험에서는 대화상자를 띄우지 않고 기록만 한다
    return [System.Windows.Forms.MessageBox]::Show($text, $appTitle, 'OK', $icon)
}
function Ask($text, $buttons = 'YesNo', $icon = 'Question') {
    if ($SelfTest) { Write-Host "   [질문창→예] $($text -replace "`r?`n", ' / ')"; return 'Yes' }
    return [System.Windows.Forms.MessageBox]::Show($text, $appTitle, $buttons, $icon)
}

# 비밀번호 칸을 가릴 수 있는 작은 입력창(처음 실행에 기본 계정·키가 없을 때만 쓴다)
function InputDialog($title, $prompt, $default, [bool]$secret) {
    $f = New-Object System.Windows.Forms.Form
    $f.Text = $title; $f.StartPosition = 'CenterParent'; $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
    $f.ClientSize = New-Object System.Drawing.Size(420, 150); $f.Font = New-Object System.Drawing.Font('맑은 고딕', 9.5)
    $l = New-Object System.Windows.Forms.Label; $l.Text = $prompt; $l.Location = '16,14'; $l.Size = '388,40'; $f.Controls.Add($l)
    $t = New-Object System.Windows.Forms.TextBox; $t.Location = '16,60'; $t.Size = '388,26'; $t.Text = $default; if ($secret) { $t.UseSystemPasswordChar = $true }; $f.Controls.Add($t)
    $ok = New-Object System.Windows.Forms.Button; $ok.Text = '확인'; $ok.Location = '230,104'; $ok.Size = '84,32'; $ok.DialogResult = 'OK'; $f.Controls.Add($ok); $f.AcceptButton = $ok
    $no = New-Object System.Windows.Forms.Button; $no.Text = '취소'; $no.Location = '320,104'; $no.Size = '84,32'; $no.DialogResult = 'Cancel'; $f.Controls.Add($no); $f.CancelButton = $no
    $res = $f.ShowDialog($script:form)
    $val = $t.Text; $f.Dispose()
    if ($res -ne 'OK') { return $null }
    return $val
}

# ------------------------------------------------------------------ 화면
$cBg = [System.Drawing.Color]::FromArgb(244, 247, 248)
$cHeader = [System.Drawing.Color]::FromArgb(15, 61, 76)
$cGreen = [System.Drawing.Color]::FromArgb(30, 150, 90);  $cGreenH = [System.Drawing.Color]::FromArgb(24, 128, 76)
$cRed = [System.Drawing.Color]::FromArgb(205, 66, 60);    $cRedH = [System.Drawing.Color]::FromArgb(176, 53, 48)
$cTeal = [System.Drawing.Color]::FromArgb(21, 122, 128);  $cTealH = [System.Drawing.Color]::FromArgb(17, 100, 105)
$cGray = [System.Drawing.Color]::FromArgb(226, 232, 235); $cGrayH = [System.Drawing.Color]::FromArgb(210, 219, 223)
$cText = [System.Drawing.Color]::FromArgb(33, 48, 56);    $cMuted = [System.Drawing.Color]::FromArgb(103, 120, 128)
$cOffBack = [System.Drawing.Color]::FromArgb(233, 237, 239); $cOffFore = [System.Drawing.Color]::FromArgb(154, 167, 173)
$fontUi = New-Object System.Drawing.Font('맑은 고딕', 9.5)
$fontBtn = New-Object System.Drawing.Font('맑은 고딕', 11.5, [System.Drawing.FontStyle]::Bold)

function NewButton($text, $x, $y, $w, $h, $back, $backHover, $fore, $font) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y); $b.Size = New-Object System.Drawing.Size($w, $h)
    $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0; $b.FlatAppearance.MouseOverBackColor = $backHover; $b.FlatAppearance.MouseDownBackColor = $backHover
    $b.BackColor = $back; $b.ForeColor = $fore; $b.Font = $font; $b.Cursor = [System.Windows.Forms.Cursors]::Hand; $b.UseVisualStyleBackColor = $false
    $b.Tag = @{ Back = $back; Hover = $backHover; Fore = $fore }
    return $b
}
function SetEnabled($b, [bool]$on) {
    $b.Enabled = $on
    if ($on) { $b.BackColor = $b.Tag.Back; $b.ForeColor = $b.Tag.Fore; $b.FlatAppearance.MouseOverBackColor = $b.Tag.Hover; $b.Cursor = [System.Windows.Forms.Cursors]::Hand }
    else { $b.BackColor = $cOffBack; $b.ForeColor = $cOffFore; $b.FlatAppearance.MouseOverBackColor = $cOffBack; $b.Cursor = [System.Windows.Forms.Cursors]::Default }
}

$script:form = New-Object System.Windows.Forms.Form
$form = $script:form
$form.Text = $appTitle; $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = 'FixedSingle'; $form.MaximizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(560, 566); $form.BackColor = $cBg; $form.Font = $fontUi
$iconPath = Join-Path $PSScriptRoot 'app.ico'
if (Test-Path $iconPath) { try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch { } }

# 머리글
$hdr = New-Object System.Windows.Forms.Panel; $hdr.Location = '0,0'; $hdr.Size = '560,86'; $hdr.BackColor = $cHeader; $form.Controls.Add($hdr)
$logo = New-Object System.Windows.Forms.PictureBox; $logo.Location = '20,17'; $logo.Size = '52,52'; $logo.SizeMode = 'Zoom'; $logo.BackColor = $cHeader
$png = Join-Path $PSScriptRoot 'app-256.png'
if (Test-Path $png) { $logo.Image = [System.Drawing.Image]::FromFile($png) }
$hdr.Controls.Add($logo)
$t1 = New-Object System.Windows.Forms.Label; $t1.Text = $appTitle; $t1.Location = '84,14'; $t1.AutoSize = $true; $t1.ForeColor = [System.Drawing.Color]::White
$t1.Font = New-Object System.Drawing.Font('맑은 고딕', 17, [System.Drawing.FontStyle]::Bold); $hdr.Controls.Add($t1)
$t2 = New-Object System.Windows.Forms.Label; $t2.Text = 'Road Ledger System  ·  내 PC 실행판'; $t2.Location = '86,52'; $t2.AutoSize = $true
$t2.ForeColor = [System.Drawing.Color]::FromArgb(160, 196, 205); $t2.Font = New-Object System.Drawing.Font('맑은 고딕', 9); $hdr.Controls.Add($t2)

# 상태 카드
$card = New-Object System.Windows.Forms.Panel; $card.Location = '20,106'; $card.Size = '520,94'; $card.BackColor = [System.Drawing.Color]::White; $form.Controls.Add($card)
$card.Add_Paint({ param($s, $e) $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(214, 224, 228)); $e.Graphics.DrawRectangle($pen, 0, 0, $s.Width - 1, $s.Height - 1); $pen.Dispose() })
$dot = New-Object System.Windows.Forms.Label; $dot.Text = '●'; $dot.Location = '18,16'; $dot.AutoSize = $true; $dot.Font = New-Object System.Drawing.Font('맑은 고딕', 20); $dot.BackColor = [System.Drawing.Color]::White; $card.Controls.Add($dot)
$stText = New-Object System.Windows.Forms.Label; $stText.Location = '58,14'; $stText.Size = '450,30'; $stText.Font = New-Object System.Drawing.Font('맑은 고딕', 13, [System.Drawing.FontStyle]::Bold)
$stText.ForeColor = $cText; $stText.BackColor = [System.Drawing.Color]::White; $card.Controls.Add($stText)
$stDetail = New-Object System.Windows.Forms.Label; $stDetail.Location = '60,48'; $stDetail.Size = '448,38'; $stDetail.ForeColor = $cMuted; $stDetail.BackColor = [System.Drawing.Color]::White; $card.Controls.Add($stDetail)

# 버튼
$btnStart = NewButton '▶  서버 시작' 20 214 254 54 $cGreen $cGreenH ([System.Drawing.Color]::White) $fontBtn; $form.Controls.Add($btnStart)
$btnStop = NewButton '■  서버 종료' 286 214 254 54 $cRed $cRedH ([System.Drawing.Color]::White) $fontBtn; $form.Controls.Add($btnStop)
$btnOpen = NewButton '브라우저에서 열기' 20 280 520 42 $cTeal $cTealH ([System.Drawing.Color]::White) (New-Object System.Drawing.Font('맑은 고딕', 10.5, [System.Drawing.FontStyle]::Bold)); $form.Controls.Add($btnOpen)
$btnBackup = NewButton '백업' 20 334 164 36 $cGray $cGrayH $cText $fontUi; $form.Controls.Add($btnBackup)
$btnRestore = NewButton '복원' 198 334 164 36 $cGray $cGrayH $cText $fontUi; $form.Controls.Add($btnRestore)
$btnFolder = NewButton '자료 폴더 열기' 376 334 164 36 $cGray $cGrayH $cText $fontUi; $form.Controls.Add($btnFolder)

# 진행 상황(로그)
$lblLog = New-Object System.Windows.Forms.Label; $lblLog.Text = '진행 상황'; $lblLog.Location = '20,384'; $lblLog.AutoSize = $true; $lblLog.ForeColor = $cMuted; $form.Controls.Add($lblLog)
$logBox = New-Object System.Windows.Forms.TextBox; $logBox.Location = '20,406'; $logBox.Size = '520,108'; $logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = 'Vertical'
$logBox.BackColor = [System.Drawing.Color]::White; $logBox.ForeColor = $cText; $logBox.BorderStyle = 'FixedSingle'; $logBox.Font = New-Object System.Drawing.Font('Consolas', 8.5); $form.Controls.Add($logBox)

# 바닥
$foot = New-Object System.Windows.Forms.Label; $foot.Text = '자료는 data 폴더에 저장됩니다.'; $foot.Location = '20,528'; $foot.AutoSize = $true; $foot.ForeColor = $cMuted; $foot.Font = New-Object System.Drawing.Font('맑은 고딕', 8.5); $form.Controls.Add($foot)
$btnExit = NewButton '프로그램 종료' 410 520 130 34 $cGray $cGrayH $cText $fontUi; $form.Controls.Add($btnExit)

# ------------------------------------------------------------------ 상태
$script:state = ''           # stopped | starting | running | stopping | busy
$script:busyText = ''
$script:busyProc = $null; $script:busyOut = $null; $script:busyKind = ''
$script:stopping = $false
$script:startedAt = $null
$script:openedBrowser = $false
$script:logPos = @{ out = 0; err = 0 }
$script:lastPort = 0

function AddLog($text) {
    if (-not $text) { return }
    $t = $text -replace "`r?`n", "`r`n"
    $logBox.AppendText($t)
    if ($logBox.TextLength -gt 24000) { $logBox.Text = $logBox.Text.Substring($logBox.TextLength - 16000); }
    $logBox.SelectionStart = $logBox.TextLength; $logBox.ScrollToCaret()
}
function TailFile($path, $key) {
    if (-not (Test-Path $path)) { return '' }
    try {
        $fs = New-Object System.IO.FileStream($path, 'Open', 'Read', 'ReadWrite')
        try {
            if ($fs.Length -lt $script:logPos[$key]) { $script:logPos[$key] = 0 }
            if ($fs.Length -eq $script:logPos[$key]) { return '' }
            $fs.Seek($script:logPos[$key], 'Begin') | Out-Null
            $buf = New-Object byte[] ($fs.Length - $script:logPos[$key]); $n = $fs.Read($buf, 0, $buf.Length)
            $script:logPos[$key] += $n
            return [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)
        } finally { $fs.Close() }
    } catch { return '' }
}
function ComputeState {
    if ($script:busyProc) { return 'busy' }
    if ($script:stopping) { return 'stopping' }
    $w = GetWorker
    $port = [int](ReadEnvValue 'PORT')
    $up = PortListening $port
    if ($w -and $up) { return 'running' }
    if ($w) { return 'starting' }
    if ($up -and (GetOurNode).Count -gt 0) { return 'running' }   # 이 프로그램이 띄운 서버가 창 없이 계속 도는 경우
    return 'stopped'
}
function ApplyState($s) {
    $port = [int](ReadEnvValue 'PORT')
    $firstRun = -not (Test-Path (Join-Path $data 'pgdata\PG_VERSION'))
    switch ($s) {
        'stopped' {
            $dot.ForeColor = [System.Drawing.Color]::FromArgb(140, 156, 164); $stText.Text = '서버가 중지되어 있습니다'
            $stDetail.Text = if ($firstRun) { "‘서버 시작’을 누르면 데이터베이스를 만들고 서버를 시작합니다.`r`n처음에는 1~2분 걸립니다." } else { "‘서버 시작’을 누르면 데이터베이스와 서버가 시작됩니다." }
            SetEnabled $btnStart $true; SetEnabled $btnStop $false; SetEnabled $btnOpen $false; SetEnabled $btnBackup $true; SetEnabled $btnRestore $true; SetEnabled $btnFolder $true; SetEnabled $btnExit $true
        }
        'starting' {
            $dot.ForeColor = [System.Drawing.Color]::FromArgb(230, 160, 0); $stText.Text = '서버를 시작하는 중…'
            $stDetail.Text = if ($firstRun) { "처음 실행이라 데이터베이스를 만드는 중입니다. 1~2분 걸릴 수 있습니다.`r`n창을 닫지 말고 기다려 주세요." } else { '잠시만 기다려 주세요.' }
            $stuck = $script:startedAt -and ((Get-Date) - $script:startedAt).TotalSeconds -gt 180
            SetEnabled $btnStart $false; SetEnabled $btnStop $stuck; SetEnabled $btnOpen $false; SetEnabled $btnBackup $false; SetEnabled $btnRestore $false; SetEnabled $btnFolder $true; SetEnabled $btnExit $stuck
        }
        'running' {
            $dot.ForeColor = [System.Drawing.Color]::FromArgb(34, 165, 90); $stText.Text = '서버가 실행 중입니다'
            $stDetail.Text = "주소:  http://localhost:$port`r`n내 PC에서만 접속할 수 있습니다."
            SetEnabled $btnStart $false; SetEnabled $btnStop $true; SetEnabled $btnOpen $true; SetEnabled $btnBackup $true; SetEnabled $btnRestore $false; SetEnabled $btnFolder $true; SetEnabled $btnExit $true
        }
        'stopping' {
            $dot.ForeColor = [System.Drawing.Color]::FromArgb(230, 160, 0); $stText.Text = '서버를 종료하는 중…'; $stDetail.Text = '데이터베이스를 안전하게 닫고 있습니다.'
            foreach ($b in $btnStart, $btnStop, $btnOpen, $btnBackup, $btnRestore, $btnFolder, $btnExit) { SetEnabled $b $false }
        }
        'busy' {
            $dot.ForeColor = [System.Drawing.Color]::FromArgb(230, 160, 0); $stText.Text = $script:busyText; $stDetail.Text = '끝날 때까지 기다려 주세요. 자료 양에 따라 시간이 걸릴 수 있습니다.'
            foreach ($b in $btnStart, $btnStop, $btnOpen, $btnBackup, $btnRestore, $btnExit) { SetEnabled $b $false }; SetEnabled $btnFolder $true
        }
    }
    $script:lastPort = $port
}

# ------------------------------------------------------------------ 동작
function StartServer {
    if (GetWorker) { return }
    $firstRun = -not (Test-Path (Join-Path $data 'pgdata\PG_VERSION'))
    $d = ReadDefaults
    $env:RL_GUI = '1'
    if ($firstRun) {
        # 패키지에 기본 계정·키가 없으면 여기서 한 번 묻는다(있으면 묻지 않는다)
        if (-not ($d['ADMIN_USER'] -and $d['ADMIN_PASSWORD'])) {
            $u = InputDialog '관리자 계정 만들기' '처음 실행입니다. 관리자 아이디를 입력하세요.' 'admin' $false
            if (-not $u) { Remove-Item Env:RL_GUI -ErrorAction SilentlyContinue; return }
            $pw = ''
            while ($pw.Length -lt 8) {
                $pw = InputDialog '관리자 계정 만들기' "‘$u’ 의 비밀번호를 입력하세요. (8자 이상)" '' $true
                if ($null -eq $pw) { Remove-Item Env:RL_GUI -ErrorAction SilentlyContinue; return }
            }
            $env:RL_ADMIN_USER = $u; $env:RL_ADMIN_PASSWORD = $pw
        }
        if (-not $d['VWORLD_API_KEY']) {
            $k = InputDialog 'VWorld 지도 키' '이 PC 용으로 발급받은 VWorld 지도 키를 입력하세요.`n(없으면 비워 두고 확인 — 나중에 app\server\.env 에 넣을 수 있습니다)' '' $false
            $env:RL_VWORLD_KEY = if ($k) { $k.Trim() } else { ' ' }
        }
    }
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    foreach ($f in $logOut, $logErr) { try { [System.IO.File]::WriteAllText($f, '', (New-Object System.Text.UTF8Encoding($false))) } catch { } }
    $script:logPos = @{ out = 0; err = 0 }
    $logBox.Clear()
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$startPs1`"", '-NoBrowser')
    if ($PgPort) { $argList += @('-PgPort', "$PgPort") }
    if ($AppPort) { $argList += @('-AppPort', "$AppPort") }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr | Out-Null
    foreach ($n in 'RL_GUI', 'RL_ADMIN_USER', 'RL_ADMIN_PASSWORD', 'RL_VWORLD_KEY') { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
    $script:startedAt = Get-Date; $script:openedBrowser = $false
    UpdateStatus
}

function StopServer {
    $script:stopping = $true; UpdateStatus
    try {
        # 서버(node)를 끄면 start.ps1 이 DB 를 닫고 스스로 끝난다
        foreach ($n in (GetOurNode)) { try { Stop-Process -Id $n.Id -Force } catch { } }
        $t = [Diagnostics.Stopwatch]::StartNew()
        while ((GetWorker) -and $t.Elapsed.TotalSeconds -lt 45) { WaitMs 250; AddLog (TailFile $logOut 'out') }
        $w = GetWorker
        if ($w) {   # 끝나지 않으면 강제로 정리
            try { Stop-Process -Id $w.Id -Force } catch { }
            $null = RunNoPipe 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'stop.ps1'))
        }
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        AddLog (TailFile $logOut 'out')
    } finally { $script:stopping = $false }
    UpdateStatus
}

function OpenBrowser {
    $port = [int](ReadEnvValue 'PORT'); if ($port -gt 0) { Start-Process "http://localhost:$port" }
}

function StartChild($kind, $text, $scriptName, $extraArgs) {
    $script:busyOut = [System.IO.Path]::GetTempFileName()
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot $scriptName)`"") + $extraArgs
    $script:busyProc = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -WindowStyle Hidden -PassThru -RedirectStandardOutput $script:busyOut
    $null = $script:busyProc.Handle
    $script:busyKind = $kind; $script:busyText = $text
    AddLog "`r`n[$text]`r`n"
    UpdateStatus
}

function DoBackup { if ($script:busyProc) { return }; StartChild 'backup' '백업하는 중…' 'backup.ps1' @() }
function DoRestore {
    if ($script:busyProc) { return }
    if ((GetWorker) -or (GetOurNode).Count -gt 0) { Info '서버가 실행 중입니다. ‘서버 종료’ 후에 복원하세요.' 'Warning' | Out-Null; return }
    if (-not (Test-Path (Join-Path $data 'pgdata\PG_VERSION'))) { Info '아직 데이터베이스가 만들어지지 않았습니다.`n먼저 ‘서버 시작’을 한 번 실행한 뒤 종료하고 복원하세요.' 'Warning' | Out-Null; return }
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = '복원할 백업 폴더를 선택하세요. (road_ledger.dump 가 들어 있는 폴더)'
    $bk = Join-Path $data 'backups'; if (Test-Path $bk) { $dlg.SelectedPath = $bk }
    if ($dlg.ShowDialog($form) -ne 'OK') { return }
    $dir = $dlg.SelectedPath
    if (-not (Test-Path (Join-Path $dir 'road_ledger.dump'))) { Info "선택한 폴더에 road_ledger.dump 가 없습니다.`n$dir" 'Warning' | Out-Null; return }
    $r = Ask "다음 백업으로 복원합니다.`n$dir`n`n지금 들어 있는 자료는 덮어써집니다. 계속할까요?" 'YesNo' 'Warning'
    if ($r -ne 'Yes') { return }
    StartChild 'restore' '복원하는 중…' 'restore.ps1' @('-BackupDir', "`"$dir`"", '-Yes')
}

function FinishChild {
    $kind = $script:busyKind; $proc = $script:busyProc; $outFile = $script:busyOut
    $script:busyProc = $null; $script:busyOut = $null; $script:busyKind = ''
    $text = ''; try { $text = [System.IO.File]::ReadAllText($outFile, [System.Text.Encoding]::UTF8) } catch { }
    Remove-Item $outFile -Force -ErrorAction SilentlyContinue
    AddLog ($text.Trim() + "`r`n")
    $ok = ($proc.ExitCode -eq 0)
    UpdateStatus
    if ($kind -eq 'backup') {
        if ($ok) { Info "백업이 끝났습니다.`n`n$(($text -split "`r?`n" | Where-Object { $_ -match '백업 완료' } | Select-Object -Last 1).Trim())" | Out-Null } else { Info "백업에 실패했습니다. ‘진행 상황’ 창을 확인하세요." 'Error' | Out-Null }
    } else {
        if ($ok) { Info '복원이 끝났습니다. ‘서버 시작’으로 다시 시작하세요.' | Out-Null } else { Info "복원에 실패했습니다. ‘진행 상황’ 창을 확인하세요." 'Error' | Out-Null }
    }
}

function UpdateStatus {
    $s = ComputeState
    if ($s -ne $script:state -or [int](ReadEnvValue 'PORT') -ne $script:lastPort) {
        $prev = $script:state; $script:state = $s; ApplyState $s
        if ($s -eq 'running' -and $prev -eq 'starting' -and -not $script:openedBrowser -and -not $SelfTest) { $script:openedBrowser = $true; OpenBrowser }
        if ($prev -eq 'starting' -and $s -eq 'stopped') {
            $err = (TailFile $logErr 'err').Trim()
            $why = ((Get-Content $logOut -Tail 6 -Encoding UTF8 -ErrorAction SilentlyContinue) -join "`n").Trim()
            if ($why -match '실패') { Info "서버를 시작하지 못했습니다.`n`n$why`n`n자세한 내용: data\server.out.log" 'Error' | Out-Null }
        }
    }
}

# ------------------------------------------------------------------ 이벤트
$btnStart.Add_Click({ StartServer })
$btnStop.Add_Click({ StopServer })
$btnOpen.Add_Click({ OpenBrowser })
$btnBackup.Add_Click({ DoBackup })
$btnRestore.Add_Click({ DoRestore })
$btnFolder.Add_Click({ New-Item -ItemType Directory -Force -Path $data | Out-Null; Start-Process explorer.exe $data })
$script:forceClose = $false
$btnExit.Add_Click({
    if ((GetWorker) -or (GetOurNode).Count -gt 0) {
        if ((Ask "서버를 종료하고 프로그램을 닫습니다.`n계속할까요?" 'YesNo' 'Question') -ne 'Yes') { return }
        StopServer
    }
    $script:forceClose = $true; $form.Close()
})
$form.Add_FormClosing({
    param($s, $e)
    if ($script:forceClose -or $SelfTest) { return }
    if ($script:busyProc) { Info '백업/복원이 진행 중입니다. 끝난 뒤에 닫아 주세요.' 'Warning' | Out-Null; $e.Cancel = $true; return }
    if ((GetWorker) -or (GetOurNode).Count -gt 0) {
        $r = Ask "서버가 실행 중입니다.`n`n예: 서버를 종료하고 프로그램을 닫습니다.`n아니오: 서버는 계속 실행하고 이 창만 닫습니다.`n취소: 닫지 않습니다." 'YesNoCancel' 'Question'
        if ($r -eq 'Cancel') { $e.Cancel = $true; return }
        if ($r -eq 'Yes') { StopServer }
    }
})
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 800
$timer.Add_Tick({
    AddLog (TailFile $logOut 'out'); AddLog (TailFile $logErr 'err')
    if ($script:busyProc -and $script:busyProc.HasExited) { FinishChild } else { UpdateStatus }
})

# ------------------------------------------------------------------ 시작
# 이미 실행 중인 서버가 있으면 로그를 처음부터 보여 주지 않고 끝에서부터 이어 본다
foreach ($pair in @(@($logOut, 'out'), @($logErr, 'err'))) { if (Test-Path $pair[0]) { $script:logPos[$pair[1]] = (Get-Item $pair[0]).Length } }
$script:state = ''; UpdateStatus
$timer.Start()

if (-not $SelfTest) {
    [void]$form.ShowDialog()
    $timer.Stop()
    exit 0
}

# ------------------------------------------------------------------ 자체 시험(-SelfTest)
function Shot($name) {
    if (-not $ShotDir) { return }
    New-Item -ItemType Directory -Force -Path $ShotDir | Out-Null
    $bmp = New-Object System.Drawing.Bitmap $form.Width, $form.Height
    $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle 0, 0, $form.Width, $form.Height))
    $bmp.Save((Join-Path $ShotDir "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
function Report($label, $ok, $extra = '') { Write-Host ("{0,-46} {1} {2}" -f $label, $(if ($ok) { 'OK ' } else { 'FAIL' }), $extra) }
$form.Show(); WaitMs 600
$fail = 0
$s0 = ComputeState; Report '1. 처음 상태 = stopped' ($s0 -eq 'stopped') $s0; if ($s0 -ne 'stopped') { $fail++ }
Report '   버튼: 시작 켜짐/종료 꺼짐' ($btnStart.Enabled -and -not $btnStop.Enabled) ; Shot '1_stopped'
$btnStart.PerformClick(); WaitMs 800
$s1 = ComputeState; Report '2. 시작 누름 → starting' ($s1 -eq 'starting') $s1; Shot '2_starting'
$t = [Diagnostics.Stopwatch]::StartNew(); while ((ComputeState) -ne 'running' -and $t.Elapsed.TotalSeconds -lt 150) { WaitMs 500; if (-not (GetWorker) -and $t.Elapsed.TotalSeconds -gt 5) { break } }
$s2 = ComputeState; Report '3. 실행 중 상태' ($s2 -eq 'running') ("$s2 (" + [int]$t.Elapsed.TotalSeconds + '초)'); if ($s2 -ne 'running') { $fail++ }
WaitMs 1200; Report '   버튼: 종료·브라우저 켜짐, 시작·복원 꺼짐' ($btnStop.Enabled -and $btnOpen.Enabled -and -not $btnStart.Enabled -and -not $btnRestore.Enabled); Shot '3_running'
$port = [int](ReadEnvValue 'PORT')
try { $r = Invoke-WebRequest "http://localhost:$port/" -UseBasicParsing -TimeoutSec 10; Report '   서버 응답 HTTP 200' ($r.StatusCode -eq 200) } catch { Report '   서버 응답 HTTP 200' $false; $fail++ }
# 백업 버튼(서버가 켜진 채로): 끝날 때까지 기다린 뒤 백업 폴더에 덤프가 생겼는지 확인
$bkRoot = Join-Path $data 'backups'; $before = @(Get-ChildItem $bkRoot -Directory -ErrorAction SilentlyContinue).Count
$btnBackup.PerformClick(); WaitMs 400
Report '   백업 중 상태 = busy, 다른 버튼 잠김' ((ComputeState) -eq 'busy' -and -not $btnStop.Enabled -and -not $btnStart.Enabled); Shot '3b_busy'
$t4 = [Diagnostics.Stopwatch]::StartNew(); while ($script:busyProc -and $t4.Elapsed.TotalSeconds -lt 120) { WaitMs 400 }
$newest = Get-ChildItem $bkRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
Report '   백업 결과: 폴더·덤프 생성' ($newest -and (Test-Path (Join-Path $newest.FullName 'road_ledger.dump')) -and (@(Get-ChildItem $bkRoot -Directory).Count -gt $before)) $(if ($newest) { $newest.Name } else { '' })
if (-not ($newest -and (Test-Path (Join-Path $newest.FullName 'road_ledger.dump')))) { $fail++ }
Report '   백업 뒤 다시 running' ((ComputeState) -eq 'running') (ComputeState)
$btnStop.PerformClick(); WaitMs 300
$s4 = ComputeState; Report '4. 종료 후 → stopped' ($s4 -eq 'stopped') $s4; if ($s4 -ne 'stopped') { $fail++ }
$clean = $false; $t3 = [Diagnostics.Stopwatch]::StartNew()
do { WaitMs 400; $clean = (-not (PortListening $port)) -and (@(Get-Process postgres -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$root\*" -or $_.Path -match '^[R-Z]:\\' }).Count -eq 0) } until ($clean -or $t3.Elapsed.TotalSeconds -gt 10)
Report '   포트 닫힘·DB 프로세스 없음' $clean ("(" + [int]$t3.Elapsed.TotalSeconds + '초 확인)'); if (-not $clean) { $fail++ }; Shot '4_stopped'
Write-Host ("자체 시험 결과: {0}" -f $(if ($fail -eq 0) { '통과' } else { "실패 $fail 건" }))
$timer.Stop(); $form.Dispose()
exit $fail
