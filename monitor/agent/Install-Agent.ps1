<#
  Installs (or updates) the NJMonitor agent on this PC. Run in an elevated PowerShell:

    powershell -ExecutionPolicy Bypass -File .\Install-Agent.ps1 -ServerUrl http://192.168.1.10:8090 -DeviceId front-desk-1 -Token <token>

  Get the token on the monitor server with:  npm run token -- front-desk-1
  Uninstall:  .\Install-Agent.ps1 -Uninstall
#>
[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
  [Parameter(ParameterSetName = 'Install', Mandatory)] [string]$ServerUrl,
  [Parameter(ParameterSetName = 'Install', Mandatory)] [string]$DeviceId,
  [Parameter(ParameterSetName = 'Install', Mandatory)] [string]$Token,
  [Parameter(ParameterSetName = 'Install')] [int]$IntervalMinutes = 5,
  [Parameter(ParameterSetName = 'Uninstall')] [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$TaskName = 'NJMonitor Agent'
$Dir = "$env:ProgramData\NJMonitor"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this from an elevated (Administrator) PowerShell.' }

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'NJMonitor agent removed.'
  exit 0
}

New-Item -ItemType Directory -Path $Dir -Force | Out-Null
# Lock the folder down: it holds this device's token. SYSTEM + Administrators only.
# Well-known SIDs, not names: "SYSTEM"/"Administrators" are localized on non-English Windows.
& icacls $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed to secure $Dir (exit $LASTEXITCODE)" }

Copy-Item -Path (Join-Path $PSScriptRoot 'NJMonitor-Agent.ps1') -Destination $Dir -Force
[ordered]@{ serverUrl = $ServerUrl.TrimEnd('/'); deviceId = $DeviceId; token = $Token } | ConvertTo-Json | Set-Content -Path "$Dir\agent.json" -Encoding UTF8

# Connectivity test before scheduling, so mistakes show up now rather than as a silent "offline" later.
Write-Host "Testing connection to $ServerUrl ..."
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$Dir\NJMonitor-Agent.ps1"
$exit = $LASTEXITCODE
$log = "$Dir\agent.log"
if ($exit -ne 0) {
  $last = if (Test-Path $log) { Get-Content $log -Tail 1 } else { '(no log written)' }
  Write-Warning "Check-in failed (exit $exit). Last log line: $last"
  Write-Warning 'Fix the server URL / token / firewall, then run this installer again.'
  exit 1
}
Write-Host 'Check-in succeeded.'

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\NJMonitor-Agent.ps1`""
$triggers = @(
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)),
  (New-ScheduledTaskTrigger -AtStartup)
)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$runAs = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $runAs -Force | Out-Null

Write-Host "Installed. '$TaskName' runs every $IntervalMinutes minutes as SYSTEM. Log: $log"
