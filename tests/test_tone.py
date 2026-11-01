import io
import json
import os
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from ecko.app import app
from ecko.digitizer.preprocess import ImageError
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
    base = {"width_in": 4, "inks": ["#000000"], "garment": "#000000", "shirt_fit": "off"}
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


# ------------------------------------------------------------- fit to shirt


def _ink_luma(rgba):
    ink = rgba[..., 3] > 128
    return float(rgba[..., :3][ink].mean()) / 255 if ink.any() else None


def test_fit_recolors_ink_that_would_vanish(logo):
    o = E.parse_options({"width_in": 4, "garment": "#141414", "shirt_fit": "recolor"})
    prep = E.prepare(logo, o)
    rgba, plates, bm = E.render_preview(prep, o, 400)
    assert plates[0].rgb == E.CREAM and _ink_luma(rgba) > 0.8
    rep = E.report(prep, o, plates, bm)
    assert rep["fit"]["mode"] == "recolor" and "cream" in rep["fit"]["notes"][0]
    # same design on a white shirt keeps its black ink
    o2 = E.parse_options({"width_in": 4, "garment": "#ffffff"})
    assert E.plate_specs(prep, o2)[0][0].rgb == E._hex("#1d1d1f")


def test_fit_tones_matches_picture_on_dark_shirt(ramp_png):
    """On a black shirt with cream ink, light parts of a photo get the most ink, dark parts let the shirt show."""
    o = E.parse_options({"width_in": 6, "garment": "#000000", "shirt_fit": "tones", "min_dot": 0, "max_dot": 1,
                         "sharpen": 0, "remove_background": False, "roughness": 0})
    prep = E.prepare(ramp_png, o)
    _, plates, seps = E.render_full(prep, o, keep_plates=True)
    cols = [float(c.mean()) for c in np.array_split(seps[0], 8, axis=1)]
    assert cols[0] > 0.85 and cols[-1] < 0.1  # ramp runs white -> black
    assert all(b < a for a, b in zip(cols, cols[1:]))


def test_auto_fit_picks_tones_for_photos_and_recolor_for_logos(logo, ramp_png):
    o = E.parse_options({"width_in": 4})
    assert not E.prepare(logo, o).photo_like
    photo = _png((np.random.default_rng(1).random((300, 300, 3)) * 0.6 * 255 + 50).astype(np.uint8))
    assert E.prepare(photo, E.parse_options({"remove_background": False})).photo_like


def test_fit_drops_spot_ink_matching_shirt(logo):
    o = E.parse_options({"mode": "spot", "spot_colors": 3, "width_in": 4, "shirt_fit": "tones"})
    prep = E.prepare(logo, o)
    pal = [E.to_hex(c) for c in prep.palette]
    o = E.parse_options({"mode": "spot", "spot_colors": 3, "width_in": 4, "shirt_fit": "tones", "garment": pal[0]})
    plates, _ = E.plate_specs(prep, o)
    assert len(plates) == 2 and all(E.to_hex(p.rgb) != pal[0] for p in plates)


def test_underbase_for_dark_shirts(logo):
    base = {"mode": "cmyk", "width_in": 3, "garment": "#141414"}
    prep = E.prepare(logo, E.parse_options(base))
    plates, _ = E.plate_specs(prep, E.parse_options({**base, "target": "screen"}))
    # black shirt: white base + C, M, Y. The shirt is the black, so no black ink.
    assert [p.name for p in plates] == ["White underbase", "Cyan", "Magenta", "Yellow"]
    assert not any(p.underbase for p in E.plate_specs(prep, E.parse_options(base))[0])  # DTF auto: RIP adds white
    assert E.plate_specs(prep, E.parse_options({**base, "underbase": "on"}))[0][0].underbase  # your choice wins
    navy = E.plate_specs(prep, E.parse_options({**base, "garment": "#6b6b6b", "underbase": "on"}))[0]
    assert "Black" in [p.name for p in navy]  # mid-dark shirt: black ink is still needed
    o = E.parse_options({**base, "target": "screen"})
    rgba, plates, seps = E.render_full(prep, o, keep_plates=True)
    assert seps[0].any()
    white = (rgba[..., 3] == 255) & (rgba[..., :3].min(axis=2) == 255)
    assert white.any()  # the base shows in the PNG where no colour covers it
    more_choke = E.render_full(prep, E.parse_options({**base, "target": "screen", "choke_mm": 0.3}), keep_plates=True)[2]
    assert more_choke[0].mean() < seps[0].mean()


def test_black_shirt_process_puts_white_where_the_art_is_light(ramp_png):
    """A grey ramp on a black shirt is all white base (light end) fading to bare shirt (dark end), no colour."""
    o = E.parse_options({"mode": "cmyk", "width_in": 6, "garment": "#000000", "underbase": "on", "choke_mm": 0,
                         "min_dot": 0, "max_dot": 1, "sharpen": 0, "remove_background": False, "roughness": 0})
    prep = E.prepare(ramp_png, o)
    _, plates, seps = E.render_full(prep, o, keep_plates=True)
    cols = [float(c.mean()) for c in np.array_split(seps[0], 8, axis=1)]
    assert cols[0] > 0.85 and cols[-1] < 0.1 and all(b < a for a, b in zip(cols, cols[1:]))
    assert all(s.mean() < 0.02 for s in seps[1:])  # neutral greys need no cyan, magenta or yellow


def test_four_spot_colours_on_black_shirt_is_white_plus_three(logo):
    o = E.parse_options({"mode": "spot", "spot_colors": 4, "width_in": 3, "garment": "#111111", "target": "screen"})
    prep = E.prepare(logo, o)
    plates, _ = E.plate_specs(prep, o)
    assert plates[0].underbase and len(plates) == 4
    assert all(np.linalg.norm(np.array(p.rgb) - 17) > 40 for p in plates[1:])  # no near-black ink: the shirt is black


def test_ink_switch_and_choke(logo):
    base = {"mode": "cmyk", "width_in": 3}
    prep = E.prepare(logo, E.parse_options(base))
    _, _, seps = E.render_full(prep, E.parse_options(base), keep_plates=True)
    rgba, plates, seps_off = E.render_full(prep, E.parse_options({**base, "ink_edits": {"Magenta": {"on": False}}}),
                                           keep_plates=True)
    assert not plates[1].on and not seps_off[1].any() and np.array_equal(seps_off[0], seps[0])
    choked = E.render_full(prep, E.parse_options({**base, "ink_edits": {"Cyan": {"choke_mm": 0.15}}}), keep_plates=True)[2]
    spread = E.render_full(prep, E.parse_options({**base, "ink_edits": {"Cyan": {"choke_mm": -0.15}}}), keep_plates=True)[2]
    assert choked[0].mean() < seps[0].mean() < spread[0].mean()
    assert np.array_equal(choked[3], seps[3])  # other inks untouched
    with pytest.raises(ValueError):
        E.parse_options({"ink_edits": {"Cyan": {"choke_mm": 2}}})
    with pytest.raises(ValueError):
        E.parse_options({"ink_edits": {"Cyan": {"bogus": 1}}})


def test_switched_off_ink_has_no_film(logo):
    iid = _upload(logo)
    r = client.post("/api/tone/export", json={"image_id": iid, "format": "zip", "options": {
        "width_in": 2, "mode": "cmyk", "registration_marks": False, "ink_edits": {"Yellow": {"on": False}}}})
    names = zipfile.ZipFile(io.BytesIO(r.content)).namelist()
    assert not any("Yellow" in n for n in names) and sum(n.endswith(".png") for n in names) == 4


# ------------------------------------------------------------- text


def test_text_only_design_with_arc():
    o = E.parse_options({"width_in": 8, "text": [
        {"text": "VINTAGE CLUB", "arc": 120, "size": 0.15, "y": -0.3},
        {"text": "EST. 1974", "arc": -60, "size": 0.1, "y": 0.4, "font": "block"}]})
    prep = E.prepare(None, o)
    w, h = prep.out_size(o)
    assert w == 2400 and 300 < h < 2400
    rgba, _, _ = E.render_preview(prep, o, 600)
    assert rgba[..., 3].mean() > 5


def test_text_extends_canvas_around_art(logo):
    plain = E.prepare(logo, E.parse_options({"width_in": 4}))
    o = E.parse_options({"width_in": 4, "text": [{"text": "TEAM", "y": -1.2, "size": 0.2}]})
    with_text = E.prepare(logo, o)
    assert with_text.src_h / with_text.src_w > plain.src_h / plain.src_w  # text sits above the art


def test_text_validation():
    for bad in ([{"text": "x" * 81}], [{"text": "A", "font": "comic"}], [{"text": "A", "arc": 999}],
                [{"text": "A", "bogus": 1}], [{"text": "A"}] * 7):
        with pytest.raises(ValueError):
            E.parse_options({"text": bad})
    assert E.parse_options({"text": [{"text": "   "}]}).text == []
    with pytest.raises(ImageError):
        E.prepare(None, E.parse_options({}))


# ------------------------------------------------------------- batch, mockup, text API


def test_batch_designs_times_shirts(logo, ramp_png):
    a, b = _upload(logo), _upload(ramp_png)
    r = client.post("/api/tone/batch", json={
        "items": [{"image_id": a, "name": "Logo"}, {"image_id": b, "name": "Ramp"}],
        "garments": [{"hex": "#ffffff", "name": "White"}, {"hex": "#141414"}],
        "options": {"width_in": 2, "dpi": 150, "target": "paper"}, "name": "Drop 1"})
    assert r.status_code == 200, r.text
    z = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(z.namelist())
    for d in ("Logo", "Ramp"):
        for g in ("White", "Black"):  # unnamed #141414 takes its catalog name
            assert f"{d}/{d}-{g}.png" in names and f"{d}/{d}-{g}-mockup.jpg" in names
    # fit to shirt: the logo's ink is cream on black, black on white
    on_black = np.array(Image.open(io.BytesIO(z.read("Logo/Logo-Black.png"))))
    on_white = np.array(Image.open(io.BytesIO(z.read("Logo/Logo-White.png"))))
    assert _ink_luma(on_black) > 0.8 > 0.2 > _ink_luma(on_white)
    assert "cream" in z.read("README.txt").decode()


def test_batch_limits_and_bad_input(logo):
    a = _upload(logo)
    r = client.post("/api/tone/batch", json={"items": [{"image_id": a}] * 26, "options": {}})
    assert r.status_code == 400
    r = client.post("/api/tone/batch", json={"items": [], "options": {}})
    assert r.status_code == 400
    r = client.post("/api/tone/batch", json={"items": [{"image_id": a}], "garments": [{"hex": "nope"}], "options": {}})
    assert r.status_code == 400


def test_mockup_and_text_only_preview():
    opts = {"width_in": 10, "garment": "#1f2a44", "text": [{"text": "HELLO", "arc": 90, "size": 0.2}]}
    r = client.post("/api/tone/preview", json={"image_id": None, "options": opts})
    assert r.status_code == 200, r.text
    assert r.json()["report"]["fit"]["mode"] == "recolor"
    r = client.post("/api/tone/mockup", json={"image_id": None, "options": opts, "size": 600})
    assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
    assert Image.open(io.BytesIO(r.content)).size == (600, 660)
    r = client.post("/api/tone/preview", json={"image_id": None, "options": {}})
    assert r.status_code == 400


def test_catalog_lists_fonts_fits_and_garments():
    body = client.get("/api/tone/catalog").json()
    assert {f["id"] for f in body["fonts"]} >= {"varsity", "script"}
    assert [f["id"] for f in body["shirt_fits"]][0] == "auto"
    assert any(g["name"] == "Black" for g in body["garments"])


def test_dark_shirt_cmyk_suggests_underbase(logo):
    o = E.parse_options({"mode": "cmyk", "width_in": 2, "garment": "#141414"})  # DTF: auto leaves it to the RIP
    prep = E.prepare(logo, o)
    rgba, plates, bm = E.render_preview(prep, o, 300)
    fixes = [w.get("fix") for w in E.report(prep, o, plates, bm)["warnings"]]
    assert {"underbase": "on"} in fixes
    o2 = E.parse_options({"mode": "cmyk", "width_in": 2, "garment": "#141414", "underbase": "on"})
    rgba, plates, bm = E.render_preview(prep, o2, 300)
    assert {"underbase": "on"} not in [w.get("fix") for w in E.report(prep, o2, plates, bm)["warnings"]]


def test_art_darker_than_black_shirt_prints_nothing():
    arr = np.zeros((200, 300, 4), np.uint8)
    arr[..., 3] = 255
    arr[:, :150, :3] = 5      # darker than the shirt
    arr[:, 150:, :3] = 230    # light
    o = E.parse_options({"mode": "cmyk", "width_in": 3, "garment": "#141414", "underbase": "on",
                         "remove_background": False, "choke_mm": 0})
    prep = E.prepare(_png(arr), o)
    _, _, seps = E.render_full(prep, o, keep_plates=True)
    half = seps[0].shape[1] // 2
    assert all(s[:, :half - 20].mean() < 0.01 for s in seps)   # dark half: bare shirt
    assert seps[0][:, half + 20:].mean() > 0.6                   # light half: white base


# ------------------------------------------------------------- hybrid: threshold layers, dithers, index colour


@pytest.fixture(scope="module")
def three_greys():
    arr = np.zeros((120, 360, 3), np.uint8)
    arr[:, :120], arr[:, 120:240], arr[:, 240:] = 30, 128, 225
    return _png(arr)


def test_threshold_auto_cuts_split_the_tones(three_greys):
    o = E.parse_options({"mode": "threshold", "width_in": 3, "remove_background": False, "sharpen": 0})
    prep = E.prepare(three_greys, o)
    cuts = E.threshold_cuts(prep, o)
    assert len(cuts) == 2 and 30 / 255 < cuts[0] < 128 / 255 < cuts[1] < 225 / 255
    _, plates, seps = E.render_full(prep, o, keep_plates=True)
    names = [p.name for p in plates]
    assert names == ["Tone 2", "Tone 1"]   # Tone 3 (near white) is the white shirt: not printed
    third = seps[0].shape[1] // 3
    tone2, tone1 = seps
    assert tone1[:, :third - 5].mean() > 0.99 and tone1[:, third + 5:].mean() < 0.01
    assert tone2[:, third + 5:2 * third - 5].mean() > 0.99 and tone2[:, :third - 5].mean() < 0.01  # knockout


def test_threshold_stack_overlaps_and_manual_cuts(three_greys):
    o = E.parse_options({"mode": "threshold", "width_in": 3, "remove_background": False, "sharpen": 0,
                         "threshold_stack": True})
    prep = E.prepare(three_greys, o)
    _, plates, seps = E.render_full(prep, o, keep_plates=True)
    third = seps[0].shape[1] // 3
    assert seps[0][:, :third - 5].mean() > 0.99   # the lighter tone also runs under the darkest
    o2 = E.parse_options({"mode": "threshold", "width_in": 3, "remove_background": False, "thresholds": [0.6]})
    assert E.threshold_cuts(prep, E.parse_options({**{"mode": "threshold"}, "threshold_levels": 2, "thresholds": [0.6]})) == [0.6]
    with pytest.raises(ValueError):
        E.parse_options({"thresholds": [1.5]})


def test_threshold_on_black_shirt_frees_the_dark_tone(three_greys):
    o = E.parse_options({"mode": "threshold", "width_in": 3, "remove_background": False, "garment": "#141414",
                         "threshold_colors": "image", "target": "screen"})
    plates, _ = E.plate_specs(E.prepare(three_greys, o), o)
    assert plates[0].underbase and "Tone 1" not in [p.name for p in plates]


@pytest.mark.parametrize("style", ["fs", "atkinson", "jarvis", "stucki", "burkes", "sierra", "sierra_lite",
                                   "bayer4", "bayer8", "random", "modulation"])
def test_dither_styles_hold_tone_and_line_up(style):
    grey = np.full((150, 200, 3), 180, np.uint8)   # ~30% ink
    o = E.parse_options({"style": style, "width_in": 2, "dpi": 200, "remove_background": False, "sharpen": 0,
                         "min_dot": 0, "max_dot": 1, "roughness": 0, "grain_mm": 0.3, "lpi": 30})
    prep = E.prepare(_png(grey), o)
    full, _, seps = E.render_full(prep, o, keep_plates=True)
    target = 1 - 180 / 255
    tol = 0.12 if style == "atkinson" else 0.05   # Atkinson drops a quarter of the error by design
    assert abs(seps[0].mean() - target) < tol, seps[0].mean()
    crop, _, _ = E.render_preview(prep, o, region=(37, 21, 120, 90))
    assert np.array_equal(crop, full[21:111, 37:157])


def test_index_colour_gives_each_pixel_one_ink(logo):
    o = E.parse_options({"mode": "index", "spot_colors": 4, "width_in": 2, "dpi": 150})
    prep = E.prepare(logo, o)
    _, plates, seps = E.render_full(prep, o, keep_plates=True)
    assert 1 <= len(plates) <= 4
    assert np.sum([s.astype(int) for s in seps], axis=0).max() == 1
    o2 = E.parse_options({"mode": "index", "spot_colors": 4, "width_in": 2, "dpi": 150, "palette": "gameboy"})
    pal = [E.to_hex(c) for c in E.resolve_fit(prep, o2).palette]
    assert set(pal) <= set(E.PALETTES["gameboy"]["colors"])


def test_smooth_and_denoise_are_accepted(logo):
    o = E.parse_options({"smooth_mm": 1.0, "denoise": 2, "width_in": 3})
    assert E.prepare(logo, o).src_w > 0
    with pytest.raises(ValueError):
        E.parse_options({"denoise": 9})
    with pytest.raises(ValueError):
        E.parse_options({"palette": "nope"})


# ------------------------------------------------------------- border knockouts


@pytest.fixture(scope="module")
def solid_square():
    return _png(np.full((300, 300, 3), 90, np.uint8))


@pytest.mark.parametrize("border", ["fade", "grunge", "torn", "storm", "barbwire"])
@pytest.mark.parametrize("shape", ["rect", "oval", "rounded"])
def test_borders_knock_out_the_edge(solid_square, border, shape):
    o = E.parse_options({"width_in": 3, "dpi": 150, "remove_background": False, "sharpen": 0, "border": border,
                         "border_shape": shape, "border_mm": 10})
    prep = E.prepare(solid_square, o)
    full, _, seps = E.render_full(prep, o, keep_plates=True)
    ink = seps[0]
    h, w = ink.shape
    edge = np.concatenate([ink[:3].ravel(), ink[-3:].ravel(), ink[:, :3].ravel(), ink[:, -3:].ravel()])
    centre = ink[h // 2 - 20:h // 2 + 20, w // 2 - 20:w // 2 + 20]
    assert edge.mean() < 0.05 < centre.mean() - 0.4       # bare at the edge, full ink in the middle
    assert set(np.unique(full[..., 3])) <= {0, 255}
    crop, _, _ = E.render_preview(prep, o, region=(5, 7, 150, 90))
    assert np.array_equal(crop, full[7:97, 5:155])


def test_fade_border_is_a_halftone_gradient(solid_square):
    o = E.parse_options({"width_in": 3, "dpi": 150, "remove_background": False, "sharpen": 0, "border": "fade",
                         "border_mm": 20, "roughness": 0, "min_dot": 0})
    _, _, seps = E.render_full(E.prepare(solid_square, o), o, keep_plates=True)
    row = seps[0][:, :]
    cols = [float(row[150 - 10:150 + 10, x:x + 10].mean()) for x in range(0, 120, 12)]
    assert all(b >= a - 0.03 for a, b in zip(cols, cols[1:])) and cols[0] < 0.1 < cols[-1] - 0.3


def test_border_validation():
    with pytest.raises(ValueError):
        E.parse_options({"border": "lightning"})
    with pytest.raises(ValueError):
        E.parse_options({"border_mm": 500})
