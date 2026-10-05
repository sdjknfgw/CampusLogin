$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$appleRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetRoot = Join-Path $appleRoot 'Resources/Assets.xcassets'
$mascotPath = Join-Path $appleRoot '../CampusLogin/src/panel/assets/deepseek_mascot_happy.png'
$mascot = [System.Drawing.Image]::FromFile([System.IO.Path]::GetFullPath($mascotPath))
try {
    foreach ($name in @('AppIcon', 'MacIcon')) {
        $iconRoot = Join-Path $assetRoot ($name + '.appiconset')
        New-Item -ItemType Directory -Path $iconRoot -Force | Out-Null
        $entries = @()
        if ($name -eq 'AppIcon') { $variants = @(@{ idiom = 'universal'; size = '1024x1024'; scale = '1x'; pixels = 1024; platform = 'ios' }) }
        else {
            $variants = @()
            foreach ($size in @(16, 32, 128, 256, 512)) {
                foreach ($scale in @(1, 2)) { $variants += @{ idiom = 'mac'; size = ($size.ToString() + 'x' + $size); scale = ($scale.ToString() + 'x'); pixels = $size * $scale } }
            }
        }
        foreach ($variant in $variants) {
            $filename = 'icon-' + $variant.size + '-' + $variant.scale + '.png'
            $bitmap = New-Object System.Drawing.Bitmap($variant.pixels, $variant.pixels, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            try {
                $graphics.Clear([System.Drawing.Color]::FromArgb(10, 18, 30))
                $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $side = [int]($variant.pixels * 0.82)
                $ratio = [Math]::Min($side / $mascot.Width, $side / $mascot.Height)
                $w = [int]($mascot.Width * $ratio)
                $h = [int]($mascot.Height * $ratio)
                $graphics.DrawImage($mascot, [int](($variant.pixels - $w) / 2), [int](($variant.pixels - $h) / 2), $w, $h)
                $bitmap.Save((Join-Path $iconRoot $filename), [System.Drawing.Imaging.ImageFormat]::Png)
            } finally { $graphics.Dispose(); $bitmap.Dispose() }
            $entry = @{ idiom = $variant.idiom; size = $variant.size; scale = $variant.scale; filename = $filename }
            if ($variant.platform) { $entry.platform = $variant.platform }
            $entries += $entry
        }
        @{ images = $entries; info = @{ version = 1; author = 'xcode' } } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $iconRoot 'Contents.json') -Encoding UTF8
    }
    @{ info = @{ version = 1; author = 'xcode' } } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $assetRoot 'Contents.json') -Encoding UTF8
} finally { $mascot.Dispose() }
