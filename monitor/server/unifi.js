// UniFi Network integration (official local API, UniFi Network 9.x+).
// Create the key in UniFi Network: Settings → Control Plane → Integrations → Create API Key.
// Requests: GET {url}/proxy/network/integration/v1/sites[/{siteId}/devices]  with header X-API-KEY.
//
// NOTE: written against Ubiquiti's published API shape; verify against your controller with
// `npm run unifi-test` before relying on it.
import http from 'node:http';
import https from 'node:https';

const DOWN_STATES = new Set(['OFFLINE', 'CONNECTION_INTERRUPTED', 'ISOLATED']);

function getJSON(cfg, path) {
  const url = new URL(cfg.url.replace(/\/$/, '') + path);
  const mod = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.get(
      url,
      {
        headers: { 'X-API-KEY': cfg.apiKey, Accept: 'application/json' },
        // UniFi consoles ship a self-signed certificate. Set insecureTls:false once you install a real one.
        rejectUnauthorized: !cfg.insecureTls,
        timeout: 10_000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`UniFi ${path}: HTTP ${res.statusCode} ${body.slice(0, 200)}`));
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`UniFi ${path}: response is not JSON`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('UniFi request timed out')));
    req.on('error', reject);
  });
}

async function paged(cfg, path) {
  const out = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = await getJSON(cfg, `${path}?offset=${offset}&limit=200`);
    const data = Array.isArray(page) ? page : page.data || [];
    out.push(...data);
    if (data.length < 200 || (page.totalCount && out.length >= page.totalCount)) break;
  }
  return out;
}

export async function fetchUnifiDevices(cfg) {
  const sites = await paged(cfg, '/proxy/network/integration/v1/sites');
  const site = sites.find((s) => s.internalReference === cfg.site || s.name === cfg.site || s.id === cfg.site) || (sites.length === 1 ? sites[0] : null);
  if (!site) throw new Error(`UniFi site "${cfg.site}" not found. Available: ${sites.map((s) => s.internalReference || s.name).join(', ')}`);
  const devices = await paged(cfg, `/proxy/network/integration/v1/sites/${site.id}/devices`);
  return devices.map((d) => ({
    mac: String(d.macAddress || d.id).toLowerCase(),
    name: d.name || d.model || d.macAddress,
    model: d.model || null,
    ip: d.ipAddress || null,
    state: d.state || 'UNKNOWN',
    down: DOWN_STATES.has(d.state),
    firmwareUpdatable: d.firmwareUpdatable === true,
  }));
}

// UniFi device ids in the monitor are "unifi-<mac without colons>".
export const unifiId = (mac) => `unifi-${mac.replace(/[^a-f0-9]/g, '')}`;
