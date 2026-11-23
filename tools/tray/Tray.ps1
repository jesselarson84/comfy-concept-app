# Tray.ps1 - system tray controller for one local server (config: tray.config.json).
# Right-click: Start / Stop / Restart / Open log / Exit tray. The icon is the app's own
# icon: green dot = running, amber dot = starting (or the port is used by something
# else), greyed = stopped. Exit tray leaves the server as it is.
# Start hidden with Tray.vbs. Only one tray per app (named mutex from the config).
param([string]$ConfigPath = (Join-Path $PSScriptRoot 'tray.config.json'))
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TrayCore.psm1') -Force
$cfg = Get-TrayConfig -Path $ConfigPath

$created = $false
$mutex = New-Object System.Threading.Mutex($true, $cfg.Mutex, [ref]$created)
if (-not $created) { exit 0 }  # this app's tray is already running

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$icoDir = Split-Path -Parent (Resolve-Path $ConfigPath)
function Load-Icon($file) { if (-not [IO.Path]::IsPathRooted($file)) { $file = Join-Path $icoDir $file }; New-Object System.Drawing.Icon($file, [System.Windows.Forms.SystemInformation]::SmallIconSize) }
$icons = @{ Running = Load-Icon $cfg.IconRunning; Starting = Load-Icon $cfg.IconStarting; Stopped = Load-Icon $cfg.IconStopped }
$icons.Foreign = $icons.Starting

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miStatus = $menu.Items.Add($cfg.Name); $miStatus.Enabled = $false
[void]$menu.Items.Add('-')
$miStart = $menu.Items.Add('Start'); $miStop = $menu.Items.Add('Stop'); $miRestart = $menu.Items.Add('Restart')
[void]$menu.Items.Add('-')
$miLog = $menu.Items.Add('Open log'); $miExit = $menu.Items.Add('Exit tray')
$tray.ContextMenuStrip = $menu
$script:busy = $false

function Update-Tray {
    try { $s = Get-ServerState -Config $cfg } catch { return }
    $st = if ($script:busy) { 'Starting' } else { $s.Status }
    $tray.Icon = $icons[$st]
    $label = switch ($st) { 'Running' { "running (port $($cfg.Port))" } 'Starting' { 'working...' } 'Foreign' { $s.Detail } default { 'stopped' } }
    $text = "$($cfg.Name): $label"; if ($text.Length -gt 63) { $text = $text.Substring(0, 63) }
    $tray.Text = $text; $miStatus.Text = $text
    $miStart.Enabled = -not $script:busy -and $st -eq 'Stopped'
    $miStop.Enabled = -not $script:busy -and $st -in 'Running', 'Starting'
    $miRestart.Enabled = -not $script:busy -and $st -eq 'Running'
    $miLog.Enabled = [bool]($cfg.LogPath -and (Test-Path $cfg.LogPath))
}

function Invoke-TrayAction([scriptblock]$Action, [string]$What) {
    $script:busy = $true; Update-Tray; [System.Windows.Forms.Application]::DoEvents()
    try {
        $r = & $Action
        if ($r -and -not $r.Ok) { $tray.ShowBalloonTip(4000, $cfg.Name, "$What did not finish: $($r.Note)", 'Warning') }
    } catch { $tray.ShowBalloonTip(4000, $cfg.Name, "$What failed: $($_.Exception.Message)", 'Error') }
    finally { $script:busy = $false; Update-Tray }
}

$miStart.add_Click({ Invoke-TrayAction { Start-Server -Config $cfg } 'Start' })
$miStop.add_Click({ Invoke-TrayAction { Stop-Server -Config $cfg } 'Stop' })
$miRestart.add_Click({ Invoke-TrayAction { Restart-Server -Config $cfg } 'Restart' })
$miLog.add_Click({ if ($cfg.LogPath -and (Test-Path $cfg.LogPath)) { Start-Process notepad.exe -ArgumentList ('"' + $cfg.LogPath + '"') } })
$miExit.add_Click({ $timer.Stop(); $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, [int]$cfg.PollSeconds) * 1000
$timer.add_Tick({ if (-not $script:busy) { Update-Tray } })

# At login: give the existing autostart LaunchGraceSec to bring the server up, then
# start it if it still isn't running (never a second copy: Start-Server checks first).
if ($cfg.StartServerOnLaunch) {
    $grace = New-Object System.Windows.Forms.Timer
    $grace.Interval = [Math]::Max(1, [int]$cfg.LaunchGraceSec) * 1000
    $grace.add_Tick({ $grace.Stop(); if ((Get-ServerState -Config $cfg).Status -eq 'Stopped') { Invoke-TrayAction { Start-Server -Config $cfg } 'Start' } })
    $grace.Start()
}

Update-Tray
$tray.Visible = $true
$timer.Start()
try { [System.Windows.Forms.Application]::Run() }
finally { $tray.Visible = $false; $tray.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }
