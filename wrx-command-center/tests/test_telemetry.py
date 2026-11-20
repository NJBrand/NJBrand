from datetime import datetime, timezone

from core.models import DataSource, Reading, ReadingStatus, Snapshot
from core.telemetry import TelemetryBuffer, process, validate
from core.units import convert

TS = datetime(2026, 1, 1, tzinfo=timezone.utc)


def snap(**values):
    return Snapshot(TS, DataSource.SIMULATED, {k: Reading.ok(k, v) for k, v in values.items()})


def test_zero_is_a_valid_reading():
    s = process(snap(speed_kph=0))
    assert s.status("speed_kph") is ReadingStatus.OK
    assert s.value("speed_kph") == 0.0


def test_missing_sensor_is_unavailable_not_fabricated():
    s = process(snap(rpm=800))
    assert s.status("coolant_c") is ReadingStatus.UNAVAILABLE
    assert s.value("coolant_c") is None


def test_out_of_range_and_nan_become_errors():
    assert validate(Reading.ok("coolant_c", 400)).status is ReadingStatus.ERROR
    assert validate(Reading.ok("coolant_c", float("nan"))).status is ReadingStatus.ERROR


def test_boost_is_map_minus_baro():
    s = process(snap(map_kpa=180.0, baro_kpa=100.0))
    assert s.value("boost_kpa") == 80.0
    s = process(snap(map_kpa=30.0, baro_kpa=100.0))
    assert s.value("boost_kpa") == -70.0  # vacuum, not "zero boost"


def test_boost_unavailable_without_baro():
    s = process(snap(map_kpa=180.0))
    assert s.status("boost_kpa") is ReadingStatus.UNAVAILABLE


def test_buffer_rows_keep_gaps_as_none():
    buf = TelemetryBuffer(maxlen=2)
    for v in (1, 2, 3):
        buf.append(process(snap(rpm=v)))
    rows = buf.rows()
    assert [r["rpm"] for r in rows] == [2, 3]
    assert rows[0]["coolant_c"] is None


def test_unit_conversion():
    assert round(convert("boost_kpa", 100, True)[0], 2) == 14.5
    assert convert("coolant_c", 100, True)[0] == 212
    assert convert("coolant_c", 100, False) == (100, "°C")
    assert convert("coolant_c", None, True) == (None, "°F")
