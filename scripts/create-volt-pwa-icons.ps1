# Renders the Volt app icon (violet rounded square with "V") as 192x192
# and 512x512 PNGs for the PWA manifest. Same design as volt.ico.
# Run:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/create-volt-pwa-icons.ps1
$assetsDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'pdf-viewer\assets'

Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

function New-VoltIconPng([int]$size, [string]$outPath) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(4, [int]($size * 0.05))
  $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($size - 2 * $pad), ($size - 2 * $pad)
  $radius = [int]($size * 0.22)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()

  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
      $rect,
      [System.Drawing.Color]::FromArgb(124, 108, 255),
      [System.Drawing.Color]::FromArgb(76, 201, 240),
      45)
  $g.FillPath($brush, $path)

  $fontSize = [int]($size * 0.55)
  $font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rectF = New-Object System.Drawing.RectangleF $rect.X, $rect.Y, $rect.Width, $rect.Height
  $g.DrawString('V', $font, [System.Drawing.Brushes]::White, $rectF, $fmt)
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)

  $g.Dispose(); $bmp.Dispose(); $path.Dispose(); $brush.Dispose(); $font.Dispose(); $fmt.Dispose()
  Write-Host "PNG icon: $outPath"
}

New-VoltIconPng 192 (Join-Path $assetsDir 'icon-192.png')
New-VoltIconPng 512 (Join-Path $assetsDir 'icon-512.png')
