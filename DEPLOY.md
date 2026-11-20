# Deploying Vault

## Recommended: an always-on home machine + Tailscale

**Why:** the server is never exposed to the public internet. Only your devices, and the people
you explicitly invite, can even reach it. That greatly reduces the biggest risk for any web-based
password manager: someone compromising the server. Tailscale also gives you a real HTTPS
certificate (which the app requires) with no domain, port forwarding or router config. It's free
for personal use.

**What you need:** a machine that stays on (an old laptop, a mini PC or a Raspberry Pi 4/5 are all
plenty), Node.js 22.13+, and a free Tailscale account.

### 1. Set up the machine (Linux, e.g. Ubuntu/Debian/Raspberry Pi OS)

```bash
# Node.js 22 (via NodeSource or your distro; check `node -v` is >= 22.13)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs git

# App + a dedicated, unprivileged user
sudo useradd --system --home /var/lib/vault --shell /usr/sbin/nologin vault
sudo git clone https://github.com/NJBrand/NJBrand.git /opt/vault
sudo cp /opt/vault/deploy/vault.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now vault
curl -s http://127.0.0.1:8080/ | head -3      # should print HTML
```

### 2. Make it reachable from your phone and laptop

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
sudo tailscale serve --bg 8080
```

In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (DNS page).
`tailscale serve status` prints your URL, like `https://vault-pc.your-tailnet.ts.net`.

Install the Tailscale app on your phone, sign in, and open that URL. Then:
- **iPhone:** Safari → Share → *Add to Home Screen*
- **Android:** Chrome → ⋮ → *Install app*

It opens full-screen like a native app.

### 3. Giving other people access

Either invite them to your tailnet, or use Tailscale's **share a machine** feature so they reach only
this one machine. Check the current free-plan user limits on tailscale.com. Each person then
creates their own Vault account, and you share vaults with them inside the app.

### Windows instead of Linux?

It works: install Node.js 22 LTS and Tailscale for Windows, copy the project to `C:\vault`,
and run `npm start` at boot via Task Scheduler (*At startup*, "Run whether user is logged on or not",
with environment variables set as in `deploy/vault.service`). Then run `tailscale serve --bg 8080` once.
Linux is preferred for an always-on server: it's simpler to lock down and update.

## Alternative: public server (VPS)

If people need access without installing Tailscale, use a small VPS ($4–6/month) with a domain and
Caddy for HTTPS (see README). Trade-off: the login page is on the public internet, so you take on
patching the OS, monitoring and firewalling. Don't choose this unless you need it.

## Backups

The server takes a verified snapshot every `BACKUP_INTERVAL_HOURS` (default 24) and keeps the newest
`BACKUP_KEEP` (default 14). The first one runs about 10 seconds after start. Failures are logged as
`[backup] FAILED` (`journalctl -u vault | grep backup`).

```bash
npm run backup                         # take one now (safe while running)
npm run backup -- --list
npm run backup -- --verify <file>
sudo systemctl stop vault
npm run restore -- <file> --yes        # makes a safety copy of the current DB first
sudo systemctl start vault
```

**A backup on the same disk is not a backup.** Copy them off the machine: set `BACKUP_DIR` to a
synced/NAS folder, or add a nightly `rclone copy /var/lib/vault/backups remote:vault-backups`.
Backups contain only encrypted vault data, but they *do* include email addresses and enough to
attempt offline guessing of master passwords. So keep them private, and use strong master passwords.

**Test a restore once** after setting this up. An untested backup is a hope, not a backup.

## Updating

```bash
cd /opt/vault && sudo git pull && sudo systemctl restart vault
```
