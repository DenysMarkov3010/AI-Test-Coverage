# CSV file picker for the AI Test Coverage web UI.
#
# Called by web-ui-server.js (/__da/file-pick/start). Writes the chosen full path
# to stdout, or nothing if the user cancelled.
#
# The owner-form + SetForegroundWindow trick is the same one pick-folder.ps1 needs:
# the launcher starts the process tree with -WindowStyle Hidden and Node spawns
# powershell with CREATE_NO_WINDOW, so without an explicit TopMost owner Windows'
# foreground-lock leaves the dialog behind the browser and the UI polls /status
# forever with no picker in sight.

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$signature = @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
"@
Add-Type -Namespace DA -Name WinFile -MemberDefinition $signature

$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = "CenterScreen"
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = "None"
$owner.Opacity = 0
$owner.TopMost = $true

# Start where exported CSVs usually land. OneDrive-redirected Downloads first.
$startDir = ""
foreach ($candidate in @(
    (Join-Path $env:USERPROFILE "OneDrive\Downloads"),
    (Join-Path $env:USERPROFILE "Downloads")
)) {
    if (Test-Path $candidate) { $startDir = $candidate; break }
}

try {
    $null = $owner.Show()
    $owner.Activate()
    [void][DA.WinFile]::BringWindowToTop($owner.Handle)
    [void][DA.WinFile]::SetForegroundWindow($owner.Handle)

    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Title = "Select the CSV to update"
    $dlg.Filter = "CSV files (*.csv)|*.csv|All files (*.*)|*.*"
    $dlg.Multiselect = $false
    $dlg.CheckFileExists = $true
    if ($startDir -ne "") { $dlg.InitialDirectory = $startDir }

    $result = $dlg.ShowDialog($owner)
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
        Write-Output $dlg.FileName
    }
} finally {
    $owner.Close()
    $owner.Dispose()
}
