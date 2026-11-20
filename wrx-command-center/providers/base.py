"""Provider interface. The dashboard only talks to this, so simulation, replay and real
OBD-II can be swapped without touching the UI."""
from __future__ import annotations

from abc import ABC, abstractmethod

from core.models import DataSource, Snapshot


class ProviderError(Exception):
    """Communication failure: no snapshot could be produced this cycle."""


class TelemetryProvider(ABC):
    source: DataSource

    @abstractmethod
    def connect(self) -> None: ...

    @abstractmethod
    def read(self) -> Snapshot:
        """Return one snapshot of raw readings, or raise ProviderError."""

    def close(self) -> None:
        pass
