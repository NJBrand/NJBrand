import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const NAME_RE = /^vault-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

export function verifyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const { integrity_check: result } = db.prepare('PRAGMA integrity_check').get();
    if (result !== 'ok') throw new Error(`Integrity check failed for ${file}: ${result}`);
    const { c } = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name IN ('users','vaults','items')").get();
    if (c !== 3) throw new Error(`${file} is not a Vault database`);
    return {
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      vaults: db.prepare('SELECT COUNT(*) c FROM vaults').get().c,
      items: db.prepare('SELECT COUNT(*) c FROM items').get().c,
    };
  } finally {
    db.close();
  }
}

export function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

// Consistent online snapshot (safe while the server is running), verified before
// it is kept, then old snapshots beyond `keep` are pruned.
export function backupDatabase(db, dir, keep = 14) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `vault-${stamp}.db`);
  const tmp = `${file}.partial`;
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    fs.chmodSync(tmp, 0o600);
    const stats = verifyDatabase(tmp);
    fs.renameSync(tmp, file);
    const all = listBackups(dir);
    const pruned = all.slice(0, Math.max(0, all.length - keep));
    for (const old of pruned) fs.rmSync(old, { force: true });
    return { file, ...stats, pruned: pruned.length };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function startBackupSchedule(db, { dir, intervalHours = 24, keep = 14, log = console } = {}) {
  const run = () => {
    try {
      const r = backupDatabase(db, dir, keep);
      log.log(`[backup] ${path.basename(r.file)}: ${r.users} users, ${r.vaults} vaults, ${r.items} items (pruned ${r.pruned})`);
    } catch (err) {
      // Loud on purpose: a silently failing backup is worse than none.
      log.error(`[backup] FAILED: ${err.message}`);
    }
  };
  // First backup shortly after start, then on the interval.
  const first = setTimeout(run, 10_000);
  const timer = setInterval(run, intervalHours * 3600 * 1000);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
