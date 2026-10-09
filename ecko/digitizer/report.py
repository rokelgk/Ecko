"""Plain-language quality check, so problems show up before the needle does.

Reviews of auto-digitizers keep repeating the same failures: thread breaks
from over-dense spots, details too small to sew, designs that don't fit the
hoop, and nobody telling you until a garment is ruined. We check for each of
those and say what to do about it.
"""

from __future__ import annotations

import math

import numpy as np

from .regions import Region

MM_PER_IN = 25.4
DENSE_PENETRATIONS_PER_MM2 = 14  # above this, needle and thread start to suffer


def _hotspots(design) -> tuple[int, list[tuple[float, float]]]:
    pts = np.concatenate([np.asarray(r) for b in design.blocks for r in b.runs])
    cells = np.floor(pts).astype(np.int64)
    keys, counts = np.unique(cells, axis=0, return_counts=True)
    hot = keys[counts > DENSE_PENETRATIONS_PER_MM2]
    if len(hot) == 0:
        return 0, []
    # Report the worst few cluster centres.
    worst = keys[np.argsort(-counts)[:5]]
    return len(hot), [(float(x) + 0.5, float(y) + 0.5) for x, y in worst]


def build_report(design, regions: list[Region]) -> dict:
    stitches = design.stitch_points()
    trims = sum(len(b.runs) - 1 for b in design.blocks) + max(0, len(design.blocks) - 1)
    color_changes = len(design.blocks) - 1
    multi = design.brand.needles == "multi"
    spm = design.brand.stitches_per_minute
    seconds = stitches / spm * 60 + trims * 6 + color_changes * (8 if multi else 40)

    warnings: list[dict] = []
    tips: list[str] = [design.fabric.tip]

    hw, hh = design.hoop.width_mm, design.hoop.height_mm
    w, h = design.width_mm, design.height_mm
    fits = w <= hw and h <= hh
    fits_rotated = w <= hh and h <= hw
    if not fits:
        if fits_rotated:
            warnings.append({"level": "error", "code": "hoop_rotate",
                             "message": f"The design is {w:.0f} x {h:.0f} mm and doesn't fit your "
                                        f"{design.hoop.name} hoop as it is, but it fits rotated 90°."})
        else:
            scale = min(hw / w, hh / h)
            warnings.append({"level": "error", "code": "hoop_too_small",
                             "message": f"The design is {w:.0f} x {h:.0f} mm, larger than your "
                                        f"{design.hoop.name} hoop. Scale it to {w * scale:.0f} mm wide "
                                        f"or pick a bigger hoop.",
                             "suggested_width_mm": round(w * scale * 0.97, 1)})

    thin = [r for r in regions if r.kind == "satin" and r.width_mm < 1.2]
    lines = [r for r in regions if r.kind == "run"]
    if thin:
        warnings.append({"level": "warn", "code": "thin_columns",
                         "message": f"{len(thin)} part(s) are narrower than 1.2 mm. Small lettering "
                                    f"and fine lines sew best at least 5 mm tall; consider making the "
                                    f"design larger."})
    if lines:
        warnings.append({"level": "info", "code": "lines",
                         "message": f"{len(lines)} very thin line(s) will sew as running/bean stitch."})

    n_hot, where = _hotspots(design)
    if n_hot:
        warnings.append({"level": "warn", "code": "dense",
                         "message": f"{n_hot} small spot(s) have heavy stitch build-up where layers "
                                    f"overlap. Lower the density a little if you see thread breaks.",
                         "where": where})
    if stitches > 60000:
        warnings.append({"level": "warn", "code": "big",
                         "message": f"{stitches:,} stitches is a lot. Large filled areas sew stiff; "
                                    f"try a lower density or a bigger hoop with less fill."})
    if len(design.blocks) > 12 and not multi:
        warnings.append({"level": "info", "code": "colors",
                         "message": f"{len(design.blocks)} thread changes on a single-needle machine. "
                                    f"Reduce colors to save time."})

    stats = {
        "stitches": stitches,
        "colors": len(design.blocks),
        "color_changes": color_changes,
        "trims": trims,
        "width_mm": round(w, 1),
        "height_mm": round(h, 1),
        "width_in": round(w / MM_PER_IN, 2),
        "height_in": round(h / MM_PER_IN, 2),
        "sew_minutes": max(1, math.ceil(seconds / 60)),
        "fits_hoop": fits,
        "objects": {k: sum(1 for r in regions if r.kind == k) for k in ("fill", "satin", "run")},
    }
    errors = sum(1 for x in warnings if x["level"] == "error")
    warns = sum(1 for x in warnings if x["level"] == "warn")
    score = max(0, 100 - errors * 40 - warns * 10)
    return {"stats": stats, "warnings": warnings, "tips": tips, "score": score}
