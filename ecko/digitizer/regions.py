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

from .preprocess import ColorMap

RUN_MAX_MM = 1.0  # thinner than this is a line, not an area


@dataclass
class Region:
    color: int
    polygon: object  # shapely (Multi)Polygon in mm, image orientation (y down)
    mask: np.ndarray  # cropped bool mask
    offset: tuple[int, int]  # (x, y) of mask origin in working pixels
    px_per_mm: float
    width_mm: float  # typical column width (median along skeleton)
    width90_mm: float  # 90th percentile width
    area_mm2: float
    kind: str = "fill"
    branches: list = field(default_factory=list)  # centre lines in mm (satin/run)


def _contours_to_polygon(mask: np.ndarray, ox: int, oy: int, ppm: float):
    contours, hier = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hier is None:
        return None
    hier = hier[0]
    polys = []
    for i, c in enumerate(contours):
        if hier[i][3] != -1 or len(c) < 3:
            continue
        shell = [((p[0][0] + ox + 0.5) / ppm, (p[0][1] + oy + 0.5) / ppm) for p in c]
        holes = []
        child = hier[i][2]
        while child != -1:
            hc = contours[child]
            if len(hc) >= 3:
                holes.append([((p[0][0] + ox + 0.5) / ppm, (p[0][1] + oy + 0.5) / ppm) for p in hc])
            child = hier[child][0]
        poly = Polygon(shell, holes)
        polys.append(poly)
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


def _branches_mm(mask: np.ndarray, dist: np.ndarray, ox: int, oy: int, ppm: float) -> list:
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
        pts = [((c + ox + 0.5) / ppm, (r + oy + 0.5) / ppm, dist[r, c] / ppm) for r, c in p]
        out.append(pts)
    return out


def extract_regions(cmap: ColorMap, satin_max_mm: float) -> list[Region]:
    ppm = cmap.px_per_mm
    regions: list[Region] = []
    for color in range(len(cmap.palette)):
        mask_all = (cmap.labels == color).astype(np.uint8)
        n, comp, stats, _ = cv2.connectedComponentsWithStats(mask_all, connectivity=8)
        for c in range(1, n):
            x, y, w, h, area = stats[c]
            pad = 2
            x0, y0 = max(0, x - pad), max(0, y - pad)
            x1, y1 = min(mask_all.shape[1], x + w + pad), min(mask_all.shape[0], y + h + pad)
            mask = comp[y0:y1, x0:x1] == c
            poly = _contours_to_polygon(mask, x0, y0, ppm)
            if poly is None or poly.area < 0.05:
                continue
            dist = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
            skel = skeletonize(mask)
            widths = 2.0 * dist[skel] / ppm if skel.any() else np.array([2.0 * dist.max() / ppm])
            width = float(np.median(widths))
            width90 = float(np.percentile(widths, 90))
            reg = Region(color, poly, mask, (x0, y0), ppm, width, width90, area / ppm / ppm)
            if width < RUN_MAX_MM and width90 < RUN_MAX_MM * 1.5:
                reg.kind = "run"
            elif width90 <= satin_max_mm:
                reg.kind = "satin"
            else:
                reg.kind = "fill"
            if reg.kind != "fill":
                reg.branches = _branches_mm(mask, dist, x0, y0, ppm)
                if not reg.branches:
                    reg.kind = "fill"
            regions.append(reg)
    return regions
