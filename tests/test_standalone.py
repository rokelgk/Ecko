"""The no-server versions: JS engine tests (via Node) and an up-to-date check for the built files."""

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import build_standalone  # noqa: E402


def test_built_files_are_up_to_date():
    """Rebuild in memory and compare: if this fails, run `python tools/build_standalone.py`."""
    engine = build_standalone.build_engine()
    assert (ROOT / "web/standalone/tone-engine.js").read_text() == engine
    assert (ROOT / "photoshop-plugin/tone-engine.js").read_text() == engine
    assert (ROOT / "dist/ecko-tone.html").read_text() == build_standalone.build_page(engine)


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_js_engine():
    r = subprocess.run(["node", "--test", str(ROOT / "tests/js/engine.test.js")], capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-3000:]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_ink_names_match_between_python_and_js():
    """Films from the web app, the Photoshop panel and the server must name the same ink the same way."""
    import json

    import numpy as np

    from ecko.tone import engine as E
    colours = np.random.default_rng(3).integers(0, 256, (400, 3)).tolist()
    js = ("const E=require(process.argv[1]);const c=JSON.parse(process.argv[2]);"
          "console.log(JSON.stringify(c.map((x)=>E.inkName(x))));")
    r = subprocess.run(["node", "-e", js, str(ROOT / "web/standalone/tone-engine.js"), json.dumps(colours)],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout) == [E.ink_name(c) for c in colours]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_scan_textures_match_between_python_and_js():
    """The same scan must knock out exactly the same pixels in the web app, Photoshop and the server."""
    import json

    import numpy as np

    from ecko.tone import engine as E
    o = {"dpi": 300, "seed": 3, "textures": [{"type": sc["id"], "strength": 0.6, "scale": 0.7} for sc in E.SCANS[:8]]}
    xs = (np.arange(0, 900, 1.7) + 0.5).tolist()
    ys = (np.arange(0, 600, 2.3) + 0.5).tolist()
    remove, _ = E.texture_masks(np.array(xs), np.array(ys), E.parse_options(o))
    js = ("const E=require(process.argv[1]);E.registerScans(require(process.argv[2]));"
          "const a=JSON.parse(process.argv[3]);const o=E.parseOptions(a[0]);"
          "const m=E._internal.textureMasks(Float64Array.from(a[1]),Float64Array.from(a[2]),o,{});"
          "console.log(JSON.stringify(Array.from(m.remove)));")
    r = subprocess.run(["node", "-e", js, str(ROOT / "web/standalone/tone-engine.js"),
                        str(ROOT / "photoshop-plugin/tone-scans.js"), json.dumps([o, xs, ys])],
                       capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr
    got = np.array(json.loads(r.stdout), bool).reshape(len(ys), len(xs))
    assert remove.any() and (got == remove).mean() == 1.0
