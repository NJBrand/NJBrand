import io
from datetime import datetime, timezone

import pandas as pd

from core.alerts import AlertEvent, Severity
from core.models import DataSource, Reading, Snapshot
from core.telemetry import process
from storage.database import MIGRATIONS, TelemetryStore

TS = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)


def test_migrations_are_idempotent(tmp_path):
    path = tmp_path / "wrx.db"
    TelemetryStore(path)
    store = TelemetryStore(path)  # second open must not re-run migrations
    assert store.schema_version() == len(MIGRATIONS)


def test_roundtrip_preserves_status(tmp_path):
    store = TelemetryStore(tmp_path / "wrx.db")
    sid = store.start_session(DataSource.SIMULATED)
    snap = process(Snapshot(TS, DataSource.SIMULATED, {
        "rpm": Reading.ok("rpm", 0),
        "coolant_c": Reading.unavailable("coolant_c", "no response"),
        "map_kpa": Reading.ok("map_kpa", 500),  # implausible -> error
    }))
    store.save_snapshot(sid, snap)

    df = store.load_telemetry(sid).set_index("sensor")
    assert df.loc["rpm", "value"] == 0 and df.loc["rpm", "status"] == "ok"
    assert pd.isna(df.loc["coolant_c", "value"]) and df.loc["coolant_c", "status"] == "unavailable"
    assert df.loc["map_kpa", "status"] == "error"
    assert set(df["source"]) == {"simulated"}

    wide = store.load_wide(sid)
    assert len(wide) == 1 and wide["rpm"].iloc[0] == 0
    assert "coolant_c" not in wide.columns or pd.isna(wide["coolant_c"].iloc[0])


def test_csv_export(tmp_path):
    store = TelemetryStore(tmp_path / "wrx.db")
    sid = store.start_session(DataSource.SIMULATED)
    store.save_snapshot(sid, process(Snapshot(TS, DataSource.SIMULATED, {"rpm": Reading.ok("rpm", 2500)})))
    df = pd.read_csv(io.StringIO(store.export_csv(sid)))
    assert list(df.columns) == ["ts", "source", "sensor", "value", "status", "message"]
    assert df[df.sensor == "rpm"].value.iloc[0] == 2500


def test_alerts_and_sessions(tmp_path):
    store = TelemetryStore(tmp_path / "wrx.db")
    sid = store.start_session(DataSource.SIMULATED)
    store.save_alerts(sid, [AlertEvent("hot", Severity.WARNING, "raised", TS, "Hot", 110.0)])
    assert store.load_alerts(sid).iloc[0]["rule_id"] == "hot"
    assert store.list_sessions().iloc[0]["id"] == sid


def test_sql_injection_is_inert(tmp_path):
    store = TelemetryStore(tmp_path / "wrx.db")
    sid = store.start_session(DataSource.SIMULATED, notes="x'); DROP TABLE telemetry; --")
    store.save_snapshot(sid, process(Snapshot(TS, DataSource.SIMULATED, {"rpm": Reading.ok("rpm", 1)})))
    assert not store.load_telemetry(sid).empty
