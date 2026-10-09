"""Stitch generators: tatami fill, satin columns, running/bean lines, underlay.

All coordinates are millimetres. Every generator returns a list of *runs*:
each run is a list of (x, y) needle points sewn one after another. A new
run means "move without sewing" and the planner decides whether that needs
a trim.
"""

from __future__ import annotations

import math

import numpy as np
from shapely import affinity
from shapely.geometry import LineString, MultiPolygon, Point, Polygon

Pt = tuple[float, float]
Run = list[Pt]

TRAVEL_STITCH_MM = 2.5
MAX_RING_TRAVEL_MM = 25.0
MIN_STITCH_MM = 0.4


def _lines(geom):
    if geom.is_empty:
        return []
    t = geom.geom_type
    if t == "LineString":
        return [geom]
    if t in ("MultiLineString", "GeometryCollection"):
        out = []
        for g in geom.geoms:
            out.extend(_lines(g))
        return out
    return []


def _polys(geom) -> list[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    if hasattr(geom, "geoms"):
        out = []
        for g in geom.geoms:
            out.extend(_polys(g))
        return out
    return []


def resample(coords, step: float, include_start: bool = True) -> list[Pt]:
    line = LineString(coords)
    length = line.length
    if length < 1e-6:
        return [tuple(coords[0])] if include_start else []
    n = max(1, int(math.ceil(length / step)))
    pts = [line.interpolate(length * i / n) for i in range(0 if include_start else 1, n + 1)]
    return [(p.x, p.y) for p in pts]


def _dist(a: Pt, b: Pt) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ---------------------------------------------------------------- travel


def travel(geom, p: Pt, q: Pt) -> list[Pt] | None:
    """Stitched path from p to q that stays inside geom, or None (jump)."""
    if _dist(p, q) < 0.05:
        return []
    seg = LineString([p, q])
    if geom.buffer(0.15).contains(seg):
        return resample([p, q], TRAVEL_STITCH_MM, include_start=False)
    inner = geom.buffer(-0.3)
    ring_geom = inner if not inner.is_empty else geom
    best = None
    pp, qp = Point(p), Point(q)
    for poly in _polys(ring_geom):
        for ring in [poly.exterior, *poly.interiors]:
            d = ring.distance(pp) + ring.distance(qp)
            if best is None or d < best[0]:
                best = (d, ring)
    if best is None or best[0] > 2.0:
        return None
    ring = LineString(best[1].coords)
    total = ring.length
    a, b = ring.project(pp), ring.project(qp)
    fwd = (b - a) % total
    back = (a - b) % total
    span, sign = (fwd, 1) if fwd <= back else (back, -1)
    if span > MAX_RING_TRAVEL_MM:
        return None
    n = max(1, int(math.ceil(span / TRAVEL_STITCH_MM)))
    pts = []
    for i in range(1, n + 1):
        pt = ring.interpolate((a + sign * span * i / n) % total)
        pts.append((pt.x, pt.y))
    pts.append(q)
    return pts


# ---------------------------------------------------------------- fill


def _fill_rows(rpoly, spacing: float):
    minx, miny, maxx, maxy = rpoly.bounds
    rows = []
    y = miny + spacing / 2
    idx = 0
    while y < maxy:
        line = LineString([(minx - 1, y), (maxx + 1, y)])
        segs = []
        for g in _lines(line.intersection(rpoly)):
            xs = [c[0] for c in g.coords]
            if max(xs) - min(xs) >= 0.15:
                segs.append((min(xs), max(xs)))
        rows.append((idx, y, sorted(segs)))
        y += spacing
        idx += 1
    return rows


def _sections(rows):
    """Group row segments into blocks that can be sewn back-and-forth."""
    sections: list[list] = []
    open_: list[int] = []
    for idx, y, segs in rows:
        matches = []
        for s in segs:
            matches.append([si for si in open_ if sections[si][-1][2] < s[1] and s[0] < sections[si][-1][3]])
        counts: dict[int, int] = {}
        for m in matches:
            for si in m:
                counts[si] = counts.get(si, 0) + 1
        new_open = []
        for s, m in zip(segs, matches):
            if len(m) == 1 and counts[m[0]] == 1:
                sections[m[0]].append((idx, y, s[0], s[1]))
                new_open.append(m[0])
            else:
                sections.append([(idx, y, s[0], s[1])])
                new_open.append(len(sections) - 1)
        open_ = new_open
    return sections


def _row_points(x0, x1, y, row_idx, stitch_len, ltr) -> list[Pt]:
    # Tatami: needle points sit on a grid shifted every row so the holes
    # don't line up into visible lines.
    offset = (0.0, 0.5, 0.25, 0.75)[row_idx % 4] * stitch_len
    k0 = math.ceil((x0 - offset) / stitch_len)
    xs = [x0]
    k = k0
    while True:
        x = offset + k * stitch_len
        if x >= x1 - MIN_STITCH_MM:
            break
        if x > x0 + MIN_STITCH_MM:
            xs.append(x)
        k += 1
    xs.append(x1)
    if not ltr:
        xs.reverse()
    return [(x, y) for x in xs]


def _section_count(poly, angle, spacing) -> int:
    rpoly = affinity.rotate(poly, -angle, origin=(0, 0))
    return len(_sections(_fill_rows(rpoly, spacing)))


def best_fill_angle(poly) -> float:
    """Angle giving the fewest separate blocks (fewer travels and trims)."""
    candidates = [45.0, 135.0, 0.0, 90.0, 22.5, 67.5, 112.5, 157.5]
    best = None
    for a in candidates:
        n = _section_count(poly, a, 1.5)
        if best is None or n < best[0]:
            best = (n, a)
    return best[1]


def fill(poly, angle: float, spacing: float, stitch_len: float, start: Pt | None) -> list[Run]:
    rpoly = affinity.rotate(poly, -angle, origin=(0, 0))
    rows = _fill_rows(rpoly, spacing)
    sections = _sections(rows)
    if not sections:
        return []
    cos_a, sin_a = math.cos(math.radians(-angle)), math.sin(math.radians(-angle))

    def rot(p):  # world -> rotated frame
        return (p[0] * cos_a - p[1] * sin_a, p[0] * sin_a + p[1] * cos_a)

    def unrot(p):
        return (p[0] * cos_a + p[1] * sin_a, -p[0] * sin_a + p[1] * cos_a)

    cur = rot(start) if start else None
    remaining = list(range(len(sections)))
    runs: list[Run] = []
    run: Run = []
    while remaining:
        best = None
        for si in remaining:
            sec = sections[si]
            for rev in (False, True):
                first = sec[-1] if rev else sec[0]
                for ltr in (True, False):
                    p = (first[2], first[1]) if ltr else (first[3], first[1])
                    d = _dist(cur, p) if cur else 0.0
                    if best is None or d < best[0]:
                        best = (d, si, rev, ltr)
        _, si, rev, ltr = best
        remaining.remove(si)
        sec = sections[si][::-1] if rev else sections[si]
        pts: list[Pt] = []
        for k, (idx, y, x0, x1) in enumerate(sec):
            pts.extend(_row_points(x0, x1, y, idx, stitch_len, ltr if k % 2 == 0 else not ltr))
        if cur is not None and run:
            path = travel(rpoly, cur, pts[0])
            if path is None:
                runs.append(run)
                run = []
            else:
                run.extend(path[:-1])
        run.extend(pts)
        cur = pts[-1]
    if run:
        runs.append(run)
    return [[unrot(p) for p in r] for r in runs]


def fill_underlay(poly, angle: float, level: str, start: Pt | None) -> list[Run]:
    inset = poly.buffer(-0.5)
    if inset.is_empty or inset.area < 4.0:
        return []
    runs: list[Run] = []
    if level in ("medium", "heavy") and inset.area > 8.0:
        for p in _polys(inset):
            runs.append(resample(list(p.exterior.coords), 2.5))
    if inset.area > 15.0:
        spacing = {"light": 3.0, "medium": 2.2, "heavy": 2.0}[level]
        s = runs[-1][-1] if runs else start
        runs.extend(fill(inset, angle + 90, spacing, 3.0, s))
        if level == "heavy":
            runs.extend(fill(inset, angle, 2.5, 3.0, runs[-1][-1] if runs else s))
    return _join(runs, poly)


def _join(runs: list[Run], geom) -> list[Run]:
    """Merge consecutive runs when we can travel between them inside geom."""
    out: list[Run] = []
    for r in runs:
        if not r:
            continue
        if out:
            path = travel(geom, out[-1][-1], r[0])
            if path is not None:
                out[-1].extend(path[:-1])
                out[-1].extend(r)
                continue
        out.append(list(r))
    return out


# ---------------------------------------------------------------- satin


def _order_branches(branches, start: Pt | None):
    remaining = list(branches)
    cur = start
    ordered = []
    while remaining:
        best = None
        for i, b in enumerate(remaining):
            for rev in (False, True):
                p = b[-1] if rev else b[0]
                d = _dist(cur, (p[0], p[1])) if cur else 0.0
                if best is None or d < best[0]:
                    best = (d, i, rev)
        _, i, rev = best
        b = remaining.pop(i)
        b = b[::-1] if rev else b
        ordered.append(b)
        cur = (b[-1][0], b[-1][1])
    return ordered


def _free_ends(branches) -> set:
    ends: dict[tuple, int] = {}
    keys = []
    for b in branches:
        for p in (b[0], b[-1]):
            k = (round(p[0], 1), round(p[1], 1))
            keys.append(k)
            ends[k] = ends.get(k, 0) + 1
    return {k for k in keys if ends[k] == 1}


def _extend(b, free: set):
    """Push free ends of a centre line out by the local radius so the satin
    reaches the tip of the shape instead of stopping short."""
    xy = [(p[0], p[1]) for p in b]
    if len(xy) < 2:
        return xy
    for end in (0, -1):
        p = b[end]
        if (round(p[0], 1), round(p[1], 1)) not in free or p[2] <= 0:
            continue
        q = xy[min(3, len(xy) - 1)] if end == 0 else xy[max(-4, -len(xy))]
        dx, dy = p[0] - q[0], p[1] - q[1]
        n = math.hypot(dx, dy)
        if n < 1e-6:
            continue
        ext = (p[0] + dx / n * p[2], p[1] + dy / n * p[2])
        if end == 0:
            xy.insert(0, ext)
        else:
            xy.append(ext)
    return xy


def _smooth(xy, window: int):
    """Moving average that keeps the end points; removes skeleton jitter."""
    if len(xy) <= 2 or window < 2:
        return xy
    arr = np.asarray(xy, dtype=np.float64)
    closed = np.allclose(arr[0], arr[-1])
    out = arr.copy()
    for i in range(1, len(arr) - 1):
        lo, hi = max(0, i - window), min(len(arr), i + window + 1)
        out[i] = arr[lo:hi].mean(0)
    if closed:
        out[-1] = out[0]
    return [tuple(p) for p in out]


def _rails(line: LineString, poly, step: float, half: float, max_len: float):
    rails = []
    length = line.length
    n = max(1, int(length / step))
    for i in range(n + 1):
        d = length * i / n
        c = line.interpolate(d)
        p0 = line.interpolate(max(0.0, d - 1.0))
        p1 = line.interpolate(min(length, d + 1.0))
        tx, ty = p1.x - p0.x, p1.y - p0.y
        tn = math.hypot(tx, ty)
        if tn < 1e-9:
            continue
        nx, ny = -ty / tn, tx / tn
        chord = LineString([(c.x - nx * half, c.y - ny * half), (c.x + nx * half, c.y + ny * half)])
        pieces = _lines(chord.intersection(poly))
        if not pieces:
            continue
        piece = min(pieces, key=lambda g: g.distance(c))
        if piece.distance(c) > 0.3:
            continue
        a, b = piece.coords[0], piece.coords[-1]
        if (a[0] - c.x) * nx + (a[1] - c.y) * ny > 0:
            a, b = b, a
        span = _dist(a, b)
        if span < 0.25 or span > max_len:
            continue
        rails.append((a, b))
    return rails


def satin(poly, branches, width: float, spacing: float, max_len: float, start: Pt | None) -> list[Run]:
    free = _free_ends(branches)
    half = max(2.0, width * 1.2 + 1.0)
    runs: list[Run] = []
    for b in _order_branches(branches, start):
        xy = _smooth(_extend(b, free), 5)
        line = LineString(xy).simplify(0.1)
        if line.length < 0.3:
            continue
        rails = _rails(line, poly, spacing, half, max_len)
        if not rails:
            continue
        pts: list[Pt] = []
        if width >= 1.5:
            pts.extend(resample(list(line.coords), 2.0))  # centre-walk underlay
            if width >= 3.5:
                inner = []
                for a, bb in _rails(line, poly.buffer(-0.45), 2.0, half, max_len)[::-1]:
                    inner.extend([a, bb])
                pts.extend(inner)  # zig-zag underlay back; top satin goes forward again
            else:
                rails = rails[::-1]  # top satin comes back over the underlay
        for a, bb in rails:
            pts.extend([a, bb])
        if runs:
            path = travel(poly, runs[-1][-1], pts[0])
            if path is not None:
                runs[-1].extend(path[:-1])
                runs[-1].extend(pts)
                continue
        runs.append(pts)
    return runs


# ---------------------------------------------------------------- running


def running(poly, branches, width: float, start: Pt | None) -> list[Run]:
    bean = width >= 0.6
    runs: list[Run] = []
    for b in _order_branches(branches, start):
        xy = [(p[0], p[1]) for p in b]
        line = LineString(xy).simplify(0.1)
        base = resample(list(line.coords), 2.0)
        if len(base) < 2:
            continue
        pts = [base[0]]
        for i in range(1, len(base)):
            if bean:
                pts.extend([base[i], base[i - 1], base[i]])
            else:
                pts.append(base[i])
        if runs:
            path = travel(poly.buffer(0.3), runs[-1][-1], pts[0])
            if path is not None:
                runs[-1].extend(path[:-1])
                runs[-1].extend(pts)
                continue
        runs.append(pts)
    return runs


def stitch_count(runs: list[Run]) -> int:
    return sum(len(r) for r in runs)


def centroid(geom) -> Pt:
    c = geom.centroid
    return (c.x, c.y)


def np_runs(runs: list[Run]) -> list[np.ndarray]:
    return [np.asarray(r, dtype=np.float64) for r in runs if r]
