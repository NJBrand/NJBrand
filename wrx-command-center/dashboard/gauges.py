"""Dependency-free SVG gauges."""
from __future__ import annotations

import math

SWEEP = 240.0  # degrees of arc, centred on 12 o'clock
BLUE, RED, TRACK, TEXT, MUTED = "#3D7BFF", "#E5484D", "#263042", "#E6EAF2", "#8A94A8"


def _polar(cx: float, cy: float, r: float, deg: float) -> tuple[float, float]:
    rad = math.radians(deg - 90)
    return cx + r * math.cos(rad), cy + r * math.sin(rad)


def _arc(cx: float, cy: float, r: float, a0: float, a1: float) -> str:
    x0, y0 = _polar(cx, cy, r, a0)
    x1, y1 = _polar(cx, cy, r, a1)
    large = 1 if a1 - a0 > 180 else 0
    return f"M {x0:.1f} {y0:.1f} A {r} {r} 0 {large} 1 {x1:.1f} {y1:.1f}"


def rpm_gauge_svg(value: float | None, max_rpm: float, redline: float, caption: str = "") -> str:
    cx, cy, r = 150, 150, 118
    start = -SWEEP / 2

    def angle(v: float) -> float:
        return start + SWEEP * min(max(v, 0), max_rpm) / max_rpm

    parts = [
        f'<path d="{_arc(cx, cy, r, start, start + SWEEP)}" stroke="{TRACK}" stroke-width="16" fill="none" stroke-linecap="round"/>',
        f'<path d="{_arc(cx, cy, r, angle(redline), start + SWEEP)}" stroke="{RED}" stroke-width="16" fill="none" opacity="0.55"/>',
    ]
    for k in range(0, int(max_rpm) + 1, 1000):
        a = angle(k)
        x0, y0 = _polar(cx, cy, r - 14, a)
        x1, y1 = _polar(cx, cy, r - 24, a)
        tx, ty = _polar(cx, cy, r - 40, a)
        color = RED if k >= redline else MUTED
        parts.append(f'<line x1="{x0:.1f}" y1="{y0:.1f}" x2="{x1:.1f}" y2="{y1:.1f}" stroke="{color}" stroke-width="2"/>')
        parts.append(f'<text x="{tx:.1f}" y="{ty + 5:.1f}" fill="{color}" font-size="14" text-anchor="middle">{k // 1000}</text>')

    if value is None:
        readout, readout_color = "N/A", MUTED
    else:
        color = RED if value >= redline else BLUE
        if value > 0:
            parts.append(f'<path d="{_arc(cx, cy, r, start, angle(value))}" stroke="{color}" stroke-width="16" fill="none" stroke-linecap="round"/>')
        nx, ny = _polar(cx, cy, r - 56, angle(value))
        parts.append(f'<line x1="{cx}" y1="{cy}" x2="{nx:.1f}" y2="{ny:.1f}" stroke="{TEXT}" stroke-width="3" stroke-linecap="round"/>')
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="7" fill="{TEXT}"/>')
        readout, readout_color = f"{value:,.0f}", color

    parts.append(f'<text x="{cx}" y="{cy + 112}" fill="{readout_color}" font-size="40" font-weight="700" text-anchor="middle" font-family="monospace">{readout}</text>')
    parts.append(f'<text x="{cx}" y="{cy + 134}" fill="{MUTED}" font-size="13" text-anchor="middle">RPM (scale ×1000) {caption}</text>')
    return (
        '<svg viewBox="0 0 300 292" width="100%" style="max-width:360px;display:block;margin:auto" '
        'xmlns="http://www.w3.org/2000/svg" role="img" aria-label="RPM gauge">' + "".join(parts) + "</svg>"
    )
