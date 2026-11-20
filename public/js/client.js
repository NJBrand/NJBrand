// Vault client: all crypto + API orchestration. UI-free so it can be tested in Node.
import * as C from './crypto.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class VaultClient {
  constructor({ baseUrl = '', fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.lock();
  }

  // Drop every key from memory.
  lock() {
    this.user = null;
    this.privateKey = null;
    this.encKey = null;
    this.vaultKeys = new Map(); // vaultId -> { version, raw, key }
  }

  get unlocked() {
    return !!this.privateKey;
  }

  async api(method, path, body) {
    const res = await this.fetch(this.baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* empty */
    }
    if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- account ----------
  async register(email, password) {
    const kdfSalt = C.toB64(C.randomBytes(16));
    const { authKey, encKey } = await C.deriveMasterKeys(password, kdfSalt, C.KDF_ITERATIONS);
    const keys = await C.createUserKeys(encKey);
    const profile = await this.api('POST', '/api/register', {
      email,
      kdfSalt,
      kdfIterations: C.KDF_ITERATIONS,
      authKey,
      publicKey: keys.publicKey,
      encryptedPrivateKey: keys.encryptedPrivateKey,
    });
    this._setUnlocked(profile, encKey, keys.privateKey);
    return profile;
  }

  async login(email, password) {
    const pre = await this.api('GET', `/api/prelogin?email=${encodeURIComponent(email)}`);
    const { authKey, encKey } = await C.deriveMasterKeys(password, pre.kdfSalt, pre.kdfIterations);
    const profile = await this.api('POST', '/api/login', { email, authKey });
    const privateKey = await C.unlockPrivateKey(encKey, profile.encryptedPrivateKey);
    this._setUnlocked(profile, encKey, privateKey);
    return profile;
  }

  // Session cookie still valid but keys were dropped (reload / auto-lock).
  async me() {
    return this.api('GET', '/api/me');
  }

  async unlock(password) {
    const profile = await this.me();
    const { encKey } = await C.deriveMasterKeys(password, profile.kdfSalt, profile.kdfIterations);
    let privateKey;
    try {
      privateKey = await C.unlockPrivateKey(encKey, profile.encryptedPrivateKey);
    } catch {
      throw new ApiError(401, 'Incorrect master password');
    }
    this._setUnlocked(profile, encKey, privateKey);
    return profile;
  }

  async logout() {
    try {
      await this.api('POST', '/api/logout', {});
    } finally {
      this.lock();
    }
  }

  async changePassword(currentPassword, newPassword) {
    const profile = await this.me();
    const cur = await C.deriveMasterKeys(currentPassword, profile.kdfSalt, profile.kdfIterations);
    const kdfSalt = C.toB64(C.randomBytes(16));
    const next = await C.deriveMasterKeys(newPassword, kdfSalt, C.KDF_ITERATIONS);
    let encryptedPrivateKey;
    try {
      encryptedPrivateKey = await C.reencryptPrivateKeyBlob(cur.encKey, next.encKey, profile.encryptedPrivateKey);
    } catch {
      throw new ApiError(401, 'Current password is incorrect');
    }
    await this.api('POST', '/api/account/password', {
      currentAuthKey: cur.authKey,
      kdfSalt,
      kdfIterations: C.KDF_ITERATIONS,
      authKey: next.authKey,
      encryptedPrivateKey,
    });
    this.encKey = next.encKey;
    this.user = { ...this.user, kdfSalt, encryptedPrivateKey };
  }

  _setUnlocked(profile, encKey, privateKey) {
    this.user = profile;
    this.encKey = encKey;
    this.privateKey = privateKey;
    this.vaultKeys = new Map();
  }

  _requireUnlocked() {
    if (!this.unlocked) throw new ApiError(401, 'Vault is locked');
  }

  async myFingerprint() {
    return C.fingerprint(this.user.publicKey);
  }

  // ---------- vaults ----------
  async _vaultKey(vault) {
    const cached = this.vaultKeys.get(vault.id);
    if (cached && cached.version === vault.keyVersion) return cached;
    const raw = await C.openSealed(
      vault.wrappedKey,
      this.privateKey,
      this.user.publicKey,
      C.aad.vaultKey(vault.id, this.user.id, vault.keyVersion),
    );
    const entry = { version: vault.keyVersion, raw, key: await C.importVaultKey(raw) };
    this.vaultKeys.set(vault.id, entry);
    return entry;
  }

  async listVaults() {
    this._requireUnlocked();
    const { vaults } = await this.api('GET', '/api/vaults');
    const out = [];
    for (const v of vaults) {
      try {
        const { key } = await this._vaultKey(v);
        const name = (await C.decryptJSON(key, v.encryptedName, C.aad.vaultName(v.id, v.keyVersion))).name;
        out.push({ ...v, name });
      } catch {
        out.push({ ...v, name: '(unable to decrypt)', broken: true });
      }
    }
    this._vaults = new Map(out.map((v) => [v.id, v]));
    return out;
  }

  async _vault(vaultId, refresh = false) {
    if (refresh || !this._vaults?.has(vaultId)) await this.listVaults();
    const v = this._vaults.get(vaultId);
    if (!v) throw new ApiError(404, 'Vault not found');
    return v;
  }

  async createVault(name) {
    this._requireUnlocked();
    const id = globalThis.crypto.randomUUID();
    const raw = C.newVaultKeyBytes();
    const key = await C.importVaultKey(raw);
    const wrappedKey = await C.sealToPublicKey(raw, this.user.publicKey, C.aad.vaultKey(id, this.user.id, 1));
    const encryptedName = await C.encryptJSON(key, { name }, C.aad.vaultName(id, 1));
    await this.api('POST', '/api/vaults', { id, encryptedName, wrappedKey });
    this.vaultKeys.set(id, { version: 1, raw, key });
    await this.listVaults();
    return id;
  }

  async renameVault(vaultId, name) {
    const v = await this._vault(vaultId, true);
    const { key } = await this._vaultKey(v);
    const encryptedName = await C.encryptJSON(key, { name }, C.aad.vaultName(v.id, v.keyVersion));
    await this.api('PATCH', `/api/vaults/${vaultId}`, { encryptedName });
  }

  async deleteVault(vaultId) {
    await this.api('DELETE', `/api/vaults/${vaultId}`);
  }

  async leaveVault(vaultId) {
    await this.api('DELETE', `/api/vaults/${vaultId}/membership`);
    this.vaultKeys.delete(vaultId);
  }

  async activity(vaultId) {
    return (await this.api('GET', `/api/vaults/${vaultId}/activity`)).activity;
  }

  // ---------- items ----------
  async listItems(vaultId) {
    const v = await this._vault(vaultId, true);
    const { key } = await this._vaultKey(v);
    const { items } = await this.api('GET', `/api/vaults/${vaultId}/items`);
    const out = [];
    for (const it of items) {
      try {
        const fields = await C.decryptJSON(key, it.data, C.aad.item(vaultId, it.id, it.keyVersion));
        out.push({ id: it.id, updatedAt: it.updatedAt, ...fields });
      } catch {
        out.push({ id: it.id, updatedAt: it.updatedAt, title: '(unable to decrypt)', broken: true });
      }
    }
    return out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  }

  // fields: { title, username, password, url, notes }
  async saveItem(vaultId, fields, itemId = globalThis.crypto.randomUUID()) {
    const v = await this._vault(vaultId, true);
    const { key, version } = await this._vaultKey(v);
    const clean = {
      title: String(fields.title || '').slice(0, 500),
      username: String(fields.username || '').slice(0, 1000),
      password: String(fields.password || '').slice(0, 10_000),
      url: String(fields.url || '').slice(0, 2000),
      notes: String(fields.notes || '').slice(0, 50_000),
    };
    const data = await C.encryptJSON(key, clean, C.aad.item(vaultId, itemId, version));
    await this.api('PUT', `/api/vaults/${vaultId}/items/${itemId}`, { data, keyVersion: version });
    return itemId;
  }

  async deleteItem(vaultId, itemId) {
    await this.api('DELETE', `/api/vaults/${vaultId}/items/${itemId}`);
  }

  // ---------- sharing ----------
  async listMembers(vaultId) {
    const { members } = await this.api('GET', `/api/vaults/${vaultId}/members`);
    for (const m of members) m.fingerprint = await C.fingerprint(m.publicKey);
    return members;
  }

  // Step 1: look up the person and show their key fingerprint so it can be verified
  // out-of-band before sharing (defends against a malicious server swapping keys).
  async lookupUser(email) {
    const u = await this.api('GET', `/api/users/lookup?email=${encodeURIComponent(email)}`);
    return { ...u, fingerprint: await C.fingerprint(u.publicKey) };
  }

  // Step 2: wrap the vault key for that person's public key and grant access.
  async shareVault(vaultId, recipient, role) {
    const v = await this._vault(vaultId, true);
    const { raw, version } = await this._vaultKey(v);
    const wrappedKey = await C.sealToPublicKey(raw, recipient.publicKey, C.aad.vaultKey(vaultId, recipient.id, version));
    await this.api('POST', `/api/vaults/${vaultId}/members`, { userId: recipient.id, role, wrappedKey, keyVersion: version });
  }

  async setRole(vaultId, userId, role) {
    await this.api('PATCH', `/api/vaults/${vaultId}/members/${userId}`, { role });
  }

  // Revoke access: generate a fresh vault key, re-encrypt everything, re-wrap for
  // the people who remain. Also usable with no removals as a plain key rotation.
  async rotateVaultKey(vaultId, removeUserIds = []) {
    const v = await this._vault(vaultId, true);
    const { key: oldKey } = await this._vaultKey(v);
    const [members, { items }] = await Promise.all([
      this.listMembers(vaultId),
      this.api('GET', `/api/vaults/${vaultId}/items`),
    ]);
    const newVersion = v.keyVersion + 1;
    const raw = C.newVaultKeyBytes();
    const newKey = await C.importVaultKey(raw);

    const reItems = [];
    for (const it of items) {
      const pt = await C.decryptBytes(oldKey, it.data, C.aad.item(vaultId, it.id, it.keyVersion));
      reItems.push({ id: it.id, data: await C.encryptBytes(newKey, pt, C.aad.item(vaultId, it.id, newVersion)) });
      pt.fill(0);
    }
    const remaining = members.filter((m) => !removeUserIds.includes(m.userId));
    const reMembers = [];
    for (const m of remaining) {
      reMembers.push({
        userId: m.userId,
        wrappedKey: await C.sealToPublicKey(raw, m.publicKey, C.aad.vaultKey(vaultId, m.userId, newVersion)),
      });
    }
    const encryptedName = await C.encryptJSON(newKey, { name: v.name }, C.aad.vaultName(vaultId, newVersion));
    await this.api('POST', `/api/vaults/${vaultId}/rotate`, {
      expectedKeyVersion: v.keyVersion,
      removeUserIds,
      encryptedName,
      members: reMembers,
      items: reItems,
    });
    this.vaultKeys.set(vaultId, { version: newVersion, raw, key: newKey });
    await this.listVaults();
  }

  async removeMember(vaultId, userId) {
    return this.rotateVaultKey(vaultId, [userId]);
  }
}
