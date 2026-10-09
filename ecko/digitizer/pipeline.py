"""One-click digitizing: picture (and/or text) in, sewable design out.

Two stages so edits are instant:
  analyze_image()  slow: colors, regions, widths        (cached per image)
  plan()           fast: stitch types, stitches, order   (re-run on every edit)
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np
from shapely.geometry import Point

from .. import threadcharts
from ..fabrics import Fabric, get_fabric
from ..machines import Brand, Hoop, get_brand, get_model
from . import stitches as st
from .preprocess import build_color_map
from .regions import Region, extract_regions
from .text import PX_PER_MM as TEXT_PPM
from .text import TextLayer, render_mask
from .threads import from_hex, to_hex

CONNECT_MAX_MM = 2.0  # gaps shorter than this are stitched over, longer ones trim
TIE_MM = 0.7
MIN_STEP_MM = 0.3
TEXT_GAP_MM = 4.0
MAX_SATIN_EDIT_MM = 12.0  # wider than this can't be satin even on request
KINDS = ("fill", "satin", "run")

# Options that change the image analysis (everything else only re-plans).
ANALYSIS_KEYS = ("width_mm", "height_mm", "colors", "remove_background", "detail")


@dataclass
class Options:
    brand: str = "brother"
    model: str | None = None
    hoop: str | None = None
    hoop_width_mm: float | None = None  # custom hoop
    hoop_height_mm: float | None = None
    fabric: str = "woven"
    width_mm: float | None = None
    height_mm: float | None = None
    colors: int | None = None  # None = automatic
    remove_background: bool = True
    detail: float = 0.5
    density: float = 1.0  # >1 = denser
    underlay: str | None = None  # override fabric underlay
    thread_chart: str | None = None  # None = the machine brand's own chart
    text: list = field(default_factory=list)  # list of TextLayer dicts

    def text_layers(self) -> list[TextLayer]:
        return [t if isinstance(t, TextLayer) else TextLayer(**t) for t in self.text]

    def analysis_key(self) -> tuple:
        return tuple(getattr(self, k) for k in ANALYSIS_KEYS)


@dataclass
class Edits:
    objects: dict = field(default_factory=dict)  # "id" -> {kind, angle, density, hidden}
    color_order: list = field(default_factory=list)  # palette indices, first sews first
    threads: dict = field(default_factory=dict)  # "palette index" -> {hex, name, code, brand}

    @classmethod
    def from_dict(cls, d: dict | None) -> "Edits":
        d = d or {}
        return cls(dict(d.get("objects") or {}), list(d.get("color_order") or []), dict(d.get("threads") or {}))


@dataclass
class ImageArt:
    regions: list[Region]
    palette: list[tuple[int, int, int]]
    width_mm: float
    height_mm: float


@dataclass
class Artwork:
    regions: list[Region]
    palette: list[tuple[int, int, int]]
    text_boxes: list[dict]  # per layer: x_mm, y_mm (centre), width_mm, height_mm


@dataclass
class ColorBlock:
    palette: list[int]  # palette indices merged into this block
    thread: threadcharts.Thread
    runs: list[list[tuple[float, float]]]
    kinds: dict[str, int] = field(default_factory=dict)

    @property
    def rgb(self) -> tuple[int, int, int]:
        return from_hex(self.thread.hex)

    @property
    def name(self) -> str:
        return self.thread.name


@dataclass
class Design:
    blocks: list[ColorBlock]
    width_mm: float
    height_mm: float
    options: Options
    brand: Brand
    fabric: Fabric
    hoop: Hoop
    artwork: Artwork
    kinds: dict[int, str]  # region id -> stitch type used
    offset: tuple[float, float]  # artwork mm -> centred design mm
    report: dict = field(default_factory=dict)

    def stitch_points(self) -> int:
        return sum(len(r) for b in self.blocks for r in b.runs)


# ------------------------------------------------------------ analysis


def analyze_image(image: bytes, opts: Options) -> ImageArt:
    cmap = build_color_map(image, opts.width_mm, opts.height_mm, opts.colors,
                           opts.remove_background, max(0.0, min(1.0, opts.detail)))
    regions = extract_regions(cmap.labels, cmap.px_per_mm)
    return ImageArt(regions, list(cmap.palette), cmap.width_mm, cmap.height_mm)


def build_artwork(image_art: ImageArt | None, layers: list[TextLayer]) -> Artwork:
    palette = list(image_art.palette) if image_art else []
    regions: list[Region] = list(image_art.regions) if image_art else []
    width = image_art.width_mm if image_art else 0.0
    cursor = (image_art.height_mm + TEXT_GAP_MM) if image_art else 0.0
    boxes = []
    for li, layer in enumerate(layers):
        layer.validate()
        mask = render_mask(layer)
        h, w = mask.shape
        size = (w / TEXT_PPM, h / TEXT_PPM)
        cx = layer.x_mm if layer.x_mm is not None else width / 2
        cy = layer.y_mm if layer.y_mm is not None else cursor + size[1] / 2
        if layer.y_mm is None:
            cursor += size[1] + TEXT_GAP_MM
        rgb = from_hex(layer.color)
        near = [i for i, c in enumerate(palette) if math.dist(c, rgb) < 40]
        if near:  # "black" text on a logo with near-black: same thread
            color = min(near, key=lambda i: math.dist(palette[i], rgb))
        else:
            palette.append(rgb)
            color = len(palette) - 1
        labels = np.where(mask, color, -1).astype(np.int32)
        origin = (cx - size[0] / 2, cy - size[1] / 2)
        regions.extend(extract_regions(labels, TEXT_PPM, origin, source="text", layer=li))
        boxes.append({"x_mm": cx, "y_mm": cy, "width_mm": size[0], "height_mm": size[1]})
    for i, r in enumerate(regions):
        r.id = i
    return Artwork(regions, palette, boxes)


# ------------------------------------------------------------ planning


def _color_order(regions: list[Region], kinds: dict[int, str], n_colors: int, requested: list) -> list[int]:
    present = sorted({r.color for r in regions})
    stats = []
    for c in present:
        rs = [r for r in regions if r.color == c]
        area = sum(r.area_mm2 for r in rs)
        fill_area = sum(r.area_mm2 for r in rs if kinds[r.id] == "fill")
        # Big fills go down first, satin details and outlines sew on top.
        stats.append((-(fill_area / area) if area else 0, -area, c))
    auto = [c for *_, c in sorted(stats)]
    order = [c for c in requested if c in auto]
    return order + [c for c in auto if c not in order]


def _clean(run, min_step=MIN_STEP_MM):
    out = []
    for p in run:
        if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= min_step:
            out.append((float(p[0]), float(p[1])))
    if len(out) == 1 and len(run) > 1:
        out.append((float(run[-1][0]), float(run[-1][1])))
    return out


def _tie(p, q):
    dx, dy = q[0] - p[0], q[1] - p[1]
    n = math.hypot(dx, dy) or 1.0
    t = (p[0] + dx / n * TIE_MM, p[1] + dy / n * TIE_MM)
    return [p, t, p, t, p]


def _with_ties(run):
    if len(run) < 2:
        return run
    return _tie(run[0], run[1]) + run[1:-1] + _tie(run[-1], run[-2])[::-1]


def _order_regions(regs: list[Region], cur, fabric: Fabric, center):
    if fabric.center_out:
        # Caps: centre column first, then outwards; bottom to top.
        return sorted(regs, key=lambda r: (abs(r.polygon.centroid.x - center[0]) // 10,
                                           -r.polygon.centroid.y))
    out, remaining = [], list(regs)
    while remaining:
        if cur is None:
            nxt = max(remaining, key=lambda r: r.area_mm2)
        else:
            p = Point(cur)
            nxt = min(remaining, key=lambda r: r.polygon.distance(p))
        remaining.remove(nxt)
        out.append(nxt)
        cur = st.centroid(nxt.polygon)
    return out


def _region_runs(reg: Region, kind: str, edit: dict, fabric: Fabric, opts: Options, overlap: float, cur):
    density = max(0.5, min(2.0, opts.density * float(edit.get("density") or 1.0)))
    pull = fabric.pull_comp_mm
    underlay = opts.underlay or fabric.underlay
    if kind == "fill":
        poly = reg.polygon.buffer(pull + overlap, join_style=1)
        angle = edit.get("angle")
        angle = float(angle) if angle is not None else st.best_fill_angle(reg.polygon)
        under = st.fill_underlay(reg.polygon, angle, underlay, cur) if underlay != "none" else []
        start = under[-1][-1] if under else cur
        top = st.fill(poly, angle, fabric.fill_spacing_mm / density, fabric.fill_stitch_mm, start)
        return st._join(under + top, poly)
    if kind == "satin":
        poly = reg.polygon.buffer(pull + overlap * 0.5, join_style=1)
        return st.satin(poly, reg.branches, reg.width90_mm, fabric.satin_spacing_mm / density,
                        max(fabric.max_satin_mm, reg.width90_mm) * 1.6 + 2 * pull, cur)
    return st.running(reg.polygon, reg.branches, reg.width_mm, cur)


def _resolve_hoop(brand: Brand, opts: Options) -> Hoop:
    if opts.hoop_width_mm and opts.hoop_height_mm:
        return Hoop("custom", "Custom hoop", float(opts.hoop_width_mm), float(opts.hoop_height_mm))
    model = get_model(brand, opts.model)
    for h in model.hoops:
        if h.id == opts.hoop:
            return h
    return max(model.hoops, key=lambda h: h.width_mm * h.height_mm)


def _kind_for(reg: Region, edit: dict, fabric: Fabric) -> str:
    kind = edit.get("kind") or reg.default_kind(fabric.max_satin_mm)
    if kind not in KINDS:
        kind = reg.default_kind(fabric.max_satin_mm)
    if kind == "satin" and reg.width90_mm > MAX_SATIN_EDIT_MM:
        kind = "fill"  # stitches this long would snag and loop
    if kind in ("satin", "run") and not reg.branches:
        kind = "fill"
    return kind


def plan(artwork: Artwork, opts: Options, edits: Edits | None = None) -> Design:
    edits = edits or Edits()
    brand = get_brand(opts.brand)
    fabric = get_fabric(opts.fabric)
    hoop = _resolve_hoop(brand, opts)
    chart = opts.thread_chart or threadcharts.default_chart(brand.id)

    obj_edits = {int(k): v for k, v in edits.objects.items()}
    visible = [r for r in artwork.regions if not obj_edits.get(r.id, {}).get("hidden")]
    if not visible:
        raise ValueError("Every object is hidden, so there's nothing to stitch.")
    kinds = {r.id: _kind_for(r, obj_edits.get(r.id, {}), fabric) for r in visible}
    order = _color_order(visible, kinds, len(artwork.palette), [int(c) for c in edits.color_order])

    xs = [r.polygon.bounds for r in visible]
    center = ((min(b[0] for b in xs) + max(b[2] for b in xs)) / 2,
              (min(b[1] for b in xs) + max(b[3] for b in xs)) / 2)
    blocks: list[ColorBlock] = []
    cur = None
    for i, color in enumerate(order):
        overlap = 0.25 if i < len(order) - 1 else 0.0
        regs = [r for r in visible if r.color == color]
        runs = []
        used: dict[str, int] = {}
        for reg in _order_regions(regs, cur, fabric, center):
            kind = kinds[reg.id]
            new = [r for r in _region_runs(reg, kind, obj_edits.get(reg.id, {}), fabric, opts, overlap, cur)
                   if len(r) >= 2]
            if not new:
                continue
            used[kind] = used.get(kind, 0) + 1
            for r in new:
                r = _clean(r)
                if runs and math.dist(runs[-1][-1], r[0]) <= CONNECT_MAX_MM:
                    runs[-1].extend(r)
                else:
                    runs.append(r)
            cur = runs[-1][-1]
        runs = [_with_ties(r) for r in runs if len(r) >= 2]
        if not runs:
            continue
        t = edits.threads.get(str(color))
        thread = (threadcharts.Thread(t["hex"].lower(), t.get("name") or "Custom", t.get("code") or "",
                                      t.get("brand") or "")
                  if t else threadcharts.nearest(chart, artwork.palette[color]))
        if blocks and blocks[-1].thread.hex == thread.hex:
            # Same thread twice in a row: no color change needed.
            blocks[-1].runs.extend(runs)
            blocks[-1].palette.append(color)
            for k, n in used.items():
                blocks[-1].kinds[k] = blocks[-1].kinds.get(k, 0) + n
        else:
            blocks.append(ColorBlock([color], thread, runs, used))

    if not blocks:
        raise ValueError("Nothing in this design could be turned into stitches.")

    # Centre the design on the hoop origin, like every machine expects.
    allp = np.concatenate([np.asarray(r) for b in blocks for r in b.runs])
    mn, mx = allp.min(0), allp.max(0)
    c = (mn + mx) / 2
    for b in blocks:
        b.runs = [[(p[0] - c[0], p[1] - c[1]) for p in r] for r in b.runs]

    design = Design(blocks, float(mx[0] - mn[0]), float(mx[1] - mn[1]), opts, brand, fabric, hoop,
                    artwork, kinds, (-float(c[0]), -float(c[1])))
    from .report import build_report
    design.report = build_report(design, [(r, kinds[r.id]) for r in visible], opts.text_layers())
    return design


def digitize(image: bytes | None, opts: Options, edits: Edits | None = None) -> Design:
    """Convenience: analyze + plan in one go."""
    art = analyze_image(image, opts) if image else None
    layers = opts.text_layers()
    if art is None and not layers:
        raise ValueError("Add a picture or some text to digitize.")
    return plan(build_artwork(art, layers), opts, edits)


# ------------------------------------------------------------ preview


def _rings(geom, dx, dy):
    out = []
    for poly in st._polys(geom.simplify(0.25)):
        for ring in [poly.exterior, *poly.interiors]:
            out.append([round(v, 2) for x, y in ring.coords for v in (x + dx, y + dy)])
    return out


def preview(design: Design) -> dict:
    dx, dy = design.offset
    art = design.artwork
    return {
        "width_mm": round(design.width_mm, 1),
        "height_mm": round(design.height_mm, 1),
        "offset": [round(dx, 3), round(dy, 3)],
        "hoop": {"name": design.hoop.name, "width_mm": design.hoop.width_mm,
                 "height_mm": design.hoop.height_mm},
        "blocks": [
            {
                "color": b.thread.hex,
                "name": b.thread.name,
                "code": b.thread.code,
                "brand": b.thread.brand,
                "palette": b.palette,
                "kinds": b.kinds,
                "stitches": sum(len(r) for r in b.runs),
                "runs": [[round(v, 2) for p in r for v in p] for r in b.runs],
            }
            for b in design.blocks
        ],
        "objects": [
            {
                "id": r.id,
                "color": r.color,
                "source": r.source,
                "layer": r.layer,
                "kind": design.kinds.get(r.id),
                "default_kind": r.default_kind(design.fabric.max_satin_mm),
                "hidden": r.id not in design.kinds,
                "satin_ok": r.width90_mm <= MAX_SATIN_EDIT_MM,
                "width_mm": round(r.width_mm, 2),
                "area_mm2": round(r.area_mm2, 1),
                "rings": _rings(r.polygon, dx, dy),
            }
            for r in art.regions
        ],
        "palette": [to_hex(c) for c in art.palette],
        "text_boxes": [{k: round(v + (dx if k == "x_mm" else dy if k == "y_mm" else 0), 2)
                        for k, v in b.items()} for b in art.text_boxes],
    }


def threads_used(design: Design) -> list[dict]:
    return [asdict(b.thread) for b in design.blocks]
