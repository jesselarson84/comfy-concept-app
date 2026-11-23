# TrayCore.psm1 - start / stop / status for ONE local server, used by Tray.ps1.
# PowerShell 5.1, no modules beyond what ships with Windows.
#
# How the server is found (never by process name):
#   1. the process LISTENING on Port whose command line contains every string in
#      ServerMatch (tokens {wd} = WorkingDirectory, {exe} = Exe, full paths);
#   2. its "root": walking up the parents, every ancestor whose command line contains
#      all strings of one Ancestors entry belongs to the server too (cmd /c wrapper,
#      launcher script, Gradle wrapper). The highest such ancestor is the root, except
#      entries marked passThrough (e.g. a Gradle daemon), which are never the root.
#   3. or the PID file written by Start-Server (checked: alive, same start time).
# Stop kills exactly the root and its descendants (by ParentProcessId, started
# after the root, so a reused PID is never hit), children first. Nothing else.

Set-StrictMode -Version 2

function Expand-TrayValue([string]$s, $cfg) {
    if ($null -eq $s) { return $s }
    $s = [Environment]::ExpandEnvironmentVariables($s)
    $s = $s.Replace('{wd}', [string]$cfg.WorkingDirectory).Replace('{exe}', [string]$cfg.Exe)
    return $s
}

function Get-TrayConfig {
    param([Parameter(Mandatory)][string]$Path)
    $base = Split-Path -Parent (Resolve-Path $Path)
    $raw = Get-Content -Raw -Path $Path | ConvertFrom-Json
    $cfg = [ordered]@{
        Name = 'Server'; Port = 0; WorkingDirectory = '.'; Exe = ''; Args = ''; LogPath = ''
        PidFile = ''; Task = ''; ServerMatch = @(); Ancestors = @(); Mutex = ''
        PollSeconds = 3; StartTimeoutSec = 90; StopTimeoutSec = 20
        StartServerOnLaunch = $true; LaunchGraceSec = 30
    }
    foreach ($p in $raw.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    # Relative paths are relative to the config file's folder.
    $wd = [Environment]::ExpandEnvironmentVariables([string]$cfg.WorkingDirectory)
    if (-not [IO.Path]::IsPathRooted($wd)) { $wd = Join-Path $base $wd }
    $cfg.WorkingDirectory = [IO.Path]::GetFullPath($wd)
    $exe = Expand-TrayValue $cfg.Exe $cfg
    if ($exe -and -not [IO.Path]::IsPathRooted($exe) -and (Test-Path (Join-Path $cfg.WorkingDirectory $exe))) { $exe = Join-Path $cfg.WorkingDirectory $exe }
    $cfg.Exe = $exe
    foreach ($k in 'Args', 'LogPath', 'PidFile') { $cfg[$k] = Expand-TrayValue $cfg[$k] $cfg }
    foreach ($k in 'LogPath', 'PidFile') { if ($cfg[$k] -and -not [IO.Path]::IsPathRooted($cfg[$k])) { $cfg[$k] = Join-Path $cfg.WorkingDirectory $cfg[$k] } }
    $cfg.ServerMatch = @($cfg.ServerMatch | ForEach-Object { Expand-TrayValue $_ $cfg })
    $cfg.Ancestors = @($cfg.Ancestors | ForEach-Object {
        [pscustomobject]@{ all = @($_.all | ForEach-Object { Expand-TrayValue $_ $cfg }); passThrough = [bool]($_.PSObject.Properties['passThrough'] -and $_.passThrough) }
    })
    if (-not $cfg.Mutex) { $cfg.Mutex = 'Local\Tray-' + ($cfg.Name -replace '[^A-Za-z0-9]', '') }
    return [pscustomobject]$cfg
}

function Test-CmdLine([string]$cmd, [string[]]$all) {
    if (-not $cmd -or -not $all -or $all.Count -eq 0) { return $false }
    foreach ($s in $all) { if ($cmd.IndexOf($s, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false } }
    return $true
}

function Get-ProcTable { @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine, CreationDate) }

function Get-ListenerPid([int]$Port) {
    $c = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($c.Count) { return [int]$c[0].OwningProcess } else { return $null }
}

function Get-ServerState {
    param([Parameter(Mandatory)]$Config, $Procs = $null)
    if (-not $Procs) { $Procs = Get-ProcTable }
    $byId = @{}; foreach ($p in $Procs) { $byId[[int]$p.ProcessId] = $p }
    $lp = Get-ListenerPid $Config.Port
    $state = [pscustomobject]@{ Status = 'Stopped'; ListenerPid = $lp; RootPid = $null; Detail = '' }
    if ($lp) {
        $l = $byId[$lp]
        if (-not $l -or -not (Test-CmdLine $l.CommandLine $Config.ServerMatch)) {
            $state.Status = 'Foreign'; $state.Detail = "port $($Config.Port) is used by another program (PID $lp)"; return $state
        }
        $state.Status = 'Running'
        $root = $l; $cur = $l
        for ($i = 0; $i -lt 16; $i++) {
            $par = $byId[[int]$cur.ParentProcessId]
            if (-not $par -or $par.CreationDate -gt $cur.CreationDate) { break }
            $m = @($Config.Ancestors | Where-Object { Test-CmdLine $par.CommandLine $_.all })
            if (-not $m.Count) { break }
            if (@($m | Where-Object { -not $_.passThrough }).Count) { $root = $par }
            $cur = $par
        }
        $state.RootPid = [int]$root.ProcessId
        return $state
    }
    # Not listening (yet): still "Starting" while the PID file's process is alive.
    $pf = Read-PidFile $Config $byId
    if ($pf) { $state.Status = 'Starting'; $state.RootPid = $pf }
    return $state
}

function Read-PidFile($Config, $byId) {
    if (-not $Config.PidFile -or -not (Test-Path $Config.PidFile)) { return $null }
    $parts = (Get-Content -Raw $Config.PidFile).Trim() -split '\s+'
    $id = 0; if (-not [int]::TryParse($parts[0], [ref]$id)) { return $null }
    $p = $byId[$id]
    if (-not $p) { return $null }
    if ($parts.Count -gt 1 -and $p.CreationDate.ToUniversalTime().Ticks -ne [long]$parts[1]) { return $null } # PID reused
    return $id
}

function Get-ProcessTree {
    param([Parameter(Mandatory)][int]$RootPid, $Procs = $null)
    if (-not $Procs) { $Procs = Get-ProcTable }
    $byId = @{}; foreach ($p in $Procs) { $byId[[int]$p.ProcessId] = $p }
    $root = $byId[$RootPid]; if (-not $root) { return @() }
    $kids = @{}
    foreach ($p in $Procs) { $pp = [int]$p.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }; [void]$kids[$pp].Add($p) }
    $out = New-Object System.Collections.ArrayList
    $queue = New-Object System.Collections.Queue; $queue.Enqueue($root)
    while ($queue.Count) {
        $cur = $queue.Dequeue(); [void]$out.Add([int]$cur.ProcessId)
        if ($kids.ContainsKey([int]$cur.ProcessId)) {
            foreach ($k in $kids[[int]$cur.ProcessId]) { if ($k.ProcessId -ne $cur.ProcessId -and $k.CreationDate -ge $cur.CreationDate) { $queue.Enqueue($k) } }
        }
    }
    return @($out)  # root first, deepest last
}

function Wait-TrayCondition([scriptblock]$Cond, [int]$Seconds) {
    $t = [Diagnostics.Stopwatch]::StartNew()
    while ($t.Elapsed.TotalSeconds -lt $Seconds) { if (& $Cond) { return $true }; Start-Sleep -Milliseconds 300 }
    return [bool](& $Cond)
}

function Test-TaskAvailable($Config) {
    if (-not $Config.Task) { return $false }
    return [bool](Get-ScheduledTask -TaskName $Config.Task -ErrorAction SilentlyContinue)
}

function Stop-Server {
    param([Parameter(Mandatory)]$Config)
    $killed = @()
    if (Test-TaskAvailable $Config) {
        $t = Get-ScheduledTask -TaskName $Config.Task
        if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskName $Config.Task }  # ends the task's run; its definition is untouched
        [void](Wait-TrayCondition { -not (Get-ListenerPid $Config.Port) } 5)
    }
    $s = Get-ServerState -Config $Config
    if ($s.RootPid) {
        $tree = Get-ProcessTree -RootPid $s.RootPid
        [array]::Reverse($tree)  # children first
        foreach ($id in $tree) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue; $killed += $id }
    }
    $ok = Wait-TrayCondition { (Get-ServerState -Config $Config).Status -in 'Stopped', 'Foreign' } $Config.StopTimeoutSec
    if ($Config.PidFile -and (Test-Path $Config.PidFile)) { Remove-Item $Config.PidFile -Force -ErrorAction SilentlyContinue }
    return [pscustomobject]@{ Ok = $ok; Killed = $killed }
}

function Start-Server {
    param([Parameter(Mandatory)]$Config, [switch]$NoWait)
    $s = Get-ServerState -Config $Config
    if ($s.Status -eq 'Running' -or $s.Status -eq 'Starting') { return [pscustomobject]@{ Ok = $true; Pid = $s.RootPid; Note = 'already ' + $s.Status.ToLower() } }
    if ($s.Status -eq 'Foreign') { return [pscustomobject]@{ Ok = $false; Pid = $null; Note = $s.Detail } }
    if (Test-TaskAvailable $Config) {
        Start-ScheduledTask -TaskName $Config.Task  # same launcher, env and key handling as at login
        $id = $null; $note = "started task '$($Config.Task)'"
    } else {
        if ($Config.LogPath) { $ld = Split-Path -Parent $Config.LogPath; if ($ld -and -not (Test-Path $ld)) { New-Item -ItemType Directory -Path $ld | Out-Null } }
        $line = '"' + $Config.Exe + '" ' + $Config.Args
        if ($Config.LogPath) { $line += ' >> "' + $Config.LogPath + '" 2>&1' }
        # cmd /c "<line>": the outer quotes are stripped by cmd, the rest runs as typed.
        $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList ('/d /c "' + $line + '"') -WorkingDirectory $Config.WorkingDirectory -WindowStyle Hidden -PassThru
        $id = $p.Id; $note = "started PID $id"
        if ($Config.PidFile) {
            $cp = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
            $pd = Split-Path -Parent $Config.PidFile; if ($pd -and -not (Test-Path $pd)) { New-Item -ItemType Directory -Path $pd | Out-Null }
            Set-Content -Path $Config.PidFile -Value ("$id " + $cp.CreationDate.ToUniversalTime().Ticks) -Encoding ascii
        }
    }
    if ($NoWait) { return [pscustomobject]@{ Ok = $true; Pid = $id; Note = $note } }
    $ok = Wait-TrayCondition { (Get-ServerState -Config $Config).Status -eq 'Running' } $Config.StartTimeoutSec
    return [pscustomobject]@{ Ok = $ok; Pid = $id; Note = $note }
}

function Restart-Server {
    param([Parameter(Mandatory)]$Config)
    $r = Stop-Server -Config $Config
    if (-not $r.Ok) { return [pscustomobject]@{ Ok = $false; Pid = $null; Note = 'stop did not finish' } }
    return Start-Server -Config $Config
}

Export-ModuleMember -Function Get-TrayConfig, Get-ServerState, Get-ProcessTree, Get-ListenerPid, Start-Server, Stop-Server, Restart-Server, Test-CmdLine
