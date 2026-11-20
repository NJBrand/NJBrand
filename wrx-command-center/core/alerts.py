"""Alert engine: threshold rules with hold time + hysteresis, sensor-health and connection alerts.

Anti-spam: an alert produces exactly one "raised" event when it starts and one "cleared"
event when it ends — never one event per polling cycle.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum

from core.models import SENSORS, ReadingStatus, Snapshot


class Severity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


@dataclass(frozen=True)
class ThresholdRule:
    rule_id: str
    sensor: str
    severity: Severity
    above: float  # raise when value > above for hold_s seconds
    clear_below: float  # clear when value < clear_below (hysteresis band)
    hold_s: float
    message: str
    validated: bool = False  # False = placeholder, not confirmed against WRX documentation


@dataclass(frozen=True)
class AlertEvent:
    rule_id: str
    severity: Severity
    state: str  # "raised" | "cleared"
    timestamp: datetime
    message: str
    value: float | None = None


class AlertEngine:
    def __init__(self, rules: list[ThresholdRule]):
        self.rules = {r.rule_id: r for r in rules}
        self.active: dict[str, AlertEvent] = {}
        self._pending_since: dict[str, datetime] = {}

    # -- generic on/off condition (used for health and connection alerts) ----------
    def set_condition(
        self, cond_id: str, is_active: bool, severity: Severity, message: str, ts: datetime, value: float | None = None
    ) -> list[AlertEvent]:
        if is_active and cond_id not in self.active:
            ev = AlertEvent(cond_id, severity, "raised", ts, message, value)
            self.active[cond_id] = ev
            return [ev]
        if not is_active and cond_id in self.active:
            prev = self.active.pop(cond_id)
            return [AlertEvent(cond_id, prev.severity, "cleared", ts, f"Cleared: {prev.message}", value)]
        return []

    # -- per-snapshot evaluation ----------------------------------------------------
    def evaluate(self, snap: Snapshot) -> list[AlertEvent]:
        events: list[AlertEvent] = []
        ts = snap.timestamp

        for rule in self.rules.values():
            v = snap.value(rule.sensor)
            if rule.rule_id in self.active:
                # Only clear on a real reading below the hysteresis band. A missing reading
                # does not prove the condition went away; sensor-health alerts cover that.
                if v is not None and v < rule.clear_below:
                    events += self.set_condition(rule.rule_id, False, rule.severity, rule.message, ts, v)
                continue
            if v is not None and v > rule.above:
                since = self._pending_since.setdefault(rule.rule_id, ts)
                if (ts - since).total_seconds() >= rule.hold_s:
                    self._pending_since.pop(rule.rule_id, None)
                    msg = rule.message if rule.validated else f"{rule.message} [placeholder threshold]"
                    events += self.set_condition(rule.rule_id, True, rule.severity, msg, ts, v)
            else:
                self._pending_since.pop(rule.rule_id, None)

        for key, spec in SENSORS.items():
            status = snap.status(key)
            r = snap.readings.get(key)
            detail = r.message if r is not None else ""
            events += self.set_condition(
                f"sensor_error:{key}", status is ReadingStatus.ERROR, Severity.WARNING,
                f"{spec.label}: invalid reading ({detail})", ts,
            )
            events += self.set_condition(
                f"sensor_unavailable:{key}", status is ReadingStatus.UNAVAILABLE, Severity.INFO,
                f"{spec.label}: unavailable ({detail})", ts,
            )
        return events
