import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { openDatabase, tx } from './db.js';

const scrypt = promisify(crypto.scrypt);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_ITERATIONS = 600_000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};

// ---------------- validation ----------------
const RE = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  b64: /^[A-Za-z0-9+/]+={0,2}$/,
  aes: /^a1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/,
  sealed: /^e1\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]+={0,2}$/,
  email: /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/,
};
const ROLES = new Set(['owner', 'editor', 'viewer']);

function v(value, name, re, max = 4096) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || !re.test(value)) {
    fail(400, `Invalid ${name}`);
  }
  return value;
}
const vUuid = (x, n = 'id') => v(x, n, RE.uuid, 36);
const vAes = (x, n, max = 256 * 1024) => v(x, n, RE.aes, max);
const vSealed = (x, n = 'wrappedKey') => v(x, n, RE.sealed, 512);
const vRole = (x) => (ROLES.has(x) ? x : fail(400, 'Invalid role'));
function vEmail(x) {
  if (typeof x !== 'string') fail(400, 'Invalid email');
  const e = x.trim().toLowerCase();
  return v(e, 'email', RE.email, 254);
}
function vB64Len(x, name, bytes) {
  v(x, name, RE.b64, 1024);
  if (Buffer.from(x, 'base64').length !== bytes) fail(400, `Invalid ${name}`);
  return x;
}
function vArray(x, name, max = 10_000) {
  if (!Array.isArray(x) || x.length > max) fail(400, `Invalid ${name}`);
  return x;
}

// ---------------- rate limiting ----------------
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [k, e] of this.hits) if (e.reset <= now) this.hits.delete(k);
    }, 60_000).unref();
  }
  check(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) this.hits.set(key, (e = { count: 0, reset: now + this.windowMs }));
    if (e.count >= this.limit) fail(429, 'Too many attempts. Try again later.');
    e.count++;
  }
  clear(key) {
    this.hits.delete(key);
  }
}

// ---------------- helpers ----------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

async function hashAuthKey(authKeyB64, saltB64) {
  const buf = await scrypt(Buffer.from(authKeyB64, 'base64'), Buffer.from(saltB64, 'base64'), 32, SCRYPT);
  return buf.toString('base64');
}

function loadServerSecret(dataDir) {
  if (process.env.SERVER_SECRET) return Buffer.from(process.env.SERVER_SECRET, 'utf8');
  if (!dataDir) return crypto.randomBytes(32);
  const file = path.join(dataDir, 'server-secret');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    return fs.readFileSync(file);
  } catch {
    const s = crypto.randomBytes(32);
    fs.writeFileSync(file, s, { mode: 0o600, flag: 'wx' });
    return s;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error();
        resolve(obj);
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function securityHeaders(res, secure) {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
      "font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body ?? {});
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------------- app ----------------
export function createApp({ dbFile = ':memory:', dataDir = null, secureCookies = true, trustProxy = false } = {}) {
  const db = openDatabase(dbFile);
  const serverSecret = loadServerSecret(dataDir);
  const cookieName = secureCookies ? '__Host-sid' : 'sid';
  const ipLimiter = new RateLimiter(30, 15 * 60 * 1000);
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const dummySalt = crypto.randomBytes(16).toString('base64');

  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      `INSERT INTO users (id,email,kdf_salt,kdf_iterations,auth_hash,auth_salt,public_key,encrypted_private_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ),
    insertSession: db.prepare('INSERT INTO sessions (token_hash,user_id,created_at,last_seen) VALUES (?,?,?,?)'),
    session: db.prepare('SELECT * FROM sessions WHERE token_hash = ?'),
    touchSession: db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?'),
    membership: db.prepare('SELECT * FROM vault_members WHERE vault_id = ? AND user_id = ?'),
    vault: db.prepare('SELECT * FROM vaults WHERE id = ?'),
    myVaults: db.prepare(
      `SELECT v.id, v.encrypted_name, v.key_version, v.updated_at, m.role, m.wrapped_key,
              (SELECT COUNT(*) FROM vault_members x WHERE x.vault_id = v.id) AS member_count,
              (SELECT COUNT(*) FROM items i WHERE i.vault_id = v.id) AS item_count
         FROM vault_members m JOIN vaults v ON v.id = m.vault_id
        WHERE m.user_id = ? ORDER BY v.created_at`,
    ),
    members: db.prepare(
      `SELECT m.user_id, m.role, m.created_at, u.email, u.public_key
         FROM vault_members m JOIN users u ON u.id = m.user_id
        WHERE m.vault_id = ? ORDER BY m.created_at`,
    ),
    items: db.prepare('SELECT id, data, key_version, updated_at, updated_by FROM items WHERE vault_id = ?'),
    item: db.prepare('SELECT * FROM items WHERE id = ?'),
    audit: db.prepare('INSERT INTO audit_log (vault_id,user_id,action,target,created_at) VALUES (?,?,?,?,?)'),
    activity: db.prepare(
      `SELECT a.action, a.target, a.created_at, u.email
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.vault_id = ? ORDER BY a.id DESC LIMIT 100`,
    ),
  };

  setInterval(() => q.purgeSessions.run(now() - SESSION_IDLE_MS, now() - SESSION_MAX_MS), 5 * 60_000).unref();

  const audit = (vaultId, userId, action, target = null) => q.audit.run(vaultId, userId, action, target, now());

  function clientIp(req) {
    if (trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function setSessionCookie(res, token, maxAgeSec) {
    const parts = [`${cookieName}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (secureCookies) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = now();
    q.insertSession.run(sha256(token), userId, t, t);
    setSessionCookie(res, token, SESSION_MAX_MS / 1000);
  }

  function authenticate(req) {
    const token = parseCookies(req.headers.cookie)[cookieName];
    if (!token || token.length > 100) return null;
    const hash = sha256(token);
    const s = q.session.get(hash);
    if (!s) return null;
    const t = now();
    if (t - s.last_seen > SESSION_IDLE_MS || t - s.created_at > SESSION_MAX_MS) {
      q.deleteSession.run(hash);
      return null;
    }
    q.touchSession.run(t, hash);
    return { userId: s.user_id, tokenHash: hash };
  }

  function requireMember(vaultId, userId, roles) {
    const m = q.membership.get(vaultId, userId);
    if (!m) fail(404, 'Vault not found');
    if (roles && !roles.includes(m.role)) fail(403, 'You do not have permission for this action');
    return m;
  }

  function fakeSalt(email) {
    return crypto.createHmac('sha256', serverSecret).update(`salt:${email}`).digest().subarray(0, 16).toString('base64');
  }

  function profile(u) {
    return {
      id: u.id,
      email: u.email,
      kdfSalt: u.kdf_salt,
      kdfIterations: u.kdf_iterations,
      publicKey: u.public_key,
      encryptedPrivateKey: u.encrypted_private_key,
    };
  }

  // ---------------- routes ----------------
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$',
    );
    routes.push({ method, re, keys, handler, auth });
  };

  // --- auth ---
  route('GET', '/api/prelogin', async ({ url, req }) => {
    ipLimiter.check(`pre:${clientIp(req)}`);
    const email = vEmail(url.searchParams.get('email'));
    const u = q.userByEmail.get(email);
    // Unknown accounts get a stable fake salt so responses don't reveal who is registered.
    return { kdfSalt: u ? u.kdf_salt : fakeSalt(email), kdfIterations: u ? u.kdf_iterations : MIN_ITERATIONS };
  }, { auth: false });

  route('POST', '/api/register', async ({ body, req, res }) => {
    ipLimiter.check(`reg:${clientIp(req)}`);
    const email = vEmail(body.email);
    const kdfSalt = vB64Len(body.kdfSalt, 'kdfSalt', 16);
    const iters = body.kdfIterations;
    if (!Number.isInteger(iters) || iters < MIN_ITERATIONS || iters > 10_000_000) fail(400, 'Invalid kdfIterations');
    const authKey = vB64Len(body.authKey, 'authKey', 32);
    const publicKey = vB64Len(body.publicKey, 'publicKey', 91);
    const encPriv = vAes(body.encryptedPrivateKey, 'encryptedPrivateKey', 1024);
    const authSalt = crypto.randomBytes(16).toString('base64');
    const authHash = await hashAuthKey(authKey, authSalt);
    const id = crypto.randomUUID();
    try {
      q.insertUser.run(id, email, kdfSalt, iters, authHash, authSalt, publicKey, encPriv, now());
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) fail(409, 'An account with that email already exists');
      throw e;
    }
    startSession(res, id);
    return profile(q.userById.get(id));
  }, { auth: false });

  route('POST', '/api/login', async ({ body, req, res }) => {
    const ip = clientIp(req);
    ipLimiter.check(`login:${ip}`);
    const email = vEmail(body.email);
    const authKey = vB64Len(body.authKey, 'authKey', 32);
    loginLimiter.check(`login:${email}`);
    const u = q.userByEmail.get(email);
    const hash = await hashAuthKey(authKey, u ? u.auth_salt : dummySalt); // constant work either way
    if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'base64'), Buffer.from(u.auth_hash, 'base64'))) {
      fail(401, 'Invalid email or password');
    }
    loginLimiter.clear(`login:${email}`);
    startSession(res, u.id);
    return profile(u);
  }, { auth: false });

  route('POST', '/api/logout', async ({ req, res }) => {
    const s = authenticate(req);
    if (s) q.deleteSession.run(s.tokenHash);
    setSessionCookie(res, '', 0);
    return { ok: true };
  }, { auth: false });

  route('GET', '/api/me', async ({ user }) => profile(user));

  route('POST', '/api/account/password', async ({ body, user, session }) => {
    loginLimiter.check(`pwchange:${user.id}`);
    const current = vB64Len(body.currentAuthKey, 'currentAuthKey', 32);
    const hash = await hashAuthKey(current, user.auth_salt);
    if (!crypto.timingSafeEqual(Buffer.from(hash, 'base64'), Buffer.from(user.auth_hash, 'base64'))) {
      fail(401, 'Current password is incorrect');
    }
    const kdfSalt = vB64Len(body.kdfSalt, 'kdfSalt', 16);
    const iters = body.kdfIterations;
    if (!Number.isInteger(iters) || iters < MIN_ITERATIONS || iters > 10_000_000) fail(400, 'Invalid kdfIterations');
    const authKey = vB64Len(body.authKey, 'authKey', 32);
    const encPriv = vAes(body.encryptedPrivateKey, 'encryptedPrivateKey', 1024);
    const authSalt = crypto.randomBytes(16).toString('base64');
    const authHash = await hashAuthKey(authKey, authSalt);
    db.prepare(
      'UPDATE users SET kdf_salt=?, kdf_iterations=?, auth_hash=?, auth_salt=?, encrypted_private_key=? WHERE id=?',
    ).run(kdfSalt, iters, authHash, authSalt, encPriv, user.id);
    q.deleteOtherSessions.run(user.id, session.tokenHash); // sign out everywhere else
    loginLimiter.clear(`pwchange:${user.id}`);
    return { ok: true };
  });

  route('GET', '/api/users/lookup', async ({ url, user }) => {
    ipLimiter.check(`lookup:${user.id}`);
    const email = vEmail(url.searchParams.get('email'));
    const u = q.userByEmail.get(email);
    if (!u) fail(404, 'No user with that email. They need to create an account first.');
    return { id: u.id, email: u.email, publicKey: u.public_key };
  });

  // --- vaults ---
  route('GET', '/api/vaults', async ({ user }) => ({
    vaults: q.myVaults.all(user.id).map((r) => ({
      id: r.id,
      encryptedName: r.encrypted_name,
      keyVersion: r.key_version,
      role: r.role,
      wrappedKey: r.wrapped_key,
      memberCount: r.member_count,
      itemCount: r.item_count,
      updatedAt: r.updated_at,
    })),
  }));

  route('POST', '/api/vaults', async ({ body, user }) => {
    const id = vUuid(body.id);
    const name = vAes(body.encryptedName, 'encryptedName', 4096);
    const wrapped = vSealed(body.wrappedKey);
    tx(db, () => {
      if (q.vault.get(id)) fail(409, 'Vault already exists');
      const t = now();
      db.prepare('INSERT INTO vaults (id,encrypted_name,key_version,created_at,updated_at) VALUES (?,?,1,?,?)').run(id, name, t, t);
      db.prepare(
        'INSERT INTO vault_members (vault_id,user_id,role,wrapped_key,added_by,created_at) VALUES (?,?,?,?,?,?)',
      ).run(id, user.id, 'owner', wrapped, user.id, t);
      audit(id, user.id, 'vault.create');
    });
    return { id, keyVersion: 1 };
  });

  route('PATCH', '/api/vaults/:vaultId', async ({ params, body, user }) => {
    const vaultId = vUuid(params.vaultId);
    requireMember(vaultId, user.id, ['owner']);
    const name = vAes(body.encryptedName, 'encryptedName', 4096);
    db.prepare('UPDATE vaults SET encrypted_name=?, updated_at=? WHERE id=?').run(name, now(), vaultId);
    audit(vaultId, user.id, 'vault.rename');
    return { ok: true };
  });

  route('DELETE', '/api/vaults/:vaultId', async ({ params, user }) => {
    const vaultId = vUuid(params.vaultId);
    requireMember(vaultId, user.id, ['owner']);
    db.prepare('DELETE FROM vaults WHERE id = ?').run(vaultId);
    return { ok: true };
  });

  route('GET', '/api/vaults/:vaultId/activity', async ({ params, user }) => {
    const vaultId = vUuid(params.vaultId);
    requireMember(vaultId, user.id);
    return {
      activity: q.activity.all(vaultId).map((a) => ({
        action: a.action,
        target: a.target,
        at: a.created_at,
        email: a.email,
      })),
    };
  });

  // --- items ---
  route('GET', '/api/vaults/:vaultId/items', async ({ params, user }) => {
    const vaultId = vUuid(params.vaultId);
    requireMember(vaultId, user.id);
    return {
      items: q.items.all(vaultId).map((i) => ({
        id: i.id,
        data: i.data,
        keyVersion: i.key_version,
        updatedAt: i.updated_at,
      })),
    };
  });

  route('PUT', '/api/vaults/:vaultId/items/:itemId', async ({ params, body, user }) => {
    const vaultId = vUuid(params.vaultId);
    const itemId = vUuid(params.itemId, 'itemId');
    const data = vAes(body.data, 'data');
    return tx(db, () => {
      requireMember(vaultId, user.id, ['owner', 'editor']);
      const vault = q.vault.get(vaultId);
      // Reject writes made with a stale (rotated-out) vault key.
      if (body.keyVersion !== vault.key_version) fail(409, 'Vault key has changed. Reload and try again.');
      const existing = q.item.get(itemId);
      if (existing && existing.vault_id !== vaultId) fail(404, 'Item not found');
      const t = now();
      if (existing) {
        db.prepare('UPDATE items SET data=?, key_version=?, updated_by=?, updated_at=? WHERE id=?').run(data, vault.key_version, user.id, t, itemId);
      } else {
        db.prepare('INSERT INTO items (id,vault_id,data,key_version,updated_by,updated_at) VALUES (?,?,?,?,?,?)').run(itemId, vaultId, data, vault.key_version, user.id, t);
      }
      db.prepare('UPDATE vaults SET updated_at=? WHERE id=?').run(t, vaultId);
      audit(vaultId, user.id, existing ? 'item.update' : 'item.create', itemId);
      return { ok: true, updatedAt: t };
    });
  });

  route('DELETE', '/api/vaults/:vaultId/items/:itemId', async ({ params, user }) => {
    const vaultId = vUuid(params.vaultId);
    const itemId = vUuid(params.itemId, 'itemId');
    requireMember(vaultId, user.id, ['owner', 'editor']);
    const r = db.prepare('DELETE FROM items WHERE id = ? AND vault_id = ?').run(itemId, vaultId);
    if (!r.changes) fail(404, 'Item not found');
    audit(vaultId, user.id, 'item.delete', itemId);
    return { ok: true };
  });

  // --- sharing ---
  route('GET', '/api/vaults/:vaultId/members', async ({ params, user }) => {
    const vaultId = vUuid(params.vaultId);
    requireMember(vaultId, user.id);
    return {
      members: q.members.all(vaultId).map((m) => ({
        userId: m.user_id,
        email: m.email,
        role: m.role,
        publicKey: m.public_key,
        addedAt: m.created_at,
      })),
    };
  });

  route('POST', '/api/vaults/:vaultId/members', async ({ params, body, user }) => {
    const vaultId = vUuid(params.vaultId);
    const userId = vUuid(body.userId, 'userId');
    const role = vRole(body.role);
    const wrapped = vSealed(body.wrappedKey);
    return tx(db, () => {
      requireMember(vaultId, user.id, ['owner']);
      const vault = q.vault.get(vaultId);
      if (body.keyVersion !== vault.key_version) fail(409, 'Vault key has changed. Reload and try again.');
      const target = q.userById.get(userId);
      if (!target) fail(404, 'User not found');
      if (q.membership.get(vaultId, userId)) fail(409, 'That user already has access');
      db.prepare(
        'INSERT INTO vault_members (vault_id,user_id,role,wrapped_key,added_by,created_at) VALUES (?,?,?,?,?,?)',
      ).run(vaultId, userId, role, wrapped, user.id, now());
      audit(vaultId, user.id, 'member.add', `${target.email} (${role})`);
      return { ok: true };
    });
  });

  route('PATCH', '/api/vaults/:vaultId/members/:userId', async ({ params, body, user }) => {
    const vaultId = vUuid(params.vaultId);
    const userId = vUuid(params.userId, 'userId');
    const role = vRole(body.role);
    return tx(db, () => {
      requireMember(vaultId, user.id, ['owner']);
      const m = q.membership.get(vaultId, userId);
      if (!m) fail(404, 'Member not found');
      if (m.role === 'owner' && role !== 'owner') {
        const owners = db.prepare("SELECT COUNT(*) c FROM vault_members WHERE vault_id=? AND role='owner'").get(vaultId).c;
        if (owners <= 1) fail(400, 'A vault must keep at least one owner');
      }
      db.prepare('UPDATE vault_members SET role=? WHERE vault_id=? AND user_id=?').run(role, vaultId, userId);
      audit(vaultId, user.id, 'member.role', `${q.userById.get(userId).email} → ${role}`);
      return { ok: true };
    });
  });

  // Leave a vault you were added to.
  route('DELETE', '/api/vaults/:vaultId/membership', async ({ params, user }) => {
    const vaultId = vUuid(params.vaultId);
    return tx(db, () => {
      const m = requireMember(vaultId, user.id);
      if (m.role === 'owner') {
        const owners = db.prepare("SELECT COUNT(*) c FROM vault_members WHERE vault_id=? AND role='owner'").get(vaultId).c;
        if (owners <= 1) fail(400, 'You are the only owner. Delete the vault or make someone else an owner first.');
      }
      db.prepare('DELETE FROM vault_members WHERE vault_id=? AND user_id=?').run(vaultId, user.id);
      audit(vaultId, user.id, 'member.leave', user.email);
      return { ok: true };
    });
  });

  // Atomically rotate the vault key: re-encrypt every item and re-wrap the new key for
  // every remaining member, optionally removing members. This is how access is revoked:
  // a removed member's copy of the old key no longer decrypts anything.
  route('POST', '/api/vaults/:vaultId/rotate', async ({ params, body, user }) => {
    const vaultId = vUuid(params.vaultId);
    const remove = new Set(vArray(body.removeUserIds ?? [], 'removeUserIds', 1000).map((x) => vUuid(x, 'removeUserIds')));
    const name = vAes(body.encryptedName, 'encryptedName', 4096);
    const members = vArray(body.members, 'members', 1000).map((m) => ({
      userId: vUuid(m?.userId, 'members.userId'),
      wrappedKey: vSealed(m?.wrappedKey),
    }));
    const items = vArray(body.items, 'items', 50_000).map((i) => ({ id: vUuid(i?.id, 'items.id'), data: vAes(i?.data, 'items.data') }));

    return tx(db, () => {
      requireMember(vaultId, user.id, ['owner']);
      if (remove.has(user.id)) fail(400, 'You cannot remove yourself this way. Use "Leave vault".');
      const vault = q.vault.get(vaultId);
      if (body.expectedKeyVersion !== vault.key_version) fail(409, 'Vault changed while rotating. Reload and try again.');

      const current = q.members.all(vaultId);
      for (const id of remove) if (!current.some((m) => m.user_id === id)) fail(400, 'Unknown member to remove');
      const remaining = new Set(current.filter((m) => !remove.has(m.user_id)).map((m) => m.user_id));
      const given = new Set(members.map((m) => m.userId));
      if (given.size !== members.length || given.size !== remaining.size || [...remaining].some((id) => !given.has(id))) {
        fail(409, 'Member list changed. Reload and try again.');
      }
      const currentItems = new Set(q.items.all(vaultId).map((i) => i.id));
      const givenItems = new Set(items.map((i) => i.id));
      if (givenItems.size !== items.length || givenItems.size !== currentItems.size || [...currentItems].some((id) => !givenItems.has(id))) {
        fail(409, 'Items changed. Reload and try again.');
      }

      const newVersion = vault.key_version + 1;
      const t = now();
      for (const id of remove) {
        db.prepare('DELETE FROM vault_members WHERE vault_id=? AND user_id=?').run(vaultId, id);
        audit(vaultId, user.id, 'member.remove', q.userById.get(id)?.email);
      }
      const upd = db.prepare('UPDATE vault_members SET wrapped_key=? WHERE vault_id=? AND user_id=?');
      for (const m of members) upd.run(m.wrappedKey, vaultId, m.userId);
      const updItem = db.prepare('UPDATE items SET data=?, key_version=?, updated_at=? WHERE id=? AND vault_id=?');
      for (const i of items) updItem.run(i.data, newVersion, t, i.id, vaultId);
      db.prepare('UPDATE vaults SET key_version=?, encrypted_name=?, updated_at=? WHERE id=?').run(newVersion, name, t, vaultId);
      audit(vaultId, user.id, 'vault.rotate_key', `v${newVersion}`);
      return { ok: true, keyVersion: newVersion };
    });
  });

  // ---------------- static files (fixed whitelist: no path traversal possible) ----------------
  const STATIC = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/js/app.js': ['js/app.js', 'text/javascript; charset=utf-8'],
    '/js/client.js': ['js/client.js', 'text/javascript; charset=utf-8'],
    '/js/crypto.js': ['js/crypto.js', 'text/javascript; charset=utf-8'],
    '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  };
  const staticCache = new Map();
  for (const [p, [file, type]] of Object.entries(STATIC)) {
    const full = path.join(ROOT, 'public', file);
    if (fs.existsSync(full)) staticCache.set(p, { body: fs.readFileSync(full), type });
  }

  // ---------------- dispatcher ----------------
  async function handle(req, res) {
    securityHeaders(res, secureCookies);
    const url = new URL(req.url, 'http://localhost');

    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed');
      const f = staticCache.get(url.pathname);
      if (!f) fail(404, 'Not found');
      res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.body.length, 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : f.body);
    }

    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) fail(404, 'Not found');

    // CSRF defence in depth (on top of SameSite=Strict): state-changing requests must carry
    // a custom header (forces a CORS preflight cross-origin) and a matching Origin if present.
    if (req.method !== 'GET') {
      if (req.headers['x-requested-with'] !== 'vault') fail(403, 'Missing CSRF header');
      const origin = req.headers.origin;
      if (origin) {
        let host = null;
        try {
          host = new URL(origin).host;
        } catch {
          /* "null" or malformed origin */
        }
        if (host !== req.headers.host) fail(403, 'Cross-origin request rejected');
      }
    }

    const match = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
    const ctx = { req, res, url, params, body: req.method === 'GET' ? {} : await readBody(req) };
    if (r.auth) {
      const session = authenticate(req);
      if (!session) fail(401, 'Not signed in');
      ctx.session = session;
      ctx.user = q.userById.get(session.userId);
      if (!ctx.user) fail(401, 'Not signed in');
    }
    sendJSON(res, 200, await r.handler(ctx));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendJSON(res, err.status, { error: err.message });
      console.error(err);
      sendJSON(res, 500, { error: 'Internal server error' });
    });
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.on('close', () => db.close());
  return server;
}

// ---------------- entry point ----------------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || '127.0.0.1';
  const secureCookies = process.env.INSECURE_COOKIES !== '1';
  const server = createApp({
    dbFile: path.join(dataDir, 'vault.db'),
    dataDir,
    secureCookies,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  server.listen(port, host, () => {
    console.log(`Vault server listening on http://${host}:${port}`);
    if (!secureCookies) console.warn('WARNING: INSECURE_COOKIES=1. Only use this for local development.');
  });
}
