"""HTTP API for Ecko Tone. Mounted under /api/tone by ecko.app."""

from __future__ import annotations

import base64
import hashlib
import io
import json
import re
import threading
from collections import OrderedDict
from dataclasses import asdict

import numpy as np
from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile
from fastapi.responses import Response
from PIL import Image

from ..digitizer.preprocess import ImageError, load_image
from . import engine as E
from .export import png_bytes, separations_zip
from .presets import PRESETS

router = APIRouter(prefix="/api/tone")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_IMAGES = 48
MAX_PREPARED = 24
ID_RE = re.compile(r"^[0-9a-f]{32}$")

_lock = threading.Lock()
_images: OrderedDict[str, bytes] = OrderedDict()
_prepared: OrderedDict[tuple, E.Prepared] = OrderedDict()
_textures: OrderedDict[str, np.ndarray] = OrderedDict()


def _lru_put(cache: OrderedDict, key, value, limit: int) -> None:
    cache[key] = value
    cache.move_to_end(key)
    while len(cache) > limit:
        cache.popitem(last=False)


def _image(iid: str) -> bytes:
    if not isinstance(iid, str) or not ID_RE.match(iid):
        raise HTTPException(400, "Bad image id.")
    with _lock:
        data = _images.get(iid)
        if data is not None:
            _images.move_to_end(iid)
    if data is None:
        # The browser keeps the file and re-uploads on this status.
        raise HTTPException(410, "Image expired; upload it again.")
    return data


def _options(raw) -> E.ToneOptions:
    try:
        return E.parse_options(raw if isinstance(raw, dict) else {})
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc


def _prepare(iid: str, o: E.ToneOptions) -> E.Prepared:
    key = (iid, o.prepare_key())
    with _lock:
        prep = _prepared.get(key)
        if prep is not None:
            _prepared.move_to_end(key)
            return prep
    try:
        prep = E.prepare(_image(iid), o)
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    with _lock:
        _lru_put(_prepared, key, prep, MAX_PREPARED)
    return prep


def _texture_images(o: E.ToneOptions) -> dict:
    out = {}
    for t in o.textures:
        tid = t.get("image_id")
        if t["type"] != "image" or not tid:
            continue
        with _lock:
            arr = _textures.get(tid)
        if arr is None:
            rgba = load_image(_image(tid))
            a = rgba[..., 3:4].astype(np.float32) / 255
            lum = (rgba[..., :3].astype(np.float32) @ np.float32([0.299, 0.587, 0.114]))[..., None] / 255
            arr = (lum * a + (1 - a))[..., 0].astype(np.float32)  # transparent = no wear
            with _lock:
                _lru_put(_textures, tid, arr, 16)
        out[tid] = arr
    return out


def _safe_name(name: str | None) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "-", name or "").strip("-")[:40] or "ecko-tone"


# ----------------------------------------------------------------- routes


@router.get("/catalog")
def catalog():
    return {
        "styles": [{"id": k, "name": v, "grain": k in E.GRAIN_STYLES} for k, v in E.STYLES.items()],
        "modes": [{"id": k, "name": v} for k, v in E.MODES.items()],
        "textures": [{"id": k, "name": v["label"], "adds_ink": v["adds_ink"]} for k, v in E.TEXTURES.items()],
        "targets": [{"id": k, "name": v["label"], "lpi": list(v["lpi"]), "min_dot_mm": v["min_dot_mm"]}
                    for k, v in E.TARGETS.items()],
        "presets": PRESETS,
        "defaults": asdict(E.ToneOptions()),
        "limits": {"max_megapixels": E.MAX_OUTPUT_PX // 1_000_000, "loupe_max": E.LOUPE_MAX},
    }


@router.post("/images")
async def upload_image(file: UploadFile = File(...)):
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That file is over 25 MB.")
    try:
        rgba = load_image(data)
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    iid = hashlib.sha256(data).hexdigest()[:32]
    with _lock:
        _lru_put(_images, iid, data, MAX_IMAGES)
    return {"id": iid, "width": int(rgba.shape[1]), "height": int(rgba.shape[0])}


@router.post("/preview")
def preview(body: dict = Body(...)):
    o = _options(body.get("options"))
    prep = _prepare(body.get("image_id"), o)
    region = body.get("region")
    if region is not None:
        if not (isinstance(region, list) and len(region) == 4 and all(isinstance(v, (int, float)) for v in region)):
            raise HTTPException(400, "region is [x, y, width, height] in print pixels.")
    try:
        max_px = int(body.get("max_px", 900))
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "max_px must be a number.") from exc
    max_px = max(200, min(max_px, 1600))
    rgba, plates, bitmaps = E.render_preview(prep, o, max_px, region, _texture_images(o))
    rep = E.report(prep, o, plates, bitmaps)
    buf = io.BytesIO()
    Image.fromarray(rgba, "RGBA").save(buf, "PNG", compress_level=1)
    return {
        "image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "size": rep["pixels"],
        "report": rep,
        "palette": [E.to_hex(c) for c in prep.palette] if prep.palette else None,
    }


@router.post("/export")
def export(body: dict = Body(...)):
    o = _options(body.get("options"))
    fmt = body.get("format", "png")
    if fmt not in ("png", "zip"):
        raise HTTPException(400, "format is png or zip.")
    prep = _prepare(body.get("image_id"), o)
    name = _safe_name(body.get("name"))
    try:
        rgba, plates, seps = E.render_full(prep, o, _texture_images(o), keep_plates=fmt == "zip")
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    if fmt == "png":
        return Response(png_bytes(rgba, o.dpi), media_type="image/png",
                        headers={"Content-Disposition": f'attachment; filename="{name}.png"'})
    small = [s[::4, ::4] for s in seps]
    rep = E.report(prep, o, plates, small)
    return Response(separations_zip(rgba, seps, plates, o, name, rep), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}-separations.zip"'})


@router.post("/raw")
async def raw(request: Request, width: int, height: int, options: str = "{}"):
    """For the Photoshop panel: raw RGBA bytes in the body, raw RGBA out at the same pixel size.

    Raw bytes (not multipart) because UXP's networking is limited. The panel sends the
    document resolution as ``dpi`` so the output lines up 1:1 with the layer.
    """
    if not (16 <= width <= 30000 and 16 <= height <= 30000) or width * height > E.MAX_OUTPUT_PX:
        raise HTTPException(400, "Layer size out of range.")
    data = await request.body()
    if len(data) != width * height * 4:
        raise HTTPException(400, "Expected width x height x 4 bytes of RGBA.")
    try:
        opts = json.loads(options)
        if not isinstance(opts, dict):
            raise ValueError
    except ValueError as exc:
        raise HTTPException(400, "options must be a JSON object.") from exc
    opts["width_in"] = 1.0  # replaced below once the artwork box is known
    o = _options(opts)
    rgba_in = np.frombuffer(data, np.uint8).reshape(height, width, 4)
    # A layer with transparency already has its background removed.
    o.remove_background = o.remove_background and bool((rgba_in[..., 3] == 255).all())
    try:
        prep = E.prepare(rgba_in.copy(), o)
        out = _render_uncropped(rgba_in, prep, o)
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(out.tobytes(), media_type="application/octet-stream",
                    headers={"X-Width": str(out.shape[1]), "X-Height": str(out.shape[0])})


def _render_uncropped(rgba_in: np.ndarray, prep: E.Prepared, o: E.ToneOptions) -> np.ndarray:
    h, w = rgba_in.shape[:2]
    x0, y0, cw, _ = prep.crop
    o.width_in = cw / o.dpi
    rgba, _, _ = E.render_full(prep, o)
    out = np.zeros((h, w, 4), np.uint8)
    rh, rw = min(rgba.shape[0], h - y0), min(rgba.shape[1], w - x0)
    out[y0:y0 + rh, x0:x0 + rw] = rgba[:rh, :rw]
    return out
