"""Application settings.

Every vehicle-specific number below is marked VERIFY. None of them has been confirmed
against Subaru documentation or measured on the actual car. Do not treat alerts based on
them as real diagnostics until they are verified (Phase 3).
"""
from __future__ import annotations

import os
from pathlib import Path

from core.alerts import Severity, ThresholdRule

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("WRX_DB_PATH", PROJECT_ROOT / "data" / "wrx.db"))

# Polling / freshness
DEFAULT_REFRESH_S = 1.0
STALE_AFTER_S = 3.0  # last good snapshot older than this -> shown as STALE, alert raised
LIVE_WINDOW_SNAPSHOTS = 300  # live chart history (~5 min at 1 Hz)

# Dashboard
REDLINE_RPM = 6000  # VERIFY against the tachometer / owner's manual
GAUGE_MAX_RPM = 8000

# Alert rules (metric units). validated=False -> UI labels them as placeholders.
ALERT_RULES: list[ThresholdRule] = [
    ThresholdRule("coolant_high", "coolant_c", Severity.WARNING, above=105, clear_below=102, hold_s=5,
                  message="Coolant temperature high"),  # VERIFY
    ThresholdRule("coolant_critical", "coolant_c", Severity.CRITICAL, above=112, clear_below=108, hold_s=3,
                  message="Coolant temperature very high"),  # VERIFY
    ThresholdRule("intake_high", "intake_c", Severity.WARNING, above=60, clear_below=55, hold_s=10,
                  message="Intake air temperature high (heat soak?)"),  # VERIFY
    ThresholdRule("overboost", "boost_kpa", Severity.WARNING, above=125, clear_below=115, hold_s=1,
                  message="Boost above expected stock peak"),  # VERIFY (~18 psi)
]
