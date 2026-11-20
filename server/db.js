import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA secure_delete = ON;

    CREATE TABLE IF NOT EXISTS users (
      id                    TEXT PRIMARY KEY,
      email                 TEXT NOT NULL UNIQUE,
      kdf_salt              TEXT NOT NULL,
      kdf_iterations        INTEGER NOT NULL,
      auth_hash             TEXT NOT NULL,   -- scrypt(authKey) - server never sees the master password
      auth_salt             TEXT NOT NULL,
      public_key            TEXT NOT NULL,
      encrypted_private_key TEXT NOT NULL,
      created_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash  TEXT PRIMARY KEY,         -- SHA-256 of the cookie token
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS vaults (
      id             TEXT PRIMARY KEY,
      encrypted_name TEXT NOT NULL,
      key_version    INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vault_members (
      vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
      wrapped_key TEXT NOT NULL,           -- vault key sealed to this member's public key
      added_by    TEXT,
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (vault_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS members_user ON vault_members(user_id);

    CREATE TABLE IF NOT EXISTS items (
      id          TEXT PRIMARY KEY,
      vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      data        TEXT NOT NULL,           -- AES-GCM ciphertext under the vault key
      key_version INTEGER NOT NULL,
      updated_by  TEXT,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS items_vault ON items(vault_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id   TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id    TEXT,
      action     TEXT NOT NULL,
      target     TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_vault ON audit_log(vault_id, id);
  `);
  return db;
}

// Synchronous transaction helper. node:sqlite is synchronous, so nothing else
// can interleave while fn runs (fn must not await).
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
