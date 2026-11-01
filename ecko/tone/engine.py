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

import math
from dataclasses import dataclass, field, fields
from functools import lru_cache

import cv2
import numpy as np

from .. import arctext
from ..digitizer import text as lettering
from ..digitizer.preprocess import ImageError, _find_palette, _lab_to_rgb, _resize_max, _to_lab, load_image
from . import noise

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
}
AM_STYLES = ("round", "euclid", "ellipse", "square", "diamond", "line", "cross")
GRAIN_STYLES = ("fm", "xerox", "mezzotint")

MODES = {
    "mono": "One ink",
    "duotone": "Two inks (duotone)",
    "cmyk": "CMYK process",
    "spot": "Spot colours (screen-print separations)",
}

# size_mm is the feature size at scale 1.0
TEXTURES = {
    "worn": {"label": "Worn print", "size_mm": 7.0, "adds_ink": False},
    "cracked": {"label": "Cracked ink", "size_mm": 9.0, "adds_ink": False},
    "grunge": {"label": "Grunge blotches", "size_mm": 6.0, "adds_ink": False},
    "paper": {"label": "Paper fibres", "size_mm": 2.5, "adds_ink": False},
    "scratches": {"label": "Scratches", "size_mm": 30.0, "adds_ink": False},
    "toner": {"label": "Toner specks (adds ink)", "size_mm": 1.5, "adds_ink": True},
    "image": {"label": "Your texture image", "size_mm": 100.0, "adds_ink": False},
}

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

MAX_OUTPUT_PX = 120_000_000
MAX_SOURCE_SIDE = 5000
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

    # Settings that change the prepared source (the slow step).
    def prepare_key(self) -> tuple:
        text = tuple(tuple(sorted(t.items())) for t in self.text)
        return (self.remove_background, round(float(self.bg_tolerance), 2), round(float(self.sharpen), 3),
                self.mode == "spot" and int(self.spot_colors), text,
                text and _text_work_width(self))


_RANGES = {
    "width_in": (0.5, 60), "dpi": (72, 1200), "lpi": (3, 200), "angle": (-360, 360),
    "grain_mm": (0.02, 5), "spot_colors": (2, 8), "spot_softness": (1, 60),
    "brightness": (-1, 1), "contrast": (-1, 1), "gamma": (0.2, 5),
    "black_point": (0, 0.95), "white_point": (0.05, 1), "sharpen": (0, 3),
    "min_dot": (0, 0.5), "max_dot": (0.5, 1), "dot_gain": (0, 0.4), "roughness": (0, 1),
    "misregister_mm": (0, 5), "bg_tolerance": (1, 80), "seed": (0, 2**31 - 1), "choke_mm": (0, 1),
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
        setattr(o, name, int(v) if name in ("dpi", "spot_colors", "seed") else v)
    if o.white_point <= o.black_point + 0.02:
        raise ValueError("The white point must be above the black point.")
    for name, table in (("mode", MODES), ("style", STYLES), ("target", TARGETS), ("shirt_fit", SHIRT_FITS),
                        ("underbase", {"auto": 1, "on": 1, "off": 1})):
        if getattr(o, name) not in table:
            raise ValueError(f"Unknown {name}: {getattr(o, name)!r}")
    for name in ("invert", "remove_background", "knockout", "registration_marks"):
        setattr(o, name, bool(getattr(o, name)))
    if not isinstance(o.inks, list) or not 1 <= len(o.inks) <= 8:
        raise ValueError("Give between 1 and 8 ink colours.")
    for ink in o.inks:
        _hex(ink)
    if o.mode == "duotone" and len(o.inks) < 2:
        raise ValueError("Duotone needs two ink colours.")
    _hex(o.garment)
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
        clean.append({"type": t["type"], "strength": strength, "scale": scale,
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
            raise ValueError("Each ink edit is {ink name: {on, choke_mm}}.")
        unknown = set(e) - {"on", "choke_mm"}
        if unknown:
            raise ValueError(f"Unknown ink settings: {', '.join(sorted(unknown))}")
        try:
            choke = float(e.get("choke_mm", 0.0))
        except (TypeError, ValueError) as exc:
            raise ValueError("Ink choke must be a number.") from exc
        if not (math.isfinite(choke) and -0.5 <= choke <= 0.5):
            raise ValueError("Ink choke must be between -0.5 and 0.5 mm.")
        out[name] = {"on": bool(e.get("on", True)), "choke_mm": round(choke, 4)}
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

    pm = np.dstack([rgb * alpha[..., None], alpha]).astype(np.float32)
    prep = Prepared(rgba=np.ascontiguousarray(pm), src_w=rgb.shape[1], src_h=rgb.shape[0],
                    crop=(round(crop_xy[0] * back), round(crop_xy[1] * back),
                          round(crop_wh[0] * back), round(crop_wh[1] * back)),
                    photo_like=photo)

    if o.mode == "spot":
        sel = alpha > 0.5
        pix = (rgb[sel] * 255).astype(np.uint8)
        if len(pix) > 200_000:
            pix = pix[np.random.default_rng(0).choice(len(pix), 200_000, replace=False)]
        centers = _find_palette(pix, int(o.spot_colors))
        order = np.argsort(-centers[:, 0])  # light inks first, dark inks print on top
        prep.palette_lab = centers[order]
        prep.palette = _lab_to_rgb(prep.palette_lab)
    return prep


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


def _lum(rgb) -> float:
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255.0


def _lab1(rgb) -> np.ndarray:
    return cv2.cvtColor(np.array([[rgb]], np.float32) / 255, cv2.COLOR_RGB2LAB)[0, 0]


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
    if o.mode == "spot":
        pal = prep.palette or []
        base = [_hex(c) for c in o.inks] if len(o.inks) == len(pal) else list(pal)
        glab = _lab1(g)
        for i, c in enumerate(base):
            close = mode != "off" and float(np.linalg.norm(_lab1(c) - glab)) < 14
            if close and mode == "tones":
                fit.spot.append(None)
                fit.notes.append(f"Spot {i + 1} ({to_hex(c)}) matches the shirt, so the shirt shows through instead.")
            elif close:
                new = contrast_ink(g)
                fit.spot.append(new)
                fit.notes.append(f"Spot {i + 1} ({to_hex(c)}) matches the shirt, so it prints in {name(new)}.")
            else:
                fit.spot.append(c)
    if o.mode == "cmyk":
        printed = [c for _, c, _ in PROCESS_INKS]
    elif o.mode == "spot":
        printed = [c for c in fit.spot if c is not None]
    else:
        printed = fit.inks[:2 if o.mode == "duotone" else 1]
    fit.underbase = o.underbase == "on" or (
        o.underbase == "auto" and o.target == "screen" and lg < 0.6 and any(_lum(c) < 0.85 for c in printed))
    if fit.underbase and o.underbase == "auto":
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
        plates, blend = [Plate(n, c, o.angle + a, src=i) for i, (n, c, a) in enumerate(PROCESS_INKS)], "multiply"
    else:
        plates = [Plate(f"Spot {i + 1}", c, o.angle + 30 * i, src=i) for i, c in enumerate(fit.spot) if c is not None]
        blend = "opaque"
    if fit.underbase:
        plates.insert(0, Plate("White underbase", (255, 255, 255), o.angle + 7.5, src=-1, underbase=True,
                               choke_mm=o.choke_mm))
    for p in plates:
        e = o.ink_edits.get(p.name)
        if e:
            p.on = e["on"]
            if not p.underbase:
                p.choke_mm = e["choke_mm"]
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
    if o.mode == "cmyk":
        adj = _tone(rgb, o)
        cmy = 1 - adj
        k = cmy.min(axis=2) * 0.85
        inv = np.maximum(1 - k, 1e-4)[..., None]
        cmy = np.clip((cmy - k[..., None]) / inv, 0, 1)
        return [cmy[..., 0] * a, cmy[..., 1] * a, cmy[..., 2] * a, k * a]
    centers = prep.palette_lab
    if fit.mode == "tones":  # the shirt is a free extra "ink"
        centers = np.vstack([centers, _lab1(_hex(o.garment))[None, :]])
    lab = cv2.cvtColor(rgb.astype(np.float32), cv2.COLOR_RGB2LAB)
    d2 = ((lab[..., None, :] - centers[None, None, :, :]) ** 2).sum(-1)
    w = np.exp(-(d2 - d2.min(-1, keepdims=True)) / (2 * o.spot_softness ** 2))
    w /= w.sum(-1, keepdims=True)
    return [w[..., i] * a for i in range(len(prep.palette_lab))]


def _underbase(covs: list[np.ndarray], plates: list[Plate], o: ToneOptions) -> np.ndarray:
    """White base under every ink, shrunk ("choked") so it never peeks out past the colour."""
    m = None
    for p in plates:
        if not p.underbase and p.on:
            m = covs[p.src] if m is None else np.maximum(m, covs[p.src])
    if m is None:
        return np.zeros_like(covs[0]) if covs else np.zeros(1, np.float32)
    return _choke(m, o.choke_mm, o)


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
        u = (u - np.floor(u) - 0.5).astype(np.float32)
        v = (v - np.floor(v) - 0.5).astype(np.float32)
        T = np.interp(_spot(o.style, u, v), _spot_quantiles(o.style),
                      np.linspace(0, 1, 1025)).astype(np.float32)
        if o.roughness > 0:
            r = max(cell * 0.3, 1.5)
            T = T + o.roughness * 0.35 * (noise.value_noise(xs, ys, r, r, seed + 71) - 0.5)
        return np.clip(T, 0.0005, 0.9995)

    g = max(o.grain_mm * ppm, 0.5)
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
        elif kind == "image":
            tex = (texture_images or {}).get(t.get("image_id"))
            if tex is None:
                continue
            th, tw = tex.shape
            tile_px = base  # one tile is 100 mm wide at scale 1
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
    out_w, _ = prep.out_size(o)
    xs = x0 + (np.arange(gw) + 0.5) * step
    ys = y0 + (np.arange(gh) + 0.5) * step
    samples: dict[tuple, list[np.ndarray]] = {}
    result = []
    for i, p in enumerate(plates):
        if p.shift not in samples:
            rgb, a = _sample(prep, x0, y0, gw, gh, step, out_w, *p.shift)
            samples[p.shift] = [_shape_dots(c, o) for c in _coverages(rgb, a, prep, o, fit)]
        if not p.on:
            result.append(np.zeros((gh, gw), bool))
            continue
        covs = samples[p.shift]
        cov = _underbase(covs, plates, o) if p.underbase else _choke(covs[p.src], p.choke_mm, o)
        # seed by ink, not list position, so adding an underbase never changes the other plates
        T = threshold(xs - p.shift[0], ys - p.shift[1], o, p.angle, o.seed * 31 + (p.src if p.src >= 0 else 97))
        result.append(cov > T)
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
                result[inks[-1]] |= add & alpha_any & ~remove
    return result


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
    if o.style in AM_STYLES:
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
        inks.append({"name": p.name, "hex": to_hex(p.rgb), "angle": round(p.angle % 180, 1),
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
