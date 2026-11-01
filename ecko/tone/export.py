"""Print files: composite PNG for DTF/DTG, and a ZIP of 1-bit films for screen print."""

from __future__ import annotations

import io
import zipfile

import numpy as np
from PIL import Image, ImageDraw

from .engine import STYLES, ToneOptions, to_hex


def png_bytes(rgba: np.ndarray, dpi: int) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", dpi=(dpi, dpi), optimize=False, compress_level=6)
    return buf.getvalue()


def _film(bitmap: np.ndarray, o: ToneOptions, label: str) -> Image.Image:
    """A film positive: black = ink. Optional margin with registration marks and a label."""
    ink = Image.fromarray(~bitmap).convert("1")  # PIL "1": 0 = black
    if not o.registration_marks:
        return ink
    m = int(o.dpi * 0.5)
    w, h = ink.size
    film = Image.new("1", (w + 2 * m, h + 2 * m), 1)
    film.paste(ink, (m, m))
    d = ImageDraw.Draw(film)
    r = max(6, int(o.dpi * 0.12))
    lw = max(1, int(o.dpi / 150))
    for cx, cy in ((m // 2, m + h // 2), (w + m + m // 2, m + h // 2), (m + w // 2, m // 2), (m + w // 2, h + m + m // 2)):
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=0, width=lw)
        d.line((cx - r * 1.5, cy, cx + r * 1.5, cy), fill=0, width=lw)
        d.line((cx, cy - r * 1.5, cx, cy + r * 1.5), fill=0, width=lw)
    d.text((m + 4, h + m + 4), label, fill=0)
    return film


def separations_zip(rgba: np.ndarray, seps: list[np.ndarray], plates, o: ToneOptions, name: str,
                    report: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(f"{name}-composite.png", png_bytes(rgba, o.dpi))
        lines = [f"{name}: {len(plates)} separation(s)", "",
                 f"Print size: {report['inches'][0]} x {report['inches'][1]} in "
                 f"({report['cm'][0]} x {report['cm'][1]} cm) at {o.dpi} DPI",
                 f"Screen: {STYLES[o.style]}" + (f", {o.lpi:g} LPI" if o.style not in ("fm", "xerox", "mezzotint")
                                                  else f", grain {o.grain_mm:g} mm"), ""]
        for i, (b, p) in enumerate(zip(seps, plates), 1):
            safe = "".join(ch if ch.isalnum() else "-" for ch in p.name)
            label = f"{name} | {i}/{len(plates)} {p.name} {to_hex(p.rgb)} | {o.lpi:g} LPI @ {p.angle % 180:.1f} deg"
            fbuf = io.BytesIO()
            _film(b, o, label).save(fbuf, "PNG", dpi=(o.dpi, o.dpi))
            z.writestr(f"{name}-{i:02d}-{safe}.png", fbuf.getvalue())
            lines.append(f"{i:02d} {p.name:12s} {to_hex(p.rgb)}  angle {p.angle % 180:5.1f}  "
                         f"coverage {float(b.mean()) * 100:.1f}%")
        lines += ["", "Films are black = ink, 1-bit, with registration marks in a 0.5 in margin."
                  if o.registration_marks else "Films are black = ink, 1-bit.",
                  "Print order: as numbered (light inks first)."]
        z.writestr("README.txt", "\n".join(lines) + "\n")
    return buf.getvalue()
