"""Turn an uploaded picture into a clean map of thread colors.

Steps: decode -> find the thread colors (k-means in Lab space) -> drop the
background -> crop to the artwork -> scale to the requested stitch size ->
label every pixel with a thread color -> remove anti-aliasing slivers and
specks too small to sew.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import cv2
import numpy as np
from PIL import Image, ImageOps

# Working resolution: up to 10 px per mm (0.1 mm, the resolution of the
# machine file formats themselves), capped so large designs stay fast.
MAX_PX_PER_MM = 10.0
MAX_WORKING_PX = 1800


@dataclass
class ColorMap:
    labels: np.ndarray  # (H, W) int32, -1 = no stitches
    palette: list[tuple[int, int, int]]  # RGB per label
    px_per_mm: float
    width_mm: float
    height_mm: float


class ImageError(ValueError):
    pass


def load_image(data: bytes) -> np.ndarray:
    """Decode any common image format to an RGBA uint8 array."""
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img)
        img = img.convert("RGBA")
    except Exception as exc:  # PIL raises many types
        raise ImageError("That file isn't an image we can read. Try PNG or JPG.") from exc
    arr = np.array(img)
    if arr.shape[0] < 16 or arr.shape[1] < 16:
        raise ImageError("The image is too small. Upload at least 200 x 200 pixels.")
    return arr


def _to_lab(rgb: np.ndarray) -> np.ndarray:
    lab = cv2.cvtColor(rgb.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB)
    lab = lab.reshape(-1, 3).astype(np.float32)
    # OpenCV scales L to 0..255; bring it back to 0..100 so distances are deltaE-ish
    lab[:, 0] *= 100.0 / 255.0
    lab[:, 1:] -= 128.0
    return lab


def _resize_max(arr: np.ndarray, max_side: int) -> np.ndarray:
    h, w = arr.shape[:2]
    s = max_side / max(h, w)
    if s >= 1:
        return arr
    return cv2.resize(arr, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)


def _composite_white(rgba: np.ndarray) -> np.ndarray:
    a = rgba[..., 3:4].astype(np.float32) / 255.0
    rgb = rgba[..., :3].astype(np.float32) * a + 255.0 * (1 - a)
    return rgb.astype(np.uint8)


def _find_palette(rgb_pixels: np.ndarray, n_colors: int | None) -> np.ndarray:
    """k-means in Lab. With n_colors=None, over-cluster then merge look-alikes."""
    lab = _to_lab(rgb_pixels)
    k = n_colors or 12
    k = max(1, min(k, len(np.unique(lab, axis=0))))
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.5)
    _, labels, centers = cv2.kmeans(lab, k, None, criteria, 4, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    counts = np.bincount(labels, minlength=k).astype(np.float64)
    centers = centers.astype(np.float64)

    if n_colors is None:
        # Merge clusters that a viewer wouldn't tell apart (deltaE < 14) and
        # fold tiny clusters (< 0.4% of pixels, usually anti-aliasing) into
        # their nearest neighbour.
        alive = list(range(k))
        changed = True
        while changed and len(alive) > 1:
            changed = False
            best = None
            for i in alive:
                for j in alive:
                    if j <= i:
                        continue
                    d = np.linalg.norm(centers[i] - centers[j])
                    small = min(counts[i], counts[j]) / counts.sum() < 0.004
                    if d < 14 or (small and d < 40):
                        if best is None or d < best[0]:
                            best = (d, i, j)
            if best:
                _, i, j = best
                tot = counts[i] + counts[j]
                centers[i] = (centers[i] * counts[i] + centers[j] * counts[j]) / tot
                counts[i] = tot
                counts[j] = 0
                alive.remove(j)
                changed = True
        # Anti-aliasing and JPEG blur create "in-between" colors along edges
        # (e.g. dark red between red and black). Drop small clusters that sit
        # on the line between two bigger ones.
        total = counts.sum()
        for i in sorted(alive, key=lambda x: counts[x]):
            if counts[i] / total > 0.06 or len(alive) <= 2:
                continue
            others = [j for j in alive if j != i and counts[j] > counts[i]]
            for a in others:
                for b in others:
                    if b <= a:
                        continue
                    ab = centers[b] - centers[a]
                    t = float(np.dot(centers[i] - centers[a], ab) / max(np.dot(ab, ab), 1e-9))
                    off = np.linalg.norm(centers[a] + t * ab - centers[i])
                    if 0.1 < t < 0.9 and off < 10:
                        alive.remove(i)
                        break
                if i not in alive:
                    break
        centers = centers[alive]
    return centers.astype(np.float32)


def _assign(lab: np.ndarray, centers: np.ndarray) -> np.ndarray:
    out = np.empty(len(lab), dtype=np.int32)
    step = 400_000
    for s in range(0, len(lab), step):
        chunk = lab[s:s + step]
        d = ((chunk[:, None, :] - centers[None, :, :]) ** 2).sum(-1)
        out[s:s + step] = d.argmin(1)
    return out


def _lab_to_rgb(centers: np.ndarray) -> list[tuple[int, int, int]]:
    lab = centers.copy()
    lab[:, 0] *= 255.0 / 100.0
    lab[:, 1:] += 128.0
    lab = np.clip(lab, 0, 255).astype(np.uint8).reshape(-1, 1, 3)
    rgb = cv2.cvtColor(lab, cv2.COLOR_LAB2RGB).reshape(-1, 3)
    return [tuple(int(v) for v in c) for c in rgb]


def _mode_filter(labels: np.ndarray, n: int, ksize: int) -> np.ndarray:
    """Majority vote in a ksize window. Removes 1-2 px anti-alias fringes."""
    if ksize < 3:
        return labels
    votes = np.zeros((n + 1,) + labels.shape, dtype=np.float32)
    for i in range(-1, n):
        votes[i + 1] = cv2.boxFilter((labels == i).astype(np.float32), -1, (ksize, ksize), normalize=False)
    return votes.argmax(0).astype(np.int32) - 1


def _remove_specks(labels: np.ndarray, min_area_px: int) -> np.ndarray:
    """Reassign connected pieces smaller than min_area_px to their neighbour."""
    kernel = np.ones((3, 3), np.uint8)
    for _ in range(2):
        changed = False
        for lab in np.unique(labels):
            mask = (labels == lab).astype(np.uint8)
            n, comp, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
            for c in range(1, n):
                if stats[c, cv2.CC_STAT_AREA] >= min_area_px:
                    continue
                x, y, w, h = stats[c, :4]
                x0, y0 = max(0, x - 2), max(0, y - 2)
                x1, y1 = min(labels.shape[1], x + w + 2), min(labels.shape[0], y + h + 2)
                piece = (comp[y0:y1, x0:x1] == c).astype(np.uint8)
                ring = cv2.dilate(piece, kernel) - piece
                neigh = labels[y0:y1, x0:x1][ring.astype(bool)]
                neigh = neigh[neigh != lab]
                if len(neigh) == 0:
                    continue
                vals, cnts = np.unique(neigh, return_counts=True)
                labels[y0:y1, x0:x1][piece.astype(bool)] = vals[cnts.argmax()]
                changed = True
        if not changed:
            break
    return labels


def _touching_border(mask: np.ndarray) -> np.ndarray:
    n, comp = cv2.connectedComponents(mask.astype(np.uint8), connectivity=4)
    edge = np.unique(np.concatenate([comp[0], comp[-1], comp[:, 0], comp[:, -1]]))
    edge = edge[edge != 0]
    return np.isin(comp, edge)


def build_color_map(
    data: bytes,
    width_mm: float | None = None,
    height_mm: float | None = None,
    n_colors: int | None = None,
    remove_background: bool = True,
    detail: float = 0.5,
) -> ColorMap:
    """detail 0..1: higher keeps smaller features (and more stitches)."""
    rgba = load_image(data)

    # 1. Palette from a small copy (fast and stable).
    small = _resize_max(rgba, 500)
    alpha_small = small[..., 3] >= 128
    has_alpha = (~alpha_small).mean() > 0.01
    rgb_small = _composite_white(small)
    pix = rgb_small[alpha_small] if has_alpha else rgb_small.reshape(-1, 3)
    if len(pix) == 0:
        raise ImageError("The image is completely transparent.")
    centers = _find_palette(pix, n_colors + (0 if has_alpha or not remove_background else 1) if n_colors else None)

    # 2. Background: transparency, else the color owning most of the border.
    lab_small = _assign(_to_lab(rgb_small.reshape(-1, 3)), centers).reshape(small.shape[:2])
    bg_label = None
    if remove_background and not has_alpha:
        border = np.concatenate([lab_small[0], lab_small[-1], lab_small[:, 0], lab_small[:, -1]])
        vals, cnts = np.unique(border, return_counts=True)
        if cnts.max() / len(border) > 0.5:
            bg_label = int(vals[cnts.argmax()])

    fg_small = np.ones(small.shape[:2], bool)
    if has_alpha:
        fg_small &= alpha_small
    if bg_label is not None:
        fg_small &= ~_touching_border(lab_small == bg_label)
    if not fg_small.any():
        raise ImageError("We couldn't find any artwork once the background was removed. "
                         "Try turning off background removal.")

    # 3. Crop the full-size image to the artwork.
    ys, xs = np.nonzero(fg_small)
    sy = rgba.shape[0] / small.shape[0]
    sx = rgba.shape[1] / small.shape[1]
    y0 = max(0, int((ys.min() - 1) * sy))
    y1 = min(rgba.shape[0], int((ys.max() + 2) * sy))
    x0 = max(0, int((xs.min() - 1) * sx))
    x1 = min(rgba.shape[1], int((xs.max() + 2) * sx))
    crop = rgba[y0:y1, x0:x1]
    ch, cw = crop.shape[:2]

    # 4. Physical size.
    aspect = ch / cw
    if width_mm:
        w_mm, h_mm = float(width_mm), float(width_mm) * aspect
    elif height_mm:
        w_mm, h_mm = float(height_mm) / aspect, float(height_mm)
    else:
        w_mm = 100.0
        h_mm = w_mm * aspect
    ppm = min(MAX_PX_PER_MM, MAX_WORKING_PX / max(w_mm, h_mm))
    out_w, out_h = max(8, round(w_mm * ppm)), max(8, round(h_mm * ppm))
    interp = cv2.INTER_AREA if out_w < cw else cv2.INTER_CUBIC
    work = cv2.resize(crop, (out_w, out_h), interpolation=interp)

    # 5. Label pixels. Light smoothing first so JPEG noise doesn't speckle.
    rgb = _composite_white(work)
    rgb = cv2.bilateralFilter(rgb, 7, 40, 7)
    labels = _assign(_to_lab(rgb.reshape(-1, 3)), centers).reshape(out_h, out_w)
    if has_alpha:
        labels[work[..., 3] < 128] = -1
    if bg_label is not None:
        # Only background that connects to the edge: white lettering inside a
        # badge is artwork, not background.
        labels[_touching_border(labels == bg_label)] = -1

    # 6. Clean-up scaled by physical size: fringes ~0.3 mm, specks by detail.
    k = max(3, int(round(0.3 * ppm)) | 1)
    labels = _mode_filter(labels, len(centers), k)
    min_feature_mm2 = 0.3 + (1.0 - detail) * 2.5
    labels = _remove_specks(labels, int(min_feature_mm2 * ppm * ppm))

    # Honour an exact color count: the background color can reappear inside
    # the artwork (white text on a badge), so merge the least-used colors.
    if n_colors:
        while True:
            counts = np.bincount(labels[labels >= 0].ravel(), minlength=len(centers))
            live = [i for i in range(len(centers)) if counts[i] > 0]
            if len(live) <= n_colors:
                break
            i = min(live, key=lambda x: counts[x])
            j = min((x for x in live if x != i), key=lambda x: np.linalg.norm(centers[x] - centers[i]))
            labels[labels == i] = j

    # Compact the palette to colors that survived.
    used = [i for i in range(len(centers)) if (labels == i).any()]
    remap = np.full(len(centers) + 1, -1, np.int32)
    for new, old in enumerate(used):
        remap[old + 1] = new
    labels = remap[labels + 1]
    palette = _lab_to_rgb(centers[used]) if used else []
    if not used:
        raise ImageError("No stitchable artwork found in this image.")

    return ColorMap(labels=labels, palette=palette, px_per_mm=ppm, width_mm=w_mm, height_mm=h_mm)
