import io
import json
import math
import os
import tempfile

import numpy as np
import pyembroidery as pe
import pytest
from PIL import Image

from ecko.digitizer.export import export_bytes
from ecko.digitizer.pipeline import Edits, Options, analyze_image, build_artwork, digitize, plan, preview
from ecko.digitizer.preprocess import ImageError, build_color_map
from ecko.digitizer.threads import thread_name
from ecko.machines import BRANDS, FORMATS

FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def fixture(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


@pytest.fixture(scope="module")
def logo_design():
    return digitize(fixture("logo.png"), Options(brand="brother", model="nq1700e", width_mm=110))


def test_brother_machine_uses_brother_thread_numbers(logo_design):
    assert all(b.thread.brand == "Brother" and b.thread.code for b in logo_design.blocks)


def test_color_map_finds_logo_colors_and_keeps_inner_white():
    cmap = build_color_map(fixture("logo.png"), width_mm=100)
    names = sorted(thread_name(c) for c in cmap.palette)
    # white lettering inside the badge is artwork, not background
    assert names == ["Black", "Blue", "Red", "White"]
    assert abs(cmap.width_mm - 100) < 0.01


def test_jpeg_artifacts_do_not_create_extra_colors():
    cmap = build_color_map(fixture("logo.jpg"), width_mm=120)
    assert len(cmap.palette) == 4


def test_transparent_background_is_respected():
    cmap = build_color_map(fixture("star.png"), width_mm=80)
    assert len(cmap.palette) == 1
    assert (cmap.labels == -1).any()


def test_rejects_non_images():
    with pytest.raises(ImageError):
        build_color_map(b"not an image", width_mm=50)


def test_design_size_matches_request(logo_design):
    # pull compensation widens the edges slightly; stay within 1.5 mm
    assert abs(logo_design.width_mm - 110) < 1.5


def test_design_is_centered(logo_design):
    pts = np.concatenate([np.asarray(r) for b in logo_design.blocks for r in b.runs])
    mn, mx = pts.min(0), pts.max(0)
    assert np.allclose((mn + mx) / 2, 0, atol=0.01)


def test_stitch_types_are_mixed(logo_design):
    objs = logo_design.report["stats"]["objects"]
    assert objs["fill"] >= 2  # disc + block
    assert objs["satin"] >= 4  # ring + letters
    # the 1 mm underline is either a narrow satin or a bean stitch
    assert objs["satin"] + objs["run"] >= 6


def test_large_fills_sew_before_details(logo_design):
    first = logo_design.blocks[0]
    last = logo_design.blocks[-1]
    assert "fill" in first.kinds
    assert "fill" not in last.kinds


def test_no_overlong_stitches_within_runs(logo_design):
    worst = 0.0
    for b in logo_design.blocks:
        for r in b.runs:
            a = np.asarray(r)
            worst = max(worst, float(np.hypot(*np.diff(a, axis=0).T).max()))
    assert worst < 12.0


def test_report_flags_hoop_overflow():
    d = digitize(fixture("logo.png"), Options(brand="brother", model="se600", width_mm=150))
    codes = {w["code"] for w in d.report["warnings"]}
    assert "hoop_too_small" in codes
    assert not d.report["stats"]["fits_hoop"]


def test_custom_hoop():
    d = digitize(fixture("star.png"), Options(brand="other", hoop_width_mm=60, hoop_height_mm=60, width_mm=50))
    assert d.hoop.name == "Custom hoop"
    assert d.report["stats"]["fits_hoop"]


def test_fabric_changes_stitching():
    woven = digitize(fixture("star.png"), Options(fabric="woven", width_mm=80))
    leather = digitize(fixture("star.png"), Options(fabric="leather", width_mm=80))
    # leather preset uses fewer needle holes
    assert leather.stitch_points() < woven.stitch_points()


def test_color_count_option():
    d = digitize(fixture("logo.png"), Options(width_mm=100, colors=2))
    assert len(d.blocks) <= 2


@pytest.mark.parametrize("fmt", sorted(FORMATS))
def test_every_format_round_trips(logo_design, fmt):
    data = export_bytes(logo_design, fmt)
    assert len(data) > 100
    fd, path = tempfile.mkstemp(suffix="." + fmt)
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(data)
        pat = pe.read(path)
    finally:
        os.unlink(path)
    assert pat is not None
    assert pat.count_stitches() > 0.9 * logo_design.stitch_points()
    x0, y0, x1, y1 = pat.bounds()
    assert abs((x1 - x0) / 10 - logo_design.width_mm) < 2.0


def test_every_brand_default_format_is_known():
    for b in BRANDS:
        assert b.formats and all(f in FORMATS for f in b.formats)
        assert b.models and all(m.hoops for m in b.models)


def test_export_thread_override_and_rotation(logo_design):
    edits = Edits(threads={str(i): {"hex": "#00ff00", "name": "Lime", "code": "L1", "brand": "Test"}
                           for i in range(len(logo_design.artwork.palette))})
    green = plan(logo_design.artwork, logo_design.options, edits)
    assert len(green.blocks) == 1  # same thread everywhere -> no color changes
    data = export_bytes(green, "pes", rotate=True)
    fd, path = tempfile.mkstemp(suffix=".pes")
    os.close(fd)
    try:
        with open(path, "wb") as f:
            f.write(data)
        pat = pe.read(path)
    finally:
        os.unlink(path)
    assert pat.threadlist[0].hex_color().lower() == "#00ff00"
    assert pat.threadlist[0].description == "Lime"
    x0, y0, x1, y1 = pat.bounds()
    assert abs((y1 - y0) / 10 - logo_design.width_mm) < 2.0  # rotated


def test_preview_is_json_serialisable(logo_design):
    p = preview(logo_design)
    s = json.dumps(p)
    assert len(p["blocks"]) == len(logo_design.blocks)
    assert len(s) < 5_000_000


def test_tiny_image_rejected():
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), "red").save(buf, "PNG")
    with pytest.raises(ImageError):
        build_color_map(buf.getvalue(), width_mm=50)


def test_lock_stitches_at_run_ends(logo_design):
    run = logo_design.blocks[0].runs[0]
    # tie-in: back-and-forth tiny stitches at the start
    assert math.dist(run[0], run[2]) < 1e-6
    assert math.dist(run[0], run[1]) < 1.0


# ---------------------------------------------------------------- lettering


def test_text_only_design_is_satin():
    d = digitize(None, Options(text=[{"text": "HELLO", "font": "block", "height_mm": 20}]))
    assert d.report["stats"]["objects"]["satin"] >= 5
    assert 18 < d.height_mm < 23


def test_text_is_placed_below_picture_and_reuses_black():
    opts = Options(width_mm=100, text=[{"text": "TEAM", "font": "varsity", "height_mm": 12, "color": "#000000"}])
    d = digitize(fixture("logo.png"), opts)
    text_regions = [r for r in d.artwork.regions if r.source == "text"]
    image_regions = [r for r in d.artwork.regions if r.source == "image"]
    assert min(r.polygon.bounds[1] for r in text_regions) > max(r.polygon.bounds[3] for r in image_regions)
    # near-black text shares the logo's black thread instead of adding a color
    assert len(d.artwork.palette) == 4


def test_multiline_text():
    d = digitize(None, Options(text=[{"text": "SMITH\n23", "font": "varsity", "height_mm": 15}]))
    assert d.height_mm > 30


def test_small_text_warning():
    d = digitize(None, Options(text=[{"text": "tiny", "font": "script", "height_mm": 4}]))
    assert "small_text" in {w["code"] for w in d.report["warnings"]}


def test_bad_text_rejected():
    with pytest.raises(ValueError):
        digitize(None, Options(text=[{"text": "x", "font": "comic-sans"}]))
    with pytest.raises(ValueError):
        digitize(None, Options())


# ---------------------------------------------------------------- editing


@pytest.fixture(scope="module")
def logo_artwork():
    opts = Options(width_mm=100)
    return build_artwork(analyze_image(fixture("logo.png"), opts), []), opts


def test_analysis_is_deterministic():
    opts = Options(width_mm=100)
    a = build_artwork(analyze_image(fixture("logo.png"), opts), [])
    b = build_artwork(analyze_image(fixture("logo.png"), opts), [])
    assert [(r.color, round(r.area_mm2, 3)) for r in a.regions] == [(r.color, round(r.area_mm2, 3)) for r in b.regions]


def test_object_edits(logo_artwork):
    art, opts = logo_artwork
    big = max(art.regions, key=lambda r: r.area_mm2)
    ring = next(r for r in art.regions if r.width90_mm < 3 and r.area_mm2 > 100)
    d = plan(art, opts, Edits(objects={str(big.id): {"hidden": True}, str(ring.id): {"kind": "run"}}))
    assert big.id not in d.kinds
    assert d.kinds[ring.id] == "run"


def test_satin_refused_on_wide_shapes(logo_artwork):
    art, opts = logo_artwork
    big = max(art.regions, key=lambda r: r.area_mm2)
    d = plan(art, opts, Edits(objects={str(big.id): {"kind": "satin"}}))
    assert d.kinds[big.id] == "fill"


def test_fill_angle_and_density_change_stitches(logo_artwork):
    art, opts = logo_artwork
    big = max(art.regions, key=lambda r: r.area_mm2)
    base = plan(art, opts).stitch_points()
    denser = plan(art, opts, Edits(objects={str(big.id): {"density": 1.5}})).stitch_points()
    assert denser > base * 1.1
    angled = plan(art, opts, Edits(objects={str(big.id): {"angle": 0}}))
    assert angled.stitch_points() != base


def test_color_order_edit(logo_artwork):
    art, opts = logo_artwork
    auto = plan(art, opts)
    wanted = [b.palette[0] for b in auto.blocks][::-1]
    d = plan(art, opts, Edits(color_order=wanted))
    assert [b.palette[0] for b in d.blocks] == wanted


def test_hiding_everything_is_an_error(logo_artwork):
    art, opts = logo_artwork
    with pytest.raises(ValueError):
        plan(art, opts, Edits(objects={str(r.id): {"hidden": True} for r in art.regions}))
