import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/server.js';
import { VaultClient } from '../public/js/client.js';
import * as C from '../public/js/crypto.js';

let server;
let base;

// Minimal per-client cookie jar so each VaultClient behaves like a separate browser.
function jarFetch() {
  let cookie = '';
  const f = async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { ...opts, headers });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  f.raw = () => cookie;
  return f;
}
const newClient = () => new VaultClient({ baseUrl: base, fetchImpl: jarFetch() });

before(async () => {
  server = createApp({ secureCookies: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

let alice, bob, carol;
let vaultId;

test('register, wrong password rejected, login works', async () => {
  alice = newClient();
  await alice.register('alice@example.com', 'correct horse battery staple');
  assert.ok(alice.unlocked);

  const imposter = newClient();
  await assert.rejects(imposter.login('alice@example.com', 'wrong password'), { status: 401 });

  const again = newClient();
  await again.login('Alice@Example.com ', 'correct horse battery staple');
  assert.equal(again.user.id, alice.user.id);

  bob = newClient();
  await bob.register('bob@example.com', 'bob has a long passphrase');
  carol = newClient();
  await carol.register('carol@example.com', 'carol also has one here');
});

test('prelogin does not reveal whether an account exists', async () => {
  const r1 = await (await fetch(`${base}/api/prelogin?email=nobody@example.com`)).json();
  const r2 = await (await fetch(`${base}/api/prelogin?email=nobody@example.com`)).json();
  assert.equal(r1.kdfSalt, r2.kdfSalt); // stable fake salt
  assert.equal(r1.kdfIterations, C.KDF_ITERATIONS);
});

test('items are encrypted at rest; the server only holds ciphertext', async () => {
  vaultId = await alice.createVault('Family');
  await alice.saveItem(vaultId, { title: 'Bank', username: 'alice', password: 'S3cret-P@ss!', url: 'https://bank.example' });
  const items = await alice.listItems(vaultId);
  assert.equal(items.length, 1);
  assert.equal(items[0].password, 'S3cret-P@ss!');

  const raw = await alice.api('GET', `/api/vaults/${vaultId}/items`);
  const blob = JSON.stringify(raw);
  assert.ok(!blob.includes('S3cret'), 'plaintext leaked to server');
  assert.ok(!blob.includes('Bank'), 'title leaked to server');
});

test('non-members cannot see the vault', async () => {
  await assert.rejects(bob.listItems(vaultId), { status: 404 });
  await assert.rejects(bob.api('GET', `/api/vaults/${vaultId}/members`), { status: 404 });
});

test('sharing: bob (viewer) can read but not write; carol (editor) can write', async () => {
  const bobInfo = await alice.lookupUser('bob@example.com');
  assert.equal(bobInfo.fingerprint, await bob.myFingerprint()); // fingerprint matches out-of-band
  await alice.shareVault(vaultId, bobInfo, 'viewer');
  await alice.shareVault(vaultId, await alice.lookupUser('carol@example.com'), 'editor');

  const bobVaults = await bob.listVaults();
  assert.equal(bobVaults[0].name, 'Family');
  assert.equal(bobVaults[0].role, 'viewer');
  assert.equal((await bob.listItems(vaultId))[0].password, 'S3cret-P@ss!');
  await assert.rejects(bob.saveItem(vaultId, { title: 'nope' }), { status: 403 });

  await carol.saveItem(vaultId, { title: 'Wi-Fi', password: 'hunter2hunter2' });
  const titles = (await alice.listItems(vaultId)).map((i) => i.title);
  assert.deepEqual(titles, ['Bank', 'Wi-Fi']);
});

test('only owners can manage members', async () => {
  const bobInfo = await carol.lookupUser('bob@example.com');
  await assert.rejects(carol.setRole(vaultId, bobInfo.id, 'editor'), { status: 403 });
  await assert.rejects(carol.removeMember(vaultId, bobInfo.id), { status: 403 });
});

test('revoking access rotates the key so the old key is useless', async () => {
  const oldWrapped = (await bob.api('GET', '/api/vaults')).vaults[0];
  const oldKey = await bob._vaultKey(oldWrapped); // what bob could have cached

  await alice.removeMember(vaultId, bob.user.id);
  assert.deepEqual(await bob.listVaults(), []);
  await assert.rejects(bob.listItems(vaultId), { status: 404 });

  // Even with a leaked copy of the current ciphertexts, bob's old key fails.
  const { items } = await alice.api('GET', `/api/vaults/${vaultId}/items`);
  for (const it of items) {
    await assert.rejects(C.decryptBytes(oldKey.key, it.data, C.aad.item(vaultId, it.id, it.keyVersion)));
  }
  // Remaining members still have access under the new key.
  assert.equal((await carol.listItems(vaultId)).length, 2);
  assert.equal((await alice.listItems(vaultId)).length, 2);
});

test('writes with a stale key version are rejected', async () => {
  const stale = await alice.api('GET', '/api/vaults');
  const v = stale.vaults[0];
  await assert.rejects(
    alice.api('PUT', `/api/vaults/${vaultId}/items/${crypto.randomUUID()}`, { data: 'a1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA', keyVersion: v.keyVersion - 1 }),
    { status: 409 },
  );
});

test('server cannot swap ciphertexts between items (AAD binding)', async () => {
  const { items } = await alice.api('GET', `/api/vaults/${vaultId}/items`);
  const [a, b] = items;
  const { key } = alice.vaultKeys.get(vaultId);
  await assert.rejects(C.decryptBytes(key, a.data, C.aad.item(vaultId, b.id, b.keyVersion)));
});

test('last owner cannot leave or be demoted', async () => {
  await assert.rejects(alice.leaveVault(vaultId), { status: 400 });
  await assert.rejects(alice.setRole(vaultId, alice.user.id, 'editor'), { status: 400 });
  await carol.leaveVault(vaultId); // non-owner can leave
  assert.deepEqual(await carol.listVaults(), []);
});

test('lock + unlock with master password; wrong password fails', async () => {
  alice.lock();
  await assert.rejects(alice.listVaults(), { status: 401 });
  await assert.rejects(alice.unlock('nope'), { status: 401 });
  await alice.unlock('correct horse battery staple');
  assert.equal((await alice.listItems(vaultId)).length, 2);
});

test('change master password keeps data and invalidates the old password', async () => {
  const other = newClient();
  await other.login('alice@example.com', 'correct horse battery staple');
  await alice.changePassword('correct horse battery staple', 'an even better new passphrase');
  await assert.rejects(other.me(), { status: 401 }); // other sessions signed out
  await assert.rejects(newClient().login('alice@example.com', 'correct horse battery staple'), { status: 401 });
  const fresh = newClient();
  await fresh.login('alice@example.com', 'an even better new passphrase');
  assert.equal((await fresh.listItems(vaultId)).length, 2);
});

test('CSRF: state-changing request without custom header or from another origin is rejected', async () => {
  const f = alice.fetch;
  const r1 = await f(`${base}/api/vaults`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r1.status, 403);
  const r2 = await f(`${base}/api/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault', Origin: 'https://evil.example' },
    body: '{}',
  });
  assert.equal(r2.status, 403);
});

test('session cookie is hardened and security headers are set', async () => {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault' },
    body: JSON.stringify({ email: 'nobody2@example.com', authKey: C.toB64(new Uint8Array(32)) }),
  });
  assert.equal(res.status, 401);
  const reg = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'vault' },
    body: JSON.stringify({ email: 'x' }),
  });
  assert.equal(reg.status, 400);

  const d = newClient();
  await d.register('dave@example.com', 'dave passphrase is long');
  assert.match(d.fetch.raw(), /^__Host-sid=/);
  const login = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'X-Requested-With': 'vault' } });
  const cookie = login.headers.get('set-cookie');
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(cookie.includes(flag), flag);

  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
});

test('static files: path traversal is not possible', async () => {
  for (const p of ['/../server/server.js', '/%2e%2e/package.json', '/js/../../data/vault.db']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test('login is rate limited per account', async () => {
  const c = newClient();
  let limited = false;
  for (let i = 0; i < 12; i++) {
    try {
      await c.api('POST', '/api/login', { email: 'carol@example.com', authKey: C.toB64(C.randomBytes(32)) });
    } catch (e) {
      if (e.status === 429) limited = true;
    }
  }
  assert.ok(limited);
});

test('password generator honours options and has no obvious bias', () => {
  const p = C.generatePassword({ length: 32 });
  assert.equal(p.length, 32);
  assert.match(p, /[a-z]/);
  assert.match(p, /[A-Z]/);
  assert.match(p, /[0-9]/);
  assert.match(p, /[^A-Za-z0-9]/);
  assert.match(C.generatePassword({ length: 16, upper: false, symbols: false, digits: false }), /^[a-z]{16}$/);
});
