# 앱 아이콘(app.ico)을 그려서 만든다 — 한 번 실행해 결과(app.ico)를 저장소에 두고, 모양을 바꿀 때만 다시 실행한다.
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1
# 모양: 짙은 청록 둥근 사각형 + 굽이치는 흰 도로(가운데 점선) + 주황 위치 표시.
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function New-IconBitmap([int]$size) {
    $s = 256.0
    $bmp = New-Object System.Drawing.Bitmap 256, 256, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'
    $g.Clear([System.Drawing.Color]::Transparent)

    # 배경: 둥근 사각형 + 대각선 그라데이션
    $r = 52
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(8, 8, $r, $r, 180, 90); $path.AddArc(256 - 8 - $r, 8, $r, $r, 270, 90)
    $path.AddArc(256 - 8 - $r, 256 - 8 - $r, $r, $r, 0, 90); $path.AddArc(8, 256 - 8 - $r, $r, $r, 90, 90); $path.CloseFigure()
    $rect = New-Object System.Drawing.RectangleF 0, 0, 256, 256
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, ([System.Drawing.Color]::FromArgb(255, 14, 62, 78)), ([System.Drawing.Color]::FromArgb(255, 22, 128, 134)), 45.0
    $g.FillPath($bg, $path)

    # 도로: 아래 왼쪽에서 위 오른쪽으로 굽이치는 곡선(두꺼운 흰색) + 가운데 점선
    $pts = @(
        (New-Object System.Drawing.PointF 52, 214), (New-Object System.Drawing.PointF 60, 150), (New-Object System.Drawing.PointF 160, 190), (New-Object System.Drawing.PointF 150, 118),
        (New-Object System.Drawing.PointF 140, 70), (New-Object System.Drawing.PointF 196, 70), (New-Object System.Drawing.PointF 198, 46)
    )
    $roadPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 245, 250, 250)), 34
    $roadPen.StartCap = 'Round'; $roadPen.EndCap = 'Round'; $roadPen.LineJoin = 'Round'
    $g.DrawBezier($roadPen, $pts[0], $pts[1], $pts[2], $pts[3])
    $g.DrawBezier($roadPen, $pts[3], $pts[4], $pts[5], $pts[6])
    $dash = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 22, 110, 118)), 5
    $dash.DashStyle = 'Dash'; $dash.DashPattern = [single[]](2.2, 2.0)
    $g.DrawBezier($dash, $pts[0], $pts[1], $pts[2], $pts[3])
    $g.DrawBezier($dash, $pts[3], $pts[4], $pts[5], $pts[6])

    # 위치 표시(주황 원 + 흰 점)
    $pin = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 153, 0))
    $g.FillEllipse($pin, 170, 18, 56, 56)
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $g.FillEllipse($white, 188, 36, 20, 20)
    $g.Dispose()
    if ($size -eq 256) { return $bmp }
    $out = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g2 = [System.Drawing.Graphics]::FromImage($out)
    $g2.InterpolationMode = 'HighQualityBicubic'; $g2.SmoothingMode = 'AntiAlias'; $g2.PixelOffsetMode = 'HighQuality'
    $g2.DrawImage($bmp, 0, 0, $size, $size); $g2.Dispose(); $bmp.Dispose()
    return $out
}

# ICO 파일 조립: 크기별 PNG 를 그대로 담는다(Windows Vista 이후 지원)
$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($sz in $sizes) {
    $b = New-IconBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += , $ms.ToArray(); $b.Dispose(); $ms.Dispose()
}
$fs = [System.IO.File]::Create((Join-Path $here 'app.ico'))
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz }))); $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
    $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
    $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close(); $fs.Close()
# 미리보기 PNG(256)도 같이 저장 — 화면 머리글과 문서에서 쓴다
$prev = New-IconBitmap 256; $prev.Save((Join-Path $here 'app-256.png'), [System.Drawing.Imaging.ImageFormat]::Png); $prev.Dispose()
Write-Host "만듦: $(Join-Path $here 'app.ico') ($((Get-Item (Join-Path $here 'app.ico')).Length) bytes), app-256.png"
