param([string]$Out)
# BOOTH 用のサムネイル画像を作る（Windows の System.Drawing。ロゴ・外部素材は使わない）
# 使い方: powershell -ExecutionPolicy Bypass -File scripts/make-thumbnail.ps1 -Out docs/booth/thumbnail.png
Add-Type -AssemblyName System.Drawing
$W = 1200; $H = 1200
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.InterpolationMode = 'HighQualityBicubic'

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function RoundRect($x, $y, $w, $h, $r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}
$fontName = 'Yu Gothic UI'
$fams = (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }
if ($fams -notcontains $fontName) { $fontName = 'Meiryo' }
function F($size, $style = 'Bold') { New-Object System.Drawing.Font($fontName, $size, [System.Drawing.FontStyle]$style, [System.Drawing.GraphicsUnit]::Pixel) }
$center = New-Object System.Drawing.StringFormat; $center.Alignment = 'Center'; $center.LineAlignment = 'Center'

# 背景
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.Point 0, 0), (New-Object System.Drawing.Point $W, $H), (C '#ffe4ee'), (C '#fff8ef'))
$g.FillRectangle($bg, 0, 0, $W, $H)
# 水玉
$dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 255, 255, 255))
foreach ($c in @(@(80, 90, 140), @(1080, 150, 200), @(1000, 1080, 260), @(150, 1100, 180), @(620, 40, 90))) { $g.FillEllipse($dot, $c[0] - $c[2] / 2, $c[1] - $c[2] / 2, $c[2], $c[2]) }

$ink = New-Object System.Drawing.SolidBrush (C '#2d2a32')
$muted = New-Object System.Drawing.SolidBrush (C '#6b6573')
$pink = New-Object System.Drawing.SolidBrush (C '#e0457b')
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)

# 上のラベル
$p = RoundRect 300 110 600 72 36; $g.FillPath($white, $p)
$g.DrawString('わんコメ用プラグイン ・ YouTube 向け', (F 32), $pink, (New-Object System.Drawing.RectangleF 300, 110, 600, 72), $center)

# タイトル
$g.DrawString('配信枠', (F 150), $ink, (New-Object System.Drawing.RectangleF 0, 220, $W, 190), $center)
$g.DrawString('オートセット', (F 150), $pink, (New-Object System.Drawing.RectangleF 0, 395, $W, 190), $center)

# 説明
$g.DrawString('配信を始めたら、わんコメの枠 URL が' + "`n" + '自動で切り替わって、自動でつながる', (F 44 'Regular'), $ink, (New-Object System.Drawing.RectangleF 0, 600, $W, 140), $center)

# 流れ（3 枚のカード）
$cards = @(@('LIVE', '配信開始'), @('URL', '自動でセット'), @('ON', '自動で接続'))
$cw = 300; $ch = 210; $gap = 60; $x0 = ($W - (3 * $cw + 2 * $gap)) / 2; $y0 = 790
$arrowPen = New-Object System.Drawing.Pen((C '#e0457b'), 10); $arrowPen.EndCap = 'ArrowAnchor'
$shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 224, 69, 123))
for ($i = 0; $i -lt 3; $i++) {
  $x = $x0 + $i * ($cw + $gap)
  $g.FillPath($shadow, (RoundRect ($x + 6) ($y0 + 10) $cw $ch 32))
  $g.FillPath($white, (RoundRect $x $y0 $cw $ch 32))
  $badge = RoundRect ($x + 70) ($y0 + 30) 160 70 35
  $g.FillPath($pink, $badge)
  $g.DrawString($cards[$i][0], (F 38), $white, (New-Object System.Drawing.RectangleF ($x + 70), ($y0 + 30), 160, 70), $center)
  $g.DrawString($cards[$i][1], (F 38), $ink, (New-Object System.Drawing.RectangleF $x, ($y0 + 115), $cw, 70), $center)
  if ($i -lt 2) { $ax = $x + $cw + 8; $g.DrawLine($arrowPen, $ax, ($y0 + $ch / 2), ($ax + $gap - 16), ($y0 + $ch / 2)) }
}

# 特長
$chips = @('無料', '予約枠も先取り', '限定公開も OK')
$chipFont = F 32
$sizes = $chips | ForEach-Object { [int]$g.MeasureString($_, $chipFont).Width + 56 }
$total = ($sizes | Measure-Object -Sum).Sum + 24 * ($chips.Count - 1)
$cx = ($W - $total) / 2
$chipPen = New-Object System.Drawing.Pen((C '#e0457b'), 3)
for ($i = 0; $i -lt $chips.Count; $i++) {
  $rp = RoundRect $cx 1055 $sizes[$i] 64 32
  $g.FillPath($white, $rp); $g.DrawPath($chipPen, $rp)
  $g.DrawString($chips[$i], $chipFont, $pink, (New-Object System.Drawing.RectangleF $cx, 1055, $sizes[$i], 64), $center)
  $cx += $sizes[$i] + 24
}
$g.DrawString('非公式 ・ りーと', (F 24 'Regular'), $muted, (New-Object System.Drawing.RectangleF 0, 1140, $W, 40), $center)

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"saved: $Out (font: $fontName)"
