"""Ecko web app: upload a picture (or type text), get a machine-ready file."""

from __future__ import annotations

import hashlib
import io
import json
import re
import threading
from collections import OrderedDict
from dataclasses import asdict, fields
from pathlib import Path

from fastapi import Body, FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from . import fabrics, machines, threadcharts
from .digitizer import text as lettering
from .digitizer.export import export_bytes
from .digitizer.pipeline import (ANALYSIS_KEYS, KINDS, Design, Edits, ImageArt, Options, analyze_image,
                                 build_artwork, plan, preview, threads_used)
from .digitizer.preprocess import ImageError
from .store import Store

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_CACHED_ART = 64
MAX_RECENT = 50
ID_RE = re.compile(r"^[0-9a-f]{32}$")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Ecko Embroidery Digitizer")
store = Store()

_art_cache: OrderedDict[tuple, ImageArt] = OrderedDict()
_cache_lock = threading.Lock()


# ------------------------------------------------------------ helpers


def _image_art(image: bytes | None, opts: Options) -> ImageArt | None:
    """Image analysis is the slow part; cache it per picture + settings."""
    if not image:
        return None
    key = (hashlib.sha256(image).hexdigest(), opts.analysis_key())
    with _cache_lock:
        if key in _art_cache:
            _art_cache.move_to_end(key)
            return _art_cache[key]
    art = analyze_image(image, opts)
    with _cache_lock:
        _art_cache[key] = art
        while len(_art_cache) > MAX_CACHED_ART:
            _art_cache.popitem(last=False)
    return art


def _options(data: dict) -> Options:
    allowed = {f.name for f in fields(Options)}
    unknown = set(data) - allowed
    if unknown:
        raise HTTPException(400, f"Unknown options: {', '.join(sorted(unknown))}")
    try:
        opts = Options(**data)
        for name in ("width_mm", "height_mm"):
            v = getattr(opts, name)
            if v is not None and not (5 <= float(v) <= 600):
                raise ValueError("Design size must be between 5 and 600 mm.")
        if opts.colors is not None and not (1 <= int(opts.colors) <= 20):
            raise ValueError("Colors must be between 1 and 20.")
        if opts.thread_chart is not None and opts.thread_chart not in threadcharts.CHARTS:
            raise ValueError(f"Unknown thread chart: {opts.thread_chart}")
        if not isinstance(opts.text, list) or len(opts.text) > 10:
            raise ValueError("Up to 10 lines of lettering are supported.")
        for layer in opts.text_layers():
            layer.validate()
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return opts


def _edits(data: dict | None) -> Edits:
    e = Edits.from_dict(data)
    try:
        for k, v in e.objects.items():
            int(k)
            if not isinstance(v, dict):
                raise ValueError("Object edits must be objects.")
            if v.get("kind") not in (None, *KINDS):
                raise ValueError(f"Stitch type must be one of {', '.join(KINDS)}.")
            if v.get("angle") is not None and not (0 <= float(v["angle"]) <= 180):
                raise ValueError("Fill angle must be 0-180 degrees.")
            if v.get("density") is not None and not (0.5 <= float(v["density"]) <= 2.0):
                raise ValueError("Object density must be 0.5-2.0.")
        e.color_order = [int(c) for c in e.color_order]
        for k, t in e.threads.items():
            int(k)
            if not re.fullmatch(r"#[0-9a-fA-F]{6}", str(t.get("hex", ""))):
                raise ValueError("Thread colors must be hex values like #ff0000.")
            for f in ("name", "code", "brand"):
                if len(str(t.get(f) or "")) > 60:
                    raise ValueError("Thread names and codes are limited to 60 characters.")
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return e


def _build(record: dict) -> Design:
    opts = _options(record["options"])
    try:
        art = _image_art(record["image"], opts)
        layers = opts.text_layers()
        if art is None and not layers:
            raise ValueError("Add a picture or some text to digitize.")
        return plan(build_artwork(art, layers), opts, _edits(record["edits"]))
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _summary(design: Design) -> dict:
    s = design.report["stats"]
    return {"stitches": s["stitches"], "colors": s["colors"], "width_mm": s["width_mm"],
            "height_mm": s["height_mm"], "machine": design.brand.name}


def _state(record: dict, design: Design) -> dict:
    return {
        "id": record["id"],
        "name": record["name"],
        "has_image": record["image"] is not None,
        "options": record["options"],
        "edits": record["edits"],
        "preview": preview(design),
        "report": design.report,
        "threads": threads_used(design),
        "thread_chart": design.options.thread_chart or threadcharts.default_chart(design.brand.id),
        "formats": design.brand.formats,
        "machine": {"brand": design.brand.name, "needles": design.brand.needles},
        "fabric": design.fabric.name,
    }


def _record(did: str) -> dict:
    if not ID_RE.match(did):
        raise HTTPException(404, "Design not found.")
    rec = store.get(did)
    if rec is None:
        raise HTTPException(404, "Design not found. It may have been deleted.")
    return rec


# ------------------------------------------------------------ routes


@app.get("/api/catalog")
def get_catalog():
    return {
        "machines": machines.catalog(),
        "fabrics": fabrics.catalog(),
        "fonts": lettering.catalog(),
        "thread_charts": threadcharts.catalog(),
    }


@app.post("/api/designs")
def create_design(file: UploadFile | None = File(None), options: str = Form("{}"), name: str = Form("")):
    data = None
    if file is not None:
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "That image is over 15 MB. Please upload a smaller file.")
        if not data:
            data = None
    try:
        opts_raw = json.loads(options or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Options must be JSON.") from exc
    if not isinstance(opts_raw, dict):
        raise HTTPException(400, "Options must be a JSON object.")
    opts = _options(opts_raw)
    name = (name or (file.filename if file else "") or "Untitled design").rsplit(".", 1)[0][:80]
    rec = {"id": "", "name": name, "image": data, "options": asdict(opts), "edits": asdict(Edits())}
    design = _build(rec)
    rec["id"] = store.create(name, data, rec["options"], rec["edits"])
    store.update(rec["id"], summary=_summary(design))
    return _state(rec, design)


@app.get("/api/designs/{did}")
def get_design(did: str):
    rec = _record(did)
    return _state(rec, _build(rec))


@app.patch("/api/designs/{did}")
def update_design(did: str, body: dict = Body(...)):
    rec = _record(did)
    unknown = set(body) - {"options", "edits", "name"}
    if unknown:
        raise HTTPException(400, f"Unknown fields: {', '.join(sorted(unknown))}")
    if "name" in body:
        rec["name"] = str(body["name"])[:80] or "Untitled design"
    if "edits" in body:
        rec["edits"] = asdict(_edits(body["edits"]))
    if "options" in body:
        if not isinstance(body["options"], dict):
            raise HTTPException(400, "Options must be an object.")
        new = {**rec["options"], **body["options"]}
        new = asdict(_options(new))
        if any(new.get(k) != rec["options"].get(k) for k in ANALYSIS_KEYS) and rec["image"] is not None:
            # Regions are re-detected, so edits that point at them no longer apply.
            rec["edits"] = asdict(Edits())
        rec["options"] = new
    design = _build(rec)
    store.update(did, name=rec["name"], options=rec["options"], edits=rec["edits"], summary=_summary(design))
    return _state(rec, design)


@app.delete("/api/designs/{did}")
def delete_design(did: str):
    _record(did)
    store.delete(did)
    return {"deleted": did}


@app.get("/api/designs")
def list_designs(ids: str = Query("", description="Comma separated design ids this browser saved")):
    wanted = [i for i in ids.split(",") if ID_RE.match(i)][:MAX_RECENT]
    return {"designs": store.summaries(wanted)}


@app.get("/api/designs/{did}/file")
def get_file(did: str, format: str = Query(...), rotate: bool = False, name: str | None = None):
    rec = _record(did)
    fmt = format.lower()
    if fmt not in machines.FORMATS:
        raise HTTPException(400, f"Unknown format {format}")
    design = _build(rec)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", name or rec["name"]).strip("-")[:40] or "ecko-design"
    body = export_bytes(design, fmt, rotate, safe)
    return Response(
        body,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe}.{fmt}"'},
    )


@app.get("/api/designs/{did}/image")
def get_image(did: str):
    rec = _record(did)
    if rec["image"] is None:
        raise HTTPException(404, "This design has no picture.")
    try:
        fmt = Image.open(io.BytesIO(rec["image"])).format or ""
    except Exception:
        fmt = ""
    mime = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp", "GIF": "image/gif",
            "BMP": "image/bmp"}.get(fmt, "application/octet-stream")
    return Response(rec["image"], media_type=mime,
                    headers={"Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff"})


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
