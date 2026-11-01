"""Flat T-shirt mockups: the print, to scale, on a shirt of the chosen colour."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from . import engine as E

GARMENTS = [
    {"name": "White", "hex": "#ffffff"},
    {"name": "Natural", "hex": "#f1e9d8"},
    {"name": "Heather", "hex": "#9b9b9b"},
    {"name": "Black", "hex": "#141414"},
    {"name": "Navy", "hex": "#1f2a44"},
    {"name": "Red", "hex": "#a3262a"},
    {"name": "Forest", "hex": "#23412f"},
    {"name": "Royal", "hex": "#2349a8"},
    {"name": "Maroon", "hex": "#5a1f2b"},
    {"name": "Mustard", "hex": "#d4a21f"},
]

# Shirt outline on a 1000 x 1100 grid. The body is 540 units wide, which is a
# typical adult-medium chest of about 20 in, so prints are shown to scale.
_W, _H = 1000, 1100
_UNITS_PER_IN = 540 / 20.0
_CHEST_TOP = 235


def _outline() -> list[tuple[float, float]]:
    neck = [(670 - 340 * t, 80 + 95 * 4 * t * (1 - t)) for t in np.linspace(0, 1, 24)]
    return [(330, 80), (195, 125), (35, 335), (150, 425), (232, 345), (232, 1060),
            (768, 1060), (768, 345), (850, 425), (965, 335), (805, 125)] + neck


def mockup_jpeg(prep: E.Prepared, o: E.ToneOptions, size: int = 1000, texture_images: dict | None = None) -> bytes:
    s = size / _W
    W, H = size, int(_H * s)
    g = np.array(E._hex(o.garment), np.float32)
    bg_l = 0.93 if E._lum(tuple(g)) < 0.75 else 0.82
    img = Image.new("RGB", (W, H), tuple(int(bg_l * 255) for _ in range(3)))
    pts = [(x * s, y * s) for x, y in _outline()]

    mask = Image.new("L", (W, H), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)
    shadow = mask.filter(ImageFilter.GaussianBlur(14 * s))
    img.paste((0, 0, 0), (int(6 * s), int(10 * s)), Image.eval(shadow, lambda v: v * 35 // 255))

    # Shirt colour with soft folds and a little fabric noise.
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    shade = 1 - 0.07 * (yy / H) - 0.05 * np.abs(xx / W - 0.5) * 2
    rng = np.random.default_rng(3)
    shade += (rng.random((H, W)).astype(np.float32) - 0.5) * 0.035
    shirt = np.clip(g[None, None, :] * shade[..., None] + 6 * (shade[..., None] - 1), 0, 255)
    img.paste(Image.fromarray(shirt.astype(np.uint8)), (0, 0), mask)
    d = ImageDraw.Draw(img)
    edge = tuple(int(v * 0.8) for v in g)
    d.line(pts + [pts[0]], fill=edge, width=max(1, int(2 * s)))
    collar = [(x * s, (y + 14) * s) for x, y in _outline()[-24:]]
    d.line(collar, fill=edge, width=max(1, int(3 * s)))

    out_w, out_h = prep.out_size(o)
    pw = max(8, int(round(o.width_in * _UNITS_PER_IN * s)))
    pw = min(pw, int(520 * s))  # wider than the chest wouldn't print anyway
    ph = max(1, int(round(pw * out_h / out_w)))
    if ph > 780 * s:
        ph = int(780 * s)
        pw = max(1, int(round(ph * out_w / out_h)))
    rgba, _, _ = E.render_preview(prep, o, max(pw, ph), texture_images=texture_images)
    art = Image.fromarray(rgba, "RGBA").resize((pw, ph), Image.LANCZOS)
    img.paste(art, (int((W - pw) / 2), int(_CHEST_TOP * s)), art)

    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=88)
    return buf.getvalue()
