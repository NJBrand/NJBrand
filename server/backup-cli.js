// Usage:
//   npm run backup                      take a backup now (safe while the server runs)
//   npm run backup -- --list            list backups
//   npm run backup -- --verify <file>   check a backup is intact
//   npm run restore -- <file> --yes     restore (STOP THE SERVER FIRST)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { backupDatabase, listBackups, verifyDatabase } from './backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const dbFile = path.join(dataDir, 'vault.db');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, 'backups'));
const keep = Number(process.env.BACKUP_KEEP || 14);

const args = process.argv.slice(2);
const mode = args[0] === 'restore' ? 'restore' : args.includes('--list') ? 'list' : args.includes('--verify') ? 'verify' : 'backup';

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (mode === 'list') {
  const files = listBackups(backupDir);
  if (!files.length) console.log(`No backups in ${backupDir}`);
  for (const f of files) console.log(`${f}  ${(fs.statSync(f).size / 1024).toFixed(0)} KB`);
} else if (mode === 'verify') {
  const f = args[args.indexOf('--verify') + 1] || die('Usage: --verify <file>');
  console.log('OK', verifyDatabase(path.resolve(f)));
} else if (mode === 'backup') {
  if (!fs.existsSync(dbFile)) die(`No database at ${dbFile}`);
  const db = openDatabase(dbFile);
  try {
    const r = backupDatabase(db, backupDir, keep);
    console.log(`Backup written: ${r.file} (${r.users} users, ${r.vaults} vaults, ${r.items} items)`);
  } finally {
    db.close();
  }
} else {
  const src = args.find((a, i) => i > 0 && !a.startsWith('--')) || die('Usage: npm run restore -- <backup-file> --yes');
  const source = path.resolve(src);
  if (!fs.existsSync(source)) die(`Not found: ${source}`);
  const stats = verifyDatabase(source);
  console.log(`Backup is valid: ${stats.users} users, ${stats.vaults} vaults, ${stats.items} items.`);
  if (!args.includes('--yes')) die('Make sure the server is STOPPED, then re-run with --yes to restore.');

  if (fs.existsSync(dbFile)) {
    const current = openDatabase(dbFile);
    try {
      const r = backupDatabase(current, path.join(backupDir, 'pre-restore'), 5);
      console.log(`Safety copy of current database: ${r.file}`);
    } finally {
      current.close();
    }
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.copyFileSync(source, dbFile);
  fs.chmodSync(dbFile, 0o600);
  console.log(`Restored ${source} -> ${dbFile}. Start the server again.`);
}
