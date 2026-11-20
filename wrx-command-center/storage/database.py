"""SQLite storage: sessions, telemetry (long format), alert events.

* Parameterized queries only.
* Schema versioned with PRAGMA user_version; migrations run in order, once.
* Long format (one row per sensor per snapshot) so UNAVAILABLE/ERROR readings are
  stored explicitly with value NULL + status, instead of being silently dropped or zeroed.
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from core.alerts import AlertEvent
from core.models import DataSource, Snapshot

MIGRATIONS: list[str] = [
    # v1
    """
    CREATE TABLE sessions (
        id          INTEGER PRIMARY KEY,
        started_at  TEXT NOT NULL,
        source      TEXT NOT NULL,
        notes       TEXT
    );
    CREATE TABLE telemetry (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER NOT NULL REFERENCES sessions(id),
        ts          TEXT NOT NULL,
        source      TEXT NOT NULL,
        sensor      TEXT NOT NULL,
        value       REAL,
        status      TEXT NOT NULL,
        message     TEXT
    );
    CREATE INDEX idx_telemetry_session_ts ON telemetry(session_id, ts);
    CREATE TABLE alert_events (
        id          INTEGER PRIMARY KEY,
        session_id  INTEGER REFERENCES sessions(id),
        ts          TEXT NOT NULL,
        rule_id     TEXT NOT NULL,
        severity    TEXT NOT NULL,
        state       TEXT NOT NULL,
        message     TEXT NOT NULL,
        value       REAL
    );
    CREATE INDEX idx_alerts_session_ts ON alert_events(session_id, ts);
    """,
]


def _iso(ts: datetime) -> str:
    return ts.astimezone(timezone.utc).isoformat(timespec="microseconds")


class TelemetryStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.migrate()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=5)
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def schema_version(self) -> int:
        with closing(self._connect()) as conn:
            return conn.execute("PRAGMA user_version").fetchone()[0]

    def migrate(self) -> None:
        with closing(self._connect()) as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            current = conn.execute("PRAGMA user_version").fetchone()[0]
            for version, script in enumerate(MIGRATIONS[current:], start=current + 1):
                conn.executescript(f"BEGIN; {script} PRAGMA user_version = {version}; COMMIT;")

    # -- writes -------------------------------------------------------------------
    def start_session(self, source: DataSource, notes: str = "") -> int:
        with closing(self._connect()) as conn, conn:
            cur = conn.execute(
                "INSERT INTO sessions (started_at, source, notes) VALUES (?, ?, ?)",
                (_iso(datetime.now(timezone.utc)), source.value, notes),
            )
            return cur.lastrowid

    def save_snapshot(self, session_id: int, snap: Snapshot) -> None:
        ts = _iso(snap.timestamp)
        rows = [
            (session_id, ts, snap.source.value, r.sensor, r.value, r.status.value, r.message)
            for r in snap.readings.values()
        ]
        with closing(self._connect()) as conn, conn:
            conn.executemany(
                "INSERT INTO telemetry (session_id, ts, source, sensor, value, status, message)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                rows,
            )

    def save_alerts(self, session_id: int | None, events: list[AlertEvent]) -> None:
        if not events:
            return
        with closing(self._connect()) as conn, conn:
            conn.executemany(
                "INSERT INTO alert_events (session_id, ts, rule_id, severity, state, message, value)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(session_id, _iso(e.timestamp), e.rule_id, e.severity.value, e.state, e.message, e.value)
                 for e in events],
            )

    # -- reads --------------------------------------------------------------------
    def _query(self, sql: str, params: tuple = ()) -> pd.DataFrame:
        with closing(self._connect()) as conn:
            return pd.read_sql_query(sql, conn, params=params)

    def list_sessions(self) -> pd.DataFrame:
        return self._query(
            """
            SELECT s.id, s.started_at, s.source,
                   COUNT(DISTINCT t.ts) AS snapshots,
                   MIN(t.ts) AS first_ts, MAX(t.ts) AS last_ts
            FROM sessions s LEFT JOIN telemetry t ON t.session_id = s.id
            GROUP BY s.id ORDER BY s.id DESC
            """
        )

    def load_telemetry(self, session_id: int) -> pd.DataFrame:
        """Long format, exactly as stored — the format used for CSV export."""
        return self._query(
            "SELECT ts, source, sensor, value, status, message FROM telemetry"
            " WHERE session_id = ? ORDER BY ts, sensor",
            (session_id,),
        )

    def load_wide(self, session_id: int) -> pd.DataFrame:
        """One row per timestamp, one column per sensor (only OK values; others are NaN)."""
        df = self.load_telemetry(session_id)
        if df.empty:
            return pd.DataFrame()
        ok = df[df["status"] == "ok"]
        wide = ok.pivot_table(index="ts", columns="sensor", values="value", aggfunc="first")
        wide = wide.reindex(sorted(df["ts"].unique()))  # keep timestamps where everything failed
        wide.index = pd.to_datetime(wide.index, format="ISO8601")
        return wide

    def load_alerts(self, session_id: int | None = None) -> pd.DataFrame:
        if session_id is None:
            return self._query("SELECT * FROM alert_events ORDER BY ts DESC")
        return self._query(
            "SELECT * FROM alert_events WHERE session_id = ? ORDER BY ts DESC", (session_id,)
        )

    def export_csv(self, session_id: int) -> str:
        return self.load_telemetry(session_id).to_csv(index=False)
