# Tray.Tests.ps1 - checks TrayCore's start / stop / status against throwaway dummy
# servers (PowerShell TCP listeners on spare ports). Never touches the real server.
#   powershell -NoProfile -ExecutionPolicy Bypass -File Tray.Tests.ps1 [-Port 3199] [-TrayLaunch]
param([int]$Port = 3199, [switch]$TrayLaunch)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TrayCore.psm1') -Force
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$root = Join-Path $env:TEMP ('tray-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$wd = Join-Path $root 'server dir'; New-Item -ItemType Directory -Path $wd -Force | Out-Null
$dummy = Join-Path $root 'dummy-server.ps1'
@(
    'param([int]$Port, [string]$Out)'
    '(Get-Location).Path | Set-Content -Path $Out'
    '# a child, like Gradle / Node workers'
    'Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList ''-NoProfile -Command Start-Sleep 600'' -WindowStyle Hidden'
    '$l = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $Port); $l.Start()'
    'Write-Output "dummy listening on $Port"'
    'while ($true) { Start-Sleep -Seconds 1 }'
) | Set-Content -Path $dummy -Encoding utf8
$cfgPath = Join-Path $root 'tray.config.json'
$ico = (Get-ChildItem $PSScriptRoot -Filter 'icon-stopped.ico' | Select-Object -First 1).FullName
@{
    Name = 'Dummy'; Port = $Port; WorkingDirectory = $wd; Exe = $ps
    Args = "-NoProfile -ExecutionPolicy Bypass -File `"$dummy`" -Port $Port -Out cwd.txt"
    LogPath = (Join-Path $root 'logs\dummy.log'); PidFile = (Join-Path $root 'dummy.pid')
    ServerMatch = @($dummy, "-Port $Port"); Ancestors = @(@{ all = @($dummy, "-Port $Port") })
    Mutex = 'Local\TrayTest-' + $Port; StartTimeoutSec = 30; StopTimeoutSec = 15; LaunchGraceSec = 1; PollSeconds = 1
    StartServerOnLaunch = $true; IconRunning = $ico; IconStarting = $ico; IconStopped = $ico
} | ConvertTo-Json -Depth 5 | Set-Content -Path $cfgPath -Encoding utf8
$cfg = Get-TrayConfig -Path $cfgPath

$fail = 0; $mine = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$ok, [string]$info = '') { if ($ok) { Write-Output "PASS  $name" } else { $script:fail++; Write-Output "FAIL  $name $info" } }
function Alive([int]$id) { [bool](Get-Process -Id $id -ErrorAction SilentlyContinue) }
function WaitPort([bool]$up) { for ($i = 0; $i -lt 80; $i++) { if ([bool](Get-ListenerPid $Port) -eq $up) { return }; Start-Sleep -Milliseconds 250 } }

try {
    if (Get-ListenerPid $Port) { throw "port $Port is in use; pick another with -Port" }
    if (Get-ListenerPid ($Port - 1)) { throw "port $($Port - 1) is in use; pick another with -Port" }
    # Bystanders that must survive every Stop: the same dummy on another port, and a plain sleeper.
    $by1 = Start-Process -FilePath $ps -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$dummy`" -Port $($Port - 1) -Out `"$root\by.txt`"" -WindowStyle Hidden -PassThru
    $by2 = Start-Process -FilePath $ps -ArgumentList '-NoProfile -Command Start-Sleep 600' -WindowStyle Hidden -PassThru
    [void]$mine.Add($by1.Id); [void]$mine.Add($by2.Id)

    Check 'status: stopped before start' ((Get-ServerState -Config $cfg).Status -eq 'Stopped')

    $r = Start-Server -Config $cfg
    [void]$mine.Add($r.Pid)
    Check 'start: comes up on the port' ($r.Ok -and (Get-ServerState -Config $cfg).Status -eq 'Running')
    $cwd = Get-Content (Join-Path $wd 'cwd.txt') -ErrorAction SilentlyContinue
    Check 'start: working directory' ($cwd -eq $wd) "$cwd"
    Start-Sleep -Milliseconds 500
    Check 'start: output goes to the log' ((Get-Content $cfg.LogPath -Raw -ErrorAction SilentlyContinue) -match "dummy listening on $Port")
    Check 'start: PID file written' (Test-Path $cfg.PidFile)
    $s = Get-ServerState -Config $cfg
    $tree = @(Get-ProcessTree -RootPid $s.RootPid)
    Check 'status: root is the started process' ($s.RootPid -eq $r.Pid) "root=$($s.RootPid) started=$($r.Pid)"
    Check 'tree: root + server + its child' ($tree.Count -ge 3 -and $tree -contains $s.ListenerPid) ($tree -join ',')
    Check 'start again: no second copy' ((Start-Server -Config $cfg).Note -like 'already*')

    $x = Stop-Server -Config $cfg
    Check 'stop: port free, status stopped' ($x.Ok -and -not (Get-ListenerPid $Port))
    Check 'stop: whole tree gone' (-not @($tree | Where-Object { Alive $_ }).Count) (@($tree | Where-Object { Alive $_ }) -join ',')
    Check 'stop: killed only the tree' (-not @($x.Killed | Where-Object { $tree -notcontains $_ }).Count) ($x.Killed -join ',')
    Check 'stop: bystanders alive' ((Alive $by1.Id) -and (Alive $by2.Id) -and [bool](Get-ListenerPid ($Port - 1)))
    Check 'stop: PID file removed' (-not (Test-Path $cfg.PidFile))

    # Started outside the tray (like start-background.vbs or the login task): found
    # by command line, no PID file.
    $ext = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList "/d /c `"`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$dummy`" -Port $Port -Out cwd.txt`"" -WorkingDirectory $wd -WindowStyle Hidden -PassThru
    [void]$mine.Add($ext.Id)
    WaitPort $true
    $s2 = Get-ServerState -Config $cfg
    Check 'external start: running, root = its cmd wrapper' ($s2.Status -eq 'Running' -and $s2.RootPid -eq $ext.Id) "root=$($s2.RootPid) cmd=$($ext.Id)"
    $r2 = Restart-Server -Config $cfg
    [void]$mine.Add($r2.Pid)
    Check 'restart: old tree gone, new one running' ($r2.Ok -and -not (Alive $ext.Id) -and (Get-ServerState -Config $cfg).Status -eq 'Running')
    [void](Stop-Server -Config $cfg)

    # Something else on the port: reported, never killed.
    $foreign = Start-Process -FilePath $ps -ArgumentList "-NoProfile -Command `$l=New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback,$Port);`$l.Start();Start-Sleep 600" -WindowStyle Hidden -PassThru
    [void]$mine.Add($foreign.Id)
    WaitPort $true
    Check 'foreign: reported as another program' ((Get-ServerState -Config $cfg).Status -eq 'Foreign')
    $cfg.StopTimeoutSec = 2; [void](Stop-Server -Config $cfg); $cfg.StopTimeoutSec = 15
    Check 'foreign: stop leaves it alone' (Alive $foreign.Id)
    Check 'foreign: start refuses' (-not (Start-Server -Config $cfg -NoWait).Ok)
    Stop-Process -Id $foreign.Id -Force
    WaitPort $false

    if ($TrayLaunch) {
        $vbs = Join-Path $PSScriptRoot 'Tray.vbs'
        & wscript.exe $vbs $cfgPath; Start-Sleep 2; & wscript.exe $vbs $cfgPath
        Start-Sleep 10
        $trays = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('Tray.ps1') -and $_.CommandLine.Contains($cfgPath) })
        Check 'tray: exactly one instance (mutex)' ($trays.Count -eq 1) "count=$($trays.Count)"
        Check 'tray: started the server at launch' ((Get-ServerState -Config $cfg).Status -eq 'Running')
        foreach ($t in $trays) { Stop-Process -Id $t.ProcessId -Force }  # exit the test tray (its own PID only)
        [void](Stop-Server -Config $cfg)
    }
} finally {
    foreach ($id in $mine) {
        if (-not $id) { continue }
        $t = @(Get-ProcessTree -RootPid $id); [array]::Reverse($t)
        foreach ($k in $t) { Stop-Process -Id $k -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 500
    Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
Write-Output ("{0} failure(s)" -f $fail)
exit $fail
