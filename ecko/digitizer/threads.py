"""Friendly names for thread colors (nearest match in Lab space)."""

from __future__ import annotations

import cv2
import numpy as np

NAMED = [
    ("Black", (20, 20, 20)), ("Charcoal", (64, 64, 64)), ("Grey", (128, 128, 128)),
    ("Silver", (192, 192, 192)), ("White", (250, 250, 250)), ("Cream", (245, 235, 205)),
    ("Red", (200, 30, 40)), ("Cardinal", (150, 20, 35)), ("Burgundy", (110, 20, 40)),
    ("Pink", (240, 150, 180)), ("Hot Pink", (230, 50, 140)), ("Orange", (245, 120, 20)),
    ("Burnt Orange", (200, 85, 20)), ("Gold", (230, 170, 30)), ("Yellow", (250, 220, 40)),
    ("Lemon", (250, 240, 120)), ("Lime", (150, 210, 50)), ("Kelly Green", (20, 150, 60)),
    ("Forest Green", (30, 85, 45)), ("Olive", (110, 110, 40)), ("Mint", (160, 225, 190)),
    ("Teal", (0, 128, 128)), ("Turquoise", (40, 190, 200)), ("Sky Blue", (130, 190, 235)),
    ("Blue", (20, 110, 200)), ("Royal Blue", (30, 70, 190)), ("Cobalt", (0, 80, 160)), ("Navy", (20, 30, 80)), ("Purple", (110, 50, 150)),
    ("Lavender", (180, 160, 220)), ("Brown", (110, 70, 35)), ("Tan", (205, 170, 125)),
    ("Skin Tone", (235, 195, 165)), ("Copper", (185, 110, 60)),
]


def _lab(rgb_list) -> np.ndarray:
    arr = np.array(rgb_list, dtype=np.float32).reshape(-1, 1, 3) / 255.0
    return cv2.cvtColor(arr, cv2.COLOR_RGB2LAB).reshape(-1, 3)  # true L*a*b*


_NAMED_LAB = _lab([c for _, c in NAMED])


def thread_name(rgb: tuple[int, int, int]) -> str:
    d = ((_NAMED_LAB - _lab([rgb])[0]) ** 2).sum(1)
    return NAMED[int(d.argmin())][0]


def to_hex(rgb: tuple[int, int, int]) -> str:
    return "#%02x%02x%02x" % tuple(rgb)


def from_hex(s: str) -> tuple[int, int, int]:
    s = s.lstrip("#")
    if len(s) != 6:
        raise ValueError(f"Bad color: {s}")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
