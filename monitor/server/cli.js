// Usage:
//   npm run token -- <device-id>     print the agent token + install command for a device
//   npm run check-config             validate config.json
//   npm run unifi-test               fetch devices and connected clients from UniFi once and print them
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { loadSecret, deviceToken } from './app.js';
import { fetchUnifi } from './unifi.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig(path.resolve(process.env.CONFIG || path.join(ROOT, 'config.json')));
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'token') {
  const d = config.devices.find((x) => x.id === arg);
  if (!d || d.type !== 'agent') {
    console.error(`No agent device "${arg}" in config. Agent devices: ${config.devices.filter((x) => x.type === 'agent').map((x) => x.id).join(', ')}`);
    process.exit(1);
  }
  const token = deviceToken(loadSecret(path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'))), d.id);
  console.log(`Device: ${d.name} (${d.id})\nToken:  ${token}\n`);
  console.log('On that PC, in an elevated PowerShell, from the folder containing the agent files:');
  console.log(`  powershell -ExecutionPolicy Bypass -File .\\Install-Agent.ps1 -ServerUrl ${process.env.SERVER_URL || 'http://<monitor-server>:8090'} -DeviceId ${d.id} -Token ${token}`);
} else if (cmd === 'check-config') {
  console.log(`OK: ${config.devices.length} devices, ${config.maintenance.length} maintenance tasks, timezone ${config.timezone}`);
  for (const d of config.devices) console.log(`  ${d.id.padEnd(24)} ${d.type.padEnd(6)} ${d.priority.padEnd(9)} ${d.name}`);
  const n = config.notifications;
  console.log(`Notifications: ${['ntfy', 'pushover', 'webhook'].filter((k) => n[k]).join(', ') || 'NONE CONFIGURED'}`);
  if (config.unifi) console.log(`UniFi: ${config.unifi.url}, ${config.unifi.clients.length} Wi-Fi clients watched`);
} else if (cmd === 'unifi-test') {
  if (!config.unifi) {
    console.error('No "unifi" section in config.');
    process.exit(1);
  }
  const { devices: list, clients } = await fetchUnifi(config.unifi, { clients: true });
  for (const d of list) console.log(`${d.down ? 'DOWN' : 'up  '}  ${d.state.padEnd(22)} ${d.mac}  ${d.name}  ${d.model || ''} ${d.ip || ''}`);
  console.log(`${list.length} devices
`);
  // Connected clients, so you can copy tablet MAC addresses into "unifi.clients". * = already watched.
  const watched = new Set(config.unifi.clients.map((c) => c.mac));
  const ap = new Map(list.filter((d) => d.id).map((d) => [d.id, d.name]));
  for (const c of [...clients].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    console.log(`${watched.has(c.mac) ? '*' : ' '} ${c.mac}  ${String(c.type || '').padEnd(9)} ${String(c.ip || '').padEnd(15)} ${c.name || ''}${ap.get(c.uplinkDeviceId) ? `  (on ${ap.get(c.uplinkDeviceId)})` : ''}`);
  }
  console.log(`${clients.length} connected clients`);
  const missing = config.unifi.clients.filter((c) => !clients.some((x) => x.mac === c.mac));
  if (missing.length) console.log(`Watched but not connected right now: ${missing.map((c) => `${c.name} (${c.mac})`).join(', ')}`);
} else {
  console.error('Commands: token <device-id> | check-config | unifi-test');
  process.exit(1);
}
