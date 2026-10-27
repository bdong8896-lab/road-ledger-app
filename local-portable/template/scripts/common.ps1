# start/stop/backup/restore 가 함께 쓰는 도우미 (dot-source 로 불러온다)

# pg_ctl start 는 DB 프로세스를 띄우면서 이쪽의 출력 파이프를 계속 붙들고 있어, 파이프로 받으면 끝나지 않는다 —
# 출력을 파일로 받고 pg_ctl 자체가 끝나기만 기다린다.
function RunNoPipe($file, $argList) {
    $o = [System.IO.Path]::GetTempFileName(); $e = [System.IO.Path]::GetTempFileName()
    try {
        $q = ($argList | ForEach-Object { if ("$_" -match '\s') { '"' + $_ + '"' } else { "$_" } }) -join ' '
        $p = Start-Process -FilePath $file -ArgumentList $q -NoNewWindow -PassThru -RedirectStandardOutput $o -RedirectStandardError $e
        $null = $p.Handle
        $p.WaitForExit()
        $text = ((Get-Content $o -Raw -ErrorAction SilentlyContinue) + (Get-Content $e -Raw -ErrorAction SilentlyContinue))
        return [pscustomobject]@{ Code = $p.ExitCode; Out = "$text".Trim() }
    } finally { Remove-Item $o, $e -Force -ErrorAction SilentlyContinue }
}

# PostgreSQL 은 실행 파일·데이터 폴더 경로에 한글이 있으면 서버가 UTF8 검사에서 죽는다(initdb 실패).
# 사용자 이름이나 폴더 이름이 한글인 PC 가 많아서, 한글이 있으면 빈 드라이브 문자를 이 폴더에 연결(subst, 관리자 권한 불필요)해
# 영문 경로(예: R:\)로 DB 만 돌린다. 앱(Node)과 업로드 파일은 원래 경로 그대로 쓰므로 DB 에 저장되는 파일 경로는 바뀌지 않는다.
$script:SubstLetter = $null
function Get-PgRoot($root) {
    if ($root -cmatch '^[\x00-\x7F]+$') { return $root }
    $used = [System.IO.DriveInfo]::GetDrives() | ForEach-Object { $_.Name.Substring(0, 1).ToUpper() }
    $letter = ('R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z' | Where-Object { $used -notcontains $_ })[0]
    if (-not $letter) { throw "한글이 든 경로라 가상 드라이브가 필요한데 빈 드라이브 문자가 없습니다. 이 폴더를 영문 경로(예: D:\RoadLedger-Local)로 옮겨 주세요." }
    & subst.exe "${letter}:" $root
    if ($LASTEXITCODE -ne 0) { throw "가상 드라이브를 만들지 못했습니다. 이 폴더를 영문 경로(예: D:\RoadLedger-Local)로 옮겨 주세요." }
    $script:SubstLetter = $letter
    return "${letter}:"
}
function Remove-PgRoot {
    if ($script:SubstLetter) { & subst.exe "$($script:SubstLetter):" /d | Out-Null; $script:SubstLetter = $null }
}

# 업로드 파일 경로(DB 에 절대경로로 저장됨)를 지금 위치로 바꾸는 SQL — 다른 PC·다른 폴더의 백업을 복원할 때 쓴다.
# 예전 경로가 어디든 "uploads\" 뒤의 부분은 같으므로 그 앞부분만 새 업로드 폴더로 교체한다.
function Get-PathRemapSql($newUploadsDir) {
    $q = $newUploadsDir.TrimEnd('\', '/').Replace("'", "''")
    $targets = @(
        @('route_files', 'stored_path'), @('route_files', 'converted_path'),
        @('gov_facility_files', 'stored_path'), @('road_issue_files', 'stored_path'), @('road_ledger_files', 'stored_path'),
        @('bulk_import_file_changes', 'stored_path'), @('bulk_import_file_changes', 'converted_path'), @('bulk_import_file_changes', 'trash_path'),
        @('section_trash_files', 'original_path'), @('section_trash_files', 'trash_path')
    )
    $sql = foreach ($t in $targets) {
        "UPDATE $($t[0]) SET $($t[1]) = '$q' || '\' || substring($($t[1]) from '(?i)[\\/]uploads[\\/](.*)$') WHERE $($t[1]) ~* '[\\/]uploads[\\/]';"
    }
    return ($sql -join "`n")
}
