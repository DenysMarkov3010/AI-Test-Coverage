# Create "AI Test Coverage.lnk" on Desktop with custom icon (ai-test-coverage.ico).
# Run: powershell -ExecutionPolicy Bypass -File .\scripts\create-desktop-shortcut.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$pngPath = Join-Path $ProjectRoot "assets\ai-test-coverage.png"
$icoPath = Join-Path $ProjectRoot "assets\ai-test-coverage.ico"
$launcher = Join-Path $ProjectRoot "scripts\launch-ai-test-coverage.ps1"
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "AI Test Coverage.lnk"

if (-not (Test-Path -LiteralPath $pngPath)) {
    Write-Error "Missing icon: $pngPath"
}

# Prefer Node png-to-ico (valid multi-size .ico for Windows shortcuts)
$buildIcon = Join-Path $ProjectRoot "scripts\build-icon.js"
$node = Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
if ($node -and (Test-Path -LiteralPath $buildIcon)) {
    Push-Location $ProjectRoot
    try {
        & $node $buildIcon
    } catch {
        Write-Warning "build-icon.js failed, falling back to System.Drawing: $_"
    } finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $icoPath)) {
    Add-Type -AssemblyName System.Drawing
    $bmp = [System.Drawing.Bitmap]::FromFile($pngPath)
    try {
        $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
        try {
            $fs = [System.IO.File]::Create($icoPath)
            try {
                $icon.Save($fs)
            } finally {
                $fs.Dispose()
            }
        } finally {
            $icon.Dispose()
        }
    } finally {
        $bmp.Dispose()
    }
}

$icoFull = [System.IO.Path]::GetFullPath($icoPath)
$launcherFull = [System.IO.Path]::GetFullPath($launcher)

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($lnkPath)
$Shortcut.TargetPath = "powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcherFull`""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.IconLocation = "$icoFull,0"
$Shortcut.Description = "AI Test Coverage: start the web UI and open it in the browser"
$Shortcut.Save()

Write-Host "Created: $lnkPath"
Write-Host "Icon: $icoFull"
