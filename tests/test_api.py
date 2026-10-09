import json
import os

from fastapi.testclient import TestClient

from ecko.app import app

client = TestClient(app)
FIX = os.path.join(os.path.dirname(__file__), "fixtures")


def _upload(name="logo.png", **opts):
    with open(os.path.join(FIX, name), "rb") as f:
        return client.post(
            "/api/digitize",
            files={"file": (name, f, "image/png")},
            data={"options": json.dumps(opts)},
        )


def test_catalog():
    r = client.get("/api/catalog")
    assert r.status_code == 200
    body = r.json()
    assert any(b["id"] == "brother" for b in body["machines"]["brands"])
    assert any(f["id"] == "tshirt" for f in body["fabrics"])


def test_digitize_and_download_machine_format():
    r = _upload(brand="janome", fabric="tshirt", width_mm=90)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["formats"][0] == "jef"
    assert body["report"]["stats"]["stitches"] > 1000
    f = client.get(f"/api/designs/{body['id']}/file", params={"format": "jef", "name": "my logo!"})
    assert f.status_code == 200
    assert 'filename="my-logo.jef"' in f.headers["content-disposition"]
    assert len(f.content) > 500


def test_bad_options_rejected():
    assert _upload(width_mm=1000).status_code == 400
    assert _upload(nope=1).status_code == 400
    assert _upload(brand="acme").status_code == 422


def test_bad_image_rejected():
    r = client.post("/api/digitize", files={"file": ("x.png", b"hello", "image/png")})
    assert r.status_code == 422
    assert "image" in r.json()["detail"].lower()


def test_unknown_design_and_bad_colors():
    assert client.get("/api/designs/nope/file", params={"format": "dst"}).status_code == 404
    did = _upload(width_mm=60).json()["id"]
    r = client.get(f"/api/designs/{did}/file", params={"format": "dst", "colors": "red"})
    assert r.status_code == 400
    assert client.get(f"/api/designs/{did}/file", params={"format": "zip"}).status_code == 400


def test_index_served():
    r = client.get("/")
    assert r.status_code == 200
    assert "Ecko" in r.text
