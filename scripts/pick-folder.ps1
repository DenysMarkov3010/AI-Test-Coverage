# Folder picker for AI Test Coverage web UI.
#
# Called by web-ui-server.js (sync + async paths). Writes the chosen path to stdout,
# or nothing if the user cancelled.
#
# The owner-form + SetForegroundWindow trick is required because the AI Test Coverage
# launcher (.lnk) starts the process tree with -WindowStyle Hidden and Node spawns
# powershell with CREATE_NO_WINDOW. Without an explicit TopMost owner, Windows'
# foreground-lock denies the FolderBrowserDialog the foreground and it ends up
# hidden behind the browser - which is exactly the "spammed /status?jobId polls,
# no picker visible" symptom reported in the web UI.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$signature = @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
"@
Add-Type -Namespace DA -Name Win -MemberDefinition $signature

$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = "CenterScreen"
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = "None"
$owner.Opacity = 0
$owner.TopMost = $true

try {
    $null = $owner.Show()
    $owner.Activate()
    [void][DA.Win]::BringWindowToTop($owner.Handle)
    [void][DA.Win]::SetForegroundWindow($owner.Handle)

    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = "Select the AI Test Coverage project folder"
    $dlg.ShowNewFolderButton = $false

    $result = $dlg.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dlg.SelectedPath
    }
} finally {
    $owner.Close()
    $owner.Dispose()
}
