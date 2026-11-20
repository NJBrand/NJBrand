# IT Monitor: step-by-step install

Follow the parts in order. Each step says exactly where to click or what to type.
Budget about an hour for Parts 1 to 4, then about 5 minutes per PC.

| Part | What | Where |
|---|---|---|
| 1 | Prepare the server PC | The always-on PC that will run the monitor |
| 2 | Install the server | Server PC |
| 3 | Phone (and PC) alerts | Your phone + server PC |
| 4 | Connect UniFi, add the tablets | UniFi + server PC + each tablet |
| 5 | Add each Windows PC | Server PC + each PC |
| 6 | Printers, NAS and other network gear | Server PC |
| 7 | Test that alerts really arrive | |
| 8 | Updating later | |

---

## How to open an "elevated PowerShell" (you will do this a lot)

1. Click **Start**, type `PowerShell`.
2. Right-click **Windows PowerShell** → **Run as administrator** → **Yes**.
3. The window title starts with **Administrator:**. If it doesn't, close it and try again.

To paste into PowerShell: right-click inside the window (or Ctrl+V).

## How to edit the config file

Most settings live in one file, `C:\ProgramData\NJMonitor-Server\config.json`. It's protected, so open it from an elevated PowerShell:

```powershell
notepad C:\ProgramData\NJMonitor-Server\config.json
```

Edit, **save** (Ctrl+S), close Notepad, then apply the change:

```powershell
powershell -ExecutionPolicy Bypass -File C:\NJBrand\monitor\deploy\windows\NJMonitor-Server.ps1 restart
```

`restart` checks the file first. If you made a typo it says what's wrong and keeps the server running with the old settings, so you can't break it by editing.
JSON rules that catch people out:
- Text goes in `"double quotes"`. Items in a list are separated by commas, and there's **no comma after the last one**.
- In Windows paths, write each backslash twice: `"D:\\Backups"`.

---

## Part 1: Prepare the server PC

Pick a Windows 10/11 PC that is **always on** and **plugged into the office network with a cable**. This can't be a laptop that goes home.

1. **Never sleep:** Settings → System → Power (& battery) → Screen and sleep → set every **"Sleep"** option to **Never**.
   (The screen turning off is fine.)
2. **Install Node.js:** open https://nodejs.org, download the **LTS** version, run it, and click Next through everything with the defaults.
3. **Give it a fixed IP address in UniFi**, so the PCs can always find it:
   1. Open UniFi Network (https://unifi.ui.com, or your console's address) → **Client Devices**.
   2. Find this PC (search its name), click it, open **Settings** (the gear tab).
   3. Turn on **Fixed IP Address**, keep the address it shows (e.g. `192.168.1.50`), and click **Apply**.
   4. **Write this address down.** It's the "server address" used everywhere below.
4. **Get the files:**
   1. On the server PC, sign in to GitHub in a browser and open this link (it downloads a ZIP):
      https://github.com/NJBrand/NJBrand/archive/refs/heads/claude/it-monitoring-maintenance-system-plrdgu.zip
   2. Open the ZIP. Inside is one folder named like `NJBrand-claude-it-monitoring-…`.
      Drag that folder to `C:\` and **rename it to `NJBrand`**.
   3. Check that this folder exists: `C:\NJBrand\monitor\deploy\windows`.

## Part 2: Install the server

In an **elevated PowerShell** on the server PC:

```powershell
powershell -ExecutionPolicy Bypass -File C:\NJBrand\monitor\deploy\windows\NJMonitor-Server.ps1 install
```

It takes about a minute, and at the end it shows:
- **`Dashboard admin password: …`** in yellow. **Write it down now.** You can look it up again later with
  `notepad C:\ProgramData\NJMonitor-Server\server.env`.
- **`NJMonitor server is running. Dashboard: http://192.168.1.50:8090`**

Check it: on any PC in the office, open that dashboard address in a browser and sign in with the password.
It's empty for now, which is correct.

If you see `Node.js not found`, close PowerShell, open a new elevated one, and try again (it needs a fresh window after installing Node).
If you see a warning about sleep, go back to Part 1 step 1.

## Part 3: Phone (and PC) alerts

Alerts go through **ntfy**, a free notification app.

1. **Make up a secret channel name.** Anyone who knows it can read your alerts, so make it long and random. In PowerShell:
   ```powershell
   "nj-it-" + -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ })
   ```
   It prints something like `nj-it-k3x9q2m7ab4zt1yw`. Copy it.
2. **On your phone:** install **ntfy** (App Store / Google Play) → tap **+** → paste the name → **Subscribe**.
   - iPhone: when asked, **allow notifications**. Then Settings → Notifications → ntfy → turn on **Time Sensitive Notifications**, so critical alerts get through Focus / Do Not Disturb.
   - Android: allow notifications when asked.
3. **On a PC (optional):** open https://ntfy.sh/app in Chrome or Edge → **Subscribe to topic** → paste the name → allow browser notifications. Keep that tab pinned.
4. **Tell the server:** open the config (see "How to edit the config file") and replace `CHANGE-ME-to-a-long-random-string` with your name:
   ```json
   "ntfy": { "server": "https://ntfy.sh", "topic": "nj-it-k3x9q2m7ab4zt1yw", "token": null },
   ```
   Save, then `restart`. The output should now say `Notifications: ntfy`.
5. **Test:** on the dashboard, press **Send test notification**. Your phone should buzz within seconds.

## Part 4: Connect UniFi, add the tablets

You need **UniFi Network 9.0 or newer**. Check under UniFi Network → Settings → Control Plane → Updates; update first if it's older.

### 4a. Create an API key

1. Open UniFi Network → **Settings** → **Control Plane** → **Integrations**.
2. Click **Create API Key**, name it `NJMonitor`, and click **Create**.
3. **Copy the key immediately.** It's only shown once. (If you lose it, delete it and create another one.)

### 4b. Find the console's local address

This is the address of your UniFi gateway/console (Dream Machine, Cloud Gateway, etc.), usually `192.168.1.1`.
In UniFi Network → **UniFi Devices**, click the gateway and note its **IP address**.
Use this local address, **not** unifi.ui.com.

### 4c. Add UniFi to the config

Open the config, find `"unifi": null,` and replace it with this (put in your own address and key):

```json
  "unifi": {
    "url": "https://192.168.1.1",
    "apiKey": "PASTE-YOUR-KEY-HERE",
    "site": "default",
    "clients": []
  },
```

Save, then `restart`, then check that it can read UniFi:

```powershell
powershell -ExecutionPolicy Bypass -File C:\NJBrand\monitor\deploy\windows\NJMonitor-Server.ps1 unifi-test
```

You should see your access points and switches first, then every **connected client** (phones, tablets, PCs) with its MAC address, IP and which access point it's on.
Your UniFi gear (APs, switches, gateway) now shows on the dashboard by itself, and you get an alert if any of it goes offline.

### 4d. Set up each tablet (do this BEFORE copying its MAC address)

Tablets normally use a "private" random Wi-Fi address that can change, which would make them look offline.
Turning it off changes the address once, which is why you do it first.

- **iPad:** Settings → Wi-Fi → tap **ⓘ** next to the hotel network → **Private Wi-Fi Address: Off** (on newer iPadOS: **Off** in the drop-down) → **Rejoin** if asked.
- **Android / Samsung:** Settings → Wi-Fi → tap the gear next to the network → (View more / Advanced) → **Privacy** or **MAC address type** → **Use device MAC** / **Phone MAC**.
- **Amazon Fire:** nothing to change.

Also make sure each tablet stays **plugged in** and doesn't turn Wi-Fi off when asleep.
Tip: give each tablet a clear name in UniFi (Client Devices → click it → change the **Alias** to `Room 101 tablet`). Then it's easy to spot in `unifi-test`.

### 4e. Add the tablets to the config

1. Run `unifi-test` again and find each tablet's MAC address (looks like `a4:83:e7:12:34:56`).
2. In the config, fill in `"clients"`, one line per tablet, **comma after every line except the last**:
   ```json
       "clients": [
         { "mac": "a4:83:e7:12:34:56", "name": "Room 101 tablet" },
         { "mac": "a4:83:e7:12:34:57", "name": "Room 102 tablet" },
         { "mac": "a4:83:e7:12:34:99", "name": "Front desk tablet", "priority": "standard" }
       ]
   ```
3. Save, then `restart`. Run `unifi-test` once more: watched tablets have a `*` in front, and it lists any watched tablet it can't currently see.

**How loud are tablet alerts?**
- No priority given (the default `low`): a tablet that's off Wi-Fi for **30 minutes** goes in the **7:30 AM daily summary**. Your phone doesn't buzz, so a guest unplugging one overnight won't wake you.
- `"priority": "standard"`: your phone gets a push alert right away. Use this for tablets that must work, like the front desk.
- To change the 30 minutes, add `"offlineAfterMinutes": 15` to a tablet's line.

## Part 5: Add each Windows PC

Repeat for every PC (front desk, back office, office server and so on). **Don't** do the server PC itself unless you also want it monitored.

### 5a. On the server: add the PC to the config

Pick a short id for the PC: lowercase letters, numbers and dashes only, e.g. `front-desk-1`. Then add it inside `"devices": [ ]`:

```json
  "devices": [
    { "id": "front-desk-1", "name": "Front Desk PC", "priority": "critical", "services": ["Spooler"] },
    { "id": "back-office-1", "name": "Back Office PC" }
  ],
```

- `"priority": "critical"` gives the loudest alerts (repeated every 4 hours). Leave it out for normal PCs.
- `"services"` is optional: Windows services that must be running (`Spooler` is printing). To find a service's name, run
  `Get-Service | Sort-Object DisplayName | Format-Table Name, DisplayName` and use the **Name** column.

Save, then `restart`.

### 5b. On the server: get the install command for that PC

```powershell
powershell -ExecutionPolicy Bypass -File C:\NJBrand\monitor\deploy\windows\NJMonitor-Server.ps1 token front-desk-1
```

It prints a ready-made command starting with `powershell -ExecutionPolicy Bypass -File .\Install-Agent.ps1 -ServerUrl http://…`.
Copy that whole line into a Notepad file on a **USB stick**, e.g. `front-desk-1.txt`.
Treat it like a password. It's what lets that PC report in.

### 5c. Copy the agent to the USB stick

Copy the folder `C:\NJBrand\monitor\agent` onto the same USB stick.

### 5d. On the PC: install

1. Plug in the USB stick and note its drive letter (e.g. `E:`).
2. Open an **elevated PowerShell** on that PC and go to the agent folder:
   ```powershell
   cd E:\agent
   ```
3. Paste the command from `front-desk-1.txt` and press Enter.
4. Wait about a minute. You should see **`Check-in succeeded.`** then **`Installed.`**
5. Within 5 minutes the PC appears on the dashboard with its CPU, memory and disk.

If it says **Check-in failed**, see Troubleshooting below; nothing is installed until the check-in works.
To remove the agent from a PC later: `powershell -ExecutionPolicy Bypass -File E:\agent\Install-Agent.ps1 -Uninstall`.

## Part 6: Printers, NAS and other network gear

Anything without the agent can be checked with ping. First give it a **fixed IP in UniFi** (same as Part 1 step 3), then add it to `"devices"`:

```json
    { "id": "office-printer", "name": "Office Printer", "type": "ping", "address": "192.168.1.60" },
    { "id": "nas", "name": "NAS", "type": "tcp", "address": "192.168.1.20", "port": 443, "priority": "critical" }
```

Use `"type": "tcp"` with a `"port"` for devices that don't answer ping (e.g. a NAS web page on port 443).
Your UniFi equipment doesn't need adding; Part 4 covers it.

## Part 7: Test that alerts really arrive

Do this once, so you trust it:
1. On the dashboard, press **Send test notification**: phone buzzes.
2. Shut down one monitored PC that's marked `critical`. Within about 10 minutes you get **"Computer offline"**. Turn it back on and you get a **resolved** message.
3. Next morning at 7:30 you get the daily summary.

## Part 8: Updating later

1. Download the ZIP again (Part 1 step 4) and replace `C:\NJBrand` with the new one.
2. Run `install` again (Part 2). It keeps your config, history and password.
3. If the update says the agent changed, re-run 5b to 5d on each PC (same id, new command).

---

## Troubleshooting

All commands below are run from an elevated PowerShell on the **server**, starting with
`powershell -ExecutionPolicy Bypass -File C:\NJBrand\monitor\deploy\windows\NJMonitor-Server.ps1`:

| You see | Do this |
|---|---|
| Is it running? | `… status`: "Responds: yes" means it's fine. `… logs` shows the last 50 log lines |
| PC install: `Check-in failed` … `Unable to connect` | On that PC run `Test-NetConnection 192.168.1.50 -Port 8090` (your server address). If it fails: wrong address, server off, or the PC is on a different network/VLAN than the server (see next row) |
| PCs on a different network (VLAN) than the server can't connect | The firewall only allows the server's own subnet. Allow your other office subnet, e.g. `Set-NetFirewallRule -Name NJMonitor-Server -RemoteAddress LocalSubnet,192.168.10.0/24` |
| PC install: `401 Unauthorized` | The id isn't in the config, the server wasn't restarted after adding it, or the command was mistyped. Redo 5a and 5b |
| `restart` says config.json has a problem | It names the problem (usually a missing comma or quote). Fix it and run `restart` again; the server kept running meanwhile |
| No notifications | `… check-config` must say `Notifications: ntfy`. Check the topic on your phone matches exactly, then use **Send test notification** |
| `unifi-test`: HTTP 401 | API key wrong. Create a new one (4a) |
| `unifi-test`: timed out / not reachable | Wrong console address in `"url"` (4b). It must start with `https://` |
| `unifi-test`: `site "default" not found` | It lists the available sites. Put the right one in `"site"` |
| A tablet always shows offline | Its MAC changed: the private address is still on (4d). Turn it off, run `unifi-test`, update the MAC |
| A PC shows offline but it's on | On that PC, open Task Scheduler → **NJMonitor Agent** → "Last Run Result" should be `0x0`. `0x2` means it can't reach the server; read `C:\ProgramData\NJMonitor\agent.log` |
| Forgot the dashboard password | `notepad C:\ProgramData\NJMonitor-Server\server.env` (the `ADMIN_PASSWORD=` line) |
