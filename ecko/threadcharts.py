"""Thread color charts.

Built-in charts come from pyembroidery (MIT): the Brother, Janome and
Husqvarna Viking machine palettes with their catalog numbers. Charts for
other thread brands (Madeira, Isacord, Robison-Anton...) can be imported in
the browser from the brand's CSV/GPL file, so we never guess catalog codes.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import cv2
import numpy as np
import pyembroidery.EmbThreadHus as _hus
import pyembroidery.EmbThreadJef as _jef
import pyembroidery.EmbThreadPec as _pec

from .digitizer.threads import NAMED


@dataclass(frozen=True)
class Thread:
    hex: str
    name: str
    code: str
    brand: str


def _from_pe(module, brand: str) -> list[Thread]:
    out, seen = [], set()
    for t in module.get_thread_set():
        if t is None:
            continue
        key = (t.hex_color().lower(), t.description)
        if key in seen:
            continue
        seen.add(key)
        out.append(Thread(t.hex_color().lower(), t.description, str(t.catalog_number or ""), brand))
    return out


CHARTS: dict[str, dict] = {
    "generic": {
        "name": "Generic colors (no brand)",
        "threads": [Thread("#%02x%02x%02x" % rgb, name, "", "") for name, rgb in NAMED],
    },
    "brother": {"name": "Brother embroidery thread", "threads": _from_pe(_pec, "Brother")},
    "janome": {"name": "Janome embroidery thread", "threads": _from_pe(_jef, "Janome")},
    "husqvarna": {"name": "Husqvarna Viking thread", "threads": _from_pe(_hus, "Husqvarna")},
}

BRAND_DEFAULT_CHART = {
    "brother": "brother", "brother-pr": "brother", "babylock": "brother",
    "janome": "janome", "husqvarna": "husqvarna", "pfaff": "husqvarna",
}


def default_chart(brand_id: str) -> str:
    return BRAND_DEFAULT_CHART.get(brand_id, "generic")


def _lab(hexes: list[str]) -> np.ndarray:
    rgb = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in hexes], np.float32) / 255.0
    return cv2.cvtColor(rgb.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3)


_LAB_CACHE: dict[str, np.ndarray] = {}


def nearest(chart_id: str, rgb: tuple[int, int, int]) -> Thread:
    chart = CHARTS.get(chart_id) or CHARTS["generic"]
    if chart_id not in _LAB_CACHE:
        _LAB_CACHE[chart_id] = _lab([t.hex for t in chart["threads"]])
    target = _lab(["#%02x%02x%02x" % tuple(rgb)])[0]
    d = ((_LAB_CACHE[chart_id] - target) ** 2).sum(1)
    return chart["threads"][int(d.argmin())]


def catalog() -> dict:
    return {cid: {"name": c["name"], "threads": [asdict(t) for t in c["threads"]]} for cid, c in CHARTS.items()}
