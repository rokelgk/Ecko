"""Ecko web app: upload a picture, get a machine-ready embroidery file."""

from __future__ import annotations

import json
import re
import threading
import uuid
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from . import fabrics, machines
from .digitizer.export import export_bytes
from .digitizer.pipeline import Design, Options, digitize, preview
from .digitizer.preprocess import ImageError

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_STORED_DESIGNS = 200
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="Ecko Embroidery Digitizer")

_designs: OrderedDict[str, Design] = OrderedDict()
_lock = threading.Lock()


def _store(design: Design) -> str:
    did = uuid.uuid4().hex
    with _lock:
        _designs[did] = design
        while len(_designs) > MAX_STORED_DESIGNS:
            _designs.popitem(last=False)
    return did


def _get(did: str) -> Design:
    with _lock:
        d = _designs.get(did)
    if d is None:
        raise HTTPException(404, "This design has expired. Digitize the picture again.")
    return d


@app.get("/api/catalog")
def get_catalog():
    return {"machines": machines.catalog(), "fabrics": fabrics.catalog()}


def _parse_options(raw: str) -> Options:
    try:
        data = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise HTTPException(400, "Options must be JSON.") from exc
    allowed = set(Options.__dataclass_fields__)
    unknown = set(data) - allowed
    if unknown:
        raise HTTPException(400, f"Unknown options: {', '.join(sorted(unknown))}")
    opts = Options(**data)
    for name in ("width_mm", "height_mm"):
        v = getattr(opts, name)
        if v is not None and not (5 <= float(v) <= 600):
            raise HTTPException(400, "Design size must be between 5 and 600 mm.")
    if opts.colors is not None and not (1 <= int(opts.colors) <= 20):
        raise HTTPException(400, "Colors must be between 1 and 20.")
    return opts


@app.post("/api/digitize")
def post_digitize(file: UploadFile = File(...), options: str = Form("{}")):
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That image is over 15 MB. Please upload a smaller file.")
    opts = _parse_options(options)
    try:
        design = digitize(data, opts)
    except ImageError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    did = _store(design)
    return {
        "id": did,
        "preview": preview(design),
        "report": design.report,
        "formats": design.brand.formats,
        "machine": {"brand": design.brand.name, "needles": design.brand.needles},
        "fabric": design.fabric.name,
    }


@app.get("/api/designs/{did}/file")
def get_file(
    did: str,
    format: str = Query(...),
    colors: str | None = Query(None, description="Comma separated hex thread colors"),
    rotate: bool = False,
    name: str = "ecko-design",
):
    design = _get(did)
    fmt = format.lower()
    if fmt not in machines.FORMATS:
        raise HTTPException(400, f"Unknown format {format}")
    color_list = None
    if colors:
        color_list = [c.strip() for c in colors.split(",")]
        if not all(re.fullmatch(r"#?[0-9a-fA-F]{6}", c) for c in color_list):
            raise HTTPException(400, "Colors must be hex values like #ff0000.")
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", name).strip("-")[:40] or "ecko-design"
    body = export_bytes(design, fmt, color_list, rotate, safe)
    return Response(
        body,
        media_type="application/octet-stream",
        headers={"Content-Disposition": f'attachment; filename="{safe}.{fmt}"'},
    )


if WEB_DIR.exists():
    app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
