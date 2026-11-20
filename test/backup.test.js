import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server/server.js';
import { listBackups, verifyDatabase } from '../server/backup.js';
import { VaultClient } from '../public/js/client.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('backups: online snapshot, retention, restore, and data is still decryptable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-bk-'));
  const dataDir = path.join(dir, 'data');
  const backupDir = path.join(dataDir, 'backups');
  const dbFile = path.join(dataDir, 'vault.db');
  try {
    let server = createApp({ dbFile, dataDir, secureCookies: false, backup: { dir: backupDir, keep: 3, intervalHours: 24 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    let base = `http://127.0.0.1:${server.address().port}`;

    const c = new VaultClient({ baseUrl: base, fetchImpl: jar() });
    await c.register('erin@example.com', 'erin long passphrase');
    const vaultId = await c.createVault('Home');
    await c.saveItem(vaultId, { title: 'Router', password: 'router-pass-123' });

    const r = server.backupNow();
    assert.equal(r.items, 1);
    assert.deepEqual(verifyDatabase(r.file), { users: 1, vaults: 1, items: 1 });
    assert.equal(fs.statSync(r.file).mode & 0o777, 0o600, 'backup must not be world-readable');

    for (let i = 0; i < 4; i++) {
      await new Promise((res) => setTimeout(res, 5));
      server.backupNow();
    }
    assert.equal(listBackups(backupDir).length, 3, 'retention keeps only the newest 3');

    // Lose data after the backup, then restore.
    await c.deleteItem(vaultId, (await c.listItems(vaultId))[0].id);
    const keepFile = listBackups(backupDir).at(-1);
    await new Promise((res) => server.close(res));

    const env = { ...process.env, DATA_DIR: dataDir };
    const cli = (...a) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/backup-cli.js', ...a], { cwd: ROOT, env, encoding: 'utf8' });
    assert.throws(() => cli('restore', keepFile), /--yes/); // refuses without confirmation
    assert.match(cli('restore', keepFile, '--yes'), /Restored/);
    assert.equal(listBackups(path.join(backupDir, 'pre-restore')).length, 1, 'safety copy taken before restore');

    server = createApp({ dbFile, dataDir, secureCookies: false });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    base = `http://127.0.0.1:${server.address().port}`;
    const c2 = new VaultClient({ baseUrl: base, fetchImpl: jar() });
    await c2.login('erin@example.com', 'erin long passphrase');
    const items = await c2.listItems(vaultId);
    assert.equal(items[0].password, 'router-pass-123');
    await new Promise((res) => server.close(res));

    assert.match(cli('--list'), /vault-.*\.db/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt backups are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-bad-'));
  const f = path.join(dir, 'bad.db');
  fs.writeFileSync(f, 'not a database');
  assert.throws(() => verifyDatabase(f));
  fs.rmSync(dir, { recursive: true, force: true });
});

function jar() {
  let cookie = '';
  return async (url, opts = {}) => {
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...(cookie ? { cookie } : {}) } });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
}
