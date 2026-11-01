import io
import json
import os
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ecko.app import app
from ecko.tone import engine as E
from ecko.tone.presets import PRESETS

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _png(arr):
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def ramp_png():
    """Horizontal grey ramp, white (left) to black (right)."""
    ramp = np.tile(np.linspace(255, 0, 600), (200, 1)).astype(np.uint8)
    return _png(np.dstack([ramp] * 3))


@pytest.fixture(scope="module")
def logo():
    with open(os.path.join(FIX, "logo.png"), "rb") as f:
        return f.read()


def _upload(data):
    r = client.post("/api/tone/images", files={"file": ("a.png", data, "image/png")})
    assert r.status_code == 200, r.text
    return r.json()["id"]


# ------------------------------------------------------------- engine


@pytest.mark.parametrize("style", list(E.STYLES))
def test_screens_reproduce_tone(style):
    """Every screen except the deliberately contrasty Xerox prints a 30% grey as about 30% ink."""
    xs = np.arange(1200, dtype=float)
    ys = np.arange(900, dtype=float)
    o = E.parse_options({"style": style, "lpi": 30})
    T = E.threshold(xs, ys, o, 22.5, 1)
    cov = float((0.3 > T).mean())
    if style == "xerox":
        assert cov < 0.15
    else:
        assert abs(cov - 0.3) < 0.04, cov


def test_ramp_is_monotonic_and_binary(ramp_png):
    o = E.parse_options({"width_in": 6, "dpi": 300, "lpi": 30, "min_dot": 0, "max_dot": 1,
                         "sharpen": 0, "remove_background": False, "roughness": 0})
    prep = E.prepare(ramp_png, o)
    rgba, plates, seps = E.render_full(prep, o, keep_plates=True)
    assert set(np.unique(rgba[..., 3])) <= {0, 255}  # no semi-transparent pixels, ever
    cols = [float(c.mean()) for c in np.array_split(seps[0], 8, axis=1)]
    assert all(b > a for a, b in zip(cols, cols[1:])), cols
    assert cols[0] < 0.1 and cols[-1] > 0.9


def test_loupe_matches_full_render(logo):
    o = E.parse_options({"width_in": 4, "textures": [{"type": "worn", "strength": 0.4},
                                                     {"type": "cracked", "strength": 0.5}]})
    prep = E.prepare(logo, o)
    full, _, _ = E.render_full(prep, o, strip=97)  # odd strip height: seams would show
    crop, _, _ = E.render_preview(prep, o, region=(150, 80, 200, 160))
    assert np.array_equal(crop, full[80:240, 150:350])


def test_min_dot_and_max_dot():
    c = np.linspace(0, 1, 101, dtype=np.float32)
    o = E.parse_options({"min_dot": 0.1, "max_dot": 0.9})
    out = E._shape_dots(c, o)
    nz = out[out > 0]
    assert nz.min() >= 0.1 - 1e-6
    assert set(np.round(out[(out > 0.9) & (out < 1)], 3)) == set()


def test_dot_gain_compensation_inverts_gain():
    o = E.parse_options({"dot_gain": 0.15, "min_dot": 0, "max_dot": 1})
    want = np.linspace(0, 1, 21, dtype=np.float32)
    c = E._shape_dots(want.copy(), o)
    printed = c + 4 * 0.15 * c * (1 - c)
    assert np.allclose(printed, want, atol=1e-4)


def test_spot_mode_makes_palette_and_plates(logo):
    o = E.parse_options({"mode": "spot", "spot_colors": 3, "width_in": 4})
    prep = E.prepare(logo, o)
    assert len(prep.palette) == 3
    rgba, plates, bm = E.render_preview(prep, o, 400)
    assert len(plates) == 3 and len(bm) == 3
    lights = prep.palette_lab[:, 0]
    assert all(a >= b for a, b in zip(lights, lights[1:]))  # light inks print first


def test_knockout_removes_garment_coloured_ink(logo):
    base = {"width_in": 4, "inks": ["#000000"], "garment": "#000000"}
    prep = E.prepare(logo, E.parse_options(base))
    on, _, _ = E.render_preview(prep, E.parse_options(base), 400)
    off, _, _ = E.render_preview(prep, E.parse_options({**base, "knockout": True}), 400)
    assert on[..., 3].mean() > 10 and off[..., 3].max() == 0


def test_bad_options_rejected():
    for bad in ({"lpi": 0}, {"style": "nope"}, {"inks": ["red"]}, {"mode": "duotone", "inks": ["#000"]},
                {"textures": [{"type": "worn", "strength": 3}]}, {"zzz": 1},
                {"black_point": 0.6, "white_point": 0.5}):
        with pytest.raises(ValueError):
            E.parse_options(bad)


def test_presets_are_valid():
    for p in PRESETS:
        E.parse_options(p["options"])


# ------------------------------------------------------------- API


def test_catalog():
    body = client.get("/api/tone/catalog").json()
    assert {s["id"] for s in body["styles"]} >= {"round", "xerox", "fm"}
    assert len(body["presets"]) >= 8
    assert body["defaults"]["dpi"] == 300


def test_preview_report_and_loupe(logo):
    iid = _upload(logo)
    r = client.post("/api/tone/preview", json={"image_id": iid, "options": {"width_in": 8, "lpi": 120}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["image"].startswith("data:image/png;base64,")
    assert body["size"][0] == 2400
    texts = " ".join(w["text"] for w in body["report"]["warnings"])
    assert "LPI" in texts  # 120 LPI is far outside the DTF range
    r = client.post("/api/tone/preview", json={"image_id": iid, "options": {}, "region": [0, 0, 300, 200]})
    assert r.status_code == 200
    assert Image.open(io.BytesIO(__import__("base64").b64decode(r.json()["image"].split(",")[1]))).size == (300, 200)


def test_export_png_has_dpi_and_binary_alpha(logo):
    iid = _upload(logo)
    r = client.post("/api/tone/export", json={"image_id": iid, "options": {"width_in": 3, "dpi": 300},
                                              "format": "png", "name": "My Shirt"})
    assert r.status_code == 200
    assert 'filename="My-Shirt.png"' in r.headers["content-disposition"]
    im = Image.open(io.BytesIO(r.content))
    assert im.size[0] == 900 and round(im.info["dpi"][0]) == 300
    assert set(np.unique(np.array(im)[..., 3])) <= {0, 255}


def test_export_separations_zip(logo):
    iid = _upload(logo)
    r = client.post("/api/tone/export", json={"image_id": iid, "format": "zip",
                                              "options": {"width_in": 3, "mode": "cmyk"}})
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = z.namelist()
    assert "README.txt" in names and sum(n.endswith(".png") for n in names) == 5
    film = Image.open(io.BytesIO(z.read([n for n in names if "Black" in n][0])))
    assert film.mode == "1" and film.size[0] == 900 + 300  # 0.5 in margin each side


def test_expired_image_and_bad_requests():
    r = client.post("/api/tone/preview", json={"image_id": "0" * 32, "options": {}})
    assert r.status_code == 410
    r = client.post("/api/tone/preview", json={"image_id": "../etc", "options": {}})
    assert r.status_code == 400
    r = client.post("/api/tone/images", files={"file": ("a.png", b"not an image", "image/png")})
    assert r.status_code == 422


def test_raw_roundtrip_keeps_layer_size_and_position():
    arr = np.zeros((300, 400, 4), np.uint8)
    arr[100:200, 150:300] = (60, 60, 60, 255)  # grey box on a transparent layer
    r = client.post("/api/tone/raw", content=arr.tobytes(),
                    params={"width": 400, "height": 300, "options": json.dumps({"dpi": 300})})
    assert r.status_code == 200, r.text
    out = np.frombuffer(r.content, np.uint8).reshape(300, 400, 4)
    ink = out[..., 3] > 0
    ys, xs = np.nonzero(ink)
    assert ys.min() >= 100 and ys.max() < 200 and xs.min() >= 150 and xs.max() < 300
    assert 0.5 < ink[100:200, 150:300].mean() < 0.95  # halftoned, not solid


def test_raw_rejects_wrong_byte_count():
    r = client.post("/api/tone/raw", content=b"\0" * 100, params={"width": 400, "height": 300})
    assert r.status_code == 400
