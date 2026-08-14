$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$iconDir = Join-Path $projectRoot 'icons'
$sourceCandidates = @(
  (Join-Path $projectRoot 'design images\logo toolbar.png'),
  (Join-Path $projectRoot 'design images\logo.png'),
  (Join-Path $projectRoot 'assets\logo.png')
)
$sourcePath = $sourceCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sourcePath) { throw 'logo toolbar.png / logo.png not found in design images/ or assets/' }

[System.IO.Directory]::CreateDirectory($iconDir) | Out-Null

$argb = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$source = [System.Drawing.Bitmap]::new($sourcePath)
try {
  $rect = [System.Drawing.Rectangle]::new(0, 0, $source.Width, $source.Height)
  $data = $source.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, $argb)
  $minX = $source.Width
  $minY = $source.Height
  $maxX = -1
  $maxY = -1
  try {
    $bytes = [byte[]]::new($data.Stride * $data.Height)
    [Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
    for ($y = 0; $y -lt $source.Height; $y += 1) {
      $row = $y * $data.Stride
      for ($x = 0; $x -lt $source.Width; $x += 1) {
        if ($bytes[$row + ($x * 4) + 3] -lt 24) { continue }
        if ($x -lt $minX) { $minX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  } finally {
    $source.UnlockBits($data)
  }
  if ($maxX -lt 0) { throw 'logo.png has no visible mark to crop' }

  $boxWidth = $maxX - $minX + 1
  $boxHeight = $maxY - $minY + 1
  $pad = [Math]::Max(4, [int]([Math]::Max($boxWidth, $boxHeight) * 0.04))
  $side = [Math]::Max($boxWidth, $boxHeight) + (2 * $pad)
  $cropX = [Math]::Max(0, [Math]::Min($source.Width - $side, $minX - [int](($side - $boxWidth) / 2)))
  $cropY = [Math]::Max(0, [Math]::Min($source.Height - $side, $minY - [int](($side - $boxHeight) / 2)))
  $side = [Math]::Min($side, [Math]::Min($source.Width - $cropX, $source.Height - $cropY))

  $cropped = $source.Clone([System.Drawing.Rectangle]::new($cropX, $cropY, $side, $side), $argb)
  try {
    foreach ($size in @(16, 32, 48, 128)) {
      $bitmap = [System.Drawing.Bitmap]::new($size, $size, $argb)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($cropped, 0, 0, $size, $size)
        $bitmap.Save((Join-Path $iconDir "icon-$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
      } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
      }
    }
    $preview = [System.Drawing.Bitmap]::new(256, 256, $argb)
    $previewGraphics = [System.Drawing.Graphics]::FromImage($preview)
    try {
      $previewGraphics.Clear([System.Drawing.Color]::Transparent)
      $previewGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $previewGraphics.DrawImage($cropped, 0, 0, 256, 256)
      $preview.Save((Join-Path $iconDir 'logo.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $previewGraphics.Dispose()
      $preview.Dispose()
    }
  } finally {
    $cropped.Dispose()
  }
} finally {
  $source.Dispose()
}

Write-Output "Generated transparent cropped Chrome icons from $sourcePath"
