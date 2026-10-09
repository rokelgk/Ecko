import json
import os

from fastapi.testclient import TestClient

from ecko.app import app

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _create(name="logo.png", **opts):
    with open(os.path.join(FIX, name), "rb") as f:
        return client.post(
            "/api/designs",
            files={"file": (name, f, "image/png")},
            data={"options": json.dumps(opts)},
        )


def test_catalog():
    body = client.get("/api/catalog").json()
    assert any(b["id"] == "brother" for b in body["machines"]["brands"])
    assert any(f["id"] == "tshirt" for f in body["fabrics"])
    assert any(f["id"] == "script" for f in body["fonts"])
    assert len(body["thread_charts"]["brother"]["threads"]) > 50


def test_create_download_and_reload():
    r = _create(brand="janome", fabric="tshirt", width_mm=90)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["formats"][0] == "jef"
    assert body["thread_chart"] == "janome"
    assert body["name"] == "logo"
    assert body["report"]["stats"]["stitches"] > 1000
    f = client.get(f"/api/designs/{body['id']}/file", params={"format": "jef", "name": "my logo!"})
    assert f.status_code == 200
    assert 'filename="my-logo.jef"' in f.headers["content-disposition"]
    again = client.get(f"/api/designs/{body['id']}").json()
    assert again["report"]["stats"]["stitches"] == body["report"]["stats"]["stitches"]
    img = client.get(f"/api/designs/{body['id']}/image")
    assert img.headers["content-type"] == "image/png"


def test_text_only_design():
    r = client.post("/api/designs", data={"options": json.dumps({"text": [{"text": "Hi"}]}), "name": "Hi"})
    assert r.status_code == 200, r.text
    assert r.json()["has_image"] is False


def test_patch_edits_and_options():
    body = _create(width_mm=80).json()
    did = body["id"]
    big = max(body["preview"]["objects"], key=lambda o: o["area_mm2"])
    r = client.patch(f"/api/designs/{did}", json={"edits": {"objects": {str(big["id"]): {"hidden": True}}}})
    assert r.status_code == 200, r.text
    assert next(o for o in r.json()["preview"]["objects"] if o["id"] == big["id"])["hidden"]
    # changing the fabric keeps edits
    r = client.patch(f"/api/designs/{did}", json={"options": {"fabric": "towel"}})
    assert r.json()["edits"]["objects"]
    # changing the size re-detects shapes, so edits reset
    r = client.patch(f"/api/designs/{did}", json={"options": {"width_mm": 70}})
    assert r.json()["edits"]["objects"] == {}
    r = client.patch(f"/api/designs/{did}", json={"name": "Shop logo"})
    assert r.json()["name"] == "Shop logo"


def test_list_and_delete():
    did = _create(width_mm=60).json()["id"]
    listed = client.get("/api/designs", params={"ids": f"{did},nothex,{'0' * 32}"}).json()["designs"]
    assert [d["id"] for d in listed] == [did]
    assert listed[0]["stitches"] > 0
    assert client.delete(f"/api/designs/{did}").status_code == 200
    assert client.get(f"/api/designs/{did}").status_code == 404


def test_validation():
    assert _create(width_mm=1000).status_code == 400
    assert _create(nope=1).status_code == 400
    assert _create(brand="acme").status_code == 422
    assert _create(thread_chart="madeira").status_code == 400
    assert _create(text=[{"text": "x", "height_mm": 1}]).status_code == 400
    r = client.post("/api/designs", files={"file": ("x.png", b"hello", "image/png")})
    assert r.status_code == 422
    did = _create(width_mm=60).json()["id"]
    bad = [
        {"edits": {"objects": {"0": {"kind": "zigzag"}}}},
        {"edits": {"objects": {"0": {"angle": 500}}}},
        {"edits": {"threads": {"0": {"hex": "red"}}}},
        {"bogus": 1},
    ]
    for body in bad:
        assert client.patch(f"/api/designs/{did}", json=body).status_code == 400, body


def test_unknown_design_and_format():
    assert client.get("/api/designs/nope").status_code == 404
    assert client.get(f"/api/designs/{'a' * 32}/file", params={"format": "dst"}).status_code == 404
    did = _create(width_mm=60).json()["id"]
    assert client.get(f"/api/designs/{did}/file", params={"format": "zip"}).status_code == 400


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "Ecko" in r.text
