// Pure rule engine: turns one agent report into a list of check results.
// No I/O and no clock reads, so it is easy to test and reason about.
//
// Each result: { key, ok, severity, confirm, title, issue, action }
//   key      stable id for the condition on this device (e.g. "disk:C:")
//   ok       false = condition is currently failing
//   severity critical | warning | routine (only meaningful when !ok)
//   confirm  how many consecutive failing reports are required before alerting
// Events (unexpected restarts) are returned separately: they happen once, they don't "clear".

export const SEVERITY_RANK = { ok: 0, routine: 1, warning: 2, critical: 3 };

const DAY = 86_400_000;
const HOUR = 3_600_000;

// Outage-type problems are Critical on business-critical devices, Routine (daily summary) on
// low-priority ones such as guest-room tablets, Warning elsewhere.
export function outageSeverity(device) {
  return device.priority === 'critical' ? 'critical' : device.priority === 'low' ? 'routine' : 'warning';
}

function pct(n) {
  return `${Math.round(n)}%`;
}

// Human-readable local time for alert text, e.g. "Nov 19, 6:26 PM".
function when(iso, tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return String(iso);
  return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t);
}

function daysAgo(now, iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (now - t) / DAY : Infinity;
}

export function evaluateReport(device, report, now) {
  const checks = [];
  const events = [];
  const interval = Math.max(1, device.checkinIntervalMinutes);

  // ---- Storage ----
  for (const d of Array.isArray(report.disks) ? report.disks : []) {
    if (!d || !(d.sizeGB > 0) || !(d.freeGB >= 0)) continue;
    const freePct = (d.freeGB / d.sizeGB) * 100;
    const { warnPercentFree, criticalPercentFree } = device.disk;
    const sev = freePct <= criticalPercentFree ? 'critical' : freePct <= warnPercentFree ? 'warning' : null;
    checks.push({
      key: `disk:${d.drive}`,
      ok: !sev,
      severity: sev || 'warning',
      confirm: 1,
      title: `Low disk space on ${d.drive}`,
      issue: `Drive ${d.drive} has ${d.freeGB.toFixed(1)} GB free of ${d.sizeGB.toFixed(0)} GB (${pct(freePct)} free)`,
      action: 'Clear temp files, empty Recycle Bin, move or archive large files, or add storage',
    });
  }

  // ---- Performance (must be sustained, not a momentary spike) ----
  for (const [metric, label] of [['cpu', 'CPU'], ['memory', 'Memory']]) {
    const value = metric === 'cpu' ? report.cpuPercent : report.memoryPercent;
    if (typeof value !== 'number') continue;
    const cfg = device[metric];
    checks.push({
      key: metric,
      ok: value < cfg.warnPercent,
      severity: 'warning',
      confirm: Math.max(1, Math.ceil(cfg.sustainedMinutes / interval)),
      title: `High ${label} usage`,
      issue: `${label} at ${pct(value)} for at least ${cfg.sustainedMinutes} minutes (threshold ${cfg.warnPercent}%)`,
      action: `Check Task Manager for the process using ${label}; restart the application or PC if it is stuck`,
    });
  }

  // ---- Critical Windows services ----
  const reported = new Map((Array.isArray(report.services) ? report.services : []).filter((s) => s && s.name).map((s) => [String(s.name).toLowerCase(), s]));
  for (const name of device.services) {
    const s = reported.get(name.toLowerCase());
    if (!s) continue; // agent hasn't picked up the watch list yet
    const missing = s.status === 'NotFound';
    checks.push({
      key: `service:${name.toLowerCase()}`,
      ok: s.status === 'Running',
      severity: outageSeverity(device),
      confirm: 2, // ignore a service caught mid-restart
      title: missing ? `Service not installed: ${s.displayName || name}` : `Service stopped: ${s.displayName || name}`,
      issue: missing ? `Required service "${name}" was not found on this computer` : `Required service "${s.displayName || name}" is ${s.status}`,
      action: missing ? 'Check the service name in the monitor config, or reinstall the application' : `Start the service (services.msc) and check the application's logs for why it stopped`,
    });
  }

  // ---- Windows Update ----
  const u = report.updates;
  if (u && typeof u === 'object') {
    if (u.error) {
      checks.push({
        key: 'updates:check', ok: false, severity: 'routine', confirm: 1,
        title: 'Windows Update check failing',
        issue: `Windows Update could not be queried: ${String(u.error).slice(0, 200)}`,
        action: 'Open Settings → Windows Update and run a manual check',
      });
    } else {
      checks.push({ key: 'updates:check', ok: true, severity: 'routine', confirm: 1 });
      const pending = Number(u.pendingCount) || 0;
      const security = Number(u.securityCount) || 0;
      checks.push({
        key: 'updates:pending',
        ok: pending === 0,
        severity: 'routine',
        confirm: 1,
        title: security ? `${security} security update(s) pending` : `${pending} Windows update(s) pending`,
        issue: `${pending} update(s) available${security ? `, ${security} of them security/critical` : ''}`,
        action: 'Install during the next maintenance window',
      });
      checks.push({
        key: 'updates:reboot',
        ok: !u.rebootRequired,
        severity: 'routine',
        confirm: 1,
        title: 'Restart required to finish updates',
        issue: 'Updates are installed but will not take effect until the computer restarts',
        action: 'Restart the computer outside business hours',
      });
      if (u.lastInstallSuccess !== undefined) {
        const age = daysAgo(now, u.lastInstallSuccess);
        const max = device.updates.maxDaysSinceInstall;
        checks.push({
          key: 'updates:stale',
          ok: age <= max,
          severity: 'warning',
          confirm: 1,
          title: 'Windows updates not installing',
          issue: Number.isFinite(age) ? `No successful update install in ${Math.floor(age)} days (limit ${max})` : 'No record of a successful update install',
          action: 'Check Windows Update history for errors; updates may be paused or failing',
        });
      }
    }
  }

  // ---- Uptime (long-running machines miss updates and accumulate problems) ----
  if (report.bootTime && device.maxUptimeDays > 0) {
    const up = daysAgo(now, report.bootTime);
    checks.push({
      key: 'uptime',
      ok: up <= device.maxUptimeDays,
      severity: 'routine',
      confirm: 1,
      title: 'Restart overdue',
      issue: `Running for ${Math.floor(up)} days without a restart`,
      action: 'Restart during the next maintenance window',
    });
  }

  // ---- Unexpected restarts (one-shot events) ----
  // Windows logs both Kernel-Power 41 and EventLog 6008 for one crash, seconds apart. Keep the 41;
  // drop a 6008 within 10 minutes of a 41 so one restart is one alert. (Agents >= 0.2.0 also do this.)
  const shutdowns = (Array.isArray(report.shutdowns) ? report.shutdowns : []).filter((e) => e && e.time);
  const kp41 = shutdowns.filter((e) => e.id === 41).map((e) => Date.parse(e.time)).filter(Number.isFinite);
  for (const e of shutdowns) {
    if (e.id === 6008 && kp41.some((t) => Math.abs(t - Date.parse(e.time)) <= 10 * 60_000)) continue;
    const kind = e.id === 41 ? 'rebooted without shutting down cleanly (power loss, crash or forced power-off)' : 'shut down unexpectedly';
    events.push({
      key: `restart:${e.time}`,
      severity: 'warning',
      title: 'Unexpected restart',
      issue: `Computer ${kind} at ${when(e.time, device.timezone)} (Event ID ${e.id})`,
      action: 'Check for power problems (UPS, power strip), overheating, or crash dumps in Event Viewer',
    });
  }

  // ---- Backups ----
  const results = new Map(
    [...(Array.isArray(report.eventChecks) ? report.eventChecks : []), ...(Array.isArray(report.fileChecks) ? report.fileChecks : [])]
      .filter((r) => r && r.name)
      .map((r) => [r.name, r]),
  );
  for (const b of device.backups) {
    const r = results.get(b.name);
    if (!r) continue;
    const key = `backup:${b.name}`;
    const action = 'Open the backup software, check the job log and run the backup manually';
    if (r.error) {
      checks.push({ key, ok: false, severity: 'warning', confirm: 1, title: `Backup check failing: ${b.name}`, issue: `Could not read backup status: ${String(r.error).slice(0, 200)}`, action: 'Check the backup rule in the monitor config' });
      continue;
    }
    const lastOk = Date.parse(r.lastSuccess ?? r.newest ?? '');
    const lastFail = Date.parse(r.lastFailure ?? '');
    if (Number.isFinite(lastFail) && (!Number.isFinite(lastOk) || lastFail > lastOk)) {
      checks.push({
        key, ok: false, severity: 'warning', confirm: 1,
        title: `Backup failed: ${b.name}`,
        issue: `Most recent backup failed at ${when(r.lastFailure, device.timezone)}${r.failureMessage ? `: ${String(r.failureMessage).slice(0, 200)}` : ''}`,
        action,
      });
      continue;
    }
    const ageH = Number.isFinite(lastOk) ? (now - lastOk) / HOUR : Infinity;
    checks.push({
      key, ok: ageH <= b.maxAgeHours, severity: 'warning', confirm: 1,
      title: `Backup missed: ${b.name}`,
      issue: Number.isFinite(ageH) ? `Last successful backup was ${Math.floor(ageH)} hours ago (expected every ${b.maxAgeHours}h)` : 'No successful backup found',
      action,
    });
  }

  return { checks, events };
}
