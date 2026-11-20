// Client-side cryptography. Runs in the browser (and in Node for tests) using
// only the standard WebCrypto API. The server never sees the master password,
// any decryption key, or any plaintext secret.
//
// Key hierarchy
//   master password --PBKDF2-SHA256(600k)--> master secret
//   master secret --HKDF("auth")--> authKey   (sent to server, which hashes it again with scrypt)
//   master secret --HKDF("enc")---> encKey    (never leaves the browser)
//   encKey  --AES-256-GCM--> user's ECDH P-256 private key (stored encrypted on server)
//   vault key (random AES-256) --ECIES to each member's public key--> wrapped key per member
//   vault key --AES-256-GCM--> each item, bound to vault id + item id + key version via AAD

const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600_000;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' };

// ---------- encoding helpers ----------
export function toB64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// ---------- master password ----------
export async function deriveMasterKeys(password, saltB64, iterations = KDF_ITERATIONS) {
  if (iterations < 100_000) throw new Error('KDF iteration count too low');
  const pw = await subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const master = await subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(saltB64), iterations },
    pw,
    256,
  );
  const hk = await subtle.importKey('raw', master, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const authBits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('vault-auth-v1') },
    hk,
    256,
  );
  const encKey = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('vault-enc-v1') },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { authKey: toB64(authBits), encKey };
}

// ---------- symmetric encryption ----------
// Format: "a1.<iv>.<ciphertext+tag>"
export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes);
  return `a1.${toB64(iv)}.${toB64(ct)}`;
}

export async function decryptBytes(key, blob, aad) {
  const [v, iv, ct] = String(blob).split('.');
  if (v !== 'a1' || !iv || !ct) throw new Error('Unsupported ciphertext format');
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: te.encode(aad) },
    key,
    fromB64(ct),
  );
  return new Uint8Array(pt);
}

export async function encryptJSON(key, obj, aad) {
  return encryptBytes(key, te.encode(JSON.stringify(obj)), aad);
}

export async function decryptJSON(key, blob, aad) {
  return JSON.parse(td.decode(await decryptBytes(key, blob, aad)));
}

// ---------- user keypair ----------
export async function createUserKeys(encKey) {
  const kp = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const publicKey = toB64(await subtle.exportKey('spki', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  const encryptedPrivateKey = await encryptBytes(encKey, pkcs8, 'user-private-key');
  pkcs8.fill(0);
  const privateKey = await importPrivateKey(await decryptBytes(encKey, encryptedPrivateKey, 'user-private-key'));
  return { publicKey, encryptedPrivateKey, privateKey };
}

async function importPrivateKey(pkcs8) {
  try {
    return await subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
  } finally {
    pkcs8.fill(0);
  }
}

export async function unlockPrivateKey(encKey, encryptedPrivateKey) {
  // Throws if the master password is wrong (GCM authentication fails).
  return importPrivateKey(await decryptBytes(encKey, encryptedPrivateKey, 'user-private-key'));
}

export async function reencryptPrivateKeyBlob(oldEncKey, newEncKey, encryptedPrivateKey) {
  const pkcs8 = await decryptBytes(oldEncKey, encryptedPrivateKey, 'user-private-key');
  try {
    return await encryptBytes(newEncKey, pkcs8, 'user-private-key');
  } finally {
    pkcs8.fill(0);
  }
}

// Human-comparable fingerprint of a public key, for out-of-band verification.
export async function fingerprint(publicKeyB64) {
  const h = new Uint8Array(await subtle.digest('SHA-256', fromB64(publicKeyB64)));
  const hex = Array.from(h.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.toUpperCase().match(/.{4}/g).join(' ');
}

// ---------- ECIES: seal bytes to a public key ----------
// Format: "e1.<ephemeralPublicRaw>.<iv>.<ciphertext+tag>"
async function eciesKey(sharedBits, ephPubRaw, recipientSpki) {
  const hk = await subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  const info = new Uint8Array([...te.encode('vault-seal-v1'), ...recipientSpki]);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: ephPubRaw, info },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealToPublicKey(bytes, recipientPublicKeyB64, aad) {
  const spki = fromB64(recipientPublicKeyB64);
  const recipient = await subtle.importKey('spki', spki, CURVE, false, []);
  const eph = await subtle.generateKey(CURVE, true, ['deriveBits']);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const ephPubRaw = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const key = await eciesKey(shared, ephPubRaw, spki);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes);
  return `e1.${toB64(ephPubRaw)}.${toB64(iv)}.${toB64(ct)}`;
}

export async function openSealed(blob, privateKey, ownPublicKeyB64, aad) {
  const [v, eph, iv, ct] = String(blob).split('.');
  if (v !== 'e1' || !eph || !iv || !ct) throw new Error('Unsupported sealed format');
  const ephPubRaw = fromB64(eph);
  const ephPub = await subtle.importKey('raw', ephPubRaw, CURVE, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: ephPub }, privateKey, 256);
  const key = await eciesKey(shared, ephPubRaw, fromB64(ownPublicKeyB64));
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv), additionalData: te.encode(aad) },
    key,
    fromB64(ct),
  );
  return new Uint8Array(pt);
}

// ---------- vault keys ----------
// AAD strings bind every ciphertext to its context so the server cannot swap
// ciphertexts between vaults, items, users or key versions undetected.
export const aad = {
  vaultKey: (vaultId, userId, version) => `vault-key:${vaultId}:${userId}:${version}`,
  vaultName: (vaultId, version) => `vault-name:${vaultId}:${version}`,
  item: (vaultId, itemId, version) => `item:${vaultId}:${itemId}:${version}`,
};

export function newVaultKeyBytes() {
  return randomBytes(32);
}

export async function importVaultKey(raw) {
  return subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---------- password generator ----------
const SETS = {
  lower: 'abcdefghijkmnopqrstuvwxyz',
  upper: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  digits: '23456789',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
};

function uniformIndex(n) {
  // Rejection sampling: no modulo bias.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export function generatePassword({ length = 20, lower = true, upper = true, digits = true, symbols = true } = {}) {
  const chosen = Object.entries({ lower, upper, digits, symbols }).filter(([, on]) => on).map(([k]) => SETS[k]);
  if (!chosen.length) throw new Error('Pick at least one character set');
  if (length < chosen.length || length > 128) throw new Error('Invalid length');
  const all = chosen.join('');
  const out = chosen.map((set) => set[uniformIndex(set.length)]); // at least one of each
  while (out.length < length) out.push(all[uniformIndex(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = uniformIndex(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}
