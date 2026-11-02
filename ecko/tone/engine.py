"""Ecko Tone engine: picture -> halftoned, textured, print-ready ink plates.

Pipeline::

    picture ─► prepare   (background removal, sharpen, crop, spot palette)
            ─► sample    (any region of the print, at any zoom)
            ─► coverage  (tone curve, colour separation, dot-gain / min-max dot)
            ─► screen    (AM dots/lines, stochastic, Xerox, mezzotint)
            ─► texture   (worn, cracked, grunge, paper, toner, scratches, custom)
            ─► plates    (one on/off bitmap per ink)  ─► composite PNG / separations

Every pattern is a function of global output-pixel coordinates (see
``noise.py``), so the live preview, the 1:1 loupe and the full-size export are
the same picture at different zoom levels.
"""

from __future__ import annotations

import json
import math
import struct
import zlib
from pathlib import Path
from dataclasses import dataclass, field, fields
from functools import lru_cache

import cv2
import numpy as np

from .. import arctext
from ..digitizer import text as lettering
from ..digitizer.preprocess import ImageError, _find_palette, _lab_to_rgb, _resize_max, _to_lab, load_image
from . import hybrid, noise

# ----------------------------------------------------------------- catalog

STYLES = {
    "round": "Round dot",
    "euclid": "Classic (checkerboard at 50%)",
    "ellipse": "Elliptical dot",
    "square": "Square dot",
    "diamond": "Diamond dot",
    "line": "Line screen",
    "cross": "Cross / grid",
    "fm": "Stochastic grain (FM)",
    "xerox": "Xerox / photocopy",
    "mezzotint": "Mezzotint",
    "modulation": "Wave lines (modulation)",
    "bayer4": "Ordered dither 4x4 (Bayer)",
    "bayer8": "Ordered dither 8x8 (Bayer)",
    "random": "Random noise",
    "fs": "Floyd-Steinberg diffusion",
    "atkinson": "Atkinson diffusion",
    "jarvis": "Jarvis-Judice-Ninke diffusion",
    "stucki": "Stucki diffusion",
    "burkes": "Burkes diffusion",
    "sierra": "Sierra diffusion",
    "sierra_lite": "Sierra Lite diffusion",
}
AM_STYLES = ("round", "euclid", "ellipse", "square", "diamond", "line", "cross", "modulation")
DIFFUSION_STYLES = tuple(hybrid.DIFFUSION)
GRAIN_STYLES = ("fm", "xerox", "mezzotint", "bayer4", "bayer8", "random") + DIFFUSION_STYLES
STYLE_GROUPS = [
    ("Halftone dots", ["round", "euclid", "ellipse", "square", "diamond", "cross"]),
    ("Lines", ["line", "modulation"]),
    ("Grain and copy", ["fm", "xerox", "mezzotint", "random"]),
    ("Error diffusion dither", list(DIFFUSION_STYLES)),
    ("Ordered dither", ["bayer4", "bayer8"]),
]
PALETTES = hybrid.PALETTES

MODES = {
    "mono": "One ink",
    "duotone": "Two inks (duotone)",
    "cmyk": "CMYK process",
    "spot": "Spot colours (screen-print separations)",
    "threshold": "Threshold layers (solid tones)",
    "index": "Index colour (dithered pixels, no overlap)",
}

# size_mm is the feature size at scale 1.0
TEXTURES = {
    "worn": {"label": "Worn print", "size_mm": 7.0, "adds_ink": False},
    "cracked": {"label": "Cracked ink", "size_mm": 9.0, "adds_ink": False},
    "grunge": {"label": "Grunge blotches", "size_mm": 6.0, "adds_ink": False},
    "paper": {"label": "Paper fibres", "size_mm": 2.5, "adds_ink": False},
    "scratches": {"label": "Scratches", "size_mm": 30.0, "adds_ink": False},
    "toner": {"label": "Toner specks (adds ink)", "size_mm": 1.5, "adds_ink": True},
    "washed": {"label": "Washed out (faded ink)", "size_mm": 3.0, "adds_ink": False},
    "fabric": {"label": "Fabric weave showing through", "size_mm": 0.9, "adds_ink": False},
    "streaks": {"label": "Squeegee streaks (uneven ink)", "size_mm": 14.0, "adds_ink": False},
    "pinholes": {"label": "Screen pinholes", "size_mm": 4.0, "adds_ink": False},
    "image": {"label": "Your texture image", "size_mm": 100.0, "adds_ink": False},
}

# Real distress scans (tools/make_textures.py packs them): dark = ink knocked out. One tile is 180 mm
# wide at size 1 and tiles are mirrored, so there are no seams on big prints.
SCAN_DIR = Path(__file__).resolve().parent / "textures"
SCANS = json.loads((SCAN_DIR / "index.json").read_text()) if (SCAN_DIR / "index.json").exists() else []
for _scan in SCANS:
    TEXTURES[_scan["id"]] = {"label": _scan["label"], "size_mm": 180.0, "adds_ink": False, "scan": True}


@lru_cache(maxsize=4)
def scan_levels(scan_id: str) -> np.ndarray:
    """A packed scan as float64 0..1 (0 = darkest), exactly as the JavaScript engine decodes it."""
    data = (SCAN_DIR / f"{scan_id}.etx").read_bytes()
    if data[:4] != b"ETX1":
        raise ValueError(f"Not a texture file: {scan_id}")
    w, h = struct.unpack("<HH", data[4:8])
    q = np.frombuffer(zlib.decompress(data[8:]), np.uint8).reshape(h, w)
    return q.astype(np.float64) / 7.0


def _mirror(i: np.ndarray, n: int) -> np.ndarray:
    t = np.mod(i, 2 * n)
    return np.where(t < n, t, 2 * n - 1 - t)


def _rotated(xs, ys, angle: float):
    """Print coordinates turned by angle degrees (about the print origin): two (h, w) grids."""
    a = math.radians(angle)
    c, s = math.cos(a), math.sin(a)
    X = np.asarray(xs, np.float64)[None, :]
    Y = np.asarray(ys, np.float64)[:, None]
    return X * c + Y * s, Y * c - X * s


def sample_scan(scan_id: str, xs, ys, tile_px: float, angle: float = 0.0) -> np.ndarray:
    """Bilinear sample of a scan tiled (mirrored) every tile_px print pixels, turned by angle degrees."""
    T = scan_levels(scan_id)
    th, tw = T.shape
    k = tw / tile_px
    if angle:
        U, V = _rotated(xs, ys, angle)
        u, v = U * k - 0.5, V * k - 0.5
        x0, y0 = np.floor(u), np.floor(v)
        fx, fy = u - x0, v - y0
        xa, xb = _mirror(x0.astype(np.int64), tw), _mirror(x0.astype(np.int64) + 1, tw)
        ya, yb = _mirror(y0.astype(np.int64), th), _mirror(y0.astype(np.int64) + 1, th)
        a = T[ya, xa] + (T[ya, xb] - T[ya, xa]) * fx
        b = T[yb, xa] + (T[yb, xb] - T[yb, xa]) * fx
        return a + (b - a) * fy
    u = np.asarray(xs, np.float64) * k - 0.5
    v = np.asarray(ys, np.float64) * k - 0.5
    x0, y0 = np.floor(u), np.floor(v)
    fx, fy = u - x0, v - y0
    xa, xb = _mirror(x0.astype(np.int64), tw), _mirror(x0.astype(np.int64) + 1, tw)
    ya, yb = _mirror(y0.astype(np.int64), th), _mirror(y0.astype(np.int64) + 1, th)
    a = T[ya][:, xa] + (T[ya][:, xb] - T[ya][:, xa]) * fx[None, :]
    b = T[yb][:, xa] + (T[yb][:, xb] - T[yb][:, xa]) * fx[None, :]
    return a + (b - a) * fy[:, None]

# Rules of thumb, not guarantees: printers, films and powders vary.
TARGETS = {
    "dtf": {"label": "DTF transfer", "lpi": (25, 45), "min_dot_mm": 0.25},
    "dtg": {"label": "DTG (direct to garment)", "lpi": (30, 55), "min_dot_mm": 0.2},
    "screen": {"label": "Screen print film", "lpi": (35, 65), "min_dot_mm": 0.15},
    "paper": {"label": "Paper / poster", "lpi": (60, 150), "min_dot_mm": 0.05},
}

PROCESS_INKS = [
    ("Cyan", (0, 174, 239), -30.0),
    ("Magenta", (236, 0, 140), 30.0),
    ("Yellow", (255, 242, 0), -45.0),
    ("Black", (35, 31, 32), 0.0),
]

SHIRT_FITS = {
    "auto": "Automatic",
    "recolor": "Recolor ink (logos, text, line art)",
    "tones": "Match the picture (photos)",
    "off": "Off (print exactly as set)",
}
CREAM = (244, 241, 234)
INK_BLACK = (29, 29, 31)
FONTS = {f.id: f for f in lettering.FONTS}
MAX_TEXT_LAYERS = 6

BORDERS = {
    "none": "No border",
    "fade": "Faded edge",
    "grunge": "Grunge",
    "torn": "Torn edge",
    "storm": "Storm",
    "barbwire": "Barbed wire",
}
BORDER_SHAPES = {"rect": "Rectangle", "oval": "Oval", "rounded": "Rounded"}

MAX_OUTPUT_PX = 120_000_000
MAX_SOURCE_SIDE = 4000
LOUPE_MAX = 800


# ----------------------------------------------------------------- options


def _hex(value: str) -> tuple[int, int, int]:
    v = str(value).strip().lstrip("#")
    if len(v) == 3:
        v = "".join(ch * 2 for ch in v)
    if len(v) != 6:
        raise ValueError(f"Not a colour: {value!r}. Use #rrggbb.")
    try:
        return int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16)
    except ValueError as exc:
        raise ValueError(f"Not a colour: {value!r}. Use #rrggbb.") from exc


def to_hex(rgb) -> str:
    return "#%02x%02x%02x" % tuple(int(c) for c in rgb)


@dataclass
class ToneOptions:
    width_in: float = 10.0
    dpi: int = 300
    target: str = "dtf"
    mode: str = "mono"
    style: str = "round"
    lpi: float = 35.0
    angle: float = 22.5
    grain_mm: float = 0.25
    inks: list = field(default_factory=lambda: ["#1d1d1f"])
    spot_colors: int = 4
    spot_softness: float = 12.0
    brightness: float = 0.0
    contrast: float = 0.0
    gamma: float = 1.0
    black_point: float = 0.0
    white_point: float = 1.0
    sharpen: float = 0.5
    invert: bool = False
    min_dot: float = 0.05
    max_dot: float = 0.95
    dot_gain: float = 0.0
    roughness: float = 0.2
    misregister_mm: float = 0.0
    remove_background: bool = True
    bg_tolerance: float = 18.0
    textures: list = field(default_factory=list)
    seed: int = 1
    garment: str = "#ffffff"
    knockout: bool = False
    registration_marks: bool = True
    shirt_fit: str = "auto"
    underbase: str = "auto"
    choke_mm: float = 0.1
    text: list = field(default_factory=list)
    ink_edits: dict = field(default_factory=dict)  # {"Cyan": {"on": False, "choke_mm": 0.05}, ...}
    threshold_levels: int = 3        # threshold layers: how many tones
    thresholds: list = field(default_factory=list)  # cut points (lightness 0..1); empty = automatic
    threshold_soft: float = 0.0      # 0 = hard solid edges; more = halftone/dither blend between tones
    threshold_stack: bool = False    # False = knockout (no overlap); True = lighter tones run under darker
    threshold_colors: str = "ink"    # ink (shades of one ink) | image (colours from the picture) | palette
    palette: str = "image"           # image or a built-in palette, for spot / index / threshold colours
    smooth_mm: float = 0.0           # simplify shapes before separating
    denoise: int = 0                 # 0-3: remove speckle noise
    border: str = "none"             # edge knockout: none | fade | grunge | torn | storm | barbwire
    border_mm: float = 15.0          # how far in from the edge the border reaches
    border_shape: str = "rect"       # rect | oval | rounded
    # Vintage / bootleg extras
    outline: float = 0.0             # keyline around the whole design, as a share of its width (0 = off)
    shadow: float = 0.0              # offset drop shadow, as a share of the design width (0 = off)
    outline_color: str = "auto"      # auto (stands out on the shirt) or #rrggbb
    ghost_mm: float = 0.0            # ghost / slur: a faint second print offset by this much (0 = off)
    ghost_strength: float = 0.5      # how much of the ghost prints

    # Settings that change the prepared source (the slow step).
    def prepare_key(self) -> tuple:
        text = tuple(tuple(sorted(t.items())) for t in self.text)
        return (self.remove_background, round(float(self.bg_tolerance), 2), round(float(self.sharpen), 3),
                self.mode == "spot" and int(self.spot_colors), text,
                text and _text_work_width(self), int(self.denoise), round(float(self.smooth_mm), 3),
                self.smooth_mm and round(self.width_in * self.dpi),
                round(float(self.outline), 4), round(float(self.shadow), 4),
                (self.outline or self.shadow) and outline_rgb(self))


_RANGES = {
    "width_in": (0.5, 60), "dpi": (72, 1200), "lpi": (3, 200), "angle": (-360, 360),
    "grain_mm": (0.02, 5), "spot_colors": (2, 8), "spot_softness": (1, 60),
    "brightness": (-1, 1), "contrast": (-1, 1), "gamma": (0.2, 5),
    "black_point": (0, 0.95), "white_point": (0.05, 1), "sharpen": (0, 3),
    "min_dot": (0, 0.5), "max_dot": (0.5, 1), "dot_gain": (0, 0.4), "roughness": (0, 1),
    "misregister_mm": (0, 5), "bg_tolerance": (1, 80), "seed": (0, 2**31 - 1), "choke_mm": (0, 1),
    "threshold_levels": (2, 8), "threshold_soft": (0, 0.3), "smooth_mm": (0, 3), "denoise": (0, 3),
    "border_mm": (1, 120), "outline": (0, 0.06), "shadow": (0, 0.1), "ghost_mm": (0, 4), "ghost_strength": (0, 1),
}


def parse_options(data: dict | None) -> ToneOptions:
    data = dict(data or {})
    allowed = {f.name for f in fields(ToneOptions)}
    unknown = set(data) - allowed
    if unknown:
        raise ValueError(f"Unknown options: {', '.join(sorted(unknown))}")
    o = ToneOptions(**data)
    for name, (lo, hi) in _RANGES.items():
        v = getattr(o, name)
        try:
            v = float(v)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be a number.") from exc
        if not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError(f"{name} must be between {lo} and {hi}.")
        setattr(o, name, int(v) if name in ("dpi", "spot_colors", "seed", "threshold_levels", "denoise") else v)
    if o.white_point <= o.black_point + 0.02:
        raise ValueError("The white point must be above the black point.")
    for name, table in (("mode", MODES), ("style", STYLES), ("target", TARGETS), ("shirt_fit", SHIRT_FITS),
                        ("underbase", {"auto": 1, "on": 1, "off": 1}),
                        ("palette", {"image": 1, **PALETTES}),
                        ("threshold_colors", {"image": 1, "ink": 1, "palette": 1}),
                        ("border", BORDERS), ("border_shape", BORDER_SHAPES)):
        if getattr(o, name) not in table:
            raise ValueError(f"Unknown {name}: {getattr(o, name)!r}")
    if not isinstance(o.thresholds, list) or len(o.thresholds) > 7:
        raise ValueError("thresholds is a list of up to 7 cut points.")
    try:
        o.thresholds = sorted(float(t) for t in o.thresholds)
    except (TypeError, ValueError) as exc:
        raise ValueError("Thresholds must be numbers.") from exc
    if any(not 0.01 <= t <= 0.99 for t in o.thresholds):
        raise ValueError("Thresholds must be between 0.01 and 0.99.")
    for name in ("invert", "remove_background", "knockout", "registration_marks", "threshold_stack"):
        setattr(o, name, bool(getattr(o, name)))
    if not isinstance(o.inks, list) or not 1 <= len(o.inks) <= 8:
        raise ValueError("Give between 1 and 8 ink colours.")
    for ink in o.inks:
        _hex(ink)
    if o.mode == "duotone" and len(o.inks) < 2:
        raise ValueError("Duotone needs two ink colours.")
    _hex(o.garment)
    if o.outline_color != "auto":
        o.outline_color = to_hex(_hex(o.outline_color))
    if not isinstance(o.textures, list) or len(o.textures) > 8:
        raise ValueError("Up to 8 textures are supported.")
    clean = []
    for t in o.textures:
        if not isinstance(t, dict) or t.get("type") not in TEXTURES:
            raise ValueError(f"Unknown texture: {t!r}")
        strength = float(t.get("strength", 0.5))
        scale = float(t.get("scale", 1.0))
        if not (0 <= strength <= 1 and 0.1 <= scale <= 8):
            raise ValueError("Texture strength must be 0-1 and scale 0.1-8.")
        rotate = float(t.get("rotate", 0.0))
        if not (math.isfinite(rotate) and -360 <= rotate <= 360):
            raise ValueError("Texture rotation must be between -360 and 360 degrees.")
        clean.append({"type": t["type"], "strength": strength, "scale": scale, "rotate": rotate % 360,
                      "image_id": t.get("image_id")})
    o.textures = clean
    o.text = _parse_text(o.text)
    o.ink_edits = _parse_ink_edits(o.ink_edits)
    return o


def _parse_ink_edits(edits) -> dict:
    """Per-ink switches: turn an ink off, or choke (> 0) / spread (< 0) its dots in mm."""
    if not isinstance(edits, dict) or len(edits) > 16:
        raise ValueError("ink_edits must map up to 16 ink names to settings.")
    out = {}
    for name, e in edits.items():
        if not isinstance(name, str) or len(name) > 40 or not isinstance(e, dict):
            raise ValueError("Each ink edit is {ink name: {on, choke_mm, name}}.")
        unknown = set(e) - {"on", "choke_mm", "name"}
        if unknown:
            raise ValueError(f"Unknown ink settings: {', '.join(sorted(unknown))}")
        try:
            choke = float(e.get("choke_mm", 0.0))
        except (TypeError, ValueError) as exc:
            raise ValueError("Ink choke must be a number.") from exc
        if not (math.isfinite(choke) and -0.5 <= choke <= 0.5):
            raise ValueError("Ink choke must be between -0.5 and 0.5 mm.")
        out[name] = {"on": bool(e.get("on", True)), "choke_mm": round(choke, 4)}
        label = " ".join(str(e.get("name") or "").split())
        if len(label) > 40:
            raise ValueError("Ink names are limited to 40 characters.")
        if label:
            out[name]["name"] = label
    return out


_TEXT_RANGES = {"size": (0.02, 1.0), "arc": (-340, 340), "x": (-2, 2), "y": (-2, 2), "spacing": (-0.2, 1.0)}
_TEXT_DEFAULTS = {"font": "varsity", "size": 0.12, "arc": 0.0, "x": 0.0, "y": -0.7, "spacing": 0.05,
                  "color": "#000000"}


def _parse_text(layers) -> list:
    if not isinstance(layers, list) or len(layers) > MAX_TEXT_LAYERS:
        raise ValueError(f"Up to {MAX_TEXT_LAYERS} lines of text are supported.")
    out = []
    for t in layers:
        if not isinstance(t, dict):
            raise ValueError("Each text line must be an object.")
        unknown = set(t) - set(_TEXT_DEFAULTS) - {"text"}
        if unknown:
            raise ValueError(f"Unknown text settings: {', '.join(sorted(unknown))}")
        t = {**_TEXT_DEFAULTS, **t}
        words = str(t.get("text", "")).replace("\n", " ").strip()
        if not words:
            continue  # an empty line in the editor is not an error
        if len(words) > 80:
            raise ValueError("Each line of text is limited to 80 characters.")
        if t["font"] not in FONTS:
            raise ValueError(f"Unknown font: {t['font']!r}")
        clean = {"text": words, "font": t["font"], "color": to_hex(_hex(t["color"]))}
        for k, (lo, hi) in _TEXT_RANGES.items():
            try:
                v = float(t[k])
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Text {k} must be a number.") from exc
            if not math.isfinite(v) or not lo <= v <= hi:
                raise ValueError(f"Text {k} must be between {lo} and {hi}.")
            clean[k] = round(v, 4)
        out.append(clean)
    return out


def _text_work_width(o: ToneOptions) -> int:
    """Pixel width the design (art + text) is assembled at before screening."""
    return int(min(4000, max(800, round(o.width_in * o.dpi, -2))))


# ----------------------------------------------------------------- prepare


@dataclass
class Prepared:
    rgba: np.ndarray            # float32, premultiplied RGB + alpha, 0..1
    src_w: int
    src_h: int
    palette: list | None = None  # spot colours, light -> dark
    palette_lab: np.ndarray | None = None
    crop: tuple = (0, 0, 0, 0)    # artwork box (x, y, w, h) in the uploaded picture's pixels
    photo_like: bool = False      # many smooth tones (photo) rather than flat colours (logo)
    spot_lab: np.ndarray | None = None   # Lab sample of the art, for spot palettes of any size
    lum_counts: np.ndarray | None = None  # 256-bin luminance histogram of the art
    lum_rgb: np.ndarray | None = None     # summed RGB per luminance bin (for threshold tone colours)
    token: str = field(default_factory=lambda: __import__("uuid").uuid4().hex)
    _palettes: dict = field(default_factory=dict)
    _levels: dict = field(default_factory=dict)

    def out_size(self, o: ToneOptions) -> tuple[int, int]:
        w = max(1, round(o.width_in * o.dpi))
        h = max(1, round(w * self.src_h / self.src_w))
        return w, h

    def level(self, factor: float) -> np.ndarray:
        """Source pre-shrunk by ``factor`` (> 1) so sampling never aliases."""
        key = round(math.log2(factor) * 4) / 4
        if key <= 0.5:
            return self.rgba
        if key not in self._levels:
            f = 2 ** key
            w = max(1, round(self.src_w / f))
            h = max(1, round(self.src_h / f))
            self._levels[key] = cv2.resize(self.rgba, (w, h), interpolation=cv2.INTER_AREA)
        return self._levels[key]


def _remove_flat_background(rgb: np.ndarray, tol: float) -> np.ndarray:
    """Alpha mask that clears a flat backdrop connected to the image border."""
    small = _resize_max(rgb, 1200)
    lab = _to_lab(small.reshape(-1, 3)).reshape(small.shape)
    border = np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])
    ref = np.median(border, axis=0)
    near_border = np.linalg.norm(border - ref, axis=1) < tol
    if near_border.mean() < 0.6:  # busy border: a photo, not a logo on a backdrop
        return np.ones(rgb.shape[:2], np.float32)
    bg = (np.linalg.norm(lab - ref, axis=2) < tol).astype(np.uint8)
    _, comp = cv2.connectedComponents(bg, connectivity=4)
    edge = np.unique(np.concatenate([comp[0], comp[-1], comp[:, 0], comp[:, -1]]))
    edge = edge[edge != 0]
    keep = (~np.isin(comp, edge)).astype(np.float32)
    keep = cv2.resize(keep, (rgb.shape[1], rgb.shape[0]), interpolation=cv2.INTER_LINEAR)
    return np.clip((keep - 0.25) / 0.5, 0, 1).astype(np.float32)


def _photo_like(rgb: np.ndarray, alpha: np.ndarray) -> bool:
    small_rgb = _resize_max(rgb, 400)
    small_a = _resize_max(alpha, 400)
    pix = small_rgb[small_a > 0.5]
    if len(pix) < 50:
        return False
    lum = _luma(pix)
    mid = float(((lum > 0.12) & (lum < 0.88)).mean())
    colours = len(np.unique((pix * 15.99).astype(np.uint8), axis=0))
    return mid > 0.3 and colours > 180


def _resize_pm(rgb: np.ndarray, alpha: np.ndarray, w: int, h: int):
    """Resize straight-alpha art without dark fringes (premultiply first)."""
    interp = cv2.INTER_AREA if w < rgb.shape[1] else cv2.INTER_CUBIC
    pm = cv2.resize(np.dstack([rgb * alpha[..., None], alpha]), (w, h), interpolation=interp)
    a = np.clip(pm[..., 3], 0, 1)
    return np.clip(pm[..., :3] / np.maximum(a, 1e-4)[..., None], 0, 1), a


def _layout_text(o: ToneOptions, s: float):
    """Render every text line at ``s`` px per design unit. Returns [(coverage, left, top, rgb)]."""
    items = []
    for t in o.text:
        font = arctext.font_for_cap_height(str(lettering.FONT_DIR / FONTS[t["font"]].file), t["size"] * s)
        m, (ax, ay) = arctext.render(t["text"], font, t["arc"], t["spacing"])
        items.append((m, t["x"] * s - ax, t["y"] * s - ay, np.array(_hex(t["color"]), np.float32) / 255))
    return items


def _compose_text(rgb, alpha, o: ToneOptions):
    """Place text lines around the art. Positions and sizes are in units of the art's width
    (or of an imaginary 1-unit square when there is no picture), centred on the art."""
    aw, ah = (rgb.shape[1], rgb.shape[0]) if rgb is not None else (1, 1)
    art_h = ah / aw if rgb is not None else 0.0

    def bounds(items, s):
        boxes = [(l, t, l + m.shape[1], t + m.shape[0]) for m, l, t, _ in items]
        if rgb is not None:
            boxes.append((-s / 2, -art_h * s / 2, s / 2, art_h * s / 2))
        return (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes))

    probe = 1000.0
    x0, y0, x1, y1 = bounds(_layout_text(o, probe), probe)
    w_units, h_units = (x1 - x0) / probe, (y1 - y0) / probe
    s = _text_work_width(o) / max(w_units, 1e-3)
    s = min(s, MAX_SOURCE_SIDE / max(h_units, 1e-3), MAX_SOURCE_SIDE / max(w_units, 1e-3))
    items = _layout_text(o, s)
    x0, y0, x1, y1 = bounds(items, s)
    W, H = int(math.ceil(x1 - x0)) + 2, int(math.ceil(y1 - y0)) + 2
    out_rgb = np.zeros((H, W, 3), np.float32)
    out_a = np.zeros((H, W), np.float32)
    if rgb is not None:
        w, h = max(1, round(s)), max(1, round(art_h * s))
        r2, a2 = _resize_pm(rgb, alpha, w, h)
        left, top = int(round(-s / 2 - x0)), int(round(-art_h * s / 2 - y0))
        out_rgb[top:top + h, left:left + w] = r2[:H - top, :W - left]
        out_a[top:top + h, left:left + w] = a2[:H - top, :W - left]
    for m, l, t, col in items:
        left, top = int(round(l - x0)), int(round(t - y0))
        ta = m.astype(np.float32)[:H - top, :W - left] / 255
        hh, ww = ta.shape
        region = out_rgb[top:top + hh, left:left + ww]
        region[:] = region * (1 - ta[..., None]) + col * ta[..., None]
        out_a[top:top + hh, left:left + ww] = ta + out_a[top:top + hh, left:left + ww] * (1 - ta)
    return out_rgb, out_a


def outline_rgb(o: ToneOptions) -> tuple:
    """The keyline / shadow colour: chosen, or whichever stands out on the shirt."""
    return tuple(_hex(o.outline_color)) if o.outline_color != "auto" else tuple(contrast_ink(_hex(o.garment)))


def _add_outline(rgb, alpha, o: ToneOptions):
    """Bootleg keyline + drop shadow under the art, in one ink colour. They become part of the picture,
    so every mode separates them like any other colour. Returns rgb, alpha and the (x, y) offset of
    the new box relative to the old one."""
    h, w = alpha.shape
    r, d = o.outline * w, o.shadow * w
    pad = int(math.ceil(r + d)) + 2
    A = np.zeros((h + 2 * pad, w + 2 * pad), np.float32)
    A[pad:pad + h, pad:pad + w] = alpha
    C = np.zeros((h + 2 * pad, w + 2 * pad, 3), np.float32)
    C[pad:pad + h, pad:pad + w] = rgb
    under = A
    if r > 0:
        outside = (A <= 0.5).astype(np.uint8)
        dist = cv2.distanceTransform(outside, cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        under = np.maximum(A, np.clip(r + 0.5 - dist, 0, 1))
    if d > 0:
        k = int(round(d * math.sqrt(0.5)))
        moved = np.zeros_like(under)
        moved[k:, k:] = under[:under.shape[0] - k, :under.shape[1] - k]
        under = np.maximum(under, moved)
    col = np.float32(outline_rgb(o)) / 255
    out_a = A + under * (1 - A)
    out_rgb = (C * A[..., None] + col * (under * (1 - A))[..., None]) / np.maximum(out_a, 1e-6)[..., None]
    ys, xs = np.nonzero(out_a > 0.02)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    return (np.clip(out_rgb[y0:y1, x0:x1], 0, 1).astype(np.float32), out_a[y0:y1, x0:x1].astype(np.float32),
            (int(x0) - pad, int(y0) - pad))


def prepare(image: bytes | np.ndarray | None, o: ToneOptions) -> Prepared:
    back, crop_xy = 1.0, (0, 0)
    rgb = alpha = None
    if image is not None:
        rgba = load_image(image) if isinstance(image, (bytes, bytearray)) else image
        orig_w = rgba.shape[1]
        rgba = _resize_max(rgba, MAX_SOURCE_SIDE)
        back = orig_w / rgba.shape[1]
        rgb = rgba[..., :3].astype(np.float32) / 255.0
        alpha = rgba[..., 3].astype(np.float32) / 255.0
        has_alpha = (alpha < 0.5).mean() > 0.01
        if o.remove_background and not has_alpha:
            alpha = alpha * _remove_flat_background(rgba[..., :3], o.bg_tolerance)

        if o.denoise:
            k = 2 * int(o.denoise) + 1
            rgb = cv2.medianBlur((rgb * 255 + 0.5).astype(np.uint8), k).astype(np.float32) / 255
        if o.smooth_mm > 0:
            cols = np.nonzero((alpha > 0.02).any(axis=0))[0]
            art_w = (cols.max() - cols.min() + 1) if len(cols) else rgb.shape[1]
            sigma = o.smooth_mm * art_w / (o.width_in * 25.4)   # mm on the print -> source pixels
            rgb = cv2.GaussianBlur(rgb, (0, 0), max(0.3, sigma))
        if o.sharpen > 0:
            sigma = max(0.8, max(rgb.shape[:2]) / 1500)
            blur = cv2.GaussianBlur(rgb, (0, 0), sigma)
            rgb = np.clip(rgb + o.sharpen * (rgb - blur), 0, 1)

        ys, xs = np.nonzero(alpha > 0.02)
        if len(xs) == 0 and not o.text:
            raise ImageError("Nothing is left to print once the background is removed. "
                             "Turn off background removal or lower its tolerance.")
        if len(xs):
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            rgb, alpha = rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]
            crop_xy = (x0, y0)
        else:
            rgb = alpha = None
    elif not o.text:
        raise ImageError("Add a picture or some text.")

    photo = rgb is not None and _photo_like(rgb, alpha)
    crop_wh = (rgb.shape[1], rgb.shape[0]) if rgb is not None else (0, 0)
    if o.text:
        rgb, alpha = _compose_text(rgb, alpha, o)
        ys, xs = np.nonzero(alpha > 0.02)
        if len(xs) == 0:
            raise ImageError("Nothing to print.")
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        rgb, alpha = rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]
    if o.outline > 0 or o.shadow > 0:
        rgb, alpha, (ox, oy) = _add_outline(rgb, alpha, o)
        if not o.text:   # the print box grows by the keyline and shadow
            crop_xy = (crop_xy[0] + ox, crop_xy[1] + oy)
            crop_wh = (rgb.shape[1], rgb.shape[0])

    pm = np.dstack([rgb * alpha[..., None], alpha]).astype(np.float32)
    prep = Prepared(rgba=np.ascontiguousarray(pm), src_w=rgb.shape[1], src_h=rgb.shape[0],
                    crop=(round(crop_xy[0] * back), round(crop_xy[1] * back),
                          round(crop_wh[0] * back), round(crop_wh[1] * back)),
                    photo_like=photo)

    sel = alpha > 0.5
    pix = (rgb[sel] * 255).astype(np.uint8)
    if len(pix) > 200_000:
        pix = pix[np.random.default_rng(0).choice(len(pix), 200_000, replace=False)]
    if len(pix) == 0:
        pix = np.zeros((1, 3), np.uint8)
    prep.spot_lab = _to_lab(pix)
    lum8 = np.clip(np.round(pix.astype(np.float32) @ np.float32([0.299, 0.587, 0.114])), 0, 255).astype(np.int64)
    prep.lum_counts = np.bincount(lum8, minlength=256).astype(np.float64)
    prep.lum_rgb = np.stack([np.bincount(lum8, weights=pix[:, c].astype(np.float64), minlength=256)
                             for c in range(3)], axis=1)
    if o.mode == "spot":
        prep.palette_lab, prep.palette = spot_palette(prep, int(o.spot_colors))
    return prep


def fixed_palette(name: str, k: int, prep: Prepared | None = None, exclude=None):
    """k colours from a built-in palette: the ones closest to the art's own colours."""
    cols = [_hex(c) for c in PALETTES[name]["colors"]]
    if exclude is not None:
        cols = [c for c in cols if float(np.linalg.norm(_lab1(c) - _lab1(exclude))) >= 20] or cols
    if len(cols) > k and prep is not None and prep.spot_lab is not None:
        want, _ = spot_palette(prep, k, exclude)
        labs = np.array([_lab1(c) for c in cols])
        chosen = []
        for w in want:
            d = np.linalg.norm(labs - w, axis=1)
            d[chosen] = 1e9
            chosen.append(int(d.argmin()))
        cols = [cols[i] for i in chosen]
    cols = cols[:k]
    labs = np.array([_lab1(c) for c in cols], np.float32)
    order = np.argsort(-labs[:, 0])
    return labs[order], [tuple(cols[i]) for i in order]


def threshold_cuts(prep: Prepared, o: ToneOptions) -> list:
    """Cut points between tones: yours, or found automatically (weighted 1-D k-means on the art's tones)."""
    n = o.threshold_levels
    if len(o.thresholds) == n - 1:
        return list(o.thresholds)
    L = _tone(np.arange(256, dtype=np.float32) / 255, o)
    if o.invert:
        L = 1 - L
    centers = hybrid.kmeans_1d(L, prep.lum_counts if prep.lum_counts is not None else np.ones(256), n)
    cuts = [(a + b) / 2 for a, b in zip(centers[:-1], centers[1:])]
    out, last = [], 0.0
    for c in cuts:  # keep them strictly increasing and inside the range
        c = float(min(0.98, max(last + 0.02, c)))
        out.append(round(c, 3))
        last = c
    return out


def band_colors(prep: Prepared, o: ToneOptions, cuts: list) -> list:
    """Colour of each tone, darkest first."""
    n = len(cuts) + 1
    if o.threshold_colors == "ink":
        base = np.array(_hex(o.inks[0]), np.float32)
        return [tuple(int(round(v)) for v in base + (255 - base) * (0.85 * k / max(1, n - 1))) for k in range(n)]
    if o.threshold_colors == "palette" and o.palette != "image":
        cols = sorted((_hex(c) for c in PALETTES[o.palette]["colors"]), key=_lum)
        return [cols[int(round(k * (len(cols) - 1) / max(1, n - 1)))] for k in range(n)]
    L = _tone(np.arange(256, dtype=np.float32) / 255, o)
    if o.invert:
        L = 1 - L
    edges = [-1.0] + list(cuts) + [2.0]
    out = []
    for k in range(n):
        m = (L >= edges[k]) & (L < edges[k + 1])
        cnt = prep.lum_counts[m].sum() if prep.lum_counts is not None else 0
        if cnt > 0:
            out.append(tuple(int(round(v)) for v in prep.lum_rgb[m].sum(axis=0) / cnt))
        else:
            mid = (max(edges[k], 0) + min(edges[k + 1], 1)) / 2
            out.append((int(mid * 255),) * 3)
    return out


def spot_palette(prep: Prepared, k: int, exclude=None):
    """k spot colours from the art (light first). ``exclude``: a shirt colour whose look-alikes
    are left out, because the shirt itself prints them."""
    key = (k, tuple(exclude) if exclude is not None else None)
    if key not in prep._palettes:
        lab = prep.spot_lab
        if exclude is not None:
            keep = np.linalg.norm(lab - _lab1(exclude), axis=1) > 20
            if keep.sum() >= max(k, 16):
                lab = lab[keep]
        rgb = np.array(_lab_to_rgb(lab.astype(np.float32)), np.uint8)
        centers = _find_palette(rgb, max(1, k))
        centers = centers[np.argsort(-centers[:, 0])]  # light inks first, dark inks print on top
        prep._palettes[key] = (centers, _lab_to_rgb(centers))
    return prep._palettes[key]


# ----------------------------------------------------------------- sampling


def _sample(prep: Prepared, x0: float, y0: float, gw: int, gh: int, step: float, out_w: int,
            dx: float = 0.0, dy: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    """Unpremultiplied RGB and alpha for a grid of output pixels.

    Grid pixel (j, i) is centred on output pixel (x0 + (j + .5) * step, y0 + (i + .5) * step),
    shifted by (dx, dy) to model plate misregistration.
    """
    k = prep.src_w / out_w            # source px per output px
    src = prep.level(k * step)
    sx = src.shape[1] / prep.src_w
    sy = src.shape[0] / prep.src_h
    M = np.float32([
        [k * step * sx, 0, ((x0 - dx) + 0.5 * step) * k * sx - 0.5],
        [0, k * step * sy, ((y0 - dy) + 0.5 * step) * k * sy - 0.5],
    ])
    out = cv2.warpAffine(src, M, (gw, gh), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    a = out[..., 3]
    rgb = out[..., :3] / np.maximum(a, 1e-4)[..., None]
    return np.clip(rgb, 0, 1), np.clip(a, 0, 1)


# ----------------------------------------------------------------- tone


def _tone(v: np.ndarray, o: ToneOptions) -> np.ndarray:
    """Levels, gamma, brightness, contrast on a 0..1 lightness value."""
    v = np.clip((v - o.black_point) / (o.white_point - o.black_point), 0, 1)
    if o.gamma != 1:
        v = v ** (1.0 / o.gamma)
    if o.brightness:
        v = v + o.brightness * 0.5
    if o.contrast:
        fac = math.tan((o.contrast * 0.98 + 1) * math.pi / 4)
        v = (v - 0.5) * fac + 0.5
    return np.clip(v, 0, 1)


def _shape_dots(c: np.ndarray, o: ToneOptions) -> np.ndarray:
    """Dot-gain compensation plus the smallest / largest dot the press can hold."""
    if o.dot_gain > 0:
        # Printed p = c + 4 g c (1 - c); solve for the c that prints as the wanted p.
        g = o.dot_gain
        c = ((1 + 4 * g) - np.sqrt(np.maximum((1 + 4 * g) ** 2 - 16 * g * c, 0))) / (8 * g)
    if o.min_dot > 0:
        c = np.where(c < o.min_dot * 0.5, 0, np.maximum(c, o.min_dot))
    if o.max_dot < 1:
        c = np.where(c > (1 + o.max_dot) * 0.5, 1, np.minimum(c, o.max_dot))
    return c.astype(np.float32)


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


@dataclass
class Plate:
    name: str
    rgb: tuple
    angle: float
    shift: tuple = (0.0, 0.0)
    src: int = 0              # which coverage channel feeds this plate
    underbase: bool = False   # white base printed first, under the colours on dark shirts
    on: bool = True           # switched off: not printed, not in files
    choke_mm: float = 0.0     # > 0 shrinks this ink's dots, < 0 spreads them
    label: str = ""           # the ink's name on films and in the README ("Red", or the user's own name)


def _lum(rgb) -> float:
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0


def _lab1(rgb) -> np.ndarray:
    return cv2.cvtColor(np.array([[rgb]], np.float32) / 255, cv2.COLOR_RGB2LAB)[0, 0]


# Plain screen-print ink names; each ink is named after the nearest one (CIE76 in Lab) unless the
# user names it. The web and Photoshop versions read this same table from the catalog.
INK_NAMES = [
    ("Black", (0, 0, 0)), ("Charcoal", (54, 54, 58)), ("Dark grey", (90, 90, 95)), ("Grey", (128, 128, 128)),
    ("Light grey", (190, 190, 192)), ("White", (255, 255, 255)), ("Cream", (243, 233, 210)), ("Bone", (227, 218, 201)),
    ("Tan", (200, 170, 125)), ("Khaki", (189, 176, 140)), ("Brown", (110, 70, 40)), ("Chocolate", (70, 42, 28)),
    ("Rust", (170, 75, 40)), ("Copper", (190, 110, 70)), ("Red", (200, 16, 46)), ("Bright red", (238, 39, 55)),
    ("Cardinal", (140, 21, 40)), ("Maroon", (100, 25, 40)), ("Burgundy", (110, 30, 55)), ("Pink", (245, 160, 190)),
    ("Hot pink", (235, 50, 140)), ("Magenta", (236, 0, 140)), ("Coral", (250, 120, 100)), ("Orange", (245, 130, 32)),
    ("Burnt orange", (200, 90, 30)), ("Peach", (250, 190, 150)), ("Gold", (255, 180, 0)), ("Athletic gold", (255, 199, 44)),
    ("Yellow", (255, 230, 0)), ("Lemon", (250, 240, 120)), ("Mustard", (210, 165, 40)), ("Olive", (110, 110, 50)),
    ("Army green", (75, 83, 50)), ("Forest green", (25, 75, 45)), ("Kelly green", (0, 140, 70)), ("Green", (60, 170, 70)),
    ("Lime", (150, 210, 60)), ("Mint", (160, 220, 180)), ("Teal", (0, 128, 128)), ("Turquoise", (0, 180, 190)),
    ("Cyan", (0, 174, 239)), ("Sky blue", (120, 190, 230)), ("Light blue", (170, 205, 235)), ("Columbia blue", (155, 195, 225)),
    ("Royal blue", (30, 70, 170)), ("Blue", (40, 90, 200)), ("Navy", (25, 35, 75)), ("Indigo", (60, 50, 130)),
    ("Purple", (95, 45, 135)), ("Violet", (140, 90, 190)), ("Lavender", (190, 170, 220)),
]


def _lab_exact(rgb) -> tuple:
    """Lab exactly as the JavaScript engine computes it, so both pick the same ink names."""
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    r, g, b = (lin(v / 255) for v in rgb)
    x = (0.412453 * r + 0.357580 * g + 0.180423 * b) / 0.950456
    y = 0.212671 * r + 0.715160 * g + 0.072169 * b
    z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754
    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


_INK_LABS = [(n, _lab_exact(c)) for n, c in INK_NAMES]


def ink_name(rgb) -> str:
    L, a, b = _lab_exact(rgb)
    best, bd = "Ink", float("inf")
    for n, (l2, a2, b2) in _INK_LABS:
        d = (L - l2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2
        if d < bd:
            best, bd = n, d
    return best


def _label_plates(plates: list) -> None:
    """Process inks and the underbase keep their names; other inks are named by colour; repeats get 2, 3..."""
    seen: dict = {}
    for p in plates:
        if not p.label:
            p.label = p.name if (p.underbase or p.name in {n for n, _, _ in PROCESS_INKS}) else ink_name(p.rgb)
        base = p.label
        seen[base] = seen.get(base, 0) + 1
        if seen[base] > 1:
            p.label = f"{base} {seen[base]}"


def contrast_ink(garment) -> tuple:
    """Cream on dark shirts, near-black on light ones: whichever stands out more."""
    lg = _lum(garment)
    return CREAM if abs(_lum(CREAM) - lg) >= abs(_lum(INK_BLACK) - lg) else INK_BLACK


@dataclass
class Fit:
    """How the design is adapted to the shirt colour."""
    mode: str                                   # "recolor", "tones" or "off"
    inks: list = field(default_factory=list)    # mono / duotone inks after any swap
    spot: list = field(default_factory=list)    # per palette colour: ink rgb, or None = the shirt supplies it
    underbase: bool = False
    shirt_is_black: bool = False                # dark shirt under a white base: the shirt prints the blacks
    palette: list = field(default_factory=list)  # spot colours actually separated
    palette_lab: np.ndarray | None = None
    cuts: list = field(default_factory=list)     # threshold layers: cut points used
    bands: list = field(default_factory=list)    # threshold layers: colour per tone (dark first), None = shirt
    notes: list = field(default_factory=list)


def resolve_fit(prep: Prepared, o: ToneOptions) -> Fit:
    g = _hex(o.garment)
    lg = _lum(g)
    mode = o.shirt_fit
    if mode == "auto":
        mode = "tones" if prep.photo_like else "recolor"
    fit = Fit(mode=mode, inks=[_hex(c) for c in o.inks])
    name = lambda c: "cream" if c == CREAM else "black"  # noqa: E731
    if mode != "off" and o.mode in ("mono", "duotone") and abs(_lum(fit.inks[0]) - lg) < 0.3:
        new = contrast_ink(g)
        fit.notes.append(f"Ink {to_hex(fit.inks[0])} would disappear on this shirt, so it prints in {name(new)}.")
        fit.inks[0] = new
    printed = fit.inks[:2 if o.mode == "duotone" else 1]
    auto = o.underbase == "auto" and o.target == "screen" and lg < 0.6
    if o.mode in ("mono", "duotone"):
        auto = auto and any(_lum(c) < 0.85 for c in printed)
    fit.underbase = o.underbase == "on" or auto
    fit.shirt_is_black = fit.underbase and lg < 0.35 and o.mode in ("cmyk", "spot", "index", "threshold")
    if o.mode == "threshold":
        fit.cuts = threshold_cuts(prep, o)
        cols = band_colors(prep, o, fit.cuts)
        if len(o.inks) == len(cols):
            cols = [_hex(c) for c in o.inks]
        free = None
        if mode != "off":
            d = [abs(_lum(c) - lg) for c in cols]
            j = int(np.argmin(d))
            if d[j] < 0.2:
                free = j
        fit.bands = [None if i == free else c for i, c in enumerate(cols)]
        if free is not None:
            fit.notes.append(f"Tone {free + 1} ({to_hex(cols[free])}) is the shirt colour, so the shirt shows through there.")
    if o.mode in ("spot", "index"):
        # With a white base, it counts as one of the screens: 4 colours = white + 3 spot colours.
        k = max(1, o.spot_colors - 1) if fit.underbase else o.spot_colors
        exclude = g if (fit.shirt_is_black or o.mode == "index") else None
        if o.palette != "image":
            fit.palette_lab, pal = fixed_palette(o.palette, k, prep, exclude)
        else:
            fit.palette_lab, pal = spot_palette(prep, k, exclude)
        fit.palette = list(pal)
        base = [_hex(c) for c in o.inks] if len(o.inks) == len(pal) else list(pal)
        glab = _lab1(g)
        for i, c in enumerate(base):
            close = mode != "off" and float(np.linalg.norm(_lab1(c) - glab)) < 14
            if close and (mode == "tones" or fit.underbase or o.mode == "index"):
                fit.spot.append(None)
                fit.notes.append(f"Spot {i + 1} ({to_hex(c)}) matches the shirt, so the shirt shows through instead.")
            elif close:
                new = contrast_ink(g)
                fit.spot.append(new)
                fit.notes.append(f"Spot {i + 1} ({to_hex(c)}) matches the shirt, so it prints in {name(new)}.")
            else:
                fit.spot.append(c)
    if fit.underbase:
        if o.mode == "cmyk" and fit.shirt_is_black:
            fit.notes.append("Dark shirt: prints as a white base + cyan, magenta, yellow. "
                             "The shirt itself is the black, so there's no black ink.")
        elif o.mode == "cmyk":
            fit.notes.append("White base under the process colours, solved for this shirt colour.")
        elif o.mode == "threshold":
            fit.notes.append(f"White base + {sum(c is not None for c in fit.bands)} tones"
                             + (" (the shirt is the black)." if fit.shirt_is_black else "."))
        elif o.mode in ("spot", "index"):
            fit.notes.append(f"White base + {sum(c is not None for c in fit.spot)} spot colours"
                             + (" (the shirt is the black)." if fit.shirt_is_black else "."))
        elif o.underbase == "auto":
            fit.notes.append("Dark shirt: a choked white underbase is added under the colours so they stay bright.")
    return fit


def plate_specs(prep: Prepared, o: ToneOptions, fit: Fit | None = None) -> tuple[list[Plate], str]:
    """The inks to print and how they combine ("multiply" overprint or "opaque")."""
    fit = fit or resolve_fit(prep, o)
    if o.mode == "mono":
        plates, blend = [Plate("Ink", fit.inks[0], o.angle)], "opaque"
    elif o.mode == "duotone":
        plates, blend = [Plate("Shadow ink", fit.inks[0], o.angle, src=0),
                         Plate("Second ink", fit.inks[1], o.angle + 30, src=1)], "multiply"
    elif o.mode == "cmyk":
        plates, blend = [Plate(n, c, o.angle + a, src=i) for i, (n, c, a) in enumerate(PROCESS_INKS)
                         if not (fit.shirt_is_black and n == "Black")], "multiply"
    elif o.mode == "threshold":
        n = len(fit.bands)  # print light tones first, darker ones on top
        plates = [Plate(f"Tone {k + 1}", fit.bands[k], o.angle + 15 * (n - 1 - k), src=k)
                  for k in reversed(range(n)) if fit.bands[k] is not None]
        blend = "opaque"
    elif o.mode == "index":
        plates = [Plate(f"Colour {i + 1}", c, o.angle, src=i) for i, c in enumerate(fit.spot) if c is not None]
        blend = "opaque"
    else:
        plates = [Plate(f"Spot {i + 1}", c, o.angle + 30 * i, src=i) for i, c in enumerate(fit.spot) if c is not None]
        blend = "opaque"
    if fit.underbase:
        plates.insert(0, Plate("White underbase", (255, 255, 255), o.angle + 7.5,
                               src=4 if o.mode == "cmyk" else -1, underbase=True, choke_mm=o.choke_mm))
    for p in plates:
        e = o.ink_edits.get(p.name)
        if e:
            p.on = e["on"]
            p.label = e.get("name", "")
            if not p.underbase:
                p.choke_mm = e["choke_mm"]
    _label_plates(plates)
    return plates, blend


def _misregistration(plates: list[Plate], o: ToneOptions) -> None:
    px = o.misregister_mm * o.dpi / 25.4
    for p in plates:
        i = p.src
        if i <= 0 or px <= 0 or p.underbase:
            p.shift = (0.0, 0.0)
            continue
        h = noise.hash2(np.array([i]), np.array([o.seed]), 911)
        r = noise.hash2(np.array([i]), np.array([o.seed]), 913)
        ang = float(h[0]) * 2 * math.pi
        mag = px * (0.5 + 0.5 * float(r[0]))
        p.shift = (mag * math.cos(ang), mag * math.sin(ang))


def _coverages(rgb, a, prep: Prepared, o: ToneOptions, fit: Fit) -> list[np.ndarray]:
    """Ink amount 0..1 for every coverage channel, before screening."""
    if o.mode in ("mono", "duotone"):
        light = _tone(_luma(rgb), o)
        if fit.mode == "tones" and o.mode == "mono":
            # What you see on a shirt is coverage * ink + (1 - coverage) * shirt.
            # Solve for the coverage that shows the picture's lightness on this shirt.
            li, lg = _lum(fit.inks[0]), _lum(_hex(o.garment))
            c = np.clip((light - lg) / (li - lg), 0, 1)
        else:
            c = light if o.invert else 1 - light
        if o.style == "xerox":
            c = np.clip((c - 0.5) * 1.3 + 0.5, 0, 1)  # the Xerox threshold adds the rest
        if o.mode == "mono":
            return [c * a]
        return [(c ** 1.6) * a, np.minimum(1, c * 1.3) ** 0.8 * a]
    if o.mode == "threshold":
        L = _tone(_luma(rgb), o)
        if o.invert:
            L = 1 - L
        cuts, n = fit.cuts, len(fit.cuts) + 1
        soft = o.threshold_soft
        darker = [(L < t).astype(np.float32) if soft <= 0 else np.clip((t - L) / soft + 0.5, 0, 1) for t in cuts]
        out = []
        for k in range(n):
            if o.threshold_stack:   # lighter tones run under the darker ones (no gaps at the edges)
                cov = darker[k] if k < n - 1 else np.ones_like(L)
            else:                   # knockout: each spot gets exactly one tone (saves ink)
                cov = (darker[k] if k < n - 1 else 1.0) - (darker[k - 1] if k > 0 else 0.0)
            out.append(np.clip(cov, 0, 1) * a)
        return out
    if o.mode == "index":
        return [a * 0]   # index colour is separated on its pixel grid (see _index_grids)
    if o.mode == "cmyk":
        t = _tone(rgb, o)
        if not fit.underbase:
            cmy, k = _gcr(1 - t)
            return [cmy[..., 0] * a, cmy[..., 1] * a, cmy[..., 2] * a, k * a]
        # On a shirt with a white base: you see base * (colour over white) + (1 - base) * shirt.
        # Use the least base that can reach the wanted colour, then solve the colour over white.
        g = np.array(_hex(o.garment), np.float32) / 255
        if fit.shirt_is_black:
            t = np.maximum(t, g)  # anything darker than a black shirt is just the shirt: no ink at all
        up = np.where(t > g, (t - g) / np.maximum(1 - g, 1e-4), 0)
        down = np.where(t < g, 1 - t / np.maximum(g, 1e-4), 0)
        base = np.clip(np.maximum(up, down).max(axis=2), 0, 1)
        over = np.clip((t - (1 - base[..., None]) * g) / np.maximum(base[..., None], 1e-4), 0, 1)
        over = np.where(base[..., None] > 0.04, over, 1)  # (almost) no base: the shirt shows, no colour on it
        cmy, k = _gcr(1 - over)
        return [cmy[..., 0] * a, cmy[..., 1] * a, cmy[..., 2] * a, k * a, base * a]
    centers = fit.palette_lab if fit.palette_lab is not None else prep.palette_lab
    if fit.mode == "tones" or fit.shirt_is_black:  # the shirt is a free extra "ink"
        centers = np.vstack([centers, _lab1(_hex(o.garment))[None, :]])
    lab = cv2.cvtColor(rgb.astype(np.float32), cv2.COLOR_RGB2LAB)
    d2 = ((lab[..., None, :] - centers[None, None, :, :]) ** 2).sum(-1)
    w = np.exp(-(d2 - d2.min(-1, keepdims=True)) / (2 * o.spot_softness ** 2))
    w /= w.sum(-1, keepdims=True)
    n = len(fit.palette_lab) if fit.palette_lab is not None else len(prep.palette_lab)
    return [w[..., i] * a for i in range(n)]


def _gcr(cmy: np.ndarray):
    """Black generation: black replaces the grey part of dark colours only (no muddy black in light
    tones), and total ink is held under 300% so dots don't fill in."""
    kmin = cmy.min(axis=2)
    k = 0.9 * kmin * np.clip((kmin - 0.15) / 0.85, 0, 1) ** 0.5
    out = np.clip((cmy - k[..., None]) / np.maximum(1 - k, 1e-4)[..., None], 0, 1)
    tot = out.sum(axis=2)
    scale = np.where(tot + k > 3.0, (3.0 - k) / np.maximum(tot, 1e-4), 1.0)
    return (out * scale[..., None]).astype(np.float32), k.astype(np.float32)


def _underbase(covs: list[np.ndarray], plates: list[Plate], o: ToneOptions) -> np.ndarray:
    """White base under every ink, shrunk ("choked") so it never peeks out past the colour."""
    base = next((p for p in plates if p.underbase), None)
    if base is not None and 0 <= base.src < len(covs):   # CMYK: the base was solved with the colours
        return _choke(covs[base.src], o.choke_mm, o)
    m = None
    for p in plates:
        if not p.underbase and p.on:
            if m is None:
                m = covs[p.src].copy()
            elif o.mode in ("spot", "threshold") and not o.threshold_stack:
                m = m + covs[p.src]        # spot colours share the base: it goes under all of them
            else:
                m = np.maximum(m, covs[p.src])
    if m is None:
        return np.zeros_like(covs[0]) if covs else np.zeros(1, np.float32)
    return _choke(np.clip(m, 0, 1), o.choke_mm, o)


def _choke(c: np.ndarray, mm: float, o: ToneOptions) -> np.ndarray:
    """Shrink (mm > 0) or spread (mm < 0) every dot by about ``mm`` at its edge."""
    if not mm:
        return c
    cell = o.dpi / o.lpi if o.style in AM_STYLES else 2 * o.grain_mm * o.dpi / 25.4
    k = (mm * o.dpi / 25.4) / (cell * 0.5642)  # radius change as a fraction of the cell
    out = np.clip(np.sqrt(np.clip(c, 0, 1)) - k, 0, 1) ** 2
    return np.where(c > 0, out, 0).astype(np.float32)  # spreading never adds ink where there was none


# ----------------------------------------------------------------- screens


@lru_cache(maxsize=None)
def _spot_quantiles(style: str) -> np.ndarray:
    g = (np.arange(512) + 0.5) / 512 - 0.5
    return np.quantile(_spot(style, g[None, :], g[:, None]), np.linspace(0, 1, 1025)).astype(np.float64)


def _spot(style: str, u, v):
    """Order in which a cell fills: small values ink first."""
    au, av = np.abs(u), np.abs(v)
    if style == "round":
        return u * u + v * v
    if style == "ellipse":
        return u * u + (v / 0.62) ** 2
    if style == "square":
        return np.maximum(au, av)
    if style == "diamond":
        return au + av
    if style == "line":
        return av + 0 * au
    if style == "cross":
        return np.minimum(au, av)
    # euclid: dots grow to a checkerboard at 50%, then become inverted holes
    x, y = 2 * au, 2 * av
    inside = (x + y) <= 1
    return np.where(inside, x * x + y * y, 2 - ((1 - x) ** 2 + (1 - y) ** 2))


def threshold(xs, ys, o: ToneOptions, angle: float, seed: int) -> np.ndarray:
    """Per-pixel threshold in 0..1: a pixel gets ink where coverage > threshold."""
    ppm = o.dpi / 25.4
    if o.style in AM_STYLES:
        cell = o.dpi / o.lpi
        t = math.radians(angle)
        c, s = math.cos(t), math.sin(t)
        X = np.asarray(xs, np.float64)[None, :] / cell
        Y = np.asarray(ys, np.float64)[:, None] / cell
        u = X * c + Y * s
        v = -X * s + Y * c
        if o.style == "modulation":   # lines that wave; their width carries the tone
            vw = v + 0.22 * np.sin(2 * np.pi * u * 0.5)
            T = (np.abs(vw - np.floor(vw) - 0.5) * 2).astype(np.float32)
        else:
            u = (u - np.floor(u) - 0.5).astype(np.float32)
            v = (v - np.floor(v) - 0.5).astype(np.float32)
            T = np.interp(_spot(o.style, u, v), _spot_quantiles(o.style),
                          np.linspace(0, 1, 1025)).astype(np.float32)
        if o.roughness > 0:
            r = max(cell * 0.3, 1.5)
            T = T + o.roughness * 0.35 * (noise.value_noise(xs, ys, r, r, seed + 71) - 0.5)
        return np.clip(T, 0.0005, 0.9995)

    g = max(o.grain_mm * ppm, 0.5)
    if o.style in ("bayer4", "bayer8"):
        m = hybrid.bayer_matrix(4 if o.style == "bayer4" else 8)
        n = m.shape[0]
        ix = np.floor(np.asarray(xs) / g).astype(np.int64) % n
        iy = np.floor(np.asarray(ys) / g).astype(np.int64) % n
        return m[iy[:, None], ix[None, :]]
    if o.style == "random":
        ix = np.floor(np.asarray(xs) / g).astype(np.int64)
        iy = np.floor(np.asarray(ys) / g).astype(np.int64)
        return np.clip(noise.hash2(ix[None, :], iy[:, None], seed), 0.0005, 0.9995)
    if o.style in DIFFUSION_STYLES:
        return noise.blue_noise(xs, ys, g, seed)   # only used if called directly; plates use the diffusion grid
    if o.style == "fm":
        return noise.blue_noise(xs, ys, g, seed)
    if o.style == "mezzotint":
        a = noise.fbm(xs, ys, g * 2.5, seed + 3, octaves=2, stretch=3.0)
        b = noise.blue_noise(xs, ys, max(g * 0.6, 0.5), seed)
        s = 0.5 * (a + b)  # sum of two uniforms -> triangular; map back to uniform
        return np.where(s < 0.5, 2 * s * s, 1 - 2 * (1 - s) ** 2).astype(np.float32)
    # xerox: mottled toner edges and faint drum streaks
    T = 0.5 + 0.42 * (noise.fbm(xs, ys, g * 3, seed + 5, octaves=3) - 0.5)
    T += 0.22 * (noise.blue_noise(xs, ys, max(g * 0.5, 0.5), seed) - 0.5)
    streak = noise.value_noise(xs, np.zeros(1), g * 6, 1e6, seed + 9)[0] - 0.5
    T += 0.12 * streak[None, :]
    return np.clip(T, 0.0005, 0.9995).astype(np.float32)


# ----------------------------------------------------------------- textures


def texture_masks(xs, ys, o: ToneOptions, texture_images: dict | None = None):
    """(remove, add) boolean masks from the selected textures."""
    shape = (len(ys), len(xs))
    remove = np.zeros(shape, bool)
    add = np.zeros(shape, bool)
    ppm = o.dpi / 25.4
    for i, t in enumerate(o.textures):
        s, kind = t["strength"], t["type"]
        if s <= 0:
            continue
        base = TEXTURES[kind]["size_mm"] * t["scale"] * ppm
        seed = o.seed * 7919 + i * 131
        if kind == "worn":
            n = 0.7 * noise.fbm(xs, ys, base, seed, 5) + 0.3 * noise.fbm(xs, ys, base * 0.12, seed + 1, 3)
            remove |= n < s * 0.5
        elif kind == "cracked":
            e = noise.voronoi_edge(xs, ys, base, seed)
            width = max(0.6, base * 0.035 * (0.4 + s))
            fade = noise.fbm(xs, ys, base * 3, seed + 2, 3) < 0.25 + 0.75 * s
            remove |= (e < width) & fade
        elif kind == "grunge":
            remove |= noise.fbm(xs, ys, base, seed, 4) > 1 - s * 0.3
            remove |= noise.fbm(xs, ys, max(base * 0.06, 0.8), seed + 3, 2) > 1 - s * 0.12
        elif kind == "paper":
            fib = noise.fbm(xs, ys, max(base * 0.1, 0.8), seed, 2, stretch=25.0)
            remove |= fib > 1 - s * 0.14
        elif kind == "scratches":
            remove |= noise.scratches(xs, ys, base, seed, 0.15 + 0.6 * s, max(0.6, 0.1 * ppm))
        elif kind == "toner":
            spots = noise.fbm(xs, ys, max(base * 0.12, 0.8), seed, 2) > 1 - s * 0.05
            add |= spots & (noise.fbm(xs, ys, base * 20, seed + 4, 2) > 0.45)
        elif kind == "washed":   # fine, uneven dropouts all over: ink faded by years of washing
            fine = noise.fbm(xs, ys, max(base * 0.08, 0.7), seed, 2)
            patch = noise.fbm(xs, ys, base * 6, seed + 1, 3)
            remove |= fine < s * 0.5 * (0.45 + 0.9 * patch)
        elif kind == "fabric":   # knit ribs and rows of the shirt showing through the ink
            pitch = max(2.0, base)
            fx = (np.asarray(xs, np.float64) / pitch) % 1.0
            fy = (np.asarray(ys, np.float64) / (pitch * 0.7)) % 1.0
            breakup = noise.fbm(xs, ys, pitch * 0.6, seed, 2) > 0.3
            remove |= ((fx < s * 0.3)[None, :] | (fy < s * 0.16)[:, None]) & breakup
        elif kind == "streaks":   # dry, uneven squeegee pulls: speckled bands across the print
            band = noise.fbm(xs, ys, base, seed, 3, stretch=8.0)
            speck = noise.fbm(xs, ys, max(base * 0.05, 0.7), seed + 5, 2)
            remove |= (band < s * 0.5) & (speck < 0.35 + 0.5 * s)
        elif kind == "pinholes":   # tiny holes from dust and gaps in the screen emulsion
            remove |= noise.fbm(xs, ys, max(base * 0.08, 0.7), seed, 2) > 1 - s * 0.06
        elif TEXTURES[kind].get("scan"):
            remove |= sample_scan(kind, xs, ys, base, t.get("rotate", 0.0)) < s   # strength 1 = all but clean areas
        elif kind == "image":
            tex = (texture_images or {}).get(t.get("image_id"))
            if tex is None:
                continue
            th, tw = tex.shape
            tile_px = base  # one tile is 100 mm wide at scale 1
            if t.get("rotate", 0.0):
                U, V = _rotated(xs, ys, t["rotate"])
                ix = np.floor(U / tile_px * tw).astype(np.int64) % tw
                iy = np.floor(V / tile_px * tw).astype(np.int64) % th
                remove |= tex[iy, ix] < s * 0.75
                continue
            ix = (np.floor(np.asarray(xs) / tile_px * tw).astype(np.int64)) % tw
            iy = (np.floor(np.asarray(ys) / tile_px * tw).astype(np.int64)) % th
            remove |= tex[iy[:, None], ix[None, :]] < s * 0.75
    return remove, add


# ----------------------------------------------------------------- render


def render_plates(prep: Prepared, o: ToneOptions, x0: float, y0: float, gw: int, gh: int,
                  step: float, plates: list[Plate], texture_images: dict | None = None,
                  fit: Fit | None = None) -> list[np.ndarray]:
    """On/off bitmaps (gh x gw) for each plate over one region of the print."""
    fit = fit or resolve_fit(prep, o)
    if o.ghost_mm > 0 and o.ghost_strength > 0:
        return _with_ghost(prep, o, x0, y0, gw, gh, step, plates, texture_images, fit)
    out_w, _ = prep.out_size(o)
    xs = x0 + (np.arange(gw) + 0.5) * step
    ys = y0 + (np.arange(gh) + 0.5) * step
    samples: dict[tuple, list[np.ndarray]] = {}
    result = []
    b_soft, b_keep = border_mask(xs, ys, o, out_w, prep.out_size(o)[1])
    gridded = o.mode == "index" or o.style in DIFFUSION_STYLES
    index_grids = _index_grids(prep, o, fit, plates) if o.mode == "index" else None
    for i, p in enumerate(plates):
        if gridded:
            if not p.on:
                result.append(np.zeros((gh, gw), bool))
                continue
            G, cell = (index_grids[p.src if not p.underbase else "base"] if index_grids is not None
                       else _diffusion_grid(prep, o, fit, plates, p))
            bm = _lookup(G, cell, xs - p.shift[0], ys - p.shift[1])
            result.append(bm & b_keep if b_keep is not None else bm)
            continue
        if p.shift not in samples:
            rgb, a = _sample(prep, x0, y0, gw, gh, step, out_w, *p.shift)
            covs0 = [_shape_dots(c, o) for c in _coverages(rgb, a, prep, o, fit)]
            if b_soft is not None:   # border fades shrink the dots toward the edge
                covs0 = [c * b_soft for c in covs0]
            samples[p.shift] = covs0
        if not p.on:
            result.append(np.zeros((gh, gw), bool))
            continue
        covs = samples[p.shift]
        cov = _underbase(covs, plates, o) if p.underbase else _choke(covs[p.src], p.choke_mm, o)
        # seed by ink, not list position, so adding an underbase never changes the other plates
        T = threshold(xs - p.shift[0], ys - p.shift[1], o, p.angle, o.seed * 31 + (p.src if p.src >= 0 else 97))
        result.append((cov > T) & b_keep if b_keep is not None else cov > T)
    if o.textures:
        remove, add = texture_masks(xs, ys, o, texture_images)
        alpha_any = None
        if add.any():
            _, a = _sample(prep, x0, y0, gw, gh, step, out_w)
            alpha_any = a > 0.5
        for i in range(len(result)):
            result[i] &= ~remove
        if alpha_any is not None:
            inks = [i for i, p in enumerate(plates) if not p.underbase and p.on]
            if inks:  # toner specks go on the darkest / black plate (printed last)
                result[inks[-1]] |= add & alpha_any & ~remove & (b_keep if b_keep is not None else True)
    return result


def _with_ghost(prep, o, x0, y0, gw, gh, step, plates, texture_images, fit):
    """Ghost / slur: the screen shifted on a second pass, leaving a faint, broken double print."""
    import copy
    plain = copy.copy(o)
    plain.ghost_mm = 0.0
    main = render_plates(prep, plain, x0, y0, gw, gh, step, plates, texture_images, fit)
    g = o.ghost_mm * o.dpi / 25.4
    moved = [copy.copy(p) for p in plates]
    for p in moved:
        p.shift = (p.shift[0] + 0.6 * g, p.shift[1] + 0.8 * g)
    ghost = render_plates(prep, plain, x0, y0, gw, gh, step, moved, texture_images, fit)
    xs = x0 + (np.arange(gw) + 0.5) * step
    ys = y0 + (np.arange(gh) + 0.5) * step
    keep = noise.fbm(xs, ys, max(0.35 * o.dpi / 25.4, 0.8), o.seed * 7 + 77, 2) < o.ghost_strength * 0.8
    return [m | (gb & keep) for m, gb in zip(main, ghost)]


_GRID_CACHE: "OrderedDict[tuple, object]" = __import__("collections").OrderedDict()


def _opts_key(o: ToneOptions) -> str:
    """Everything that changes a dither grid (not textures, marks, seeds or shifts)."""
    import json
    from dataclasses import asdict
    d = asdict(o)
    for k in ("textures", "registration_marks", "misregister_mm", "seed", "knockout"):
        d.pop(k, None)
    return json.dumps(d, sort_keys=True, default=str)


def _cached_grid(key, make):
    if key in _GRID_CACHE:
        _GRID_CACHE.move_to_end(key)
        return _GRID_CACHE[key]
    val = make()
    _GRID_CACHE[key] = val
    while len(_GRID_CACHE) > 24:
        _GRID_CACHE.popitem(last=False)
    return val


def _grid_geometry(prep: Prepared, o: ToneOptions):
    out_w, out_h = prep.out_size(o)
    cell = max(1.0, o.grain_mm * o.dpi / 25.4)
    return out_w, cell, int(math.ceil(out_w / cell)), int(math.ceil(out_h / cell))


def border_mask(xs, ys, o: ToneOptions, out_w: int, out_h: int):
    """Edge knockout in global print coordinates: (soft 0..1 multiplier for ink, keep bool).
    Soft fades go through the halftone (dots shrink), so the print stays strictly on/off."""
    shape = (len(ys), len(xs))
    if o.border == "none":
        return None, None
    X = np.asarray(xs, np.float64)[None, :]
    Y = np.asarray(ys, np.float64)[:, None]
    W, H = float(out_w), float(out_h)
    w = max(1.0, o.border_mm * o.dpi / 25.4)
    ax = np.minimum(X, W - X) + 0 * Y       # distance to the left/right edges
    ay = np.minimum(Y, H - Y) + 0 * X       # distance to the top/bottom edges
    if o.border_shape == "oval":
        nx, ny = (X - W / 2) / (W / 2), (Y - H / 2) / (H / 2)
        r = np.sqrt(nx * nx + ny * ny)
        d = (1 - r) * min(W, H) / 2
        s_along = np.arctan2(ny, nx) * (W + H) / 4   # position along the edge (for the wire)
    else:
        d = np.minimum(ax, ay)
        if o.border_shape == "rounded":
            R = min(W, H) * 0.15
            corner = (ax < R) & (ay < R)
            d = np.where(corner, R - np.hypot(R - ax, R - ay), d)
        s_along = np.where(ax < ay, Y + 0 * X, X + 0 * Y)
    d = d.astype(np.float32)
    seed = o.seed * 104729 + 7
    soft = np.ones(shape, np.float32)
    keep = d > 0
    sm = lambda t: (lambda c: c * c * (3 - 2 * c))(np.clip(t, 0, 1))  # noqa: E731
    if o.border == "fade":
        soft = sm(d / w)
    elif o.border == "grunge":
        n = noise.fbm(xs, ys, w * 0.45, seed, 5)
        n2 = noise.fbm(xs, ys, max(w * 0.08, 0.8), seed + 1, 3)
        dd = d + w * (0.9 * (n - 0.5) + 0.35 * (n2 - 0.5))
        soft = sm((dd - 0.15 * w) / (0.6 * w))
        keep &= dd > 0.1 * w
    elif o.border == "torn":
        n = noise.fbm(xs, ys, w * 0.3, seed, 5)
        n2 = noise.fbm(xs, ys, max(w * 0.04, 0.8), seed + 2, 2)
        keep &= (d + w * 0.5 * (n - 0.5) + w * 0.12 * (n2 - 0.5)) > w * 0.35
    elif o.border == "storm":
        ns = noise.fbm(xs, ys, w * 0.5, seed, 4, stretch=7.0)   # wind streaks
        nf = noise.fbm(xs, ys, max(w * 0.07, 0.8), seed + 3, 3)
        dd = d + w * 1.1 * (ns - 0.5) + w * 0.3 * (nf - 0.5)
        soft = sm((dd - 0.1 * w) / (0.8 * w))
        specks = noise.fbm(xs, ys, max(w * 0.03, 0.8), seed + 4, 2) > 1 - 0.18 * np.clip(1 - d / (1.5 * w), 0, 1)
        keep &= (dd > 0) & ~specks
    elif o.border == "barbwire":
        t = max(1.5, w * 0.035)              # wire thickness
        c = w * 0.55                         # wire runs this far in from the edge
        amp, period, barb_gap, barb = w * 0.08, w * 0.5, w * 0.9, w * 0.15
        wave = amp * np.sin(2 * np.pi * s_along / period)
        strand1 = np.abs(d - c - wave) < t
        strand2 = np.abs(d - c + wave) < t
        u = np.mod(s_along, barb_gap) - barb_gap / 2
        v = d - c
        barbs = (np.hypot(u, v) < barb) & ((np.abs(u - v) < t) | (np.abs(u + v) < t))
        keep &= (d > c - amp - 3 * t) & ~strand1 & ~strand2 & ~barbs
    if o.border in ("grunge", "storm"):   # the noise never lets the art's straight edge show through
        soft = soft * sm(d / (0.3 * w))
        keep &= d > 0.06 * w
    return soft.astype(np.float32), keep


def _diffusion_grid(prep: Prepared, o: ToneOptions, fit, plates: list, p: Plate):
    """Error diffusion runs once over the whole print on a grid of grain-sized cells, so every view of
    the print (preview, loupe, export strips) reads the same dots."""
    key = ("diff", prep.token, _opts_key(o), p.src, p.underbase, p.choke_mm,
           tuple((q.src, q.on, q.underbase) for q in plates))

    def make():
        out_w, cell, GW, GH = _grid_geometry(prep, o)
        rgb, a = _sample(prep, 0, 0, GW, GH, cell, out_w)
        covs = [_shape_dots(c, o) for c in _coverages(rgb, a, prep, o, fit)]
        soft, keep = border_mask((np.arange(GW) + 0.5) * cell, (np.arange(GH) + 0.5) * cell, o, out_w,
                                 prep.out_size(o)[1])
        if soft is not None:
            covs = [c * soft * keep for c in covs]
        cov = _underbase(covs, plates, o) if p.underbase else _choke(covs[p.src], p.choke_mm, o)
        return hybrid.error_diffuse(cov, o.style).astype(bool), cell
    return _cached_grid(key, make)


def _index_grids(prep: Prepared, o: ToneOptions, fit, plates: list) -> dict:
    """Index colour: every grain cell gets exactly one ink (or the shirt) by colour error diffusion."""
    key = ("index", prep.token, _opts_key(o))

    def make():
        out_w, cell, GW, GH = _grid_geometry(prep, o)
        rgb, a = _sample(prep, 0, 0, GW, GH, cell, out_w)
        t = _tone(rgb, o)
        shirt = np.array(_hex(o.garment), np.float32) / 255
        soft, keep = border_mask((np.arange(GW) + 0.5) * cell, (np.arange(GH) + 0.5) * cell, o, out_w,
                                 prep.out_size(o)[1])
        if soft is not None:   # fade toward the shirt colour, cut where the border knocks out
            t = t * soft[..., None] + shirt * (1 - soft[..., None])
            a = a * keep
        cols = [np.array(c, np.float32) / 255 if c is not None else shirt for c in fit.spot] + [shirt]
        style = o.style if o.style in DIFFUSION_STYLES else "fs"
        idx = hybrid.error_diffuse_palette(t, a, np.array(cols), style)
        grids = {i: (idx == i) for i, c in enumerate(fit.spot) if c is not None}
        base = np.zeros_like(idx, dtype=bool)
        for g in grids.values():
            base |= g
        r = int(round(o.choke_mm * o.dpi / 25.4 / cell))
        if r > 0 and base.any():
            base = cv2.erode(base.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)).astype(bool)
        grids["base"] = base
        return {k: (v, cell) for k, v in grids.items()}
    return _cached_grid(key, make)


def _lookup(G: np.ndarray, cell: float, xs, ys) -> np.ndarray:
    ix = np.floor(np.asarray(xs) / cell).astype(np.int64)
    iy = np.floor(np.asarray(ys) / cell).astype(np.int64)
    okx = (ix >= 0) & (ix < G.shape[1])
    oky = (iy >= 0) & (iy < G.shape[0])
    out = G[np.clip(iy, 0, G.shape[0] - 1)[:, None], np.clip(ix, 0, G.shape[1] - 1)[None, :]]
    return out & oky[:, None] & okx[None, :]


def composite(bitmaps: list[np.ndarray], plates: list[Plate], blend: str, o: ToneOptions,
              float_out: bool = False):
    """Stack the plates into straight-alpha RGBA. Alpha is strictly on/off."""
    h, w = bitmaps[0].shape if bitmaps else (1, 1)
    alpha = np.zeros((h, w), bool)
    if blend == "multiply":
        rgb = np.ones((h, w, 3), np.float32)
        for b, p in zip(bitmaps, plates):
            if not p.on:
                continue
            if not p.underbase:  # the underbase is white: it shows where no colour covers it
                rgb[b] *= np.array(p.rgb, np.float32) / 255.0
            alpha |= b
    else:
        rgb = np.zeros((h, w, 3), np.float32)
        for b, p in zip(bitmaps, plates):
            if not p.on:
                continue
            rgb[b] = np.array(p.rgb, np.float32) / 255.0
            alpha |= b
    if o.knockout:
        g = np.array(_hex(o.garment), np.float32) / 255.0
        alpha &= np.linalg.norm(rgb - g, axis=2) > 0.16
    rgb[~alpha] = 0
    if float_out:
        return rgb, alpha.astype(np.float32)
    return np.dstack([(rgb * 255 + 0.5).astype(np.uint8), alpha.astype(np.uint8) * 255])


def render_preview(prep: Prepared, o: ToneOptions, max_px: int = 900,
                   region: tuple | None = None, texture_images: dict | None = None):
    """Screen-sized preview, or a 1:1 crop of the real print pixels when ``region`` is given.

    Returns (rgba uint8, plates, bitmaps-at-grid-resolution).
    """
    out_w, out_h = prep.out_size(o)
    fit = resolve_fit(prep, o)
    plates, blend = plate_specs(prep, o, fit)
    _misregistration(plates, o)
    if region:
        x0, y0, w, h = (int(round(v)) for v in region)
        w = max(1, min(w, LOUPE_MAX))
        h = max(1, min(h, LOUPE_MAX))
        bm = render_plates(prep, o, x0, y0, w, h, 1.0, plates, texture_images, fit)
        return composite(bm, plates, blend, o), plates, bm
    scale = min(1.0, max_px / max(out_w, out_h))
    ss = 1.5 if scale < 1 else 1
    step = 1.0 / (scale * ss)
    gw = max(1, round(out_w / step))
    gh = max(1, round(out_h / step))
    bm = render_plates(prep, o, 0, 0, gw, gh, step, plates, texture_images, fit)
    rgb, a = composite(bm, plates, blend, o, float_out=True)
    pw, ph = max(1, round(out_w * scale)), max(1, round(out_h * scale))
    if (pw, ph) != (gw, gh):
        pm = cv2.resize(rgb * a[..., None], (pw, ph), interpolation=cv2.INTER_AREA)
        a = cv2.resize(a, (pw, ph), interpolation=cv2.INTER_AREA)
        rgb = pm / np.maximum(a, 1e-4)[..., None]
    rgba = np.dstack([np.clip(rgb * 255 + 0.5, 0, 255).astype(np.uint8),
                      np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8)])
    return rgba, plates, bm


def render_full(prep: Prepared, o: ToneOptions, texture_images: dict | None = None,
                keep_plates: bool = False, strip: int = 384):
    """Full-resolution print in horizontal strips (seamless: patterns are global)."""
    out_w, out_h = prep.out_size(o)
    if out_w * out_h > MAX_OUTPUT_PX:
        raise ImageError(f"That print would be {out_w} x {out_h} px. Lower the width or DPI "
                         f"(limit {MAX_OUTPUT_PX // 1_000_000} megapixels).")
    fit = resolve_fit(prep, o)
    plates, blend = plate_specs(prep, o, fit)
    _misregistration(plates, o)
    rgba = np.zeros((out_h, out_w, 4), np.uint8)
    seps = [np.zeros((out_h, out_w), bool) for _ in plates] if keep_plates else None
    for y0 in range(0, out_h, strip):
        h = min(strip, out_h - y0)
        bm = render_plates(prep, o, 0, y0, out_w, h, 1.0, plates, texture_images, fit)
        rgba[y0:y0 + h] = composite(bm, plates, blend, o)
        if seps is not None:
            for s, b in zip(seps, bm):
                s[y0:y0 + h] = b
    return rgba, plates, seps


# ----------------------------------------------------------------- report


def report(prep: Prepared, o: ToneOptions, plates: list[Plate], bitmaps: list[np.ndarray]) -> dict:
    out_w, out_h = prep.out_size(o)
    tgt = TARGETS[o.target]
    ppm = o.dpi / 25.4
    warnings: list[dict] = []
    info: dict = {
        "pixels": [out_w, out_h],
        "inches": [round(out_w / o.dpi, 2), round(out_h / o.dpi, 2)],
        "cm": [round(out_w / o.dpi * 2.54, 1), round(out_h / o.dpi * 2.54, 1)],
        "dpi": o.dpi,
        "megapixels": round(out_w * out_h / 1e6, 1),
        "target": tgt["label"],
        "binary_alpha": True,
    }
    solid = o.mode == "threshold" and o.threshold_soft <= 0
    if o.mode == "threshold":
        info["thresholds"] = [round(c, 3) for c in resolve_fit(prep, o).cuts]
    if solid:
        info["solid"] = True   # solid tones: no dots to hold, nothing to check about screens
    elif o.style in AM_STYLES and o.mode != "index":
        cell = o.dpi / o.lpi
        levels = int(cell * cell) + 1
        info["cell_px"] = round(cell, 2)
        info["tone_levels"] = min(levels, 256)
        if cell < 4:
            warnings.append({"level": "error", "text": f"{o.lpi:g} LPI at {o.dpi} DPI leaves only {levels} tone "
                             "levels, so gradients will band. Raise DPI or lower LPI.",
                             "fix": {"dpi": min(1200, int(math.ceil(o.lpi * 6 / 50) * 50))}})
        elif cell < 6:
            warnings.append({"level": "warn", "text": f"Only {levels} tone levels at this LPI/DPI. "
                             "Fine for bold art; raise DPI for smooth photos."})
        lo, hi = tgt["lpi"]
        if not lo <= o.lpi <= hi:
            warnings.append({"level": "warn",
                             "text": f"{tgt['label']} usually holds {lo}-{hi} LPI. {o.lpi:g} LPI may "
                             + ("fill in or wash out." if o.lpi > hi else "look very coarse (fine if that's the look)."),
                             "fix": {"lpi": float(min(max(o.lpi, lo), hi))}})
        dot_mm = (25.4 / o.lpi) * math.sqrt(max(o.min_dot, 1e-6) * 4 / math.pi) if o.min_dot > 0 else 0
        info["smallest_dot_mm"] = round(dot_mm, 3)
        if o.min_dot <= 0:
            warnings.append({"level": "warn", "text": "No minimum dot: the tiniest highlight dots may not "
                             f"hold on {tgt['label']}.", "fix": {"min_dot": _min_dot_for(o, tgt)}})
        elif dot_mm < tgt["min_dot_mm"]:
            warnings.append({"level": "warn", "text": f"Smallest dot is {dot_mm:.2f} mm; {tgt['label']} reliably "
                             f"holds about {tgt['min_dot_mm']} mm. Tiny dots may wash out or not stick.",
                             "fix": {"min_dot": _min_dot_for(o, tgt)}})
    else:
        g = o.grain_mm
        info["grain_mm"] = g
        if g < tgt["min_dot_mm"] * 0.8:
            warnings.append({"level": "warn", "text": f"Grain of {g:.2f} mm is finer than {tgt['label']} "
                             f"reliably holds (about {tgt['min_dot_mm']} mm).",
                             "fix": {"grain_mm": tgt["min_dot_mm"]}})
        if g * ppm < 1.5:
            warnings.append({"level": "warn", "text": "Grain is under 2 pixels at this DPI; raise DPI or grain."})
    if o.dpi < 200 and o.target != "paper":
        warnings.append({"level": "warn", "text": f"{o.dpi} DPI is low for garment printing; 300 is standard.",
                         "fix": {"dpi": 300}})

    any_ink = np.zeros_like(bitmaps[0]) if bitmaps else None
    inks = []
    for p, b in zip(plates, bitmaps):
        inks.append({"name": p.name, "label": p.label, "hex": to_hex(p.rgb), "angle": round(p.angle % 180, 1),
                     "coverage": round(float(b.mean()) * 100, 1), "underbase": p.underbase,
                     "on": p.on, "choke_mm": p.choke_mm})
        if not p.underbase:
            any_ink |= b
    info["ink_area_pct"] = round(float(any_ink.mean()) * 100, 1) if any_ink is not None else 0
    if o.target == "dtf" and info["ink_area_pct"] > 60:
        warnings.append({"level": "info", "text": "Lots of solid film: the transfer will feel heavy. "
                         "More halftone (lower max dot, or a worn texture) makes it lighter and more breathable."})
    garment = _hex(o.garment)
    fit = resolve_fit(prep, o)
    info["fit"] = {"mode": fit.mode, "notes": fit.notes, "underbase": fit.underbase,
                   "photo_like": prep.photo_like}
    if o.shirt_fit == "off":
        for ink in inks:
            if np.linalg.norm(np.array(_hex(ink["hex"])) - garment) < 40 and not o.knockout and not ink["underbase"]:
                warnings.append({"level": "info", "text": f"{ink['name']} is almost the shirt colour. "
                                 "Turn on Fit to shirt to fix it automatically.", "fix": {"shirt_fit": "auto"}})
                break
    elif fit.mode == "tones" and o.mode == "mono":
        lost = _lost_to_shirt(prep, o, fit)
        if lost > 0.4:
            warnings.append({"level": "warn", "text": f"{round(lost * 100)}% of the picture is darker than this "
                             "shirt, so it blends into the shirt. Recolor prints it as ink instead.",
                             "fix": {"shirt_fit": "recolor"}})
    if (o.mode in ("cmyk", "spot", "duotone") and _lum(garment) < 0.6 and not fit.underbase
            and o.underbase != "off"):
        warnings.append({"level": "warn", "text": "Colours print dull and dark straight onto a dark shirt. "
                         "A white underbase underneath keeps them bright.", "fix": {"underbase": "on"}})
    info["inks"] = inks
    info["warnings"] = warnings
    return info


def _lost_to_shirt(prep: Prepared, o: ToneOptions, fit: Fit) -> float:
    """Share of the art that needs 'negative ink' on this shirt (and so vanishes into it)."""
    src = prep.level(max(1.0, prep.src_w / 300))
    a = src[..., 3]
    sel = a > 0.5
    if not sel.any():
        return 0.0
    rgb = src[..., :3][sel] / a[sel][:, None]
    light = _tone(_luma(rgb), o)
    li, lg = _lum(fit.inks[0]), _lum(_hex(o.garment))
    c = (light - lg) / (li - lg)
    return float((c < 0.02).mean())


def _min_dot_for(o: ToneOptions, tgt: dict) -> float:
    cell_mm = 25.4 / o.lpi
    need = math.pi * (tgt["min_dot_mm"] / cell_mm) ** 2 / 4
    return round(min(0.5, max(0.02, need)), 3)
