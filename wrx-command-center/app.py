"""WRX Command Center v0.1 — Streamlit dashboard (simulated data).

Run:  streamlit run app.py
"""
from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
import streamlit as st

from config import settings
from core.alerts import AlertEngine, Severity
from core.models import SENSORS, DataSource, ReadingStatus, Snapshot
from core.telemetry import TelemetryBuffer, age_seconds, process
from core.units import convert
from dashboard.gauges import rpm_gauge_svg
from providers.base import ProviderError
from providers.simulator import FaultMode, SimulationProvider
from storage.database import TelemetryStore

st.set_page_config(page_title="WRX Command Center", page_icon="🏁", layout="wide")

SEVERITY_ICON = {Severity.INFO: "ℹ️", Severity.WARNING: "⚠️", Severity.CRITICAL: "🛑"}
FAULT_LABELS = {
    FaultMode.NONE: "None (normal driving)",
    FaultMode.OVERHEAT: "Overheat — coolant climbs",
    FaultMode.COOLANT_DROPOUT: "Coolant sensor drop-out",
    FaultMode.RPM_GLITCH: "RPM garbage value",
    FaultMode.CONNECTION_LOSS: "Adapter connection loss",
}


# --------------------------------------------------------------------------- state
def init_state() -> None:
    ss = st.session_state
    if "provider" in ss:
        return
    ss.store = TelemetryStore(settings.DB_PATH)
    ss.provider = SimulationProvider()
    ss.provider.connect()
    ss.engine = AlertEngine(settings.ALERT_RULES)
    ss.buffer = TelemetryBuffer(settings.LIVE_WINDOW_SNAPSHOTS)
    ss.last_snapshot = None
    ss.last_error = None
    ss.session_id = ss.store.start_session(ss.provider.source)
    ss.write_errors = 0


def poll_once() -> None:
    """One telemetry cycle: read -> validate -> alerts -> record."""
    ss = st.session_state
    now = datetime.now(timezone.utc)
    events = []
    try:
        snap = process(ss.provider.read())
        ss.last_snapshot, ss.last_error = snap, None
        ss.buffer.append(snap)
        events += ss.engine.set_condition("connection", False, Severity.WARNING, "", now)
        events += ss.engine.evaluate(snap)
    except ProviderError as exc:
        ss.last_error = str(exc)
        events += ss.engine.set_condition("connection", True, Severity.WARNING, f"No data from provider: {exc}", now)
        snap = None

    age = age_seconds(ss.last_snapshot, now)
    stale = age is None or age > settings.STALE_AFTER_S
    events += ss.engine.set_condition(
        "stale_data", stale and ss.last_snapshot is not None, Severity.WARNING,
        f"Telemetry stale (no fresh data for >{settings.STALE_AFTER_S:.0f}s)", now,
    )

    if ss.recording:
        try:
            if snap is not None:
                ss.store.save_snapshot(ss.session_id, snap)
            ss.store.save_alerts(ss.session_id, events)
            ss.engine.set_condition("db_write", False, Severity.WARNING, "", now)
        except Exception as exc:  # disk full, locked DB, etc. — never crash the dashboard
            ss.write_errors += 1
            ss.engine.set_condition("db_write", True, Severity.WARNING, f"Data logging failed: {exc}", now)


# --------------------------------------------------------------------------- display helpers
def fmt(snap: Snapshot | None, key: str, imperial: bool, decimals: int = 0) -> tuple[str, str]:
    """Return (display value, unit). Never shows a number for unavailable/error readings."""
    _, unit = convert(key, None, imperial)
    if snap is None:
        return "—", unit
    status = snap.status(key)
    if status is ReadingStatus.UNAVAILABLE:
        return "N/A", unit
    if status is ReadingStatus.ERROR:
        return "ERR", unit
    value, unit = convert(key, snap.value(key), imperial)
    return f"{value:,.{decimals}f}", unit


def chart_frame(rows: list[dict], cols: dict[str, str], imperial: bool) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    out = pd.DataFrame(index=pd.to_datetime(df["timestamp"]))
    for key, label in cols.items():
        _, unit = convert(key, None, imperial)
        out[f"{label} ({unit})"] = [convert(key, v, imperial)[0] for v in df[key]]
    return out


# --------------------------------------------------------------------------- UI
def sidebar() -> tuple[bool, float]:
    ss = st.session_state
    with st.sidebar:
        st.header("Controls")
        st.selectbox(
            "Data source", ["Simulation", "Replay (Phase 2)", "OBD-II (Phase 3)"],
            index=0, disabled=True, help="Only simulation exists in v0.1.",
        )
        fault = st.selectbox(
            "Inject fault (simulation only)", list(FAULT_LABELS),
            format_func=FAULT_LABELS.get, key="fault_mode",
        )
        ss.provider.fault = fault
        imperial = st.radio("Units", ["Imperial", "Metric"], horizontal=True) == "Imperial"
        refresh = st.select_slider("Refresh interval (s)", [0.5, 1.0, 2.0, 5.0], value=settings.DEFAULT_REFRESH_S)
        ss.recording = st.toggle("Record to database", value=True)
        if st.button("Start new session", use_container_width=True):
            ss.session_id = ss.store.start_session(ss.provider.source)
            ss.buffer.clear()
            st.toast(f"Session #{ss.session_id} started")
        st.caption(f"Session #{ss.session_id} · DB: `{settings.DB_PATH.name}`")
    return imperial, refresh


def render_live(imperial: bool) -> None:
    ss = st.session_state
    snap: Snapshot | None = ss.last_snapshot
    now = datetime.now(timezone.utc)
    age = age_seconds(snap, now)
    stale = snap is None or (age is not None and age > settings.STALE_AFTER_S)

    # status strip
    c1, c2, c3, c4 = st.columns(4)
    if ss.last_error:
        c1.markdown(f"**Link:** :red[● {ss.last_error}]")
    else:
        c1.markdown("**Link:** :green[● connected (simulator)]")
    c2.markdown(f"**Data:** {':orange[STALE]' if stale else ':green[live]'}" + (f" · {age:.1f}s old" if age is not None else ""))
    c3.markdown(f"**Recording:** {':red[● REC]' if ss.recording else 'off'}" + (f" · :red[{ss.write_errors} write errors]" if ss.write_errors else ""))
    n_active = len(ss.engine.active)
    worst = max((e.severity for e in ss.engine.active.values()),
                key=[Severity.INFO, Severity.WARNING, Severity.CRITICAL].index, default=None)
    c4.markdown(f"**Alerts:** {SEVERITY_ICON[worst] + ' ' + str(n_active) if worst else ':green[none]'}")

    # gauges
    left, right = st.columns([1, 1.4])
    with left:
        rpm = None if stale else (snap.value("rpm") if snap else None)
        st.markdown(rpm_gauge_svg(rpm, settings.GAUGE_MAX_RPM, settings.REDLINE_RPM,
                                  "· STALE" if stale and snap else ""), unsafe_allow_html=True)
    with right:
        tiles = [
            ("Speed", "speed_kph", 0), ("Boost", "boost_kpa", 1), ("Throttle", "throttle_pct", 0),
            ("Coolant", "coolant_c", 0), ("Intake air", "intake_c", 0), ("Manifold (abs)", "map_kpa", 1),
        ]
        cols = st.columns(3)
        for i, (label, key, dec) in enumerate(tiles):
            value, unit = fmt(None if stale else snap, key, imperial, dec)
            cols[i % 3].metric(f"{label} ({unit})", value)
        if snap is not None:
            bad = [f"{SENSORS[k].label}: {r.status.value} — {r.message}"
                   for k, r in snap.readings.items() if r.status is not ReadingStatus.OK]
            if bad:
                st.caption("Sensor issues: " + " · ".join(bad))

    # active alerts
    if ss.engine.active:
        for ev in sorted(ss.engine.active.values(), key=lambda e: e.timestamp):
            text = f"{SEVERITY_ICON[ev.severity]} **{ev.severity.value.upper()}** — {ev.message} (since {ev.timestamp:%H:%M:%S} UTC)"
            {Severity.CRITICAL: st.error, Severity.WARNING: st.warning}.get(ev.severity, st.info)(text)

    # live charts
    rows = ss.buffer.rows()
    if rows:
        ch1, ch2 = st.columns(2)
        with ch1:
            st.caption("Engine RPM · Boost (negative = vacuum)")
            st.line_chart(chart_frame(rows, {"rpm": "RPM"}, imperial), height=220)
            st.line_chart(chart_frame(rows, {"boost_kpa": "Boost"}, imperial), height=180)
        with ch2:
            st.caption("Temperatures · Speed")
            st.line_chart(chart_frame(rows, {"coolant_c": "Coolant", "intake_c": "Intake"}, imperial), height=220)
            st.line_chart(chart_frame(rows, {"speed_kph": "Speed"}, imperial), height=180)


def render_history(imperial: bool) -> None:
    store: TelemetryStore = st.session_state.store
    sessions = store.list_sessions()
    if sessions.empty:
        st.info("No sessions recorded yet.")
        return
    labels = {
        int(r.id): f"#{r.id} · {r.source} · {r.started_at[:19].replace('T', ' ')} UTC · {r.snapshots} snapshots"
        for r in sessions.itertuples()
    }
    sid = st.selectbox("Session", list(labels), format_func=labels.get)
    st.button("Refresh", help="History doesn't auto-refresh; click to load newly recorded data.")
    wide = store.load_wide(sid)
    if wide.empty:
        st.info("This session has no telemetry yet.")
    else:
        rows = [{"timestamp": ts, **{k: (row.get(k) if pd.notna(row.get(k)) else None) for k in SENSORS}}
                for ts, row in wide.iterrows()]
        st.caption("Engine RPM")
        st.line_chart(chart_frame(rows, {"rpm": "RPM"}, imperial), height=220)
        st.caption("Temperatures")
        st.line_chart(chart_frame(rows, {"coolant_c": "Coolant", "intake_c": "Intake"}, imperial), height=220)
        st.caption("Boost (negative = vacuum)")
        st.line_chart(chart_frame(rows, {"boost_kpa": "Boost"}, imperial), height=180)
    st.download_button(
        "⬇ Export session as CSV", store.export_csv(sid),
        file_name=f"wrx_session_{sid}.csv", mime="text/csv",
        help="Long format, metric units, with source + status per reading.",
    )
    with st.expander("Raw stored rows (last 200)"):
        st.dataframe(store.load_telemetry(sid).tail(200), use_container_width=True, hide_index=True)


def render_alert_log() -> None:
    df = st.session_state.store.load_alerts()
    st.button("Refresh", key="refresh_alerts")
    if df.empty:
        st.info("No alert events recorded yet. Try an injected fault from the sidebar.")
    else:
        st.dataframe(df, use_container_width=True, hide_index=True)


# --------------------------------------------------------------------------- main
def main() -> None:
    init_state()
    imperial, refresh = sidebar()

    st.title("WRX Command Center")
    st.warning("**SIMULATED DATA** — generated by software, not read from a vehicle. "
               "Alert thresholds are unverified placeholders.", icon="🧪")

    tab_live, tab_hist, tab_alerts = st.tabs(["Live", "History & export", "Alert log"])

    @st.fragment(run_every=refresh)
    def live() -> None:
        poll_once()
        render_live(imperial)

    with tab_live:
        live()
    with tab_hist:
        render_history(imperial)
    with tab_alerts:
        render_alert_log()


main()
