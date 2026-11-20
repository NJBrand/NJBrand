// Agentless checks for printers, switches, NAS boxes etc.: ICMP ping (via the OS ping command) or TCP connect.
import net from 'node:net';
import { execFile } from 'node:child_process';

export function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const HOST_RE = /^[a-zA-Z0-9.:-]+$/; // hostnames / IPv4 / IPv6 only, never passed through a shell anyway

export function pingProbe(host, timeoutMs = 3000) {
  if (!HOST_RE.test(host)) return Promise.resolve(false);
  const win = process.platform === 'win32';
  const args = win ? ['-n', '1', '-w', String(timeoutMs), host] : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), host];
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: timeoutMs + 2000 }, (err, stdout) => {
      // Windows ping exits 0 on "Destination host unreachable", so also require a TTL in the reply.
      resolve(!err && (!win || /TTL=/i.test(stdout)));
    });
  });
}

export function probeDevice(device) {
  return device.type === 'tcp' ? tcpProbe(device.address, device.port) : pingProbe(device.address);
}
