// Alert state machine: debounces check results, opens/escalates/resolves alerts, and sends notifications.
import { SEVERITY_RANK } from './evaluate.js';
import { formatAlert } from './notify.js';

export function createAlertEngine({ db, config, notifier, now = Date.now, log = console }) {
  const q = {
    getFails: db.prepare('SELECT fails FROM check_state WHERE device_id = ? AND check_key = ?'),
    setFails: db.prepare(`INSERT INTO check_state (device_id, check_key, fails, updated_at) VALUES (?, ?, ?, ?)
                          ON CONFLICT(device_id, check_key) DO UPDATE SET fails = excluded.fails, updated_at = excluded.updated_at`),
    open: db.prepare('SELECT * FROM alerts WHERE device_id = ? AND check_key = ? AND resolved_at IS NULL'),
    openForDevice: db.prepare("SELECT * FROM alerts WHERE device_id = ? AND resolved_at IS NULL AND kind = 'condition'"),
    insert: db.prepare(`INSERT INTO alerts (device_id, check_key, kind, severity, title, issue, action, opened_at, last_notified_at, resolved_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    update: db.prepare('UPDATE alerts SET severity = ?, title = ?, issue = ?, action = ? WHERE id = ?'),
    notified: db.prepare('UPDATE alerts SET last_notified_at = ? WHERE id = ?'),
    resolve: db.prepare('UPDATE alerts SET resolved_at = ? WHERE id = ?'),
    byId: db.prepare('SELECT * FROM alerts WHERE id = ?'),
    logNotification: db.prepare('INSERT INTO notifications (ts, alert_id, kind, title, channels, error) VALUES (?, ?, ?, ?, ?, ?)'),
    lastSeen: db.prepare('SELECT last_seen FROM device_state WHERE id = ?'),
    stale: db.prepare(`SELECT * FROM alerts WHERE resolved_at IS NULL AND acked_at IS NULL AND kind = 'condition'
                       AND severity = 'critical' AND last_notified_at < ?`),
  };

  const deviceName = (id) => config.devices.find((d) => d.id === id) || { id, name: db.prepare('SELECT name FROM device_state WHERE id = ?').get(id)?.name || id };

  // Routine items go into the daily digest instead of buzzing a phone.
  const pushes = (sev) => sev !== 'routine';

  // Delivery happens in the background so a slow channel never blocks a check-in.
  const pending = new Set();
  function notify(kind, alert, extraCtx = {}) {
    const ctx = { now: now(), timezone: config.timezone, ...extraCtx };
    const msg = formatAlert(kind, alert, deviceName(alert.device_id), ctx);
    const p = notifier
      .send(msg, { alertId: alert.id, deviceId: alert.device_id, check: alert.check_key, kind })
      .then((r) => q.logNotification.run(now(), alert.id, kind, msg.title, r.ok.join(','), r.errors.join('; ') || null))
      .catch((e) => log.error(e))
      .finally(() => pending.delete(p));
    pending.add(p);
    q.notified.run(now(), alert.id);
  }

  function lastSeenCtx(deviceId, check) {
    // Only availability alerts quote "last successful check" (matches the example alert format).
    if (check !== 'offline') return {};
    return { lastSeen: q.lastSeen.get(deviceId)?.last_seen ?? 0 };
  }

  // Apply one check result. Returns the open alert (if any) after processing.
  function apply(deviceId, result) {
    const t = now();
    const open = q.open.get(deviceId, result.key);

    if (result.ok) {
      q.setFails.run(deviceId, result.key, 0, t);
      if (open) {
        q.resolve.run(t, open.id);
        if (config.notifications.recovery && pushes(open.severity)) notify('resolve', open);
      }
      return null;
    }

    const fails = (q.getFails.get(deviceId, result.key)?.fails || 0) + 1;
    q.setFails.run(deviceId, result.key, fails, t);

    if (open) {
      const escalated = SEVERITY_RANK[result.severity] > SEVERITY_RANK[open.severity];
      // Keep the alert text current (e.g. disk free keeps shrinking) without re-notifying.
      q.update.run(escalated ? result.severity : open.severity, result.title, result.issue, result.action || null, open.id);
      const updated = q.byId.get(open.id);
      if (escalated && pushes(result.severity)) notify('escalate', updated, lastSeenCtx(deviceId, result.key));
      return updated;
    }
    if (fails < (result.confirm || 1)) return null;

    const { lastInsertRowid } = q.insert.run(deviceId, result.key, 'condition', result.severity, result.title, result.issue, result.action || null, t, null, null);
    const alert = q.byId.get(Number(lastInsertRowid));
    if (pushes(alert.severity)) notify('open', alert, lastSeenCtx(deviceId, result.key));
    return alert;
  }

  // One-off events (unexpected restart): recorded and notified once, closed immediately.
  function event(deviceId, ev) {
    const t = now();
    const dupe = db.prepare('SELECT id FROM alerts WHERE device_id = ? AND check_key = ?').get(deviceId, ev.key);
    if (dupe) return;
    const { lastInsertRowid } = q.insert.run(deviceId, ev.key, 'event', ev.severity, ev.title, ev.issue, ev.action || null, t, null, t);
    const alert = q.byId.get(Number(lastInsertRowid));
    if (pushes(alert.severity)) notify('open', alert);
  }

  // Resolve open alerts for checks that are no longer reported (e.g. a disk removed, a service unwatched).
  function resolveMissing(deviceId, presentKeys, prefixes) {
    for (const a of q.openForDevice.all(deviceId)) {
      if (prefixes.some((p) => a.check_key.startsWith(p)) && !presentKeys.has(a.check_key)) apply(deviceId, { key: a.check_key, ok: true });
    }
  }

  function remindStale() {
    const hours = config.notifications.renotifyCriticalHours;
    if (!(hours > 0)) return;
    for (const a of q.stale.all(now() - hours * 3_600_000)) notify('remind', a, lastSeenCtx(a.device_id, a.check_key));
  }

  return {
    apply,
    event,
    resolveMissing,
    remindStale,
    flush: () => Promise.all([...pending]),
  };
}
