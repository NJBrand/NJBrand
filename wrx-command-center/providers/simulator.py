"""Simulated WRX telemetry for development without the car.

A small drive-cycle model (idle -> accelerate through the gears -> cruise -> brake -> stop)
so RPM, speed, boost and temperatures move together plausibly. It is NOT a physics-accurate
model of the FA24 and must never be presented as real vehicle data.

Fault modes let you exercise the alert engine and the "unavailable vs error" handling.
"""
from __future__ import annotations

import random
import time
from datetime import datetime, timezone
from enum import Enum
from typing import Callable

from core.models import DataSource, Reading, Snapshot
from providers.base import ProviderError, TelemetryProvider

# Drivetrain approximation — VERIFY against Subaru specs before using for gear estimation.
GEAR_RATIOS = (3.454, 1.947, 1.296, 0.972, 0.738, 0.666)
FINAL_DRIVE = 4.111
TIRE_CIRCUMFERENCE_M = 2.052  # 245/40R18
IDLE_RPM = 750.0
BARO_KPA = 101.3


class FaultMode(str, Enum):
    NONE = "none"
    OVERHEAT = "overheat"  # coolant climbs past warning/critical thresholds
    COOLANT_DROPOUT = "coolant_dropout"  # coolant sensor stops reporting (UNAVAILABLE)
    RPM_GLITCH = "rpm_glitch"  # implausible RPM value (should become ERROR)
    CONNECTION_LOSS = "connection_loss"  # read() raises ProviderError


def wheel_rpm(speed_mps: float, gear: int) -> float:
    if gear <= 0:
        return 0.0
    return speed_mps / TIRE_CIRCUMFERENCE_M * 60.0 * GEAR_RATIOS[gear - 1] * FINAL_DRIVE


class SimulationProvider(TelemetryProvider):
    source = DataSource.SIMULATED

    def __init__(self, seed: int | None = None, ambient_c: float = 22.0,
                 clock: Callable[[], float] = time.monotonic,
                 now: Callable[[], datetime] = lambda: datetime.now(timezone.utc)):
        self._rng = random.Random(seed)
        self._clock = clock
        self._now = now
        self.ambient_c = ambient_c
        self.fault = FaultMode.NONE
        self._last_clock: float | None = None
        # vehicle state
        self.speed = 0.0  # m/s
        self.gear = 0  # 0 = neutral
        self.rpm = IDLE_RPM
        self.throttle = 0.0  # 0..1
        self.map_kpa = 33.0
        self.coolant = ambient_c + 20.0  # car recently driven; shortens warm-up for demos
        self.intake = ambient_c + 5.0
        # drive-cycle state
        self.phase = "idle"
        self.phase_time = 0.0
        self.phase_len = 5.0
        self.target_speed = 0.0
        self.aggression = 0.5

    # -- provider interface -------------------------------------------------------
    def connect(self) -> None:
        self._last_clock = self._clock()

    def read(self) -> Snapshot:
        if self._last_clock is None:
            self.connect()
        now = self._clock()
        dt = min(max(now - self._last_clock, 0.0), 2.0)  # clamp after pauses
        self._last_clock = now
        self.step(dt)
        if self.fault is FaultMode.CONNECTION_LOSS:
            raise ProviderError("simulated adapter timeout")
        return self.snapshot()

    # -- model --------------------------------------------------------------------
    def step(self, dt: float) -> None:
        while dt > 1e-9:
            h = min(dt, 0.1)
            self._tick(h)
            dt -= h

    def _tick(self, dt: float) -> None:
        rng = self._rng
        self.phase_time += dt
        accel = 0.0

        if self.phase == "idle":
            self.throttle, self.gear = 0.0, 0
            if self.phase_time >= self.phase_len:
                self._enter("accel")
                self.target_speed = rng.choice([13.4, 20.1, 26.8, 31.3])  # 30/45/60/70 mph
                self.aggression = rng.uniform(0.3, 1.0)
                self.gear = 1
        elif self.phase == "accel":
            self.throttle = self.aggression
            shift_rpm = 2800 + self.aggression * 3000
            if self.rpm >= shift_rpm and self.gear < 6:
                self.gear += 1
            accel = self.throttle * 5.0 * (GEAR_RATIOS[self.gear - 1] / GEAR_RATIOS[0]) ** 0.7
            if self.speed >= self.target_speed:
                self._enter("cruise", rng.uniform(10, 25))
        elif self.phase == "cruise":
            self.throttle = 0.12 + rng.uniform(-0.03, 0.03)
            accel = (self.target_speed - self.speed) * 0.3 + rng.uniform(-0.2, 0.2)
            while self.gear < 6 and wheel_rpm(self.speed, self.gear + 1) > 1700:
                self.gear += 1
            if self.phase_time >= self.phase_len:
                self._enter("decel")
                self.aggression = rng.uniform(1.5, 3.5)  # braking m/s²
        elif self.phase == "decel":
            self.throttle = 0.0
            accel = -self.aggression
            while self.gear > 1 and wheel_rpm(self.speed, self.gear) < 1300:
                self.gear -= 1
            if self.speed <= 0.5:
                self.speed, self.gear = 0.0, 0
                self._enter("idle", rng.uniform(4, 10))

        drag = 0.1 + 0.0004 * self.speed**2
        self.speed = max(0.0, self.speed + (accel - drag) * dt)

        # engine speed: clutch slip at launch, idle when in neutral or at a crawl in gear
        wr = wheel_rpm(self.speed, self.gear)
        if self.gear == 0:
            target_rpm = IDLE_RPM
        elif self.gear == 1 and self.throttle > 0 and wr < 1800:
            target_rpm = 1800 + self.throttle * 1200
        else:
            target_rpm = max(wr, IDLE_RPM if self.speed < 2 else wr)
        self.rpm += (target_rpm - self.rpm) * min(1.0, dt / 0.15)

        # manifold pressure with turbo lag
        if self.throttle < 0.05:
            map_target = 22.0 if self.rpm > 1200 else 33.0  # closed-throttle vacuum
        else:
            map_target = 35 + self.throttle * 60
            if self.throttle > 0.45 and self.rpm > 2200:
                spool = min(1.0, (self.rpm - 2200) / 1300)
                map_target = BARO_KPA + spool * self.throttle * 105
        self.map_kpa += (map_target - self.map_kpa) * min(1.0, dt / 0.6)

        # temperatures (thermostat-regulated coolant; heat-soaked intake at low speed)
        if self.fault is FaultMode.OVERHEAT:
            coolant_target, tau = 125.0, 25.0
        else:
            coolant_target, tau = 90.0 + 4.0 * self.throttle, 60.0
        self.coolant += (coolant_target - self.coolant) * dt / tau
        boost = max(0.0, self.map_kpa - BARO_KPA)
        soak = 18.0 if self.speed < 3 else max(2.0, 8.0 - self.speed * 0.15)
        self.intake += (self.ambient_c + soak + boost * 0.12 - self.intake) * dt / 20.0

    def _enter(self, phase: str, length: float = 0.0) -> None:
        self.phase, self.phase_time, self.phase_len = phase, 0.0, length

    # -- output -------------------------------------------------------------------
    def snapshot(self) -> Snapshot:
        n = self._rng.gauss
        rpm = max(0.0, self.rpm + n(0, 8))
        if self.fault is FaultMode.RPM_GLITCH:
            rpm = 16383.75  # max encodable value of OBD PID 0x0C — a classic garbage read
        readings = {
            "rpm": Reading.ok("rpm", round(rpm)),
            "speed_kph": Reading.ok("speed_kph", round(self.speed * 3.6)),  # PID 0x0D is whole km/h
            "coolant_c": Reading.ok("coolant_c", round(self.coolant + n(0, 0.2), 1)),
            "intake_c": Reading.ok("intake_c", round(self.intake + n(0, 0.3), 1)),
            "map_kpa": Reading.ok("map_kpa", round(max(0.0, self.map_kpa + n(0, 0.4)), 1)),
            "baro_kpa": Reading.ok("baro_kpa", round(BARO_KPA + n(0, 0.05), 1)),
            "throttle_pct": Reading.ok("throttle_pct", round(self.throttle * 100, 1)),
        }
        if self.fault is FaultMode.COOLANT_DROPOUT:
            readings["coolant_c"] = Reading.unavailable("coolant_c", "no response from sensor")
        return Snapshot(self._now(), self.source, readings)
