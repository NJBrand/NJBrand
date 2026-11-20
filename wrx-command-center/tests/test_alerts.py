from datetime import datetime, timedelta, timezone

from core.alerts import AlertEngine, Severity, ThresholdRule
from core.models import DataSource, Reading, Snapshot
from core.telemetry import process

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
RULE = ThresholdRule("hot", "coolant_c", Severity.WARNING, above=105, clear_below=102, hold_s=5, message="Hot")


def snap(t, coolant):
    readings = {"coolant_c": Reading.ok("coolant_c", coolant) if coolant is not None
                else Reading.unavailable("coolant_c")}
    return Snapshot(T0 + timedelta(seconds=t), DataSource.SIMULATED, readings)


def threshold_events(engine, t, coolant):
    return [e for e in engine.evaluate(snap(t, coolant)) if e.rule_id == "hot"]


def test_requires_hold_time():
    e = AlertEngine([RULE])
    assert threshold_events(e, 0, 110) == []
    assert threshold_events(e, 4, 110) == []
    ev = threshold_events(e, 5, 110)
    assert len(ev) == 1 and ev[0].state == "raised"
    assert "placeholder" in ev[0].message


def test_brief_spike_does_not_alert():
    e = AlertEngine([RULE])
    threshold_events(e, 0, 110)
    threshold_events(e, 2, 100)  # dips back -> resets the hold timer
    assert threshold_events(e, 6, 110) == []
    assert "hot" not in e.active


def test_no_spam_and_hysteresis():
    e = AlertEngine([RULE])
    events = []
    for t, v in [(0, 110), (5, 110), (6, 111), (7, 104), (8, 103), (9, 101), (10, 101)]:
        events += threshold_events(e, t, v)
    assert [x.state for x in events] == ["raised", "cleared"]
    assert events[1].timestamp == T0 + timedelta(seconds=9)


def test_missing_reading_does_not_clear_alert():
    e = AlertEngine([RULE])
    threshold_events(e, 0, 110)
    threshold_events(e, 5, 110)
    assert threshold_events(e, 6, None) == []
    assert "hot" in e.active


def test_sensor_health_alerts():
    e = AlertEngine([])
    s = process(Snapshot(T0, DataSource.SIMULATED, {"rpm": Reading.ok("rpm", 99999)}))
    ids = {ev.rule_id for ev in e.evaluate(s)}
    assert "sensor_error:rpm" in ids
    assert "sensor_unavailable:coolant_c" in ids
    assert e.evaluate(s) == []  # second identical snapshot: no duplicate events


def test_set_condition_raise_and_clear_once():
    e = AlertEngine([])
    assert len(e.set_condition("connection", True, Severity.WARNING, "lost", T0)) == 1
    assert e.set_condition("connection", True, Severity.WARNING, "lost", T0) == []
    assert e.set_condition("connection", False, Severity.WARNING, "lost", T0)[0].state == "cleared"
