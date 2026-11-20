// The monitor: agent check-ins, periodic sweeps (offline detection, probes, UniFi, maintenance,
// digest), the admin API and the dashboard. Zero dependencies: Node 22.13+ built-ins only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { loadConfig, maintenanceAppliesTo } from './config.js';
import { evaluateReport, outageSeverity, SEVERITY_RANK } from './evaluate.js';
import { createAlertEngine } from './alerts.js';
import { createNotifier, formatTime } from './notify.js';
import { probeDevice } from './probes.js';
import { fetchUnifiDevices, unifiId } from './unifi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const DAY = 86_400_000;
const REPORT_PREFIXES = ['disk:', 'service:', 'backup:', 'updates:', 'cpu', 'memory', 'uptime'];

export function loadSecret(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}

// Device tokens are derived, not stored: HMAC(server secret, device id). Rotate all by deleting secret.key.
export const deviceToken = (secret, id) => crypto.createHmac('sha256', secret).update(`agent:${id}`).digest('base64url');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function localParts(ms, timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

export async function startServer(opts = {}) {
  const dataDir = path.resolve(opts.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'));
  const config = opts.config || loadConfig(path.resolve(opts.configPath || process.env.CONFIG || path.join(ROOT, 'config.json')));
  const adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 10) throw new Error('Set ADMIN_PASSWORD (at least 10 characters) to protect the dashboard.');
  const log = opts.log || console;
  const now = opts.now || Date.now;
  const sweepMs = opts.sweepMs ?? Number(process.env.SWEEP_MS || 30_000);
  const secret = loadSecret(dataDir);
  const db = openDatabase(path.join(dataDir, 'monitor.db'));
  const notifier = opts.notifier || createNotifier(config.notifications, log);
  const engine = createAlertEngine({ db, config, notifier, now, log });
  const startedAt = now();
  const byId = new Map(config.devices.map((d) => [d.id, d]));
  const kv = {
    get: (k) => db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null,
    set: (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v)),
  };

  const upsertState = db.prepare(`
    INSERT INTO device_state (id, source, name, last_seen, online, last_report, extra) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET source = excluded.source, name = excluded.name,
      last_seen = COALESCE(excluded.last_seen, device_state.last_seen), online = excluded.online,
      last_report = COALESCE(excluded.last_report, device_state.last_report), extra = COALESCE(excluded.extra, device_state.extra)`);
  const getState = db.prepare('SELECT * FROM device_state WHERE id = ?');
  const setOnline = db.prepare('UPDATE device_state SET online = ? WHERE id = ?');

  // ---------- agent check-in ----------
  function watchList(device) {
    return {
      checkinIntervalMinutes: device.checkinIntervalMinutes,
      services: device.services,
      eventChecks: device.backups.filter((b) => (b.type || 'event') === 'event').map(({ name, logName, providerName, successIds, failureIds, lookbackHours }) => ({ name, logName, providerName, successIds, failureIds, lookbackHours: lookbackHours || 168 })),
      fileChecks: device.backups.filter((b) => b.type === 'file').map(({ name, path: p }) => ({ name, path: p })),
    };
  }

  function handleCheckin(device, report) {
    const t = now();
    upsertState.run(device.id, 'agent', device.name, t, 1, JSON.stringify(report), JSON.stringify({ hostname: report.hostname, agentVersion: report.agentVersion }));
    const disks = (report.disks || []).filter((d) => d?.sizeGB > 0).map((d) => (d.freeGB / d.sizeGB) * 100);
    db.prepare('INSERT INTO metrics (device_id, ts, cpu, memory, min_disk_free) VALUES (?, ?, ?, ?, ?)').run(
      device.id, t, num(report.cpuPercent), num(report.memoryPercent), disks.length ? Math.min(...disks) : null);

    engine.apply(device.id, { key: 'offline', ok: true });
    const { checks, events } = evaluateReport(device, report, t);
    for (const c of checks) engine.apply(device.id, c);
    for (const e of events) engine.event(device.id, e);
    engine.resolveMissing(device.id, new Set(checks.map((c) => c.key)), REPORT_PREFIXES);
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // ---------- periodic sweep ----------
  const nextProbe = new Map();
  let nextUnifi = 0;
  let lastHeartbeat = 0;
  let sweeping = false;

  function offlineResult(device, minutes) {
    return {
      key: 'offline',
      ok: false,
      severity: outageSeverity(device),
      confirm: 1,
      title: device.type === 'agent' ? 'Computer offline' : 'Device not responding',
      issue: device.type === 'agent' ? `Computer not responding (no check-in for ${Math.round(minutes)} minutes)` : `No response to ${device.type === 'tcp' ? `TCP port ${device.port}` : 'ping'} at ${device.address}`,
      action: 'Investigate connectivity and system availability',
    };
  }

  function checkAgents(t) {
    for (const d of config.devices) {
      if (d.type !== 'agent') continue;
      const s = getState.get(d.id);
      if (!s?.last_seen) continue; // never enrolled; shown on the dashboard, not alerted
      // After a server restart, give agents a full window to check in before declaring them offline.
      const since = Math.max(s.last_seen, startedAt);
      const silentMin = (t - since) / 60_000;
      if (silentMin > d.offlineAfterMinutes) {
        setOnline.run(0, d.id);
        engine.apply(d.id, offlineResult(d, (t - s.last_seen) / 60_000));
      }
    }
  }

  async function runProbes(t) {
    const due = config.devices.filter((d) => d.type !== 'agent' && (nextProbe.get(d.id) || 0) <= t);
    await Promise.all(
      due.map(async (d) => {
        nextProbe.set(d.id, t + d.probeIntervalSeconds * 1000);
        const up = await probeDevice(d);
        upsertState.run(d.id, 'probe', d.name, up ? now() : null, up ? 1 : 0, null, JSON.stringify({ address: d.address, port: d.port || null }));
        engine.apply(d.id, up ? { key: 'offline', ok: true } : { ...offlineResult(d), confirm: d.probeFailuresBeforeAlert });
      }),
    );
  }

  async function pollUnifi(t) {
    const u = config.unifi;
    if (!u || t < nextUnifi) return;
    nextUnifi = t + u.pollSeconds * 1000;
    const ctrl = { id: 'unifi-controller', name: 'UniFi controller', priority: 'standard' };
    let list;
    try {
      list = await fetchUnifiDevices(u);
    } catch (e) {
      log.error(`UniFi poll failed: ${e.message}`);
      upsertState.run(ctrl.id, 'unifi', ctrl.name, null, 0, null, JSON.stringify({ error: e.message }));
      engine.apply(ctrl.id, { key: 'offline', ok: false, severity: 'warning', confirm: u.failuresBeforeAlert, title: 'UniFi controller unreachable', issue: `Cannot read network device status: ${e.message.slice(0, 200)}`, action: 'Check the UniFi console is powered on and the API key is valid' });
      return;
    }
    upsertState.run(ctrl.id, 'unifi', ctrl.name, now(), 1, null, JSON.stringify({ devices: list.length }));
    engine.apply(ctrl.id, { key: 'offline', ok: true });
    for (const d of list) {
      const over = u.devices[d.mac] || u.devices[d.name] || {};
      if (over.ignore) continue;
      const id = unifiId(d.mac);
      const dev = { id, name: over.name || d.name, priority: over.priority || u.defaultPriority, type: 'unifi' };
      upsertState.run(id, 'unifi', dev.name, d.down ? null : now(), d.down ? 0 : 1, JSON.stringify(d), JSON.stringify({ model: d.model, ip: d.ip, mac: d.mac, state: d.state, priority: dev.priority }));
      engine.apply(id, d.down
        ? { key: 'offline', ok: false, severity: outageSeverity(dev), confirm: u.failuresBeforeAlert, title: 'Network device offline', issue: `UniFi reports ${dev.name}${d.model ? ` (${d.model})` : ''} as ${d.state}`, action: 'Check power and cabling to the device; check its uplink switch port' }
        : { key: 'offline', ok: true });
      engine.apply(id, { key: 'firmware', ok: !d.firmwareUpdatable, severity: 'routine', confirm: 1, title: 'Firmware update available', issue: `A firmware update is available for ${dev.name}`, action: 'Update from the UniFi console during a maintenance window' });
    }
  }

  const lastMaint = db.prepare('SELECT MAX(performed_at) t FROM maintenance_log WHERE device_id = ? AND task_id = ?');
  function maintenanceStatus(t) {
    const out = [];
    for (const task of config.maintenance) {
      const baseKey = `maint-baseline:${task.id}`;
      let baseline = Number(kv.get(baseKey));
      if (!baseline) kv.set(baseKey, (baseline = t)); // first time we see a task, the clock starts now
      for (const d of config.devices) {
        if (!maintenanceAppliesTo(task, d)) continue;
        const last = lastMaint.get(d.id, task.id)?.t ?? null;
        const due = (last ?? baseline) + task.intervalDays * DAY;
        out.push({ taskId: task.id, task: task.name, deviceId: d.id, device: d.name, lastDone: last, due, overdue: t > due });
      }
    }
    return out;
  }
  function checkMaintenance(t) {
    for (const m of maintenanceStatus(t)) {
      engine.apply(m.deviceId, { key: `maint:${m.taskId}`, ok: !m.overdue, severity: 'routine', confirm: 1, title: `Maintenance overdue: ${m.task}`, issue: `"${m.task}" was due ${formatTime(m.due, config.timezone)}`, action: 'Perform the task and log it on the dashboard' });
    }
  }

  async function sendDigest(t, force = false) {
    const { date, time } = localParts(t, config.timezone);
    if (!force && (time < config.notifications.digestTime || kv.get('digest-date') === date)) return;
    kv.set('digest-date', date);
    const open = db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at').all();
    const nameOf = (id) => byId.get(id)?.name || getState.get(id)?.name || id;
    const counts = { critical: 0, warning: 0, routine: 0 };
    for (const a of open) counts[a.severity]++;
    const routine = open.filter((a) => a.severity === 'routine');
    const lines = [
      `Open: ${counts.critical} critical, ${counts.warning} warning, ${counts.routine} routine`,
      ...open.filter((a) => a.severity !== 'routine').map((a) => `• [${a.severity.toUpperCase()}] ${nameOf(a.device_id)}: ${a.title}`),
      ...(routine.length ? ['', 'Routine maintenance:', ...routine.slice(0, 25).map((a) => `• ${nameOf(a.device_id)}: ${a.title}`)] : []),
      ...(routine.length > 25 ? [`…and ${routine.length - 25} more on the dashboard`] : []),
    ];
    if (!open.length) lines.push('All monitored systems healthy.');
    const title = `IT daily summary — ${open.length ? `${open.length} open item(s)` : 'all clear'}`;
    const r = await notifier.send({ title, body: lines.join('\n'), severity: counts.critical ? 'warning' : 'routine', tag: 'routine' }, { kind: 'digest' });
    db.prepare('INSERT INTO notifications (ts, kind, title, channels, error) VALUES (?, ?, ?, ?, ?)').run(now(), 'digest', title, r.ok.join(','), r.errors.join('; ') || null);
  }

  async function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
      const t = now();
      checkAgents(t);
      await runProbes(t);
      await pollUnifi(t);
      checkMaintenance(t);
      engine.remindStale();
      await sendDigest(t);
      db.prepare('DELETE FROM metrics WHERE ts < ?').run(t - 90 * DAY);
      if (config.heartbeatUrl && t - lastHeartbeat > 60_000) {
        lastHeartbeat = t;
        fetch(config.heartbeatUrl, { signal: AbortSignal.timeout(10_000) }).catch((e) => log.error(`Heartbeat failed: ${e.message}`));
      }
    } catch (e) {
      log.error('Sweep failed:', e);
    } finally {
      sweeping = false;
    }
  }

  // ---------- HTTP ----------
  const sessions = new Map(); // token -> expiry
  const loginAttempts = new Map(); // ip -> [timestamps]
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  const secureCookie = opts.secureCookies ?? process.env.INSECURE_COOKIES !== '1';
  const clientIp = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  function readJSON(req, limit = 512 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(Object.assign(new Error('Body too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
        }
      });
      req.on('error', reject);
    });
  }
  function session(req) {
    const m = /(?:^|;\s*)msid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
    const exp = m && sessions.get(m[1]);
    if (!exp || exp < now()) return null;
    return m[1];
  }

  function deviceSummary(d, openByDevice) {
    const s = getState.get(d.id) || {};
    const report = s.last_report ? JSON.parse(s.last_report) : null;
    const alerts = openByDevice.get(d.id) || [];
    const worst = alerts.reduce((w, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[w] ? a.severity : w), 'ok');
    const disks = (report?.disks || []).filter((x) => x?.sizeGB > 0);
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      priority: d.priority,
      online: s.online ?? null,
      lastSeen: s.last_seen ?? null,
      // Offline counts as unhealthy even before the alert is confirmed (e.g. a probe's first failure).
      status: s.last_seen == null && s.online == null ? 'unknown' : s.online === 0 && worst === 'ok' ? 'warning' : worst,
      openAlerts: alerts.length,
      cpu: d.type === 'agent' ? report?.cpuPercent ?? null : null,
      memory: d.type === 'agent' ? report?.memoryPercent ?? null : null,
      minDiskFree: disks.length ? Math.min(...disks.map((x) => (x.freeGB / x.sizeGB) * 100)) : null,
      extra: s.extra ? JSON.parse(s.extra) : null,
    };
  }

  function allDevices() {
    const list = [...config.devices];
    for (const s of db.prepare("SELECT * FROM device_state WHERE source = 'unifi'").all()) {
      const ex = s.extra ? JSON.parse(s.extra) : {};
      list.push({ id: s.id, name: s.name, type: 'unifi', priority: ex.priority || 'standard' });
    }
    return list;
  }

  function overview() {
    const open = db.prepare('SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY opened_at DESC').all();
    const openByDevice = new Map();
    for (const a of open) openByDevice.set(a.device_id, [...(openByDevice.get(a.device_id) || []), a]);
    const devices = allDevices().map((d) => deviceSummary(d, openByDevice));
    const names = new Map(devices.map((d) => [d.id, d.name]));
    return {
      serverTime: now(),
      timezone: config.timezone,
      channels: notifier.configured,
      devices,
      alerts: open.map((a) => ({ ...a, device_name: names.get(a.device_id) || a.device_id })),
      maintenance: maintenanceStatus(now()).sort((a, b) => a.due - b.due),
      tasks: config.maintenance.map(({ id, name, intervalDays }) => ({ id, name, intervalDays })),
    };
  }

  async function route(req, res, url) {
    const p = url.pathname;

    if (p === '/api/agent/checkin' && req.method === 'POST') {
      const id = String(req.headers['x-device-id'] || '');
      const device = byId.get(id);
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] || '';
      if (!device || device.type !== 'agent' || !safeEqual(auth, deviceToken(secret, id))) return send(res, 401, { error: 'Unknown device or bad token' });
      const report = await readJSON(req);
      handleCheckin(device, report);
      return send(res, 200, { ok: true, serverTime: now(), watch: watchList(device) });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const recent = (loginAttempts.get(ip) || []).filter((t) => t > now() - 15 * 60_000);
      if (recent.length >= 10) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
      const { password } = await readJSON(req, 4096);
      if (!safeEqual(password || '', adminPassword)) {
        loginAttempts.set(ip, [...recent, now()]);
        return send(res, 401, { error: 'Wrong password' });
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('base64url');
      sessions.set(token, now() + 12 * 3_600_000);
      res.setHeader('Set-Cookie', `msid=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${secureCookie ? '; Secure' : ''}`);
      return send(res, 200, { ok: true });
    }

    if (!p.startsWith('/api/')) return serveStatic(res, p);
    const sid = session(req);
    if (!sid) return send(res, 401, { error: 'Not logged in' });
    // CSRF: state-changing requests must come from our own page (SameSite cookie + custom header).
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'monitor') return send(res, 403, { error: 'Missing X-Requested-With' });

    if (p === '/api/logout' && req.method === 'POST') {
      sessions.delete(sid);
      res.setHeader('Set-Cookie', 'msid=; Path=/; Max-Age=0');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/overview' && req.method === 'GET') return send(res, 200, overview());

    let m;
    if ((m = /^\/api\/devices\/([^/]+)$/.exec(p)) && req.method === 'GET') {
      const id = decodeURIComponent(m[1]);
      const d = allDevices().find((x) => x.id === id);
      if (!d) return send(res, 404, { error: 'No such device' });
      const s = getState.get(id) || {};
      const since = now() - 7 * DAY;
      return send(res, 200, {
        device: { ...d, ...deviceSummary(d, new Map()) },
        config: byId.get(id) ? { services: d.services, backups: d.backups?.map((b) => b.name), disk: d.disk, cpu: d.cpu, memory: d.memory } : null,
        report: s.last_report ? JSON.parse(s.last_report) : null,
        alerts: db.prepare('SELECT * FROM alerts WHERE device_id = ? ORDER BY opened_at DESC LIMIT 100').all(id),
        metrics: db.prepare('SELECT ts, cpu, memory, min_disk_free FROM metrics WHERE device_id = ? AND ts > ? ORDER BY ts').all(id, since),
        maintenance: db.prepare('SELECT * FROM maintenance_log WHERE device_id = ? ORDER BY performed_at DESC LIMIT 100').all(id),
      });
    }
    if (p === '/api/alerts' && req.method === 'GET') {
      const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
      return send(res, 200, { alerts: db.prepare('SELECT * FROM alerts ORDER BY opened_at DESC LIMIT ?').all(limit) });
    }
    if ((m = /^\/api\/alerts\/(\d+)\/ack$/.exec(p)) && req.method === 'POST') {
      const r = db.prepare('UPDATE alerts SET acked_at = ? WHERE id = ? AND acked_at IS NULL').run(now(), Number(m[1]));
      return send(res, r.changes ? 200 : 404, { ok: !!r.changes });
    }
    if (p === '/api/maintenance' && req.method === 'POST') {
      const b = await readJSON(req, 16_384);
      if (!allDevices().some((d) => d.id === b.deviceId)) return send(res, 400, { error: 'Unknown device' });
      if (b.taskId && !config.maintenance.some((t) => t.id === b.taskId)) return send(res, 400, { error: 'Unknown maintenance task' });
      if (!b.taskId && !String(b.notes || '').trim()) return send(res, 400, { error: 'Describe the work done' });
      const at = b.performedAt ? Date.parse(b.performedAt) : now();
      if (!Number.isFinite(at) || at > now() + 60_000) return send(res, 400, { error: 'Invalid date' });
      db.prepare('INSERT INTO maintenance_log (device_id, task_id, performed_at, performed_by, notes) VALUES (?, ?, ?, ?, ?)').run(
        b.deviceId, b.taskId || null, at, String(b.performedBy || '').slice(0, 100) || null, String(b.notes || '').slice(0, 4000) || null);
      checkMaintenance(now());
      return send(res, 200, { ok: true });
    }
    if (p === '/api/test-notification' && req.method === 'POST') {
      const r = await notifier.send({ title: 'IT ALERT — Test notification', body: 'If you can read this, monitoring alerts will reach this device.\nPriority: Routine', severity: 'warning', tag: 'routine' }, { kind: 'test' });
      return send(res, 200, r);
    }
    if (p === '/api/digest' && req.method === 'POST') {
      await sendDigest(now(), true);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  function serveStatic(res, p) {
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUBLIC, path.normalize(rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    route(req, res, url).catch((e) => {
      if (!e.status) log.error(e);
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    });
  });

  const port = opts.port ?? Number(process.env.PORT || 8090);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  await new Promise((r) => server.listen(port, host, r));
  const timer = sweepMs > 0 ? setInterval(sweep, sweepMs) : null;

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}`,
    db,
    config,
    secret,
    sweep,
    flush: engine.flush,
    tokenFor: (id) => deviceToken(secret, id),
    async close() {
      if (timer) clearInterval(timer);
      await new Promise((r) => server.close(r));
      await engine.flush();
      db.close();
    },
  };
}
