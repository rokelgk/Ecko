"""Procedural patterns evaluated in *global output-pixel coordinates*.

Every function takes 1-D arrays ``xs`` (columns) and ``ys`` (rows) in output
pixels and returns a (len(ys), len(xs)) array. Because nothing depends on the
size of the region being rendered, a preview, a 1:1 loupe crop and the strips
of a full-size export all line up exactly.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

_M32 = np.uint64(0xFFFFFFFF)


def hash2(ix: np.ndarray, iy: np.ndarray, seed: int) -> np.ndarray:
    """Integer lattice -> uniform float32 in [0, 1). Broadcasts ix against iy."""
    h = (ix.astype(np.int64) * 374761393 + iy.astype(np.int64) * 668265263
         + (seed * 1442695041 + 0x9E3779B9)).astype(np.uint64) & _M32
    h = ((h ^ (h >> np.uint64(13))) * np.uint64(1274126177)) & _M32
    h = h ^ (h >> np.uint64(16))
    return ((h & np.uint64(0xFFFFFF)).astype(np.float32) / np.float32(0x1000000))


def _smooth(t: np.ndarray) -> np.ndarray:
    return t * t * (3 - 2 * t)


def value_noise(xs, ys, scale_x: float, scale_y: float, seed: int) -> np.ndarray:
    """Smooth value noise with feature size ``scale`` px. Cost: one small
    lattice hash plus four gathers, so it is cheap even at print size."""
    X = np.asarray(xs, np.float64) / scale_x
    Y = np.asarray(ys, np.float64) / scale_y
    ix = np.floor(X).astype(np.int64)
    iy = np.floor(Y).astype(np.int64)
    fx = _smooth((X - ix).astype(np.float32))
    fy = _smooth((Y - iy).astype(np.float32))
    x0, y0 = ix.min(), iy.min()
    lx = np.arange(x0, ix.max() + 2)
    ly = np.arange(y0, iy.max() + 2)
    lat = hash2(lx[None, :], ly[:, None], seed)
    cx = ix - x0
    cy = iy - y0
    # separable: interpolate along x on the small lattice rows, then along y
    rows = lat[:, cx] * (1 - fx)[None, :] + lat[:, cx + 1] * fx[None, :]
    return rows[cy] * (1 - fy)[:, None] + rows[cy + 1] * fy[:, None]


def fbm(xs, ys, scale: float, seed: int, octaves: int = 4, stretch: float = 1.0) -> np.ndarray:
    """Fractal noise, roughly uniform on [0, 1) (see ``uniform``)."""
    out = np.zeros((len(ys), len(xs)), np.float32)
    amp, tot, used = 1.0, 0.0, 0
    for o in range(octaves):
        s = scale / (2 ** o)
        if s < 0.75 and used:
            break
        out += amp * value_noise(xs, ys, max(s, 0.75) * stretch, max(s, 0.75), seed + 101 * o)
        tot += amp
        amp *= 0.5
        used += 1
    out /= tot
    return _uniformize(out, used)


@lru_cache(maxsize=16)
def _fbm_quantiles(octaves: int) -> np.ndarray:
    xs = np.arange(0, 1024, dtype=np.float64)
    out = np.zeros((1024, 1024), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        out += amp * value_noise(xs, xs, 64 / 2 ** o, 64 / 2 ** o, 7 + 101 * o)
        tot += amp
        amp *= 0.5
    out /= tot
    return np.quantile(out, np.linspace(0, 1, 257)).astype(np.float32)


def _uniformize(v: np.ndarray, octaves: int) -> np.ndarray:
    """Map the bell-shaped fbm histogram to ~uniform so thresholds mean 'fraction of area'."""
    q = _fbm_quantiles(octaves)
    return np.interp(v, q, np.linspace(0, 1, 257)).astype(np.float32)


def pixel_noise(xs, ys, seed: int) -> np.ndarray:
    """Per-pixel white noise (dust, toner specks)."""
    ix = np.floor(np.asarray(xs)).astype(np.int64)
    iy = np.floor(np.asarray(ys)).astype(np.int64)
    return hash2(ix[None, :], iy[:, None], seed)


# ------------------------------------------------------------- blue noise


@lru_cache(maxsize=1)
def blue_noise_tile(n: int = 128) -> np.ndarray:
    """A tileable n x n blue-noise threshold matrix (uniform ranks in [0, 1)).

    Built by repeatedly high-passing white noise in the Fourier domain and
    re-ranking it: not a perfect void-and-cluster, but free of the low-
    frequency clumps that make white-noise stochastic screens look muddy.
    """
    rng = np.random.default_rng(20240607)
    v = rng.random((n, n))
    f = np.fft.fftfreq(n)
    r = np.sqrt(f[None, :] ** 2 + f[:, None] ** 2)
    hp = 1 - np.exp(-(r / 0.18) ** 2)
    for _ in range(8):
        v = np.real(np.fft.ifft2(np.fft.fft2(v) * hp))
        v = np.argsort(np.argsort(v.ravel())).reshape(n, n) / (n * n)
    return v.astype(np.float32)


def blue_noise(xs, ys, grain_px: float, seed: int) -> np.ndarray:
    tile = blue_noise_tile()
    n = tile.shape[0]
    ox = int(hash2(np.array([seed]), np.array([1]), 3)[0] * n)
    oy = int(hash2(np.array([seed]), np.array([2]), 3)[0] * n)
    ix = (np.floor(np.asarray(xs) / grain_px).astype(np.int64) + ox) % n
    iy = (np.floor(np.asarray(ys) / grain_px).astype(np.int64) + oy) % n
    return tile[iy[:, None], ix[None, :]]


# ---------------------------------------------------------------- cells


class _Lattice:
    """Per-cell random values hashed once on the small lattice, gathered per pixel."""

    def __init__(self, xs, ys, cell: float):
        X = np.asarray(xs, np.float64)
        Y = np.asarray(ys, np.float64)
        self.cx = np.floor(X / cell).astype(np.int64)
        self.cy = np.floor(Y / cell).astype(np.int64)
        self.x0, self.y0 = self.cx.min() - 1, self.cy.min() - 1
        self.lx = np.arange(self.x0, self.cx.max() + 2)
        self.ly = np.arange(self.y0, self.cy.max() + 2)
        self.cell = cell

    def values(self, seed: int) -> np.ndarray:
        return hash2(self.lx[None, :], self.ly[:, None], seed)

    def neighbours(self):
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                yield (self.cy - self.y0 + dy)[:, None], (self.cx - self.x0 + dx)[None, :]


def _points(lat: _Lattice, seed: int):
    jx = lat.values(seed)
    jy = lat.values(seed + 17)
    gx = lat.lx[None, :].astype(np.float32)
    gy = lat.ly[:, None].astype(np.float32)
    return ((gx + jx) * lat.cell).astype(np.float32), ((gy + jy) * lat.cell).astype(np.float32)


def voronoi_edge(xs, ys, cell: float, seed: int) -> np.ndarray:
    """Distance (px) to the nearest Voronoi border: small values are cracks."""
    X = np.asarray(xs, np.float32)[None, :]
    Y = np.asarray(ys, np.float32)[:, None]
    lat = _Lattice(xs, ys, cell)
    PX, PY = _points(lat, seed)
    f1 = np.full((len(ys), len(xs)), np.inf, np.float32)
    f2 = f1.copy()
    for iy, ix in lat.neighbours():
        d = (X - PX[iy, ix]) ** 2 + (Y - PY[iy, ix]) ** 2
        f2 = np.minimum(f2, np.maximum(f1, d))
        f1 = np.minimum(f1, d)
    return (np.sqrt(f2) - np.sqrt(f1)) * 0.5


def scratches(xs, ys, cell: float, seed: int, density: float, width_px: float) -> np.ndarray:
    """Boolean mask of thin random scratches, one candidate per lattice cell."""
    X = np.asarray(xs, np.float32)[None, :]
    Y = np.asarray(ys, np.float32)[:, None]
    lat = _Lattice(xs, ys, cell)
    PX, PY = _points(lat, seed + 5)
    on = lat.values(seed + 29) < density
    ang = (lat.values(seed + 31) - 0.5) * 1.2 + 0.6  # mostly diagonal
    UX, UY = np.cos(ang).astype(np.float32), np.sin(ang).astype(np.float32)
    HALF = ((0.3 + 0.7 * lat.values(seed + 37)) * cell * 0.8).astype(np.float32)
    hit = np.zeros((len(ys), len(xs)), bool)
    for iy, ix in lat.neighbours():
        if not on[iy, ix].any():
            continue
        px, py, ux, uy, half = PX[iy, ix], PY[iy, ix], UX[iy, ix], UY[iy, ix], HALF[iy, ix]
        rx, ry = X - px, Y - py
        t = np.clip(rx * ux + ry * uy, -half, half)
        d2 = (rx - t * ux) ** 2 + (ry - t * uy) ** 2
        # taper the ends so scratches look drawn, not stamped
        w = width_px * (1 - (t / half) ** 2)
        hit |= on[iy, ix] & (d2 < w * np.abs(w))
    return hit
