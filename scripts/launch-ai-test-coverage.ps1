# AI Test Coverage — start the web UI (if needed) and open the app in the browser.
# Run from the desktop shortcut or: powershell -ExecutionPolicy Bypass -File .\scripts\launch-ai-test-coverage.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WebUrl = "http://127.0.0.1:3847/"

function Test-WebUiUp {
    try {
        $r = Invoke-WebRequest -Uri $WebUrl -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

Add-Type -AssemblyName System.Windows.Forms

if (-not (Test-Path (Join-Path $ProjectRoot "web-ui-server.js"))) {
    [System.Windows.Forms.MessageBox]::Show("web-ui-server.js was not found in:`n$ProjectRoot", "AI Test Coverage") | Out-Null
    exit 1
}

if (-not (Test-WebUiUp)) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    if (-not $npm) { $npm = "npm.cmd" }
    Start-Process -FilePath $npm -ArgumentList "run", "web" -WorkingDirectory $ProjectRoot -WindowStyle Minimized
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 400
        if (Test-WebUiUp) { break }
    }
}

Start-Process $WebUrl
