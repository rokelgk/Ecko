"""Lettering: typed text becomes satin-stitched regions.

Fonts are bundled open-licence fonts chosen because they stitch well: thick,
even strokes with no hairlines. Text is drawn at 10 px/mm and then goes
through the same region analysis as artwork, so letters get satin columns
(or fill, for very large lettering) automatically.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


FONT_DIR = Path(__file__).resolve().parent.parent / "fonts"
PX_PER_MM = 10.0
MIN_HEIGHT_MM = 3.0
MAX_HEIGHT_MM = 300.0
MAX_TEXT_LEN = 200


@dataclass(frozen=True)
class Font:
    id: str
    name: str
    file: str
    style: str
    min_height_mm: float  # smallest size that still sews cleanly


FONTS: list[Font] = [
    Font("block", "Block (Oswald)", "oswald-700.woff", "Tall block capitals, great for caps", 5.0),
    Font("sans", "Sans (Montserrat Bold)", "montserrat-700.woff", "Clean, modern", 5.0),
    Font("serif", "Slab serif (Roboto Slab)", "roboto-slab-700.woff", "Classic, sturdy serifs", 6.0),
    Font("script", "Script (Pacifico)", "pacifico-400.woff", "Connected script for names", 8.0),
    Font("varsity", "Varsity (Graduate)", "graduate-400.woff", "College / team lettering", 6.0),
    Font("rounded", "Rounded (Fredoka)", "fredoka-600.woff", "Soft and friendly, kids wear", 5.0),
]
_BY_ID = {f.id: f for f in FONTS}


@dataclass
class TextLayer:
    text: str
    font: str = "block"
    height_mm: float = 15.0  # capital letter height
    color: str = "#000000"
    x_mm: float | None = None  # centre, in design millimetres; None = auto place
    y_mm: float | None = None

    def validate(self) -> None:
        if not self.text.strip():
            raise ValueError("Text can't be empty.")
        if len(self.text) > MAX_TEXT_LEN:
            raise ValueError(f"Text is limited to {MAX_TEXT_LEN} characters.")
        if self.font not in _BY_ID:
            raise ValueError(f"Unknown font: {self.font}")
        if not (MIN_HEIGHT_MM <= float(self.height_mm) <= MAX_HEIGHT_MM):
            raise ValueError(f"Letter height must be {MIN_HEIGHT_MM:g}-{MAX_HEIGHT_MM:g} mm.")
        c = self.color.lstrip("#")
        if len(c) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in c):
            raise ValueError("Text color must be a hex value like #000000.")


def get_font(font_id: str) -> Font:
    return _BY_ID[font_id]


def catalog() -> list[dict]:
    return [asdict(f) for f in FONTS]


def render_mask(layer: TextLayer) -> np.ndarray:
    """Bool mask of the text at PX_PER_MM, tightly cropped (plus padding)."""
    font = get_font(layer.font)
    path = str(FONT_DIR / font.file)
    # Scale so a capital H is height_mm tall.
    probe = ImageFont.truetype(path, 200)
    l, t, r, b = probe.getbbox("H")
    size = max(4, int(round(200 * layer.height_mm * PX_PER_MM / max(1, b - t))))
    ft = ImageFont.truetype(path, size)
    lines = layer.text.split("\n")
    dummy = ImageDraw.Draw(Image.new("L", (1, 1)))
    bbox = dummy.multiline_textbbox((0, 0), "\n".join(lines), font=ft, align="center",
                                    spacing=int(size * 0.25))
    pad = 6
    w, h = math.ceil(bbox[2] - bbox[0]) + 2 * pad, math.ceil(bbox[3] - bbox[1]) + 2 * pad
    img = Image.new("L", (w, h), 0)
    ImageDraw.Draw(img).multiline_text((pad - bbox[0], pad - bbox[1]), "\n".join(lines), font=ft,
                                       fill=255, align="center", spacing=int(size * 0.25))
    mask = np.array(img) >= 128
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return mask
    return mask[max(0, ys.min() - 2):ys.max() + 3, max(0, xs.min() - 2):xs.max() + 3]
