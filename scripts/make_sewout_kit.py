"""Build the sew-out test kit described in docs/sew-out-test-plan.md.

Writes every test design in every common machine format, a preview image of
each, and a worksheet, then zips it all:

    .venv/bin/python scripts/make_sewout_kit.py [output_dir]
"""

from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import pyembroidery as pe

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from ecko.digitizer.export import export_bytes, to_pattern  # noqa: E402
from ecko.digitizer.pipeline import Options, digitize  # noqa: E402

FORMATS = ["pes", "dst", "jef", "exp", "vp3", "xxx"]
IN = 25.4


def two_color_badge() -> bytes:
    """Navy disc with a gold star: two colors, a fill plus a satin-width star."""
    img = np.full((800, 800, 3), 255, np.uint8)
    cv2.circle(img, (400, 400), 360, (90, 40, 20), -1)  # navy (BGR)
    pts = []
    for i in range(10):
        r = 250 if i % 2 == 0 else 100
        a = np.pi / 2 + i * np.pi / 5
        pts.append((400 + r * np.cos(a), 400 - r * np.sin(a)))
    cv2.fillPoly(img, [np.array(pts, np.int32)], (30, 180, 240), cv2.LINE_AA)  # gold
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


def filled_circle() -> bytes:
    img = np.full((800, 800, 3), 255, np.uint8)
    cv2.circle(img, (400, 400), 380, (40, 40, 200), -1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".png", img)
    return buf.tobytes()


TESTS = [
    ("1-badge-3in", "Two-color badge, 3\" wide", "woven", two_color_badge, 3.0, None),
    ("2-badge-1.5in", "Same badge, 1.5\" wide", "woven", two_color_badge, 1.5, None),
    ("3-block-text", "\"Ecko 123\" Block lettering, 0.5\" tall", "woven", None, None,
     {"text": "Ecko 123", "font": "block", "height_mm": 0.5 * IN}),
    ("4-script-name", "\"Taylor\" Script lettering, 0.75\" tall", "tshirt", None, None,
     {"text": "Taylor", "font": "script", "height_mm": 0.75 * IN}),
    ("5-fill-circle-3in", "Large filled circle, 3\" wide", "tshirt", filled_circle, 3.0, None),
    ("6-cap-badge", "Badge on a cap, 2\" wide", "cap", two_color_badge, 2.0, None),
]


def main(out: Path) -> Path:
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    rows = []
    for slug, title, fabric, image_fn, width_in, text in TESTS:
        opts = Options(brand="other", fabric=fabric,
                       width_mm=width_in * IN if width_in else None,
                       hoop_width_mm=200, hoop_height_mm=200,
                       text=[text] if text else [])
        design = digitize(image_fn() if image_fn else None, opts)
        folder = out / slug
        folder.mkdir()
        for fmt in FORMATS:
            (folder / f"{slug}.{fmt}").write_bytes(export_bytes(design, fmt, name=slug))
        pe.write_png(to_pattern(design), str(folder / f"{slug}-preview.png"),
                     {"background": "#ffffff", "linewidth": 2})
        s = design.report["stats"]
        notes = [w["message"] for w in design.report["warnings"] if w["level"] != "info"]
        rows.append((slug, title, design.fabric.name, s, design.fabric.tip, notes,
                     [b.thread.name for b in design.blocks]))

    lines = [
        "# Ecko sew-out test kit", "",
        "Each folder has one test design in PES (Brother/Baby Lock), DST (commercial), JEF (Janome),",
        "EXP (Bernina/Melco), VP3 (Husqvarna/Pfaff) and XXX (Singer). Use the one your machine reads.",
        "See docs/sew-out-test-plan.md for what to look for.", "",
        "| Test | Design | Fabric | Size | Stitches | Colors | Est. time |",
        "|---|---|---|---|---|---|---|",
    ]
    for slug, title, fabric, s, *_ in rows:
        lines.append(f"| {slug} | {title} | {fabric} | {s['width_in']}\" × {s['height_in']}\" | "
                     f"{s['stitches']:,} | {s['colors']} | ~{s['sew_minutes']} min |")
    lines += ["", "## Record your results", ""]
    for slug, title, fabric, s, tip, notes, threads in rows:
        lines += [
            f"### {slug}: {title}", "",
            f"- Fabric: {fabric}. {tip}",
            f"- Threads in order: {', '.join(threads)}",
        ]
        lines += [f"- Note from Ecko: {n}" for n in notes]
        lines += [
            "- Machine / format used: ______________________",
            "- Stabilizer used: ______________________",
            "- Gaps between colors or outlines? ______",
            "- Puckering? ______  Fabric showing through? ______",
            "- Thread breaks or nests (where)? ______________________",
            "- Satin and letters clean? ______  Leftover jump threads? ______",
            "- Photo of front and back taken? ______", "",
        ]
    (out / "WORKSHEET.md").write_text("\n".join(lines))
    zip_path = shutil.make_archive(str(out), "zip", root_dir=out.parent, base_dir=out.name)
    return Path(zip_path)


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "out" / "ecko-sewout-kit"
    print(main(target))
