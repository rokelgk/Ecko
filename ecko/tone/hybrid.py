"""Dither, palette and threshold-layer maths for Ecko Tone.

Ideas from two popular Photoshop plug-ins, rebuilt for print:
  * DitherTone-style error diffusion (Floyd-Steinberg, Atkinson, Jarvis, ...), ordered dither
    and built-in palettes, here in global print coordinates so previews, the 1:1 loupe and the
    export are the same pixels.
  * AutoThresh-style threshold layers: the picture split into a few solid tones with automatic
    cut points; here they can also blend through any halftone or dither pattern.
"""

from __future__ import annotations

import numpy as np

# name -> (divisor, [(dx, dy, weight)])  — dy = 0 taps must have dx > 0 (scan direction)
DIFFUSION = {
    "fs": (16, [(1, 0, 7), (-1, 1, 3), (0, 1, 5), (1, 1, 1)]),
    "atkinson": (8, [(1, 0, 1), (2, 0, 1), (-1, 1, 1), (0, 1, 1), (1, 1, 1), (0, 2, 1)]),
    "jarvis": (48, [(1, 0, 7), (2, 0, 5), (-2, 1, 3), (-1, 1, 5), (0, 1, 7), (1, 1, 5), (2, 1, 3),
                    (-2, 2, 1), (-1, 2, 3), (0, 2, 5), (1, 2, 3), (2, 2, 1)]),
    "stucki": (42, [(1, 0, 8), (2, 0, 4), (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2),
                    (-2, 2, 1), (-1, 2, 2), (0, 2, 4), (1, 2, 2), (2, 2, 1)]),
    "burkes": (32, [(1, 0, 8), (2, 0, 4), (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2)]),
    "sierra": (32, [(1, 0, 5), (2, 0, 3), (-2, 1, 2), (-1, 1, 4), (0, 1, 5), (1, 1, 4), (2, 1, 2),
                    (-1, 2, 2), (0, 2, 3), (1, 2, 2)]),
    "sierra_lite": (4, [(1, 0, 2), (-1, 1, 1), (0, 1, 1)]),
}

PALETTES = {
    "retro": {"label": "Retro arcade", "colors": ["#000000", "#1d2b53", "#7e2553", "#008751", "#ab5236", "#5f574f",
                                                   "#c2c3c7", "#fff1e8", "#ff004d", "#ffa300", "#ffec27", "#00e436",
                                                   "#29adff", "#83769c", "#ff77a8", "#ffccaa"]},
    "vintage": {"label": "Vintage tee", "colors": ["#2b2118", "#1f3a5f", "#8c3b2e", "#6b3e26", "#5d7052", "#b5651d",
                                                    "#e3b778", "#f3e3c3"]},
    "pastel": {"label": "Pastel", "colors": ["#6b5b73", "#d7c6f2", "#b5e3f0", "#d4f0c0", "#fffacd", "#ffe5b4",
                                              "#ffd1dc", "#f7f4ee"]},
    "vibrant": {"label": "Vibrant", "colors": ["#111111", "#d500f9", "#00b0ff", "#00e676", "#ffea00", "#ff9100",
                                                "#ff1744", "#ffffff"]},
    "gameboy": {"label": "Handheld green", "colors": ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"]},
    "cga": {"label": "CGA", "colors": ["#000000", "#ff55ff", "#55ffff", "#ffffff"]},
    "newsprint": {"label": "Newsprint", "colors": ["#111111", "#f2efe6"]},
}


def bayer_matrix(n: int) -> np.ndarray:
    """n x n ordered-dither thresholds in (0, 1), n a power of two."""
    m = np.array([[0]])
    while m.shape[0] < n:
        m = np.block([[4 * m, 4 * m + 2], [4 * m + 3, 4 * m + 1]])
    return ((m + 0.5) / m.size).astype(np.float32)


def error_diffuse(cov: np.ndarray, style: str) -> np.ndarray:
    """1-bit error diffusion of ink amounts (0..1), serpentine scan. Returns uint8 0/1."""
    div, taps = DIFFUSION[style]
    h, w = cov.shape
    buf = np.zeros((h + 3, w + 4), np.float64)
    buf[:h, 2:w + 2] = cov
    out = np.zeros((h, w), np.uint8)
    w1 = sum(t[2] for t in taps if t[1] == 0 and t[0] == 1) / div
    w2 = sum(t[2] for t in taps if t[1] == 0 and t[0] == 2) / div
    down = [(dx, dy, wt / div) for dx, dy, wt in taps if dy > 0]
    for y in range(h):
        rev = y % 2 == 1
        row = buf[y, 2:w + 2]
        r = (row[::-1] if rev else row).tolist()
        e = [0.0] * w
        o = [0] * w
        c1 = c2 = 0.0
        for x in range(w):
            v = r[x] + c1
            bit = 1 if v >= 0.5 else 0
            err = v - bit
            o[x] = bit
            e[x] = err
            c1 = c2 + err * w1
            c2 = err * w2
        ea = np.array(e[::-1] if rev else e)
        out[y] = o[::-1] if rev else o
        for dx, dy, wt in down:
            d = -dx if rev else dx
            buf[y + dy, 2 + d:2 + d + w] += ea * wt
    return out


def error_diffuse_palette(rgb: np.ndarray, alpha: np.ndarray, colors: np.ndarray, style: str) -> np.ndarray:
    """Colour error diffusion: every cell gets exactly one of ``colors`` (rows of 0..1 RGB), or -1 where
    the art is transparent. Error is spread in RGB with the chosen kernel, serpentine scan."""
    div, taps = DIFFUSION[style]
    h, w = alpha.shape
    pal = [tuple(float(v) for v in c) for c in colors]
    k = len(pal)
    buf = np.zeros((h + 3, w + 4, 3), np.float64)
    buf[:h, 2:w + 2] = rgb
    out = np.full((h, w), -1, np.int16)
    w1 = sum(t[2] for t in taps if t[1] == 0 and t[0] == 1) / div
    w2 = sum(t[2] for t in taps if t[1] == 0 and t[0] == 2) / div
    down = [(dx, dy, wt / div) for dx, dy, wt in taps if dy > 0]
    for y in range(h):
        rev = y % 2 == 1
        row = buf[y, 2:w + 2]
        r = (row[::-1] if rev else row).tolist()
        av = (alpha[y, ::-1] if rev else alpha[y]).tolist()
        e = [(0.0, 0.0, 0.0)] * w
        o = [-1] * w
        c1 = c2 = (0.0, 0.0, 0.0)
        for x in range(w):
            if av[x] < 0.5:
                c1, c2 = c2, (0.0, 0.0, 0.0)
                continue
            vr = min(1.5, max(-0.5, r[x][0] + c1[0]))
            vg = min(1.5, max(-0.5, r[x][1] + c1[1]))
            vb = min(1.5, max(-0.5, r[x][2] + c1[2]))
            best, bd = 0, 1e9
            for i in range(k):
                p = pal[i]
                d = (vr - p[0]) ** 2 * 0.3 + (vg - p[1]) ** 2 * 0.59 + (vb - p[2]) ** 2 * 0.11
                if d < bd:
                    bd, best = d, i
            p = pal[best]
            er, eg, eb = vr - p[0], vg - p[1], vb - p[2]
            o[x] = best
            e[x] = (er, eg, eb)
            c1 = (c2[0] + er * w1, c2[1] + eg * w1, c2[2] + eb * w1)
            c2 = (er * w2, eg * w2, eb * w2)
        ea = np.array(e[::-1] if rev else e)
        out[y] = o[::-1] if rev else o
        for dx, dy, wt in down:
            d = -dx if rev else dx
            buf[y + dy, 2 + d:2 + d + w] += ea * wt
    return out


def kmeans_1d(values: np.ndarray, weights: np.ndarray, k: int, iters: int = 60) -> np.ndarray:
    """Weighted 1-D k-means (values sorted or not). Returns k sorted centres."""
    order = np.argsort(values)
    v, wts = values[order].astype(np.float64), weights[order].astype(np.float64)
    if wts.sum() <= 0:
        return np.linspace(0.1, 0.9, k)
    cdf = np.cumsum(wts) / wts.sum()
    centers = np.interp((np.arange(k) + 0.5) / k, cdf, v)
    for _ in range(iters):
        assign = np.abs(v[:, None] - centers[None, :]).argmin(1)
        new = centers.copy()
        for i in range(k):
            m = assign == i
            if wts[m].sum() > 0:
                new[i] = (v[m] * wts[m]).sum() / wts[m].sum()
        if np.allclose(new, centers, atol=1e-5):
            break
        centers = new
    return np.sort(centers)
