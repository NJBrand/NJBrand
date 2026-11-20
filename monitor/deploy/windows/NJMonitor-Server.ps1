<#
  Runs the NJMonitor server on an always-on Windows PC. Run every command from an elevated PowerShell:

    powershell -ExecutionPolicy Bypass -File .\NJMonitor-Server.ps1 install          # first time, and to update
    powershell -ExecutionPolicy Bypass -File .\NJMonitor-Server.ps1 token front-desk-1
    powershell -ExecutionPolicy Bypass -File .\NJMonitor-Server.ps1 status
    ... restart | stop | start | check-config | unifi-test | logs | uninstall

  What install does:
    - copies the server into C:\ProgramData\NJMonitor-Server\app (locked to SYSTEM + Administrators,
      because it runs as SYSTEM: a user-writable copy would let any user run code as SYSTEM)
    - creates config.json (from the example) and server.env (admin password, port, paths) if missing,
      and never overwrites them on later installs
    - opens the port in Windows Firewall for the local subnet only
    - registers the "NJMonitor Server" scheduled task: starts at boot as SYSTEM, and re-checks every
      5 minutes, so the server comes back by itself if it ever stops
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'update', 'uninstall', 'start', 'stop', 'restart', 'status', 'token', 'check-config', 'unifi-test', 'logs')]
  [string]$Action = 'status',
  [Parameter(Position = 1)] [string]$DeviceId,
  [int]$Port = 8090
)
$ErrorActionPreference = 'Stop'
$TaskName = 'NJMonitor Server'
$Root = "$env:ProgramData\NJMonitor-Server"
$App = "$Root\app"
$Data = "$Root\data"
$Config = "$Root\config.json"
$EnvFile = "$Root\server.env"
$Log = "$Root\server.log"
$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path   # the monitor\ folder

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an elevated (Administrator) PowerShell.' }

function Find-Node {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  $node = if ($cmd) { $cmd.Source } elseif (Test-Path "$env:ProgramFiles\nodejs\node.exe") { "$env:ProgramFiles\nodejs\node.exe" } else { $null }
  if (-not $node) { throw 'Node.js not found. Install the LTS version (22.13 or newer) from https://nodejs.org, then run this again.' }
  $v = [version](& $node -p 'process.versions.node')
  if ($v -lt [version]'22.13.0') { throw "Node.js $v is too old; 22.13 or newer is needed (built-in SQLite). Install the current LTS from https://nodejs.org." }
  return $node
}

function Read-EnvFile {
  $vars = @{}
  if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') { $vars[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $vars
}

function Get-LanUrl {
  $vars = Read-EnvFile
  $p = if ($vars.PORT) { $vars.PORT } else { $Port }
  $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.PrefixOrigin -in 'Dhcp', 'Manual' } |
    Sort-Object InterfaceMetric | Select-Object -First 1 -ExpandProperty IPAddress
  if (-not $ip) { $ip = $env:COMPUTERNAME }
  return "http://${ip}:$p"
}

# Run server\cli.js with the same config/data the service uses.
function Invoke-Cli([string[]]$cliArgs) {
  $node = Find-Node
  $vars = Read-EnvFile
  $env:CONFIG = $Config
  $env:DATA_DIR = $Data
  $env:SERVER_URL = Get-LanUrl
  if ($vars.TZ) { $env:TZ = $vars.TZ }
  & $node --disable-warning=ExperimentalWarning "$App\server\cli.js" @cliArgs
  if ($LASTEXITCODE -ne 0) { throw "cli.js $($cliArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

function Test-Server {
  $vars = Read-EnvFile
  $p = if ($vars.PORT) { $vars.PORT } else { $Port }
  try { return (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$p/" -TimeoutSec 3).StatusCode -eq 200 } catch { return $false }
}

function Wait-Server([int]$seconds = 20) {
  for ($i = 0; $i -lt $seconds; $i++) { if (Test-Server) { return $true }; Start-Sleep -Seconds 1 }
  return $false
}

function Show-LogTail { if (Test-Path $Log) { Write-Host "--- last lines of $Log ---"; Get-Content $Log -Tail 15 } }

switch ($Action) {
  { $_ -in 'install', 'update' } {
    $node = Find-Node
    Write-Host "Node.js $(& $node -p 'process.versions.node') at $node"

    New-Item -ItemType Directory -Path $Root, $Data -Force | Out-Null
    # SYSTEM + Administrators only (well-known SIDs, so this works on non-English Windows).
    & icacls $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed to secure $Root (exit $LASTEXITCODE)" }

    $wasRunning = (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue).State -eq 'Running'
    if ($wasRunning) { Stop-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 2 }

    # Fresh copy of the code; config, data and secrets live outside app\ and are never touched.
    if (Test-Path $App) { Remove-Item $App -Recurse -Force }
    New-Item -ItemType Directory -Path $App -Force | Out-Null
    foreach ($item in 'server', 'public', 'package.json', 'config.example.json') { Copy-Item -Path (Join-Path $Source $item) -Destination $App -Recurse -Force }
    Write-Host "Server files copied to $App"

    $newConfig = -not (Test-Path $Config)
    if ($newConfig) {
      # A starter config with no devices, so nothing is probed or alerted until you add your own.
      # (config.example.json, copied to app\, has a full example of every option.)
      $ianaZones = @{
        'Eastern Standard Time' = 'America/New_York'; 'Central Standard Time' = 'America/Chicago'
        'Mountain Standard Time' = 'America/Denver'; 'US Mountain Standard Time' = 'America/Phoenix'
        'Pacific Standard Time' = 'America/Los_Angeles'; 'Alaskan Standard Time' = 'America/Anchorage'
        'Hawaiian Standard Time' = 'Pacific/Honolulu'; 'Atlantic Standard Time' = 'America/Halifax'
        'GMT Standard Time' = 'Europe/London'; 'AUS Eastern Standard Time' = 'Australia/Sydney'
      }
      $tz = $ianaZones[(Get-TimeZone).Id]
      if (-not $tz) { $tz = 'UTC'; Write-Warning "Unknown time zone '$((Get-TimeZone).Id)': set ""timezone"" in config.json (e.g. America/Chicago)." }
      $starter = @"
{
  "timezone": "$tz",

  "devices": [
  ],

  "notifications": {
    "ntfy": { "server": "https://ntfy.sh", "topic": "CHANGE-ME-to-a-long-random-string", "token": null },
    "digestTime": "07:30"
  },

  "unifi": null,

  "maintenance": [
    { "id": "physical-clean", "name": "Clean dust from fans and vents", "intervalDays": 180 }
  ]
}
"@
      [IO.File]::WriteAllText($Config, $starter, (New-Object Text.UTF8Encoding($false)))
      Write-Host "Created a starter $Config (no devices yet, time zone $tz)."
    }

    if (-not (Test-Path $EnvFile)) {
      $bytes = New-Object byte[] 18
      [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $password = [Convert]::ToBase64String($bytes)
      $lines = @(
        '# NJMonitor server settings. Restart the server after changing:  NJMonitor-Server.ps1 restart',
        "ADMIN_PASSWORD=$password",
        "PORT=$Port",
        "CONFIG=$Config",
        "DATA_DIR=$Data",
        "LOG_FILE=$Log",
        '# The dashboard is plain HTTP on the office LAN, so login cookies cannot be HTTPS-only.',
        '# Remove this line if you put the dashboard behind HTTPS (e.g. Tailscale serve).',
        'INSECURE_COOKIES=1'
      )
      # No BOM: Node would read it as part of the first variable name.
      [IO.File]::WriteAllLines($EnvFile, $lines, (New-Object Text.UTF8Encoding($false)))
      Write-Host ''
      Write-Host "Dashboard admin password: $password" -ForegroundColor Yellow
      Write-Host "Write it down. It is also stored in $EnvFile (readable by Administrators only)." -ForegroundColor Yellow
      Write-Host ''
    }
    $vars = Read-EnvFile
    $Port = [int]$vars.PORT

    Write-Host 'Checking config ...'
    Invoke-Cli @('check-config')

    # Firewall: only devices on the same subnet can reach the server.
    Get-NetFirewallRule -Name 'NJMonitor-Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name 'NJMonitor-Server' -DisplayName 'NJMonitor Server' -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $Port -RemoteAddress LocalSubnet -Program $node -Profile Any | Out-Null
    Write-Host "Firewall: TCP $Port allowed from the local subnet."

    $action = New-ScheduledTaskAction -Execute $node -WorkingDirectory $App `
      -Argument "--env-file=`"$EnvFile`" --disable-warning=ExperimentalWarning `"$App\server\server.js`""
    # At boot, plus every 5 minutes as a watchdog: IgnoreNew means a running server is left alone,
    # and a stopped one is started again.
    $triggers = @(
      (New-ScheduledTaskTrigger -AtStartup),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5))
    )
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
      -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    $runAs = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $runAs -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    if (-not (Wait-Server)) { Show-LogTail; throw 'The server did not start. See the log above.' }
    Write-Host ''
    Write-Host "NJMonitor server is running. Dashboard: $(Get-LanUrl)" -ForegroundColor Green
    Write-Host "Log: $Log"

    # The server has to stay awake to send alerts.
    # (English Windows only: the powercfg text is localized; elsewhere this check is silently skipped.)
    $acSleep = (& powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE) | Out-String
    if ($acSleep -match 'Current AC Power Setting Index: (0x[0-9a-f]+)' -and [Convert]::ToInt32($Matches[1], 16) -gt 0) {
      Write-Warning 'This PC is set to sleep when idle. Set "Sleep" to Never (Settings > System > Power), or alerts stop while it sleeps.'
    }
    if ($newConfig) { Write-Host 'Next: follow INSTALL.md from "Part 3" (phone alerts), then add your devices.' }
  }

  'uninstall' {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Get-NetFirewallRule -Name 'NJMonitor-Server' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    if (Test-Path $App) { Remove-Item $App -Recurse -Force }
    Write-Host "Server removed. Config, data and history are kept in $Root (delete that folder to remove them too)."
  }

  'start' { Start-ScheduledTask -TaskName $TaskName; if (Wait-Server) { Write-Host 'Running.' } else { Show-LogTail; throw 'Did not start.' } }
  'stop' { Stop-ScheduledTask -TaskName $TaskName; Write-Host 'Stopped. (The 5-minute watchdog starts it again; use uninstall to stop it for good.)' }
  'restart' {
    # Check first: a typo in config.json must not take down a running server.
    Write-Host 'Checking config ...'
    try { Invoke-Cli @('check-config') } catch { throw "config.json has a problem (see above). The server was NOT restarted and is still running the old config." }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $TaskName
    if (Wait-Server) { Write-Host 'Restarted.' } else { Show-LogTail; throw 'Did not start.' }
  }

  'status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { Write-Host 'Not installed. Run:  NJMonitor-Server.ps1 install'; break }
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "Task:      $($task.State) (last run $($info.LastRunTime), result $($info.LastTaskResult))"
    Write-Host "Responds:  $(if (Test-Server) { 'yes' } else { 'NO' })"
    Write-Host "Dashboard: $(Get-LanUrl)"
    Write-Host "Config:    $Config"
    Write-Host "Log:       $Log"
  }

  'token' {
    if (-not $DeviceId) { throw 'Usage: NJMonitor-Server.ps1 token <device-id>   (the device must be in config.json; restart after adding it)' }
    Invoke-Cli @('token', $DeviceId)
  }
  'check-config' { Invoke-Cli @('check-config') }
  'unifi-test' { Invoke-Cli @('unifi-test') }
  'logs' { if (Test-Path $Log) { Get-Content $Log -Tail 50 } else { Write-Host "No log yet at $Log" } }
}
