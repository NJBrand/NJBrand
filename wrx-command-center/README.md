# WRX Command Center — v0.1 (Phase 1)

Telemetry dashboard for a 2022 Subaru WRX 6MT. **v0.1 runs on simulated data only.** Nothing here talks to a car yet.

## Run it on Windows (PowerShell)

```powershell
cd wrx-command-center
py -m venv .venv
.\.venv\Scripts\Activate.ps1      # if blocked: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
pip install -r requirements.txt
streamlit run app.py              # opens http://localhost:8501
pytest                            # 27 tests
```

## What v0.1 does

- Live dashboard (1 s refresh, configurable): RPM gauge, speed, boost, throttle, coolant, intake temp, MAP, plus rolling charts.
- A drive-cycle simulator using the 6MT gear ratios, so RPM, speed and boost move together believably.
- **Fault injection** (sidebar): overheat, coolant sensor drop-out, garbage RPM value, adapter connection loss. Use it to see the alerts working.
- Alerts with a hold time and hysteresis. Each alert produces one "raised" and one "cleared" event, never a repeat every tick.
- SQLite recording by session. The History tab has charts and CSV export.
- Imperial/metric display. Data is always stored in metric.

## Data integrity rules (enforced + tested)

| Situation | Status | Value | Shown as |
|---|---|---|---|
| Real zero (e.g. stopped) | `ok` | `0` | `0` |
| Sensor not reported | `unavailable` | `NULL` | `N/A` |
| Implausible / failed read | `error` | `NULL` | `ERR` |
| No fresh data > 3 s | — | — | `STALE`, values hidden |

Every stored row carries `source` (`simulated` / `replay` / `real`). Boost = MAP − barometric pressure, so a negative number means vacuum.

## Known placeholders (VERIFY before Phase 3)

All in `config/settings.py` and `providers/simulator.py`: alert thresholds, redline, gear ratios, final drive, tire size. None of them have been checked against Subaru documentation.

## Layout

```
app.py                 Streamlit UI
config/settings.py     thresholds, paths, refresh
core/models.py         Reading / Snapshot / status model
core/telemetry.py      validation, derived boost, live buffer
core/alerts.py         alert engine
core/units.py          display conversion
providers/base.py      provider interface (simulation / replay / OBD plug in here)
providers/simulator.py drive-cycle simulator + fault modes
storage/database.py    SQLite, versioned migrations
dashboard/gauges.py    SVG gauges
tests/                 pytest suite incl. headless app smoke test
```

DB location: `data/wrx.db` (override with the `WRX_DB_PATH` environment variable).
