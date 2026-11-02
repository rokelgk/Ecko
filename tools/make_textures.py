"""Pack distress scans into the small texture files the engine ships with.

    python tools/make_textures.py SCAN.jpg:id:"Label" [...]

Each scan becomes ecko/tone/textures/<id>.etx: "ETX1", width and height (uint16, little-endian),
then zlib-compressed 8-level greyscale (0 = darkest = knocks ink out, 7 = clean). The scans are
levelled (so faint and heavy scans behave alike), lightly de-speckled, and near-white grain is
flattened: it only costs space and barely changes a knockout.
"""

from __future__ import annotations

import json
import struct
import sys
import zlib
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "ecko" / "tone" / "textures"
SIDE, LEVELS, WHITE = 1024, 8, 0.8


def pack(path: Path) -> bytes:
    im = Image.open(path).convert("L")
    s = SIDE / max(im.size)
    g = np.asarray(im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS))
    g = cv2.medianBlur(g, 3).astype(np.float32)
    lo, hi = np.percentile(g, 1), np.percentile(g, 99.5)
    g = np.clip((g - lo) / max(hi - lo, 1.0), 0, 1)
    g = np.where(g >= WHITE, 1.0, g / WHITE)
    q = np.round(g * (LEVELS - 1)).astype(np.uint8)
    return b"ETX1" + struct.pack("<HH", q.shape[1], q.shape[0]) + zlib.compress(q.tobytes(), 9)


def main(args: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    index_path = OUT / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else []
    for arg in args:
        src, tid, label = arg.split(":", 2)
        data = pack(Path(src))
        (OUT / f"{tid}.etx").write_bytes(data)
        index = [e for e in index if e["id"] != tid] + [{"id": tid, "label": label}]
        print(f"{tid:22s} {len(data) / 1e3:7.0f} KB  {label}")
    index_path.write_text(json.dumps(index, indent=1) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
