# Idempotent desktop shortcut for «AI Test Coverage».
# If AI Test Coverage.lnk already exists on the user Desktop AND still points at this
# project's launcher, exits without doing anything.
# Otherwise (missing, or stale after the project folder was moved/renamed) runs
# create-desktop-shortcut.ps1 (same as npm run shortcut).
# Called from web-ui-server.js on Windows when the web UI starts.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$launcherFull = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "scripts\launch-ai-test-coverage.ps1"))
$desktop = [Environment]::GetFolderPath("Desktop")
$lnkPath = Join-Path $desktop "AI Test Coverage.lnk"

function Test-ShortcutCurrent {
    param([string]$Path, [string]$ExpectedLauncher)
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($Path)
        # Launcher path is passed via -File "<path>"; compare it to this project's launcher.
        # Plain substring match (not -like), so [ ] in a path are not read as wildcards.
        return $shortcut.Arguments.Contains('"' + $ExpectedLauncher + '"')
    } catch {
        return $false
    }
}

if ((Test-Path -LiteralPath $lnkPath) -and (Test-ShortcutCurrent -Path $lnkPath -ExpectedLauncher $launcherFull)) {
    exit 0
}
$createScript = Join-Path $PSScriptRoot "create-desktop-shortcut.ps1"
& $createScript
