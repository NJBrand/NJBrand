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
$AgentVersion = '0.2.0'
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
  # Return nothing (not $null) on failure: @(Try-Collect ...) then yields [] instead of [null], which the server can't read.
  try { return & $block } catch { Write-Log "collector $name failed: $($_.Exception.Message)"; return }
}

# Get-WinEvent throws when nothing matches. Treat that as "no events", but let real errors through
# (missing log/provider, access denied) so they show up instead of looking like "no backup found".
function Get-Events([hashtable]$filter, [int]$max = 0) {
  try {
    if ($max) { Get-WinEvent -FilterHashtable $filter -MaxEvents $max -ErrorAction Stop }
    else { Get-WinEvent -FilterHashtable $filter -ErrorAction Stop }
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { return }
    throw
  }
}

function To-Date($s) { if (-not $s) { return $null }; try { return [datetime]$s } catch { return $null } }

$config = Read-Json $ConfigPath $null
if (-not $config -and -not $DryRun) { Write-Log "No config at $ConfigPath. Run Install-Agent.ps1."; exit 1 }
$watch = Read-Json $WatchFile ([pscustomobject]@{ services = @(); eventChecks = @(); fileChecks = @() })
# Rebuild state with every field present, so an old or partial state.json can't break property assignment.
$saved = Read-Json $StateFile $null
$state = [pscustomobject]@{ lastShutdownScan = $saved.lastShutdownScan; updatesCheckedAt = $saved.updatesCheckedAt; updates = $saved.updates }

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
#   One crash usually logs BOTH, seconds apart. Report the 41 and drop a 6008 that has a 41 within 10 minutes,
#   checked against the whole log so a pair split across two check-ins still alerts once.
$scanFrom = To-Date $state.lastShutdownScan
if (-not $scanFrom) { $scanFrom = (Get-Date).AddDays(-1) }
$scanTo = Get-Date
$shutdownScanOk = $true
$report.shutdowns = @(try {
  Get-Events @{ LogName = 'System'; Id = 41, 6008; StartTime = $scanFrom; EndTime = $scanTo } |
    Where-Object { ($_.Id -eq 41 -and $_.ProviderName -eq 'Microsoft-Windows-Kernel-Power') -or ($_.Id -eq 6008 -and $_.ProviderName -eq 'EventLog') } |
    Where-Object {
      $_.Id -eq 41 -or -not (Get-Events @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Power'; Id = 41
          StartTime = $_.TimeCreated.AddMinutes(-10); EndTime = $_.TimeCreated.AddMinutes(10) } 1)
    } |
    ForEach-Object { [ordered]@{ time = Iso $_.TimeCreated; id = $_.Id; provider = $_.ProviderName } }
} catch {
  # Don't advance the scan window past events we failed to read.
  $shutdownScanOk = $false
  Write-Log "collector shutdowns failed: $($_.Exception.Message)"
})

# ---- Windows Update (slow: query at most every 6 hours, cache the result)
$lastUpdateScan = To-Date $state.updatesCheckedAt
$needUpdateScan = -not $lastUpdateScan -or -not $state.updates -or ((Get-Date) - $lastUpdateScan).TotalHours -ge 6
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
    # WUA returns this date in UTC but with Kind=Unspecified; ToUniversalTime() would shift it by the local offset.
    $updates.lastInstallSuccess = if ($last -and ([datetime]$last).Year -gt 2000) { Iso ([datetime]::SpecifyKind([datetime]$last, 'Utc')) } else { $null }
  } catch { }
  $state.updates = $updates
  $state.updatesCheckedAt = (Get-Date).ToString('o')  # ISO string: PS 5.1 can't parse its own DateTime JSON
}
if ($state.updates) {
  # Fresh scan: an ordered dictionary. Cached in state.json: a PSCustomObject. Copy keys from either.
  $u = [ordered]@{}
  if ($state.updates -is [System.Collections.IDictionary]) { foreach ($k in $state.updates.Keys) { $u[$k] = $state.updates[$k] } }
  else { $state.updates.PSObject.Properties | ForEach-Object { $u[$_.Name] = $_.Value } }
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
    $ok = if (@($c.successIds).Count) { Get-Events ($base + @{ Id = @($c.successIds) }) 1 } else { $null }
    $bad = if (@($c.failureIds).Count) { Get-Events ($base + @{ Id = @($c.failureIds) }) 1 } else { $null }
    [ordered]@{
      name           = $c.name
      lastSuccess    = if ($ok) { Iso $ok.TimeCreated } else { $null }
      lastFailure    = if ($bad) { Iso $bad.TimeCreated } else { $null }
      failureMessage = if ($bad) { ($bad.Message -split "\r?\n")[0].Trim() } else { $null }
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
$sent = $false
try {
  # Add TLS 1.2 without dropping whatever the OS already enables.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  # -UseBasicParsing: Windows 11 has no IE engine, and SYSTEM never ran IE first-run setup.
  $resp = Invoke-RestMethod -Method Post -Uri ("{0}/api/agent/checkin" -f $config.serverUrl.TrimEnd('/')) -TimeoutSec 30 -UseBasicParsing `
    -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($json)) `
    -Headers @{ Authorization = "Bearer $($config.token)"; 'X-Device-Id' = $config.deviceId }
  $sent = $true
  if ($resp.watch) { $resp.watch | ConvertTo-Json -Depth 6 | Set-Content -Path $WatchFile -Encoding UTF8 }
  # Only advance the shutdown scan window after a successful send, so events are never lost.
  if ($shutdownScanOk) { $state.lastShutdownScan = $scanTo.ToString('o') }
} catch {
  Write-Log "send failed: $($_.Exception.Message)"
}
$state | ConvertTo-Json -Depth 6 | Set-Content -Path $StateFile -Encoding UTF8
# Non-zero exit on a failed send: shows in Task Scheduler's "Last Run Result" and lets the installer test it.
if (-not $sent) { exit 2 }
exit 0
