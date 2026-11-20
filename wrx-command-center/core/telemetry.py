"""Telemetry processing: validation, derived values, and a short in-memory history."""
from __future__ import annotations

from collections import deque
from dataclasses import replace
from datetime import datetime

from core.models import SENSORS, Reading, ReadingStatus, Snapshot


def validate(reading: Reading) -> Reading:
    """Turn implausible OK readings into ERROR readings. Never invent a replacement value."""
    if reading.status is not ReadingStatus.OK:
        return reading
    spec = SENSORS.get(reading.sensor)
    if spec is None:
        return Reading.error(reading.sensor, "unknown sensor")
    v = reading.value
    if v is None or v != v:  # None or NaN
        return Reading.error(reading.sensor, "missing value")
    if not spec.min_valid <= v <= spec.max_valid:
        return Reading.error(
            reading.sensor, f"implausible value {v:g} {spec.unit} (valid {spec.min_valid:g}..{spec.max_valid:g})"
        )
    return reading


def derive_boost(snapshot: Snapshot) -> Reading:
    """Boost = absolute manifold pressure − barometric pressure. Negative = vacuum."""
    map_kpa, baro_kpa = snapshot.value("map_kpa"), snapshot.value("baro_kpa")
    if map_kpa is None or baro_kpa is None:
        missing = [k for k in ("map_kpa", "baro_kpa") if snapshot.value(k) is None]
        return Reading.unavailable("boost_kpa", f"needs {', '.join(missing)}")
    return Reading.ok("boost_kpa", round(map_kpa - baro_kpa, 2))


def process(raw: Snapshot) -> Snapshot:
    """Validate every reading, mark expected-but-missing sensors, add derived values."""
    readings = {k: validate(r) for k, r in raw.readings.items()}
    for key, spec in SENSORS.items():
        if not spec.derived and key not in readings:
            readings[key] = Reading.unavailable(key)
    snap = replace(raw, readings=readings)
    readings["boost_kpa"] = validate(derive_boost(snap))
    return replace(raw, readings=readings)


def age_seconds(snapshot: Snapshot | None, now: datetime) -> float | None:
    return None if snapshot is None else (now - snapshot.timestamp).total_seconds()


class TelemetryBuffer:
    """Rolling window of recent snapshots for live charts (keeps DB reads off the hot path)."""

    def __init__(self, maxlen: int = 900):
        self._items: deque[Snapshot] = deque(maxlen=maxlen)

    def append(self, snapshot: Snapshot) -> None:
        self._items.append(snapshot)

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)

    def rows(self) -> list[dict]:
        """Wide rows; unavailable/error readings become None (gaps in charts, not zeros)."""
        out = []
        for s in self._items:
            row = {"timestamp": s.timestamp}
            row.update({k: s.value(k) for k in SENSORS})
            out.append(row)
        return out
