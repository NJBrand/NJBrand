<#
  NJMonitor agent. Runs every few minutes as SYSTEM (via Scheduled Task), collects health data and
  posts it to the monitor server. READ-ONLY: it changes nothing on the computer.

  Test it by hand (elevated PowerShell):   .\NJMonitor-Agent.ps1 -DryRun
  That prints the report it would send, without sending it.
#>
[CmdletBinding()]
param(
  [string]$ConfigPath = "$env:ProgramData\NJMonitor\agent.json",
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$AgentVersion = '0.1.0'
$StateDir = Split-Path $ConfigPath
$WatchFile = Join-Path $StateDir 'watch.json'
$StateFile = Join-Path $StateDir 'state.json'
$LogFile = Join-Path $StateDir 'agent.log'

function Write-Log([string]$msg) {
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) { Move-Item $LogFile "$LogFile.old" -Force }
    Add-Content -Path $LogFile -Value "$(Get-Date -Format s) $msg"
  } catch { }
  if ($DryRun) { Write-Host $msg }
}

function Read-Json([string]$path, $default) {
  if (Test-Path $path) { try { return Get-Content $path -Raw | ConvertFrom-Json } catch { } }
  return $default
}

function Iso($dt) { if ($null -eq $dt) { return $null } ; return ([datetime]$dt).ToUniversalTime().ToString('o') }

# Each collector is isolated: one failing check must never stop the report.
function Try-Collect([string]$name, [scriptblock]$block) {
  try { return & $block } catch { Write-Log "collector $name failed: $($_.Exception.Message)"; return $null }
}

$config = Read-Json $ConfigPath $null
if (-not $config -and -not $DryRun) { Write-Log "No config at $ConfigPath. Run Install-Agent.ps1."; exit 1 }
$watch = Read-Json $WatchFile ([pscustomobject]@{ services = @(); eventChecks = @(); fileChecks = @() })
$state = Read-Json $StateFile ([pscustomobject]@{ lastShutdownScan = $null; updatesCheckedAt = $null; updates = $null })

$os = Get-CimInstance Win32_OperatingSystem
$report = [ordered]@{
  agentVersion = $AgentVersion
  hostname     = $env:COMPUTERNAME
  ts           = Iso (Get-Date)
  osCaption    = $os.Caption
  osBuild      = $os.BuildNumber
  bootTime     = Iso $os.LastBootUpTime
}

# ---- CPU: average of 5 samples over ~8 s (perf class names are not localized, unlike Get-Counter paths)
$report.cpuPercent = Try-Collect 'cpu' {
  $samples = 1..5 | ForEach-Object {
    (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
    if ($_ -lt 5) { Start-Sleep -Seconds 2 }
  }
  [math]::Round(($samples | Measure-Object -Average).Average, 1)
}

# ---- Memory
$report.memoryPercent = Try-Collect 'memory' {
  [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100, 1)
}

# ---- Fixed disks
$report.disks = @(Try-Collect 'disks' {
  Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 } | ForEach-Object {
    [ordered]@{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB, 2); freeGB = [math]::Round($_.FreeSpace / 1GB, 2) }
  }
})

# ---- Watched services (list comes from the server)
$report.services = @(Try-Collect 'services' {
  foreach ($name in @($watch.services)) {
    if (-not $name) { continue }
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc) { [ordered]@{ name = $name; displayName = $svc.DisplayName; status = "$($svc.Status)"; startType = "$($svc.StartType)" } }
    else { [ordered]@{ name = $name; status = 'NotFound' } }
  }
})

# ---- Unexpected shutdowns since the last scan
#   41   Kernel-Power: rebooted without cleanly shutting down (power loss, crash, hard power-off)
#   6008 EventLog: the previous system shutdown was unexpected
$scanFrom = if ($state.lastShutdownScan) { [datetime]$state.lastShutdownScan } else { (Get-Date).AddDays(-1) }
$scanTo = Get-Date
$report.shutdowns = @(Try-Collect 'shutdowns' {
  Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 6008; StartTime = $scanFrom } -ErrorAction SilentlyContinue |
    Where-Object { ($_.Id -eq 41 -and $_.ProviderName -eq 'Microsoft-Windows-Kernel-Power') -or ($_.Id -eq 6008 -and $_.ProviderName -eq 'EventLog') } |
    ForEach-Object { [ordered]@{ time = Iso $_.TimeCreated; id = $_.Id; provider = $_.ProviderName } }
})

# ---- Windows Update (slow: query at most every 6 hours, cache the result)
$needUpdateScan = -not $state.updatesCheckedAt -or ((Get-Date) - [datetime]$state.updatesCheckedAt).TotalHours -ge 6
$rebootRequired = Try-Collect 'reboot' {
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
  (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
}
if ($needUpdateScan) {
  $updates = [ordered]@{ checkedAt = Iso (Get-Date) }
  try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $result = $session.CreateUpdateSearcher().Search("IsInstalled=0 and Type='Software' and IsHidden=0")
    $list = @($result.Updates)
    $updates.pendingCount = $list.Count
    $updates.securityCount = @($list | Where-Object { $_.MsrcSeverity -in 'Critical', 'Important' -or ($_.Categories | Where-Object { $_.Name -eq 'Security Updates' }) }).Count
    $updates.titles = @($list | Select-Object -First 10 | ForEach-Object { $_.Title })
  } catch {
    $updates.error = $_.Exception.Message
  }
  try {
    $last = (New-Object -ComObject Microsoft.Update.AutoUpdate).Results.LastInstallationSuccessDate
    $updates.lastInstallSuccess = if ($last -and ([datetime]$last).Year -gt 2000) { Iso $last } else { $null }
  } catch { }
  $state.updates = $updates
  $state.updatesCheckedAt = (Get-Date).ToString('o')  # ISO string: PS 5.1 can't parse its own DateTime JSON
}
if ($state.updates) {
  $u = [ordered]@{}
  $state.updates.PSObject.Properties | ForEach-Object { $u[$_.Name] = $_.Value }
  $u.rebootRequired = [bool]$rebootRequired
  $report.updates = $u
}

# ---- Backup checks: event-log based (most backup tools log success/failure events)
$report.eventChecks = @(foreach ($c in @($watch.eventChecks)) {
  if (-not $c.name) { continue }
  try {
    $lookback = if ($c.lookbackHours) { [double]$c.lookbackHours } else { 168 }
    $since = (Get-Date).AddHours(-$lookback)
    $base = @{ LogName = $c.logName; StartTime = $since }
    if ($c.providerName) { $base.ProviderName = $c.providerName }
    $ok = if (@($c.successIds).Count) { Get-WinEvent -FilterHashtable ($base + @{ Id = @($c.successIds) }) -MaxEvents 1 -ErrorAction SilentlyContinue } else { $null }
    $bad = if (@($c.failureIds).Count) { Get-WinEvent -FilterHashtable ($base + @{ Id = @($c.failureIds) }) -MaxEvents 1 -ErrorAction SilentlyContinue } else { $null }
    [ordered]@{
      name           = $c.name
      lastSuccess    = if ($ok) { Iso $ok.TimeCreated } else { $null }
      lastFailure    = if ($bad) { Iso $bad.TimeCreated } else { $null }
      failureMessage = if ($bad) { ($bad.Message -split "`n")[0] } else { $null }
    }
  } catch {
    [ordered]@{ name = $c.name; error = $_.Exception.Message }
  }
})

# ---- Backup checks: newest file in a folder (for tools that just write files)
$report.fileChecks = @(foreach ($c in @($watch.fileChecks)) {
  if (-not $c.name) { continue }
  try {
    if (-not (Test-Path $c.path)) { [ordered]@{ name = $c.name; error = "Path not found: $($c.path)" }; continue }
    $newest = Get-ChildItem -Path $c.path -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    [ordered]@{ name = $c.name; newest = if ($newest) { Iso $newest.LastWriteTime } else { $null } }
  } catch {
    [ordered]@{ name = $c.name; error = $_.Exception.Message }
  }
})

$json = $report | ConvertTo-Json -Depth 6 -Compress

if ($DryRun) {
  $report | ConvertTo-Json -Depth 6
  exit 0
}

# ---- Send
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $resp = Invoke-RestMethod -Method Post -Uri ("{0}/api/agent/checkin" -f $config.serverUrl.TrimEnd('/')) -TimeoutSec 30 `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
    -Headers @{ Authorization = "Bearer $($config.token)"; 'X-Device-Id' = $config.deviceId }
  if ($resp.watch) { $resp.watch | ConvertTo-Json -Depth 6 | Set-Content -Path $WatchFile -Encoding UTF8 }
  # Only advance the shutdown scan window after a successful send, so events are never lost.
  $state.lastShutdownScan = $scanTo.ToString('o')
} catch {
  Write-Log "send failed: $($_.Exception.Message)"
}
$state | ConvertTo-Json -Depth 6 | Set-Content -Path $StateFile -Encoding UTF8
