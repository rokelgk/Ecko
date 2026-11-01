"""Text set along an arc: rainbow (arc > 0) or smile (arc < 0). Shared by embroidery and Tone."""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def font_for_cap_height(path: str, cap_px: float) -> ImageFont.FreeTypeFont:
    """A font sized so a capital H is ``cap_px`` tall."""
    probe = ImageFont.truetype(path, 200)
    _, t, _, b = probe.getbbox("H")
    return ImageFont.truetype(path, max(4, int(round(200 * cap_px / max(1, b - t)))))


def render(text: str, font: ImageFont.FreeTypeFont, arc_deg: float = 0.0,
           spacing_em: float = 0.0) -> tuple[np.ndarray, tuple[float, float]]:
    """Antialiased coverage (uint8, 0..255) of one line of text bent along an arc.

    ``arc_deg`` is how much of a circle the text spans: 0 is straight, 180 a half
    circle arching up, -180 a half circle smiling down. Returns the image and the
    point (x, y) on the middle of the baseline, so callers can place it.
    """
    text = text.replace("\n", " ").strip()
    size = font.size
    extra = spacing_em * size
    if abs(arc_deg) < 1 or len(text) < 2:
        return _straight(text, font, extra)

    adv = [font.getlength(ch) for ch in text]
    total = sum(adv) + extra * (len(text) - 1)
    radius = total / math.radians(abs(arc_deg))
    g = int(size * 2.4) | 1  # odd so the centre pixel is exact
    up = arc_deg > 0
    pieces = []
    s = 0.0
    for ch, a in zip(text, adv):
        mid = s + a / 2
        s += a + extra
        if not ch.strip():
            continue
        theta = (mid - total / 2) / radius
        if up:
            x, y, rot = radius * math.sin(theta), radius * (1 - math.cos(theta)), -math.degrees(theta)
        else:
            x, y, rot = radius * math.sin(theta), -radius * (1 - math.cos(theta)), math.degrees(theta)
        glyph = Image.new("L", (g, g), 0)
        ImageDraw.Draw(glyph).text((g / 2, g / 2), ch, font=font, fill=255, anchor="ms")
        pieces.append((glyph.rotate(rot, resample=Image.BICUBIC), x, y))
    if not pieces:
        return _straight(text, font, extra)
    xs = [p[1] for p in pieces]
    ys = [p[2] for p in pieces]
    pad = g // 2 + 2
    x0, y0 = min(xs) - pad, min(ys) - pad
    w, h = int(math.ceil(max(xs) - x0 + pad)), int(math.ceil(max(ys) - y0 + pad))
    canvas = np.zeros((h, w), np.uint8)
    for img, x, y in pieces:
        left, top = int(round(x - x0)) - g // 2, int(round(y - y0)) - g // 2
        arr = np.array(img)
        sub = canvas[top:top + g, left:left + g]
        np.maximum(sub, arr[:sub.shape[0], :sub.shape[1]], out=sub)
    return _trim(canvas, (-x0, -y0))


def _straight(text: str, font, extra: float):
    d = ImageDraw.Draw(Image.new("L", (1, 1)))
    adv = [font.getlength(ch) for ch in text] or [0]
    total = sum(adv) + extra * max(0, len(text) - 1)
    l, t, r, b = d.textbbox((0, 0), text or " ", font=font, anchor="ls")
    pad = int(font.size * 0.3) + 2
    w = int(math.ceil(max(total, r - l))) + 2 * pad
    h = int(math.ceil(b - t)) + 2 * pad
    img = Image.new("L", (w, h), 0)
    draw = ImageDraw.Draw(img)
    base_y = pad - t
    x = pad
    for ch, a in zip(text, adv):
        draw.text((x, base_y), ch, font=font, fill=255, anchor="ls")
        x += a + extra
    return _trim(np.array(img), (pad + total / 2, base_y))


def _trim(arr: np.ndarray, anchor: tuple[float, float]):
    ys, xs = np.nonzero(arr)
    if len(xs) == 0:
        return arr, anchor
    y0, x0 = max(0, ys.min() - 2), max(0, xs.min() - 2)
    return arr[y0:ys.max() + 3, x0:xs.max() + 3], (anchor[0] - x0, anchor[1] - y0)
