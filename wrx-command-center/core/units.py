"""Unit conversion for display. Internal storage is always metric."""
from __future__ import annotations

KPA_TO_PSI = 0.1450377
KPH_PER_MPH = 1.609344

# sensor key -> (imperial unit, converter)
IMPERIAL = {
    "speed_kph": ("mph", lambda v: v / KPH_PER_MPH),
    "coolant_c": ("°F", lambda v: v * 9 / 5 + 32),
    "intake_c": ("°F", lambda v: v * 9 / 5 + 32),
    "boost_kpa": ("psi", lambda v: v * KPA_TO_PSI),
    "map_kpa": ("psi", lambda v: v * KPA_TO_PSI),
    "baro_kpa": ("psi", lambda v: v * KPA_TO_PSI),
}

METRIC_UNITS = {
    "rpm": "rpm",
    "speed_kph": "km/h",
    "coolant_c": "°C",
    "intake_c": "°C",
    "boost_kpa": "kPa",
    "map_kpa": "kPa",
    "baro_kpa": "kPa",
    "throttle_pct": "%",
}


def convert(sensor: str, value: float | None, imperial: bool) -> tuple[float | None, str]:
    if imperial and sensor in IMPERIAL:
        unit, fn = IMPERIAL[sensor]
        return (None if value is None else fn(value)), unit
    return value, METRIC_UNITS.get(sensor, "")
