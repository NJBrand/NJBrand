// Loads config.json and fills in defaults so the rest of the code never has to guess.
import fs from 'node:fs';

export const DEFAULTS = {
  checkinIntervalMinutes: 5,
  offlineAfterMinutes: 10, // two missed check-ins
  maxUptimeDays: 30,
  disk: { warnPercentFree: 15, criticalPercentFree: 5 },
  cpu: { warnPercent: 90, sustainedMinutes: 15 },
  memory: { warnPercent: 90, sustainedMinutes: 15 },
  updates: { maxDaysSinceInstall: 35 },
  probeIntervalSeconds: 60,
  probeFailuresBeforeAlert: 3,
};

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? { ...base[k], ...v } : v;
  }
  return out;
}

export function normalizeConfig(raw) {
  const defaults = merge(DEFAULTS, raw.defaults);
  const timezone = raw.timezone || process.env.TZ || 'UTC';
  const seen = new Set();
  const devices = (raw.devices || []).map((d) => {
    if (!ID_RE.test(d.id || '')) throw new Error(`Device id "${d.id}" must be lowercase letters, digits, . _ - (e.g. "front-desk-1")`);
    if (seen.has(d.id)) throw new Error(`Duplicate device id "${d.id}"`);
    seen.add(d.id);
    const type = d.type || 'agent';
    if (!['agent', 'ping', 'tcp'].includes(type)) throw new Error(`Device ${d.id}: type must be agent, ping or tcp`);
    if (type !== 'agent' && !d.address) throw new Error(`Device ${d.id}: "address" is required for ${type} checks`);
    if (type === 'tcp' && !d.port) throw new Error(`Device ${d.id}: "port" is required for tcp checks`);
    const priority = d.priority || 'standard';
    if (!['critical', 'standard'].includes(priority)) throw new Error(`Device ${d.id}: priority must be critical or standard`);
    const backups = (d.backups || []).map((b) => {
      if (!b.name) throw new Error(`Device ${d.id}: every backup rule needs a name`);
      return { maxAgeHours: 26, ...b };
    });
    return { ...merge(defaults, d), id: d.id, name: d.name || d.id, type, priority, services: d.services || [], backups, timezone };
  });

  const n = raw.notifications || {};
  return {
    timezone,
    defaults,
    devices,
    notifications: {
      ntfy: n.ntfy || null,
      pushover: n.pushover || null,
      webhook: n.webhook || null,
      digestTime: n.digestTime || '07:30',
      renotifyCriticalHours: n.renotifyCriticalHours ?? 4,
      recovery: n.recovery ?? true,
    },
    unifi: raw.unifi ? { pollSeconds: 120, failuresBeforeAlert: 2, site: 'default', insecureTls: true, devices: {}, defaultPriority: 'standard', ...raw.unifi } : null,
    maintenance: (raw.maintenance || []).map((m) => {
      if (!ID_RE.test(m.id || '') || !(m.intervalDays > 0)) throw new Error(`Maintenance task needs an id and intervalDays: ${JSON.stringify(m)}`);
      return { devices: ['*'], ...m, name: m.name || m.id };
    }),
    heartbeatUrl: raw.heartbeatUrl || null,
  };
}

export function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read config ${file}: ${e.message}. Copy config.example.json to config.json to get started.`);
  }
  return normalizeConfig(raw);
}

export function maintenanceAppliesTo(task, device) {
  return task.devices.includes('*') || task.devices.includes(device.id);
}
