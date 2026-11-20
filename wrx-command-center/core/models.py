"""Core telemetry data model shared by every provider, the alert engine, storage and UI.

Design rule: a reading is never just a number. It always carries a status so the
rest of the system can tell apart:
    * a genuine zero          -> status OK, value 0.0
    * a sensor that isn't reported / supported -> status UNAVAILABLE, value None
    * a failed or implausible read           -> status ERROR, value None
Values are stored internally in metric units; conversion happens only for display.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class ReadingStatus(str, Enum):
    OK = "ok"
    UNAVAILABLE = "unavailable"
    ERROR = "error"


class DataSource(str, Enum):
    SIMULATED = "simulated"
    REPLAY = "replay"
    REAL = "real"


@dataclass(frozen=True)
class SensorDef:
    key: str
    label: str
    unit: str  # internal (metric) unit
    min_valid: float
    max_valid: float
    derived: bool = False  # computed from other sensors, not read from the vehicle


# Plausibility ranges are physical sanity limits, NOT warning thresholds.
SENSORS: dict[str, SensorDef] = {
    s.key: s
    for s in (
        SensorDef("rpm", "Engine RPM", "rpm", 0, 9000),
        SensorDef("speed_kph", "Vehicle speed", "km/h", 0, 300),
        SensorDef("coolant_c", "Coolant temp", "°C", -40, 150),
        SensorDef("intake_c", "Intake air temp", "°C", -40, 120),
        SensorDef("map_kpa", "Manifold abs. pressure", "kPa", 0, 300),
        SensorDef("baro_kpa", "Barometric pressure", "kPa", 50, 110),
        SensorDef("throttle_pct", "Throttle position", "%", 0, 100),
        SensorDef("boost_kpa", "Boost (MAP − baro)", "kPa", -110, 250, derived=True),
    )
}


@dataclass(frozen=True)
class Reading:
    sensor: str
    value: float | None
    status: ReadingStatus
    message: str = ""

    @staticmethod
    def ok(sensor: str, value: float) -> "Reading":
        return Reading(sensor, float(value), ReadingStatus.OK)

    @staticmethod
    def unavailable(sensor: str, message: str = "not reported") -> "Reading":
        return Reading(sensor, None, ReadingStatus.UNAVAILABLE, message)

    @staticmethod
    def error(sensor: str, message: str) -> "Reading":
        return Reading(sensor, None, ReadingStatus.ERROR, message)


@dataclass(frozen=True)
class Snapshot:
    """All readings captured in one polling cycle."""

    timestamp: datetime  # timezone-aware UTC
    source: DataSource
    readings: dict[str, Reading] = field(default_factory=dict)

    def value(self, sensor: str) -> float | None:
        r = self.readings.get(sensor)
        return r.value if r is not None and r.status is ReadingStatus.OK else None

    def status(self, sensor: str) -> ReadingStatus:
        r = self.readings.get(sensor)
        return r.status if r is not None else ReadingStatus.UNAVAILABLE
