"""One-click digitizing: picture in, sewable design out."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from ..fabrics import Fabric, get_fabric
from ..machines import Brand, Hoop, get_brand, get_model
from . import stitches as st
from .preprocess import build_color_map
from .regions import Region, extract_regions
from .threads import thread_name, to_hex

CONNECT_MAX_MM = 2.0  # gaps shorter than this are stitched over, longer ones trim
TIE_MM = 0.7
MIN_STEP_MM = 0.3


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


@dataclass
class ColorBlock:
    rgb: tuple[int, int, int]
    name: str
    runs: list[list[tuple[float, float]]]
    kinds: dict[str, int] = field(default_factory=dict)


@dataclass
class Design:
    blocks: list[ColorBlock]
    width_mm: float
    height_mm: float
    options: Options
    brand: Brand
    fabric: Fabric
    hoop: Hoop
    report: dict = field(default_factory=dict)

    def stitch_points(self) -> int:
        return sum(len(r) for b in self.blocks for r in b.runs)


# ------------------------------------------------------------ planning


def _color_order(regions: list[Region], n_colors: int) -> list[int]:
    stats = []
    for c in range(n_colors):
        rs = [r for r in regions if r.color == c]
        if not rs:
            continue
        area = sum(r.area_mm2 for r in rs)
        fill_area = sum(r.area_mm2 for r in rs if r.kind == "fill")
        # Big fills go down first, satin details and outlines sew on top.
        stats.append((-(fill_area / area) if area else 0, -area, c))
    return [c for *_, c in sorted(stats)]


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
    from shapely.geometry import Point
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


def _region_runs(reg: Region, fabric: Fabric, opts: Options, overlap: float, cur):
    density = max(0.5, min(2.0, opts.density))
    pull = fabric.pull_comp_mm
    underlay = opts.underlay or fabric.underlay
    if reg.kind == "fill":
        poly = reg.polygon.buffer(pull + overlap, join_style=1)
        angle = st.best_fill_angle(reg.polygon)
        under = st.fill_underlay(reg.polygon, angle, underlay, cur) if underlay != "none" else []
        start = under[-1][-1] if under else cur
        top = st.fill(poly, angle, fabric.fill_spacing_mm / density, fabric.fill_stitch_mm, start)
        return st._join(under + top, poly)
    if reg.kind == "satin":
        poly = reg.polygon.buffer(pull + overlap * 0.5, join_style=1)
        return st.satin(poly, reg.branches, reg.width90_mm, fabric.satin_spacing_mm / density,
                        fabric.max_satin_mm * 1.6 + 2 * pull, cur)
    return st.running(reg.polygon, reg.branches, reg.width_mm, cur)


def _resolve_hoop(brand: Brand, opts: Options) -> Hoop:
    if opts.hoop_width_mm and opts.hoop_height_mm:
        return Hoop("custom", "Custom hoop", float(opts.hoop_width_mm), float(opts.hoop_height_mm))
    model = get_model(brand, opts.model)
    for h in model.hoops:
        if h.id == opts.hoop:
            return h
    return max(model.hoops, key=lambda h: h.width_mm * h.height_mm)


def digitize(image: bytes, opts: Options) -> Design:
    brand = get_brand(opts.brand)
    fabric = get_fabric(opts.fabric)
    hoop = _resolve_hoop(brand, opts)

    cmap = build_color_map(image, opts.width_mm, opts.height_mm, opts.colors,
                           opts.remove_background, max(0.0, min(1.0, opts.detail)))
    regions = extract_regions(cmap, fabric.max_satin_mm)
    order = _color_order(regions, len(cmap.palette))
    center = (cmap.width_mm / 2, cmap.height_mm / 2)

    blocks: list[ColorBlock] = []
    cur = None
    for i, color in enumerate(order):
        overlap = 0.25 if i < len(order) - 1 else 0.0
        regs = [r for r in regions if r.color == color]
        runs = []
        kinds: dict[str, int] = {}
        for reg in _order_regions(regs, cur, fabric, center):
            new = [r for r in _region_runs(reg, fabric, opts, overlap, cur) if len(r) >= 2]
            if not new:
                continue
            kinds[reg.kind] = kinds.get(reg.kind, 0) + 1
            for r in new:
                r = _clean(r)
                if runs and math.dist(runs[-1][-1], r[0]) <= CONNECT_MAX_MM:
                    runs[-1].extend(r)
                else:
                    runs.append(r)
            cur = runs[-1][-1]
        runs = [_with_ties(r) for r in runs if len(r) >= 2]
        if runs:
            rgb = cmap.palette[color]
            blocks.append(ColorBlock(rgb, thread_name(rgb), runs, kinds))

    if not blocks:
        raise ValueError("Nothing in this image could be turned into stitches.")

    # Centre the design on the hoop origin, like every machine expects.
    allp = np.concatenate([np.asarray(r) for b in blocks for r in b.runs])
    mn, mx = allp.min(0), allp.max(0)
    c = (mn + mx) / 2
    for b in blocks:
        b.runs = [[(p[0] - c[0], p[1] - c[1]) for p in r] for r in b.runs]

    design = Design(blocks, float(mx[0] - mn[0]), float(mx[1] - mn[1]), opts, brand, fabric, hoop)
    from .report import build_report
    design.report = build_report(design, regions)
    return design


def preview(design: Design) -> dict:
    return {
        "width_mm": round(design.width_mm, 1),
        "height_mm": round(design.height_mm, 1),
        "hoop": {"name": design.hoop.name, "width_mm": design.hoop.width_mm,
                 "height_mm": design.hoop.height_mm},
        "blocks": [
            {
                "color": to_hex(b.rgb),
                "name": b.name,
                "kinds": b.kinds,
                "stitches": sum(len(r) for r in b.runs),
                "runs": [[round(v, 2) for p in r for v in p] for r in b.runs],
            }
            for b in design.blocks
        ],
    }
