# Vault: a self-hosted, end-to-end encrypted password manager with sharing

Store passwords in **vaults** and share a vault with anyone who has an account. Each person gets
owner, editor or viewer access. All encryption happens in the browser. The server stores only
ciphertext, so someone who steals the database (or runs the server) cannot read your passwords.

- **Zero dependencies.** Node.js 22.13+ built-ins only (`node:http`, `node:sqlite`, WebCrypto). Nothing to `npm install`, so no supply-chain risk.
- **Zero-knowledge.** The master password never leaves the browser.
- **Real revocation.** Removing someone rotates the vault key and re-encrypts every item.

## Run it

```bash
npm start          # http://127.0.0.1:8080, data stored in ./data
npm test           # end-to-end tests: real server, real crypto, multiple users
```

| Env var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `127.0.0.1` | Listen address. Keep it on localhost and put a TLS proxy in front. |
| `DATA_DIR` | `./data` | SQLite database + server secret. **Back this up.** |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy so rate limits use `X-Forwarded-For`. |
| `BACKUP_DIR` | `$DATA_DIR/backups` | Where automatic backups go. Point it at an off-machine/synced folder. |
| `BACKUP_INTERVAL_HOURS` / `BACKUP_KEEP` | `24` / `14` | Backup frequency and how many to retain. `BACKUP_DISABLED=1` turns them off. |
| `INSECURE_COOKIES` | off | Set `1` *only* for plain-HTTP testing on a non-localhost host. |

**Hosting, phone access and backups: see [DEPLOY.md](DEPLOY.md).** The recommended setup is an always-on
home machine reachable privately through Tailscale. The app installs to your phone's home screen.

### Public deployment (HTTPS required)

Browsers only expose WebCrypto on HTTPS (or `localhost`), and the session cookie is `Secure`.
The simplest setup is [Caddy](https://caddyserver.com), which gets certificates automatically:

```
vault.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then run the app with `TRUST_PROXY=1 npm start` under systemd (or similar), and back up `DATA_DIR` regularly.

## How sharing works

1. Each user has an ECDH P-256 keypair. The private key is encrypted with a key derived from their master password.
2. Each vault has a random AES-256 key. For every member, that key is sealed (ECIES) to the member's public key.
3. To share, the owner looks up the person, **verifies their key fingerprint out-of-band** (the person can see their own under *Account*), and seals the vault key to them.
4. To revoke, the owner's browser generates a new vault key, re-encrypts every item and re-seals the key for the remaining members. The server applies all of it in one atomic transaction.

## Security design

| Layer | Mechanism |
|---|---|
| Master password | PBKDF2-SHA256, 600,000 iterations, random 16-byte salt → HKDF splits into an **auth key** and an **encryption key** |
| Login | The server stores `scrypt(authKey)` with its own salt, so a stolen DB can't be replayed to log in. Constant-time comparison, dummy work for unknown accounts |
| Data at rest | AES-256-GCM. Every ciphertext is bound (AAD) to its vault, item, user and key version, so the server can't swap or replay ciphertexts undetected |
| Sessions | 256-bit random token, stored hashed. `__Host-` cookie, `HttpOnly; Secure; SameSite=Strict`. 30-min idle / 12-h absolute expiry |
| CSRF | SameSite=Strict, plus a required custom header, plus an Origin check |
| XSS | Strict CSP (`script-src 'self'`, no inline). The UI never uses `innerHTML`. Only `http(s)` links are clickable |
| Abuse | Per-IP and per-account rate limits on login/registration. Account enumeration is resisted at login (fake salts) |
| Client | Auto-lock after 10 min idle, or after 2 min in the background on phones (keys wiped from memory). Clipboard cleared 30 s after copy |
| Access control | Server-enforced roles. Writes with a stale vault key are rejected |

### Honest limitations: read these

- **No recovery.** Forget your master password and your data is gone. That is the price of zero-knowledge.
- **Trust in the server's JavaScript.** As with every web-based E2E app (Bitwarden web vault, etc.), a compromised server could serve malicious JS that steals passwords as you type. Protect the host. A browser extension or desktop client would remove this risk.
- **Key substitution.** A malicious server could hand you a fake public key when you share. Fingerprint verification defeats this, but only if people actually compare fingerprints. Rotation also re-reads members' public keys from the server.
- **Revocation is cryptographic, not magic.** A removed member keeps anything they already viewed or copied. Change those passwords if it matters.
- **Viewers hold the key.** "Viewer" is enforced by the server. A viewer can still decrypt everything in the vault, and that is the point of sharing.
- **Registration reveals existing emails** (a 409 response), and signed-in users can check whether an email has an account (needed to share). Both are rate limited.
- **Not independently audited.** The design uses standard primitives and well-known patterns, but get a professional review before trusting it with high-value secrets for a team.
- PBKDF2 is used because Argon2 is not in WebCrypto. 600k iterations follows current OWASP guidance.

## Layout

```
server/server.js     HTTP API, auth, sessions, access control, static files (whitelisted)
server/db.js         SQLite schema
server/backup.js     Online snapshots, verification, retention; backup-cli.js for backup/restore
public/js/crypto.js  All cryptography (WebCrypto)
public/js/client.js  Vault client: account, vault, item and sharing flows (shared by UI and tests)
public/js/app.js     UI
test/vault.test.js   End-to-end tests
```
