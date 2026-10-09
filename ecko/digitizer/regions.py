"""Split the color map into sewable regions and decide each one's stitch type.

For every connected area of one color we measure how wide it is (from the
distance transform along its skeleton):
  * very thin   -> running / bean stitch along the centre line
  * narrow      -> satin column (smooth, shiny; text and borders)
  * wide        -> tatami fill
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from shapely.geometry import Polygon
from shapely.validation import make_valid
from skimage.morphology import skeletonize


RUN_MAX_MM = 1.0  # thinner than this is a line, not an area


@dataclass
class Region:
    color: int
    polygon: object  # shapely (Multi)Polygon in mm, design orientation (y down)
    mask: np.ndarray  # cropped bool mask
    offset: tuple[int, int]  # (x, y) of mask origin in working pixels
    px_per_mm: float
    origin_mm: tuple[float, float]  # where working pixel (0, 0) sits, in mm
    width_mm: float  # typical column width (median along skeleton)
    width90_mm: float  # 90th percentile width
    area_mm2: float
    id: int = -1
    source: str = "image"  # "image" or "text"
    layer: int | None = None  # text layer index
    _branches: list | None = field(default=None, repr=False)

    def default_kind(self, satin_max_mm: float) -> str:
        if self.width_mm < RUN_MAX_MM and self.width90_mm < RUN_MAX_MM * 1.5:
            return "run"
        if self.width90_mm <= satin_max_mm:
            return "satin"
        return "fill"

    @property
    def branches(self) -> list:
        """Centre lines in mm, computed on first use (only satin/run need them)."""
        if self._branches is None:
            dist = cv2.distanceTransform(self.mask.astype(np.uint8), cv2.DIST_L2, 5)
            self._branches = _branches_mm(self.mask, dist, *self.offset, self.px_per_mm, self.origin_mm)
        return self._branches


def _contours_to_polygon(mask: np.ndarray, ox: int, oy: int, ppm: float, origin=(0.0, 0.0)):
    contours, hier = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return None
    hier = hier[0]
    gx, gy = origin

    def mm(c):
        return [((p[0][0] + ox + 0.5) / ppm + gx, (p[0][1] + oy + 0.5) / ppm + gy) for p in c]

    polys = []
    for i, c in enumerate(contours):
        if hier[i][3] != -1 or len(c) < 3:
            continue
        holes = []
        child = hier[i][2]
        while child != -1:
            if len(contours[child]) >= 3:
                holes.append(mm(contours[child]))
            child = hier[child][0]
        polys.append(Polygon(mm(c), holes))
    if not polys:
        return None
    geom = polys[0]
    for p in polys[1:]:
        geom = geom.union(p)
    # Contours run through pixel centres, so the outline is half a pixel
    # inside the true edge; push it back out, then smooth pixel stair-steps.
    geom = make_valid(geom).buffer(0.5 / ppm, join_style=2).simplify(0.6 / ppm)
    return geom if not geom.is_empty else None

def skeleton_paths(skel: np.ndarray) -> list[list[tuple[int, int]]]:
    """Trace a 1-px skeleton into polylines (lists of (row, col))."""
    pts = set(zip(*np.nonzero(skel)))
    if not pts:
        return []
    nbrs = {}
    for r, c in pts:
        nb = []
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if (dr or dc) and (r + dr, c + dc) in pts:
                    nb.append((r + dr, c + dc))
        nbrs[(r, c)] = nb
    nodes = {p for p, nb in nbrs.items() if len(nb) != 2}
    seen_edges = set()
    paths = []

    def walk(start, nxt):
        path = [start, nxt]
        seen_edges.add((start, nxt))
        seen_edges.add((nxt, start))
        prev, cur = start, nxt
        while cur not in nodes:
            cand = [n for n in nbrs[cur] if n != prev and (cur, n) not in seen_edges]
            if not cand:
                break
            n = cand[0]
            seen_edges.add((cur, n))
            seen_edges.add((n, cur))
            path.append(n)
            prev, cur = cur, n
            if cur == start:
                break
        return path

    for node in nodes:
        for n in nbrs[node]:
            if (node, n) not in seen_edges:
                paths.append(walk(node, n))
    # Closed loops with no end/junction (e.g. the letter O)
    for p in pts:
        for n in nbrs[p]:
            if (p, n) not in seen_edges:
                nodes.add(p)
                paths.append(walk(p, n))
                nodes.discard(p)
    return [p for p in paths if len(p) >= 2]


def _branches_mm(mask: np.ndarray, dist: np.ndarray, ox: int, oy: int, ppm: float, origin=(0.0, 0.0)) -> list:
    skel = skeletonize(mask)
    paths = skeleton_paths(skel)
    if len(paths) > 1:
        # Prune short spurs that skeletonize grows into corners.
        deg = {}
        for p in paths:
            for end in (p[0], p[-1]):
                deg[end] = deg.get(end, 0) + 1
        kept = []
        for p in paths:
            free_end = deg[p[0]] == 1 or deg[p[-1]] == 1
            junction = p[0] if deg[p[0]] > 1 else p[-1]
            radius = dist[junction]
            if free_end and len(p) < 1.6 * radius and len(paths) > 1:
                continue
            kept.append(p)
        paths = kept or paths
    out = []
    for p in paths:
        pts = [((c + ox + 0.5) / ppm + origin[0], (r + oy + 0.5) / ppm + origin[1], dist[r, c] / ppm)
               for r, c in p]
        out.append(pts)
    return out


def extract_regions(labels: np.ndarray, ppm: float, origin_mm=(0.0, 0.0), source: str = "image",
                    layer: int | None = None) -> list[Region]:
    """One Region per connected area of each label (labels < 0 are empty)."""
    regions: list[Region] = []
    for color in sorted(int(c) for c in np.unique(labels) if c >= 0):
        mask_all = (labels == color).astype(np.uint8)
        n, comp, stats, _ = cv2.connectedComponentsWithStats(mask_all, connectivity=8)
        for c in range(1, n):
            x, y, w, h, area = stats[c]
            pad = 2
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(mask_all.shape[1], x + w + pad), min(mask_all.shape[0], y + h + pad)
            mask = comp[y0:y1, x0:x1] == c
            poly = _contours_to_polygon(mask, x0, y0, ppm, origin_mm)
            if poly is None or poly.area < 0.05:
                continue
            dist = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
            skel = skeletonize(mask)
            widths = 2.0 * dist[skel] / ppm if skel.any() else np.array([2.0 * dist.max() / ppm])
            regions.append(Region(
                color=color, polygon=poly, mask=mask, offset=(x0, y0), px_per_mm=ppm,
                origin_mm=tuple(origin_mm), width_mm=float(np.median(widths)),
                width90_mm=float(np.percentile(widths, 90)), area_mm2=area / ppm / ppm,
                source=source, layer=layer,
            ))
    return regions
