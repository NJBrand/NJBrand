from core.models import SENSORS, DataSource, ReadingStatus
from core.telemetry import process
from providers.base import ProviderError
from providers.simulator import FaultMode, SimulationProvider, wheel_rpm

import pytest


def run(sim, seconds, dt=0.5):
    snaps = []
    for _ in range(int(seconds / dt)):
        sim.step(dt)
        snaps.append(process(sim.snapshot()))
    return snaps


def test_snapshots_are_labelled_simulated_and_plausible():
    snaps = run(SimulationProvider(seed=1), 600)
    for s in snaps:
        assert s.source is DataSource.SIMULATED
        for key in SENSORS:
            assert s.status(key) is ReadingStatus.OK, (key, s.readings[key])


def test_drive_cycle_actually_drives_and_boosts():
    snaps = run(SimulationProvider(seed=2), 600)
    assert max(s.value("speed_kph") for s in snaps) > 40
    assert max(s.value("rpm") for s in snaps) > 3000
    assert max(s.value("boost_kpa") for s in snaps) > 20  # positive boost under load
    assert min(s.value("boost_kpa") for s in snaps) < -40  # vacuum at idle / overrun
    assert any(s.value("speed_kph") == 0 for s in snaps)  # comes to a stop


def test_deterministic_with_seed():
    a = [s.value("rpm") for s in run(SimulationProvider(seed=7), 60)]
    b = [s.value("rpm") for s in run(SimulationProvider(seed=7), 60)]
    assert a == b


def test_gearing_sanity():
    # ~60 mph in 6th should be roughly 2,000-2,300 rpm with these (unverified) ratios
    assert 1900 < wheel_rpm(26.8, 6) < 2400


def test_overheat_fault_raises_coolant():
    sim = SimulationProvider(seed=3)
    sim.fault = FaultMode.OVERHEAT
    snaps = run(sim, 180)
    assert snaps[-1].value("coolant_c") > 112


def test_coolant_dropout_is_unavailable_not_zero():
    sim = SimulationProvider(seed=4)
    sim.fault = FaultMode.COOLANT_DROPOUT
    s = process(sim.snapshot())
    assert s.status("coolant_c") is ReadingStatus.UNAVAILABLE
    assert s.value("coolant_c") is None


def test_rpm_glitch_is_flagged_as_error():
    sim = SimulationProvider(seed=5)
    sim.fault = FaultMode.RPM_GLITCH
    s = process(sim.snapshot())
    assert s.status("rpm") is ReadingStatus.ERROR
    assert s.value("rpm") is None
    assert "implausible" in s.readings["rpm"].message


def test_connection_loss_raises():
    t = [0.0]
    sim = SimulationProvider(seed=6, clock=lambda: t[0])
    sim.connect()
    sim.fault = FaultMode.CONNECTION_LOSS
    t[0] = 1.0
    with pytest.raises(ProviderError):
        sim.read()
