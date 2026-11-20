import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    -- Latest known state of each device (config devices + auto-discovered UniFi devices)
    CREATE TABLE IF NOT EXISTS device_state (
      id           TEXT PRIMARY KEY,
      source       TEXT NOT NULL,          -- agent | probe | unifi
      name         TEXT,
      last_seen    INTEGER,                -- ms epoch of last successful check
      online       INTEGER,                -- 1 / 0 / NULL (unknown)
      last_report  TEXT,                   -- JSON of last agent report / unifi record
      extra        TEXT                    -- JSON (unifi model, ip, ...)
    );

    -- Consecutive pass/fail counters for debouncing
    CREATE TABLE IF NOT EXISTS check_state (
      device_id  TEXT NOT NULL,
      check_key  TEXT NOT NULL,
      fails      INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (device_id, check_key)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id        TEXT NOT NULL,
      check_key        TEXT NOT NULL,
      kind             TEXT NOT NULL DEFAULT 'condition', -- condition | event
      severity         TEXT NOT NULL,
      title            TEXT NOT NULL,
      issue            TEXT NOT NULL,
      action           TEXT,
      opened_at        INTEGER NOT NULL,
      last_notified_at INTEGER,
      acked_at         INTEGER,
      resolved_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS alerts_open ON alerts(device_id, check_key) WHERE resolved_at IS NULL;
    CREATE INDEX IF NOT EXISTS alerts_time ON alerts(opened_at);

    -- Metric history for trends (trimmed to 90 days)
    CREATE TABLE IF NOT EXISTS metrics (
      device_id     TEXT NOT NULL,
      ts            INTEGER NOT NULL,
      cpu           REAL,
      memory        REAL,
      min_disk_free REAL
    );
    CREATE INDEX IF NOT EXISTS metrics_dev ON metrics(device_id, ts);

    CREATE TABLE IF NOT EXISTS maintenance_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id    TEXT NOT NULL,
      task_id      TEXT,                   -- scheduled task id, or NULL for ad-hoc work
      performed_at INTEGER NOT NULL,
      performed_by TEXT,
      notes        TEXT
    );
    CREATE INDEX IF NOT EXISTS maint_dev ON maintenance_log(device_id, task_id, performed_at);

    CREATE TABLE IF NOT EXISTS notifications (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      alert_id INTEGER,
      kind     TEXT NOT NULL,              -- open | escalate | remind | resolve | digest | test
      title    TEXT NOT NULL,
      channels TEXT,                       -- which channels succeeded / failed
      error    TEXT
    );

    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
  return db;
}
