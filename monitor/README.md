# IT Monitor: monitoring, alerts and maintenance records

A small self-hosted system that watches the office's computers and network equipment, alerts
your phone when something breaks, and keeps a history of equipment health and maintenance.

- **Zero dependencies.** Node.js 22.13+ built-ins only (same approach as the Vault app in this repo).
- **Windows agent** is a read-only PowerShell script run by Task Scheduler. Nothing to buy or license.
- **Alerts** go to the free [ntfy](https://ntfy.sh) app (iPhone/Android/desktop), Pushover, or any webhook.

## What it checks

| Check | How | Default alert |
|---|---|---|
| Computer offline | No agent check-in for 10 min (2 missed check-ins) | **Critical** on `critical` devices, otherwise Warning |
| Printer / NAS / switch down | Ping or TCP port, 3 failures in a row | same as above |
| Low disk space | ≤15% free → Warning, ≤5% → **Critical** | Warning / Critical |
| High CPU / memory | ≥90% sustained for 15 min (3 check-ins in a row) | Warning |
| Critical service stopped | Services you list per device, stopped for 2 check-ins | Critical / Warning |
| Unexpected restart | Event ID 41 (Kernel-Power) and 6008 | Warning (one-off event) |
| Windows updates pending / restart pending | Windows Update API, at most every 6 h | Routine (daily summary) |
| Updates not installing | No successful install in 35 days | Warning |
| Restart overdue | Up more than 30 days | Routine |
| Backup failed / missed | Event-log success/failure IDs, or the newest file in a folder | Warning |
| UniFi device offline / firmware | UniFi Network official API | Critical / Warning / Routine |
| Scheduled maintenance overdue | Your own tasks, e.g. clean fans every 180 days | Routine |

**Notification rules:** Critical and Warning alerts push immediately, **once**, with a recovery message
when they clear. Unacknowledged Critical alerts repeat every 4 hours. Routine items never buzz your
phone. They go into one **daily summary** at 07:30, which also tells you each morning that monitoring is
alive. Every threshold is configurable globally and per device.

Example push:

```
IT ALERT — Front Desk PC: Computer offline
Device: Front Desk PC
Issue: Computer not responding (no check-in for 11 minutes)
Last successful check: 10:42 AM
Priority: Critical
Action: Investigate connectivity and system availability
```

## Install the server

Use the same always-on machine as Vault (see `../DEPLOY.md`), or any always-on PC on the office network.
It must be **on the office LAN** (or on Tailscale with the PCs) so agents can reach it.

```bash
sudo useradd --system --home /var/lib/njmonitor --shell /usr/sbin/nologin njmonitor
sudo git clone https://github.com/NJBrand/NJBrand.git /opt/njbrand
sudo mkdir -p /etc/njmonitor
sudo cp /opt/njbrand/monitor/config.example.json /etc/njmonitor/config.json   # then edit it
echo "ADMIN_PASSWORD=$(openssl rand -base64 18)" | sudo tee /etc/njmonitor/env  # note this password
sudo chmod 600 /etc/njmonitor/env && sudo chown -R njmonitor /etc/njmonitor
sudo cp /opt/njbrand/monitor/deploy/njmonitor.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now njmonitor
cd /opt/njbrand/monitor && sudo -u njmonitor CONFIG=/etc/njmonitor/config.json npm run check-config
```

**Dashboard:** `sudo tailscale serve --bg --https=8443 8090` gives you `https://<machine>.<tailnet>.ts.net:8443`
on your phone. To use it over plain HTTP on the LAN instead, add `Environment=INSECURE_COOKIES=1` to the service.

**Firewall:** allow port 8090 from the office subnet only, e.g. `sudo ufw allow from 192.168.1.0/24 to any port 8090`.

## Set up phone alerts (ntfy, free)

1. Install **ntfy** from the App Store / Play Store.
2. Make up a long random topic name (anyone who knows it can read your alerts), e.g. `nj-it-7Hq2xPz9Lk4m`.
3. Subscribe to it in the app, and put it in `config.json` → `notifications.ntfy.topic`.
4. Restart the service. On the dashboard, press **Send test notification**.

On iPhone, allow ntfy's *Time Sensitive* notifications so Critical alerts get through Focus modes.

## Add a Windows PC

1. Add it to `devices` in `config.json` (`id`, `name`, `priority`, optional `services`/`backups`), then restart the service.
2. On the server: `CONFIG=/etc/njmonitor/config.json DATA_DIR=/var/lib/njmonitor npm run token -- front-desk-1`
3. Copy the `agent` folder to the PC. In an **elevated PowerShell**:
   ```powershell
   .\NJMonitor-Agent.ps1 -DryRun     # first: see exactly what it collects, nothing is sent
   powershell -ExecutionPolicy Bypass -File .\Install-Agent.ps1 -ServerUrl http://192.168.1.10:8090 -DeviceId front-desk-1 -Token <token>
   ```
The installer does a test check-in and refuses to schedule the task if it fails. Log: `C:\ProgramData\NJMonitor\agent.log`.

Find a service's real name with `Get-Service | Out-GridView` (use the **Name** column, e.g. `Spooler`, not "Print Spooler").

### Backup rules

- **Event log** (most backup software): `logName`, `providerName`, `successIds`, `failureIds`, `maxAgeHours`.
  The example uses Windows Server Backup IDs. **Verify the IDs for your software** by looking at a real
  success and failure in Event Viewer. Vendors differ, and a wrong ID means a silent "Backup missed".
- **File**: `"type": "file", "path": "D:\\Backups"` alerts if the newest file there is older than `maxAgeHours`.

## UniFi

In UniFi Network: **Settings → Control Plane → Integrations → Create API Key**. Copy the `_unifi_example`
block to `unifi`, fill in the console address and key, then run `npm run unifi-test` to confirm it lists your
devices. Mark important devices `critical` by MAC or name. All others default to `standard`.
This uses Ubiquiti's official local API (UniFi Network 9+). It is tested against a simulated controller,
**not yet against a real one**, so run `unifi-test` first.

## Who monitors the monitor?

If the server itself dies, nothing alerts. Two safeguards:
- The **daily summary** arrives every morning. If it doesn't arrive, something is wrong.
- Set `heartbeatUrl` to a free [healthchecks.io](https://healthchecks.io) check URL. It alerts you if pings stop.

## Development

```bash
npm test     # rule engine unit tests + end-to-end: real server, simulated agents, UniFi and webhook
```

## Known limits

- The **PowerShell agent has not yet been run on a real Windows PC.** Run `-DryRun` on one machine first.
- Agents send their token over plain HTTP on the LAN. Fine on a trusted office network. Use HTTPS (Caddy/Tailscale) if the network has untrusted devices.
- Config changes need a service restart.
