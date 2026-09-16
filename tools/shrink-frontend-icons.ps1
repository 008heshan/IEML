# 把前端图标缩到"实际显示尺寸 × 4"（HiDPI 上限），原图备份到 src/assets/_original/
#
# 依据（实测的显示尺寸）：
#   brand-icon   最大显示 64px（index.html splash）→ 4x = 256px；原 1189px = 18 倍浪费
#   version-icon 最大显示 72px（LaunchPage 大卡） → 4x = 288px；原 1060px = 15 倍浪费
#
# ★ 必须保住 alpha：目标位图建为 Format32bppArgb + CompositingMode.SourceCopy，
#   否则透明区会变成黑底（这是 DrawImage 缩图最常见的坑）。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = 'E:\IEML\src\assets'
$backup = Join-Path $root '_original'
New-Item -ItemType Directory -Force -Path $backup | Out-Null

# 目标边长 = 最大显示尺寸 × 4（HiDPI）
$targets = @(
  @{ Name = 'brand-icon.png';   Max = 256 },
  @{ Name = 'version-icon.png'; Max = 320 }
)

foreach ($t in $targets) {
  $src = Join-Path $root $t.Name
  if (-not (Test-Path $src)) { Write-Output "跳过（不存在）: $($t.Name)"; continue }

  # 备份（只备份一次，避免第二次运行把已缩过的图当原图）
  $bak = Join-Path $backup $t.Name
  if (-not (Test-Path $bak)) {
    Copy-Item $src $bak -Force
    Write-Output "已备份原图 -> _original\$($t.Name)"
  }

  $origBytes = (Get-Item $src).Length
  $img = [System.Drawing.Image]::FromFile($src)
  $ow = $img.Width
  $oh = $img.Height

  # 按长边等比缩（两张图都不是严格正方形）
  $scale = [Math]::Min($t.Max / $img.Width, $t.Max / $img.Height)
  if ($scale -ge 1) {
    Write-Output "$($t.Name): 已经足够小（${ow}x${oh}），不动"
    $img.Dispose(); continue
  }
  $nw = [int][Math]::Round($img.Width * $scale)
  $nh = [int][Math]::Round($img.Height * $scale)

  $dst = New-Object System.Drawing.Bitmap($nw, $nh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($dst)
  $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle(0, 0, $nw, $nh)))
  $g.Dispose()
  $img.Dispose()

  # 原子替换（先写临时文件再覆盖，避免半截文件）
  $tmp = "$src.tmp.png"
  $dst.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose()
  Move-Item $tmp $src -Force

  $newBytes = (Get-Item $src).Length
  Write-Output ("{0,-20} {1,5}x{2,-5} -> {3,4}x{4,-5} {5,9:N0} B -> {6,8:N0} B   -{7:N1}%" -f `
    $t.Name, $ow, $oh, $nw, $nh, $origBytes, $newBytes, (1 - $newBytes / $origBytes) * 100)
}
