# DB 를 끈다(창을 그냥 닫아서 DB 가 남았을 때 쓴다). 서버(검은 창)는 따로 닫는다.
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Test-Path (Join-Path $root 'data\pgdata\PG_VERSION'))) { Write-Host "  DB 가 아직 만들어지지 않았습니다. 끌 것이 없습니다."; exit 0 }
try { $pgRoot = Get-PgRoot $root } catch { Write-Host "  $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
$pgBin  = Join-Path $pgRoot 'pg\bin'
$pgdata = Join-Path $pgRoot 'data\pgdata'
$st = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, 'status')
if ($st.Code -ne 0) { Write-Host "  DB 는 이미 꺼져 있습니다."; Remove-PgRoot; exit 0 }
$r = RunNoPipe (Join-Path $pgBin 'pg_ctl.exe') @('-D', $pgdata, '-m', 'fast', '-w', 'stop')
Remove-PgRoot
if ($r.Code -eq 0) { Write-Host "  DB 를 껐습니다." } else { Write-Host "  DB 를 끄지 못했습니다. 잠시 뒤 다시 시도하세요.`n$($r.Out)" }
