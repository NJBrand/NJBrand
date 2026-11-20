// Dashboard. All text goes through textContent (alert text includes data from monitored machines).
const $app = document.getElementById('app');
const SEV = ['critical', 'warning', 'routine'];
let data = null;
let tz = 'UTC';
let refreshTimer = null;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'monitor' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Logged out');
  }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function fmtTime(ms) {
  if (!ms) return 'never';
  const d = new Date(ms);
  const same = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d) === new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', ...(same ? {} : { month: 'short', day: 'numeric' }) }).format(d);
}
const fmtDate = (ms) => new Intl.DateTimeFormat(undefined, { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(ms));
function ago(ms) {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 2880) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} days ago`;
}
const pct = (v) => (v == null ? '–' : `${Math.round(v)}%`);
const statusLabel = (d) => (d.status === 'unknown' ? 'Never checked in' : d.online === 0 ? 'Offline' : d.status === 'ok' ? 'Healthy' : `${d.openAlerts} open`);

// ---------- login ----------
function showLogin() {
  clearInterval(refreshTimer);
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, 'aria-label': 'Password' });
  const err = h('p', { class: 'small error', role: 'alert' });
  $app.replaceChildren(
    h('form', {
      class: 'login',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/login', { password: pw.value });
          start();
        } catch (x) {
          err.textContent = x.message;
        }
      },
    }, h('h1', {}, 'IT Monitor'), h('label', {}, 'Admin password', pw), err, h('button', { class: 'primary', type: 'submit' }, 'Sign in')),
  );
  pw.focus();
}

// ---------- main view ----------
async function start() {
  await load();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => document.visibilityState === 'visible' && load().catch(() => {}), 30000);
}

async function load() {
  data = await api('/api/overview');
  tz = data.timezone;
  render();
}

function render() {
  const counts = { critical: 0, warning: 0, routine: 0 };
  for (const a of data.alerts) counts[a.severity]++;
  const healthy = data.devices.filter((d) => d.status === 'ok').length;

  const header = h('header', {},
    h('h1', {}, 'IT Monitor'),
    h('span', { class: 'small muted updated' }, `Updated ${fmtTime(data.serverTime)}`),
    h('button', { onclick: () => load().then(() => toast('Refreshed')) }, 'Refresh'),
    h('button', { onclick: () => api('/api/logout', {}).then(showLogin) }, 'Sign out'));

  const tiles = h('div', { class: 'tiles' },
    ...SEV.map((s) => h('div', { class: `tile ${counts[s] ? s : ''}` }, h('b', {}, counts[s]), s[0].toUpperCase() + s.slice(1))),
    h('div', { class: 'tile ok' }, h('b', {}, `${healthy}/${data.devices.length}`), 'Devices healthy'));

  const notice = data.channels.length ? null : h('section', { class: 'alert warning row' }, h('div', { class: 'grow' }, h('b', {}, 'No notification channel configured. '), 'Alerts are only visible here. Add ntfy or Pushover in config.json.'));

  const alerts = h('section', {}, h('h2', {}, 'Open alerts'),
    data.alerts.length
      ? h('div', { class: 'list' }, ...data.alerts.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || b.opened_at - a.opened_at).map(alertRow))
      : h('p', { class: 'muted' }, 'Nothing needs attention.'));

  const TYPE_LABEL = { unifi: 'UniFi', wifi: 'Wi-Fi', agent: 'PC', ping: 'ping', tcp: 'TCP' };
  const order = { critical: 0, warning: 1, routine: 2, unknown: 3, ok: 4 };
  const devices = h('section', {}, h('h2', {}, 'Devices'),
    h('div', { class: 'list' }, ...[...data.devices].sort((a, b) => order[a.status] - order[b.status] || (a.priority === 'critical' ? -1 : 1) - (b.priority === 'critical' ? -1 : 1) || a.name.localeCompare(b.name)).map((d) =>
      h('button', { class: 'row', onclick: () => openDevice(d.id) },
        h('span', { class: `dot ${d.online === 0 ? 'critical' : d.status}`, 'aria-hidden': 'true' }),
        h('span', { class: 'grow' }, h('div', {}, h('b', {}, d.name), d.priority === 'critical' ? h('span', { class: 'badge critical gap' }, 'critical') : null),
          h('div', { class: 'small muted' }, `${statusLabel(d)} · ${TYPE_LABEL[d.type] || d.type} · seen ${ago(d.lastSeen)}${d.type === 'wifi' && d.extra?.ap ? ` on ${d.extra.ap}` : ''}`)),
        d.type === 'agent' ? h('span', { class: 'metrics' }, h('span', {}, `CPU ${pct(d.cpu)}`), h('span', {}, `RAM ${pct(d.memory)}`), h('span', {}, `Disk free ${pct(d.minDiskFree)}`)) : null))));

  const maint = h('section', {}, h('h2', {}, 'Maintenance schedule'),
    data.maintenance.length
      ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Task'), h('th', {}, 'Device'), h('th', {}, 'Last done'), h('th', {}, 'Due'))),
          h('tbody', {}, ...data.maintenance.slice(0, 40).map((m) => h('tr', {},
            h('td', {}, m.task), h('td', {}, m.device), h('td', {}, m.lastDone ? fmtDate(m.lastDone) : '—'),
            h('td', { class: m.overdue ? 'overdue' : '' }, m.overdue ? `Overdue (${fmtDate(m.due)})` : fmtDate(m.due))))))
      : h('p', { class: 'muted' }, 'No scheduled tasks in config.json.'),
    h('p', {}, h('button', { onclick: () => api('/api/test-notification', {}).then((r) => toast(r.ok.length ? `Sent via ${r.ok.join(', ')}` : `Failed: ${r.errors.join('; ') || 'no channels'}`)) }, 'Send test notification'), ' ',
      h('button', { onclick: () => api('/api/digest', {}).then(() => toast('Digest sent')) }, 'Send daily summary now')));

  $app.replaceChildren(header, h('main', {}, tiles, notice, alerts, h('div', { class: 'cols' }, devices, maint)));
}

function alertRow(a) {
  return h('div', { class: `row alert ${a.severity}` },
    h('span', { class: 'grow' },
      h('div', {}, h('b', {}, `${a.device_name || a.device_id}: ${a.title}`), ' ', h('span', { class: `badge ${a.severity}` }, a.severity)),
      h('div', { class: 'small' }, a.issue),
      a.action ? h('div', { class: 'small muted' }, `Action: ${a.action}`) : null,
      h('div', { class: 'small muted' }, `Since ${fmtTime(a.opened_at)}${a.acked_at ? ' · acknowledged' : ''}`)),
    !a.acked_at && a.resolved_at == null && a.kind === 'condition'
      ? h('button', { title: 'Stop reminders for this alert', onclick: () => api(`/api/alerts/${a.id}/ack`, {}).then(load) }, 'Acknowledge')
      : null);
}

// ---------- device detail ----------
function spark(metrics) {
  if (metrics.length < 2) return h('p', { class: 'small muted' }, 'Not enough history yet.');
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 300 70');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'CPU and memory usage, last 7 days');
  const t0 = metrics[0].ts;
  const span = Math.max(1, metrics.at(-1).ts - t0);
  for (const y of [0, 35, 70]) {
    const l = document.createElementNS(ns, 'line');
    Object.entries({ x1: 0, x2: 300, y1: y, y2: y, class: 'grid' }).forEach(([k, v]) => l.setAttribute(k, v));
    svg.append(l);
  }
  for (const [key, cls] of [['cpu', 'cpu'], ['memory', 'mem']]) {
    const pts = metrics.filter((m) => m[key] != null).map((m) => `${(((m.ts - t0) / span) * 300).toFixed(1)},${(70 - (m[key] / 100) * 70).toFixed(1)}`);
    const p = document.createElementNS(ns, 'polyline');
    p.setAttribute('points', pts.join(' '));
    p.setAttribute('class', cls);
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(p);
  }
  return h('div', {}, svg, h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'k-cpu' }), 'CPU'), h('span', {}, h('i', { class: 'k-mem' }), 'Memory'), h('span', {}, '0–100%, last 7 days')));
}

async function openDevice(id) {
  const d = await api(`/api/devices/${encodeURIComponent(id)}`);
  const r = d.report;
  const dlg = h('dialog', { 'aria-label': d.device.name });
  const close = () => {
    dlg.close();
    dlg.remove();
  };

  const facts = [];
  if (r?.osCaption) facts.push(['Windows', `${r.osCaption} (build ${r.osBuild})`]);
  if (r?.bootTime) facts.push(['Last restart', `${fmtTime(Date.parse(r.bootTime))} (${ago(Date.parse(r.bootTime))})`]);
  if (r?.updates) facts.push(['Updates', r.updates.error ? `check failing: ${r.updates.error}` : `${r.updates.pendingCount ?? 0} pending · last installed ${r.updates.lastInstallSuccess ? fmtTime(Date.parse(r.updates.lastInstallSuccess)) : 'unknown'}${r.updates.rebootRequired ? ' · restart required' : ''}`]);
  for (const k of r?.disks || []) facts.push([`Drive ${k.drive}`, `${k.freeGB.toFixed(1)} GB free of ${k.sizeGB.toFixed(0)} GB`]);
  for (const s of r?.services || []) facts.push([`Service ${s.name}`, s.status]);
  if (d.device.extra?.model) facts.push(['Model', d.device.extra.model]);
  if (d.device.extra?.ip || d.device.extra?.address) facts.push(['Address', d.device.extra.ip || d.device.extra.address]);
  if (r?.agentVersion) facts.push(['Agent', `v${r.agentVersion} on ${r.hostname}`]);
  facts.push(['Last check', `${fmtTime(d.device.lastSeen)} (${ago(d.device.lastSeen)})`]);

  const tasks = data.tasks;
  const task = h('select', {}, h('option', { value: '' }, 'Other / ad-hoc work'), ...tasks.map((t) => h('option', { value: t.id }, t.name)));
  const by = h('input', { maxlength: 100, autocomplete: 'name' });
  try { by.value = localStorage.getItem('performedBy') || ''; } catch {}
  const when = h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
  const notes = h('textarea', { rows: 2, maxlength: 4000 });
  const form = h('form', {
    class: 'grid',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        try { localStorage.setItem('performedBy', by.value); } catch {}
        // Midday local time, so the date doesn't shift across timezones.
        await api('/api/maintenance', { deviceId: id, taskId: task.value || null, performedBy: by.value, notes: notes.value, performedAt: `${when.value}T12:00:00` });
        toast('Maintenance logged');
        close();
        await load();
        openDevice(id);
      } catch (x) {
        toast(x.message);
      }
    },
  }, h('label', {}, 'Task', task), h('label', {}, 'Date', when), h('label', {}, 'Done by', by), h('label', { class: 'full' }, 'Notes', notes), h('div', { class: 'full' }, h('button', { class: 'primary', type: 'submit' }, 'Log maintenance')));

  dlg.append(
    h('div', { class: 'head' }, h('h2', {}, d.device.name), h('button', { onclick: close }, 'Close')),
    h('div', { class: 'body' },
      h('table', {}, h('tbody', {}, ...facts.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', {}, v))))),
      d.device.type === 'agent' ? h('div', {}, h('h2', {}, 'Performance'), spark(d.metrics)) : null,
      h('div', {}, h('h2', {}, 'Log maintenance'), form),
      h('div', {}, h('h2', {}, 'Maintenance history'),
        d.maintenance.length
          ? h('table', {}, h('tbody', {}, ...d.maintenance.map((m) => h('tr', {}, h('td', {}, fmtDate(m.performed_at)), h('td', {}, tasks.find((t) => t.id === m.task_id)?.name || m.task_id || 'Ad-hoc'), h('td', {}, m.performed_by || ''), h('td', {}, m.notes || '')))))
          : h('p', { class: 'small muted' }, 'No maintenance logged yet.')),
      h('div', {}, h('h2', {}, 'Alert history'),
        d.alerts.length
          ? h('table', {}, h('tbody', {}, ...d.alerts.map((a) => h('tr', {}, h('td', {}, fmtTime(a.opened_at)), h('td', {}, h('span', { class: `badge ${a.severity}` }, a.severity)), h('td', {}, a.title, h('div', { class: 'muted' }, a.issue)), h('td', {}, a.resolved_at ? (a.kind === 'event' ? 'event' : `cleared ${fmtTime(a.resolved_at)}`) : 'OPEN')))))
          : h('p', { class: 'small muted' }, 'No alerts recorded.'))),
  );
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

api('/api/overview').then(start, () => showLogin());
