import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/app.js';
import { normalizeConfig } from '../server/config.js';
import { evaluateReport, outageSeverity } from '../server/evaluate.js';
import { formatAlert } from '../server/notify.js';

const HOUR = 3_600_000;
const quiet = { log() {}, warn() {}, error() {} };

// ---------------- pure rule engine ----------------

const cfg = normalizeConfig({
  devices: [{ id: 'pc', name: 'Front Desk PC', priority: 'critical', services: ['Spooler'], backups: [{ name: 'WSB', successIds: [4], failureIds: [5] }] }],
});
const pc = cfg.devices[0];
const T = Date.parse('2026-11-20T15:00:00Z');
const keyed = (r) => Object.fromEntries(r.checks.map((c) => [c.key, c]));

test('disk thresholds: ok / warning / critical', () => {
  const r = keyed(evaluateReport(pc, { disks: [{ drive: 'C:', sizeGB: 100, freeGB: 50 }, { drive: 'D:', sizeGB: 100, freeGB: 10 }, { drive: 'E:', sizeGB: 100, freeGB: 3 }] }, T));
  assert.equal(r['disk:C:'].ok, true);
  assert.equal(r['disk:D:'].severity, 'warning');
  assert.equal(r['disk:E:'].severity, 'critical');
});

test('CPU must stay high for the sustained window (15 min / 5 min interval = 3 reports)', () => {
  const r = keyed(evaluateReport(pc, { cpuPercent: 97 }, T));
  assert.equal(r.cpu.ok, false);
  assert.equal(r.cpu.confirm, 3);
});

test('stopped service is Critical on a critical device, Warning on a standard one', () => {
  const report = { services: [{ name: 'Spooler', displayName: 'Print Spooler', status: 'Stopped' }] };
  assert.equal(keyed(evaluateReport(pc, report, T))['service:spooler'].severity, 'critical');
  assert.equal(keyed(evaluateReport({ ...pc, priority: 'standard' }, report, T))['service:spooler'].severity, 'warning');
});

test('updates: pending is routine, not installing for 35+ days is a warning', () => {
  const r = keyed(evaluateReport(pc, { updates: { pendingCount: 3, securityCount: 1, rebootRequired: true, lastInstallSuccess: new Date(T - 40 * 24 * HOUR).toISOString() } }, T));
  assert.equal(r['updates:pending'].severity, 'routine');
  assert.match(r['updates:pending'].title, /1 security/);
  assert.equal(r['updates:reboot'].ok, false);
  assert.equal(r['updates:stale'].severity, 'warning');
});

test('backup: failure newer than success, overdue, and healthy', () => {
  const at = (h) => new Date(T - h * HOUR).toISOString();
  const run = (ec) => keyed(evaluateReport(pc, { eventChecks: [{ name: 'WSB', ...ec }] }, T))['backup:WSB'];
  assert.match(run({ lastSuccess: at(30), lastFailure: at(2), failureMessage: 'disk full' }).title, /failed/);
  assert.match(run({ lastSuccess: at(40) }).title, /missed/);
  assert.equal(run({ lastSuccess: at(40) }).ok, false);
  assert.equal(run({ lastSuccess: at(5), lastFailure: at(30) }).ok, true);
  assert.equal(run({}).ok, false); // never succeeded
});

test('unexpected shutdowns become one-shot events', () => {
  const r = evaluateReport(pc, { shutdowns: [{ time: '2026-11-20T09:13:00Z', id: 41 }] }, T);
  assert.equal(r.events.length, 1);
  assert.match(r.events[0].issue, /power loss/);
});

test('a 41 + 6008 pair from one crash is one event; a lone 6008 still alerts', () => {
  // real pair captured on Windows 11: 41 at boot, 6008 22 s later
  const pair = [{ time: '2026-11-16T16:38:47.6188885Z', id: 41 }, { time: '2026-11-16T16:39:09.1965567Z', id: 6008 }];
  const r = evaluateReport(pc, { shutdowns: [...pair, { time: '2026-11-05T01:34:00Z', id: 6008 }] }, T);
  assert.deepEqual(r.events.map((e) => e.key), ['restart:2026-11-16T16:38:47.6188885Z', 'restart:2026-11-05T01:34:00Z']);
});

test('malformed report entries are ignored, not fatal', () => {
  const r = evaluateReport(pc, { services: [null, { name: 'Spooler', status: 'Running' }], disks: [null], shutdowns: [null] }, T);
  assert.equal(keyed(r)['service:spooler'].ok, true);
});

test('config: Wi-Fi client MACs are normalized and validated; low priority is routine', () => {
  const c = normalizeConfig({ unifi: { url: 'https://u', apiKey: 'k', clients: [{ mac: 'AA-BB-CC-DD-EE-FF', name: 'T' }] } });
  assert.equal(c.unifi.clients[0].mac, 'aa:bb:cc:dd:ee:ff');
  assert.equal(c.unifi.clients[0].priority, 'low');
  assert.equal(c.unifi.clients[0].offlineAfterMinutes, 30);
  assert.throws(() => normalizeConfig({ unifi: { clients: [{ mac: 'nope' }] } }), /MAC address/);
  assert.throws(() => normalizeConfig({ unifi: { clients: [{ mac: 'aabbccddeeff' }, { mac: 'AA:BB:CC:DD:EE:FF' }] } }), /twice/);
  assert.equal(outageSeverity({ priority: 'low' }), 'routine');
  assert.equal(normalizeConfig({ devices: [{ id: 'kiosk', priority: 'low' }] }).devices[0].priority, 'low');
});

test('alert message matches the agreed format', () => {
  const m = formatAlert('open', { device_id: 'pc', severity: 'critical', title: 'Computer offline', issue: 'Computer not responding', action: 'Investigate connectivity and system availability', opened_at: T }, pc, { now: T, timezone: 'America/New_York', lastSeen: Date.parse('2026-11-20T15:42:00Z') });
  assert.equal(m.title, 'IT ALERT — Front Desk PC: Computer offline');
  assert.equal(m.body, 'Device: Front Desk PC\nIssue: Computer not responding\nLast successful check: 10:42 AM\nPriority: Critical\nAction: Investigate connectivity and system availability');
  // a check from a previous day includes the date
  const old = formatAlert('open', { device_id: 'pc', severity: 'critical', title: 't', issue: 'i', opened_at: T }, pc, { now: T, timezone: 'America/New_York', lastSeen: T - 30 * HOUR });
  assert.match(old.body, /Last successful check: Nov 19, 4:00 AM/);
});

test('config validation rejects bad input', () => {
  assert.throws(() => normalizeConfig({ devices: [{ id: 'Bad ID' }] }), /lowercase/);
  assert.throws(() => normalizeConfig({ devices: [{ id: 'p', type: 'ping' }] }), /address/);
  assert.throws(() => normalizeConfig({ devices: [{ id: 'a' }, { id: 'a' }] }), /Duplicate/);
});

// ---------------- end to end: real server, real HTTP, captured notifications ----------------

let app, hook, received, unifiState, unifiClients, unifiClientsFail, closedPort;
const TABLET_A = { macAddress: '11:22:33:44:55:01', name: 'room-101-tab', ipAddress: '10.0.50.11', type: 'WIRELESS', uplinkDeviceId: 'd1' };
const TABLET_B = { macAddress: '11-22-33-44-55-02', name: 'room-102-tab', ipAddress: '10.0.50.12', type: 'WIRELESS', uplinkDeviceId: 'd1' };
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-test-'));

before(async () => {
  received = [];
  unifiState = 'ONLINE';
  unifiClients = [TABLET_A];
  unifiClientsFail = false;
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.url === '/hook') received.push(JSON.parse(b));
      else if (req.url.startsWith('/proxy/network/integration/v1/sites?')) return res.end(JSON.stringify({ data: [{ id: 's1', internalReference: 'default', name: 'Default' }], totalCount: 1 }));
      else if (req.url.startsWith('/proxy/network/integration/v1/sites/s1/clients')) {
        if (unifiClientsFail) { res.statusCode = 500; return res.end('boom'); }
        return res.end(JSON.stringify({ data: unifiClients, totalCount: unifiClients.length }));
      } else if (req.url.startsWith('/proxy/network/integration/v1/sites/s1/devices')) {
        assert.equal(req.headers['x-api-key'], 'k');
        return res.end(JSON.stringify({ data: [{ id: 'd1', name: 'Lobby AP', model: 'U7 Pro', macAddress: 'AA:BB:CC:00:11:22', ipAddress: '192.168.1.5', state: unifiState }], totalCount: 1 }));
      }
      res.end('{}');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${hook.address().port}`;

  // A port that is guaranteed closed, for the TCP probe.
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));

  const config = normalizeConfig({
    timezone: 'UTC',
    defaults: { offlineAfterMinutes: 0.02 }, // 1.2 s, so the test runs fast
    devices: [
      { id: 'front-desk', name: 'Front Desk PC', priority: 'critical', services: ['Spooler'] },
      { id: 'back-office', name: 'Back Office PC', offlineAfterMinutes: 60 },
      { id: 'printer', name: 'Printer', type: 'tcp', address: '127.0.0.1', port: closedPort, probeFailuresBeforeAlert: 2, probeIntervalSeconds: 0 },
    ],
    notifications: { webhook: { url: `${base}/hook` }, renotifyCriticalHours: 0 },
    unifi: { url: base, apiKey: 'k', pollSeconds: 0, failuresBeforeAlert: 2, devices: { 'Lobby AP': { priority: 'critical' } },
      clientDefaults: { offlineAfterMinutes: 0.02 },
      clients: [{ mac: '11:22:33:44:55:01', name: 'Room 101 tablet' }, { mac: '112233445502', name: 'Room 102 tablet', priority: 'standard' }] },
    maintenance: [{ id: 'clean', name: 'Clean fans', intervalDays: 180 }],
  });
  app = await startServer({ config, dataDir, port: 0, host: '127.0.0.1', sweepMs: 0, adminPassword: 'correct horse battery', secureCookies: false, log: quiet });
});

after(async () => {
  await app?.close();
  await new Promise((r) => hook.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function checkin(id, report, token = app.tokenFor(id)) {
  const res = await fetch(`${app.url}/api/agent/checkin`, { method: 'POST', headers: { 'X-Device-Id': id, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(report) });
  return { status: res.status, body: await res.json() };
}
async function settle() {
  await app.flush();
  await new Promise((r) => setTimeout(r, 20));
}
const take = () => received.splice(0);
const healthy = { hostname: 'FD1', cpuPercent: 10, memoryPercent: 40, disks: [{ drive: 'C:', sizeGB: 200, freeGB: 120 }], services: [{ name: 'Spooler', status: 'Running' }] };

test('agent auth: wrong token and unknown device are rejected', async () => {
  assert.equal((await checkin('front-desk', healthy, 'nope')).status, 401);
  assert.equal((await checkin('ghost', healthy, app.tokenFor('ghost'))).status, 401);
  assert.equal((await checkin('printer', healthy)).status, 401); // probe devices can't check in
});

test('check-in returns the watch list for the agent', async () => {
  const r = await checkin('front-desk', healthy);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.watch.services, ['Spooler']);
  await settle();
  assert.deepEqual(take(), []);
});

test('low disk: one alert, no repeats, recovery notification when cleared', async () => {
  const low = { ...healthy, disks: [{ drive: 'C:', sizeGB: 200, freeGB: 20 }] };
  await checkin('front-desk', low);
  await checkin('front-desk', low);
  await settle();
  let msgs = take();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].severity, 'warning');
  assert.match(msgs[0].title, /Low disk space on C:/);

  await checkin('front-desk', { ...healthy, disks: [{ drive: 'C:', sizeGB: 200, freeGB: 6 }] });
  await settle();
  msgs = take();
  assert.equal(msgs.length, 1, 'escalation to critical notifies once');
  assert.match(msgs[0].title, /^ESCALATED/);

  await checkin('front-desk', healthy);
  await settle();
  msgs = take();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].status, 'resolved');
});

test('stopped service needs two consecutive reports before alerting', async () => {
  const stopped = { ...healthy, services: [{ name: 'Spooler', displayName: 'Print Spooler', status: 'Stopped' }] };
  await checkin('front-desk', stopped);
  await settle();
  assert.equal(take().length, 0);
  await checkin('front-desk', stopped);
  await settle();
  const [m] = take();
  assert.equal(m.severity, 'critical');
  assert.match(m.text, /Print Spooler" is Stopped/);
  await checkin('front-desk', healthy);
  await settle();
  take();
});

test('unexpected restart is notified exactly once even if reported twice', async () => {
  const r = { ...healthy, shutdowns: [{ time: '2026-11-20T03:00:00Z', id: 41 }] };
  await checkin('front-desk', r);
  await checkin('front-desk', r);
  await settle();
  const msgs = take();
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].title, /Unexpected restart/);
});

test('routine items (pending updates) do not push; they go into the daily digest', async () => {
  await checkin('back-office', { ...healthy, updates: { pendingCount: 2, securityCount: 2, rebootRequired: false, lastInstallSuccess: new Date().toISOString() } });
  await settle();
  assert.equal(take().length, 0);
});

test('offline: critical alert with last-seen time, then recovery', async () => {
  await checkin('front-desk', healthy);
  await new Promise((r) => setTimeout(r, 1500));
  await app.sweep();
  await settle();
  const msgs = take();
  const off = msgs.find((m) => m.check === 'offline' && m.deviceId === 'front-desk');
  assert.ok(off, 'offline alert sent');
  assert.equal(off.severity, 'critical');
  assert.match(off.text, /Last successful check: /);
  assert.match(off.text, /Action: Investigate connectivity and system availability/);
  assert.ok(!msgs.some((m) => m.deviceId === 'back-office' && m.check === 'offline'), 'device with a longer window is not offline');
  // Printer probe failed twice (sweep + this one) -> alert; UniFi online -> nothing.
  await app.sweep();
  await settle();
  const printer = take().find((m) => m.deviceId === 'printer');
  assert.ok(printer, 'printer alert');
  assert.match(printer.text, /No response to TCP port/);

  await checkin('front-desk', healthy);
  await settle();
  const back = take().find((m) => m.deviceId === 'front-desk');
  assert.equal(back.status, 'resolved');
});

test('UniFi: device going offline alerts after 2 polls, recovers', async () => {
  unifiState = 'OFFLINE';
  await app.sweep();
  await settle();
  assert.ok(!take().some((m) => m.deviceId?.startsWith('unifi-aabbcc')));
  await app.sweep();
  await settle();
  const m = take().find((x) => x.deviceId === 'unifi-aabbcc001122');
  assert.ok(m, 'unifi offline alert');
  assert.equal(m.severity, 'critical');
  assert.match(m.text, /Lobby AP \(U7 Pro\) as OFFLINE/);
  unifiState = 'ONLINE';
  await app.sweep();
  await settle();
  assert.ok(take().some((x) => x.deviceId === 'unifi-aabbcc001122' && x.status === 'resolved'));
});

test('UniFi Wi-Fi clients: tablet off Wi-Fi alerts, recovers; a failed client list judges nothing', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const open = (id) => app.db.prepare("SELECT * FROM alerts WHERE device_id = ? AND check_key = 'offline' AND resolved_at IS NULL").get(id);
  await sleep(1300); // past offlineAfterMinutes (1.2 s) since server start
  await app.sweep();
  await settle();
  assert.equal(open('wifi-112233445501'), undefined, 'connected tablet is fine');
  const b = open('wifi-112233445502');
  assert.ok(b, 'never-seen tablet alerts');
  assert.equal(b.severity, 'warning'); // priority standard
  assert.match(b.issue, /since monitoring started.*MAC address/);

  unifiClients = [TABLET_A, TABLET_B];
  await app.sweep();
  await settle();
  assert.equal(open('wifi-112233445502'), undefined, 'tablet back on Wi-Fi');
  assert.ok(take().some((m) => m.deviceId === 'wifi-112233445502' && m.status === 'resolved'));
  assert.equal(JSON.parse(app.db.prepare('SELECT extra FROM device_state WHERE id = ?').get('wifi-112233445502').extra).ap, 'Lobby AP');

  // Client list unreadable while tablet A is gone: nothing is judged.
  unifiClients = [TABLET_B];
  unifiClientsFail = true;
  await sleep(1300);
  await app.sweep();
  await settle();
  assert.equal(open('wifi-112233445501'), undefined, 'no false offline when the client list fails');

  unifiClientsFail = false;
  await app.sweep();
  await settle();
  const a = open('wifi-112233445501');
  assert.ok(a, 'tablet A off Wi-Fi');
  assert.equal(a.severity, 'routine'); // default priority low: daily summary, no push
  assert.match(a.issue, /Room 101 tablet has not been on Wi-Fi for \d+ minutes \(last seen on Lobby AP\)/);
  assert.ok(!take().some((m) => m.deviceId === 'wifi-112233445501'), 'low priority never pushes');
  unifiClients = [TABLET_A, TABLET_B];
  await app.sweep();
  await settle();
  take();
});

test('dashboard API: login required, overview, maintenance log, ack, digest', async () => {
  assert.equal((await fetch(`${app.url}/api/overview`)).status, 401);
  assert.equal((await fetch(`${app.url}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'wrong-password' }) })).status, 401);
  const login = await fetch(`${app.url}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'correct horse battery' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (p, body) => fetch(`${app.url}${p}`, body ? { method: 'POST', headers: { cookie, 'X-Requested-With': 'monitor' }, body: JSON.stringify(body) } : { headers: { cookie } }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const ov = (await api('/api/overview')).body;
  assert.ok(ov.devices.find((d) => d.id === 'front-desk'));
  assert.ok(ov.devices.find((d) => d.id === 'unifi-aabbcc001122'), 'discovered UniFi device listed');
  assert.equal(ov.maintenance.filter((m) => m.taskId === 'clean').length, 3);

  // CSRF guard
  assert.equal((await fetch(`${app.url}/api/maintenance`, { method: 'POST', headers: { cookie }, body: '{}' })).status, 403);

  assert.equal((await api('/api/maintenance', { deviceId: 'front-desk', taskId: 'clean', performedBy: 'NJ', notes: 'Blew out dust' })).status, 200);
  assert.equal((await api('/api/maintenance', { deviceId: 'front-desk', notes: '' })).status, 400);
  const detail = (await api('/api/devices/front-desk')).body;
  assert.equal(detail.maintenance[0].notes, 'Blew out dust');
  assert.ok(detail.metrics.length > 0);
  assert.ok(detail.alerts.length > 0);

  const open = ov.alerts.find((a) => a.device_id === 'printer');
  assert.equal((await api(`/api/alerts/${open.id}/ack`, {})).status, 200);

  take();
  await api('/api/digest', {});
  await settle();
  const [digest] = take();
  assert.match(digest.title, /IT daily summary/);
  assert.match(digest.text, /security update/);
});

test('dashboard page is served with a strict CSP; path traversal blocked', async () => {
  const r = await fetch(`${app.url}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await fetch(`${app.url}/..%2fserver%2fapp.js`)).status, 404);
});

test('overview counts devices with open alerts or offline as unhealthy', async () => {
  const login = await fetch(`${app.url}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'correct horse battery' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ov = await (await fetch(`${app.url}/api/overview`, { headers: { cookie } })).json();
  const st = Object.fromEntries(ov.devices.map((d) => [d.id, d.status]));
  assert.equal(st['printer'], 'warning'); // offline (alert acknowledged but still open)
  assert.equal(st['back-office'], 'routine'); // pending updates
});
