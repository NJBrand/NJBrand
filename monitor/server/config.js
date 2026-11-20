// Loads config.json and fills in defaults so the rest of the code never has to guess.
import fs from 'node:fs';
import { normalizeMac } from './unifi.js';

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
// critical: outages push as Critical; standard: as Warning; low: daily summary only (never buzzes the phone).
const PRIORITIES = ['critical', 'standard', 'low'];

// Wi-Fi clients (e.g. guest-room tablets) watched through UniFi: alert when one hasn't been connected for a while.
function normalizeClients(u) {
  const defaults = { offlineAfterMinutes: 30, priority: 'low', ...u.clientDefaults };
  const seen = new Set();
  return (u.clients || []).map((c) => {
    const mac = normalizeMac(c.mac);
    if (!mac) throw new Error(`UniFi client ${JSON.stringify(c.name || c.mac)}: "mac" must be a MAC address like aa:bb:cc:dd:ee:ff`);
    if (seen.has(mac)) throw new Error(`UniFi client ${mac} is listed twice`);
    seen.add(mac);
    const out = { ...defaults, ...c, mac, name: c.name || mac };
    if (!PRIORITIES.includes(out.priority)) throw new Error(`UniFi client ${out.name}: priority must be ${PRIORITIES.join(', ')}`);
    if (!(out.offlineAfterMinutes > 0)) throw new Error(`UniFi client ${out.name}: offlineAfterMinutes must be a positive number`);
    return out;
  });
}

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
    if (!PRIORITIES.includes(priority)) throw new Error(`Device ${d.id}: priority must be ${PRIORITIES.join(', ')}`);
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
      // The placeholder topic from the starter/example config is public: never send alerts to it.
      ntfy: n.ntfy?.topic && !/^CHANGE-ME/i.test(n.ntfy.topic) ? n.ntfy : null,
      pushover: n.pushover || null,
      webhook: n.webhook || null,
      digestTime: n.digestTime || '07:30',
      renotifyCriticalHours: n.renotifyCriticalHours ?? 4,
      recovery: n.recovery ?? true,
    },
    unifi: raw.unifi ? { pollSeconds: 120, failuresBeforeAlert: 2, site: 'default', insecureTls: true, devices: {}, defaultPriority: 'standard', ...raw.unifi, clients: normalizeClients(raw.unifi) } : null,
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
