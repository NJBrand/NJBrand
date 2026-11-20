"""Smoke test: the real Streamlit script runs headless and records data."""
from streamlit.testing.v1 import AppTest


def test_app_runs_and_records(tmp_path, monkeypatch):
    monkeypatch.setenv("WRX_DB_PATH", str(tmp_path / "app.db"))
    import importlib
    import config.settings
    importlib.reload(config.settings)

    at = AppTest.from_file("../app.py", default_timeout=30).run()
    assert not at.exception, at.exception
    assert any("SIMULATED DATA" in w.value for w in at.warning)
    assert len(at.metric) >= 6

    store = at.session_state["store"]
    assert store.path == tmp_path / "app.db"
    assert not store.load_telemetry(at.session_state["session_id"]).empty
