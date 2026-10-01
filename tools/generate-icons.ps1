Add-Type -AssemblyName System.Drawing

$root = Join-Path $PSScriptRoot '..\assets\icons'
New-Item -ItemType Directory -Force -Path $root | Out-Null

foreach ($size in 16, 32, 48, 128) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 8, 15, 26))

  $blade = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new($size * 0.24, $size * 0.79),
    [System.Drawing.PointF]::new($size * 0.68, $size * 0.18),
    [System.Drawing.PointF]::new($size * 0.78, $size * 0.25),
    [System.Drawing.PointF]::new($size * 0.34, $size * 0.86)
  )
  $bladeBrush = [System.Drawing.SolidBrush]::new(
    [System.Drawing.Color]::FromArgb(255, 232, 242, 255)
  )
  $graphics.FillPolygon($bladeBrush, $blade)

  $trailPen = [System.Drawing.Pen]::new(
    [System.Drawing.Color]::FromArgb(255, 34, 211, 238),
    [Math]::Max(1, $size / 16)
  )
  $graphics.DrawLine(
    $trailPen,
    [System.Drawing.PointF]::new($size * 0.18, $size * 0.88),
    [System.Drawing.PointF]::new($size * 0.82, $size * 0.12)
  )

  $guardPen = [System.Drawing.Pen]::new(
    [System.Drawing.Color]::FromArgb(255, 246, 196, 83),
    [Math]::Max(1, $size / 24)
  )
  $graphics.DrawLine(
    $guardPen,
    [System.Drawing.PointF]::new($size * 0.20, $size * 0.82),
    [System.Drawing.PointF]::new($size * 0.38, $size * 0.92)
  )

  $path = Join-Path $root "icon$size.png"
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $guardPen.Dispose()
  $trailPen.Dispose()
  $bladeBrush.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}
