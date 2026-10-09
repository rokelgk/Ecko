"""Write a design to a machine file format."""

from __future__ import annotations

import os
import tempfile

import pyembroidery as pe

from ..machines import FORMATS
from .threads import from_hex


def to_pattern(design, colors: list[str] | None = None, rotate: bool = False, name: str = "Ecko") -> pe.EmbPattern:
    pattern = pe.EmbPattern()
    pattern.metadata("name", name[:16])
    for bi, block in enumerate(design.blocks):
        rgb = block.rgb
        if colors and bi < len(colors) and colors[bi]:
            rgb = from_hex(colors[bi])
        thread = pe.EmbThread()
        thread.set_color(*rgb)
        thread.description = block.name
        pattern.add_thread(thread)
        if bi > 0:
            pattern.add_command(pe.TRIM)
            pattern.add_command(pe.COLOR_CHANGE)
        for ri, run in enumerate(block.runs):
            if ri > 0:
                pattern.add_command(pe.TRIM)
            for i, (x, y) in enumerate(run):
                if rotate:
                    x, y = -y, x
                # pyembroidery units are 0.1 mm
                pattern.add_stitch_absolute(pe.JUMP if i == 0 else pe.STITCH, x * 10, y * 10)
    pattern.add_command(pe.TRIM)
    pattern.end()
    return pattern


def export_bytes(design, fmt: str, colors: list[str] | None = None, rotate: bool = False,
                 name: str = "Ecko") -> bytes:
    fmt = fmt.lower()
    if fmt not in FORMATS:
        raise ValueError(f"Unsupported format: {fmt}")
    pattern = to_pattern(design, colors, rotate, name)
    fd, path = tempfile.mkstemp(suffix="." + fmt)
    os.close(fd)
    try:
        pe.write(pattern, path, dict(FORMATS[fmt]["settings"]))
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.unlink(path)
