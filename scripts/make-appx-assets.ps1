# Regenerates the Windows app package (appx) tile images from the app icon.
#   powershell -File scripts\make-appx-assets.ps1
# electron-builder picks them up from apps\desktop\build\appx. The square tiles are the icon scaled to
# fit with a little margin; the wide tile is the icon centred on a transparent canvas. Needs only
# Windows PowerShell 5.1 (System.Drawing); replace the PNGs with hand-made art whenever you have it.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'apps\desktop\build\icon.png'
$outDir = Join-Path $repo 'apps\desktop\build\appx'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# name, width, height, share of the shorter side the icon fills
$tiles = @(
  @('StoreLogo.png', 50, 50, 0.92),
  @('Square44x44Logo.png', 44, 44, 0.92),
  @('Square71x71Logo.png', 71, 71, 0.80),
  @('Square150x150Logo.png', 150, 150, 0.80),
  @('Wide310x150Logo.png', 310, 150, 0.80),
  @('Square310x310Logo.png', 310, 310, 0.80)
)

$icon = [System.Drawing.Image]::FromFile($source)
try {
  foreach ($tile in $tiles) {
    $name, $w, $h, $fill = $tile
    $bitmap = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $side = [int][Math]::Round([Math]::Min($w, $h) * $fill)
    $g.DrawImage($icon, [int](($w - $side) / 2), [int](($h - $side) / 2), $side, $side)
    $g.Dispose()
    $bitmap.Save((Join-Path $outDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    "{0,-26} {1}x{2}" -f $name, $w, $h
  }
} finally {
  $icon.Dispose()
}
