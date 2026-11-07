# Génère les icônes PNG de la webapp (iOS n'accepte pas le SVG pour l'écran d'accueil).
# Même dessin que web/icon.svg : chrono blanc sur fond bleu.
#   powershell -File scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\web'

function Draw-Icon([int]$size, [string]$name, [bool]$rounded, [double]$scale) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $blue = [System.Drawing.ColorTranslator]::FromHtml('#2563eb')
  $k = $size / 512.0
  if ($rounded) {
    $r = 112 * $k
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2 * $r, 2 * $r, 180, 90)
    $path.AddArc($size - 2 * $r, 0, 2 * $r, 2 * $r, 270, 90)
    $path.AddArc($size - 2 * $r, $size - 2 * $r, 2 * $r, 2 * $r, 0, 90)
    $path.AddArc(0, $size - 2 * $r, 2 * $r, 2 * $r, 90, 90)
    $g.FillPath((New-Object System.Drawing.SolidBrush $blue), $path)
  } else {
    $g.Clear($blue)
  }
  # Le dessin est réduit autour du centre pour les icônes "maskable" (zone de sécurité).
  $s = $k * $scale
  $o = $size * (1 - $scale) / 2
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), (36 * $s)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawEllipse($pen, [float]($o + 106 * $s), [float]($o + 126 * $s), [float](300 * $s), [float](300 * $s))
  $g.DrawLine($pen, [float]($o + 256 * $s), [float]($o + 276 * $s), [float]($o + 256 * $s), [float]($o + 186 * $s))
  $g.DrawLine($pen, [float]($o + 256 * $s), [float]($o + 276 * $s), [float]($o + 320 * $s), [float]($o + 316 * $s))
  $g.FillRectangle([System.Drawing.Brushes]::White, [float]($o + 216 * $s), [float]($o + 70 * $s), [float](80 * $s), [float](44 * $s))
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

Draw-Icon 192 'icon-192.png' $true 1.0
Draw-Icon 512 'icon-512.png' $true 1.0
Draw-Icon 512 'icon-maskable-512.png' $false 0.8
Draw-Icon 180 'apple-touch-icon.png' $false 1.0
Write-Output 'icônes générées'
