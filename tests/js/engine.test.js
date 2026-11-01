// Run with: node --test tests/js/engine.test.js   (the pytest suite runs this too when Node is installed)
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const E = require(path.join(__dirname, "../../web/standalone/tone-engine.js"));

const range = (n) => Float64Array.from({ length: n }, (_, i) => i);

function ramp(w = 600, h = 200) {   // white (left) to black (right), opaque
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.round(255 * (1 - x / (w - 1))), k = (y * w + x) * 4;
    rgba[k] = rgba[k + 1] = rgba[k + 2] = v; rgba[k + 3] = 255;
  }
  return { rgba, w, h };
}

function box() {   // dark grey box on a transparent layer
  const w = 300, h = 200, rgba = new Uint8Array(w * h * 4);
  for (let y = 50; y < 150; y++) for (let x = 60; x < 240; x++) {
    const k = (y * w + x) * 4; rgba[k] = rgba[k + 1] = rgba[k + 2] = 30; rgba[k + 3] = 255;
  }
  return { rgba, w, h };
}

test("hash matches the Python engine bit for bit", () => {
  assert.strictEqual(E._internal.hash2(5, -3, 7), 0.17726778984069824);
  assert.strictEqual(E._internal.hash2(123456, 789, 2 ** 31 - 1), 0.5618000626564026);
});

for (const style of Object.keys(E.STYLES)) {
  test(`${style} screen reproduces tone`, () => {
    const T = E.threshold(range(1200), range(900), E.parseOptions({ style, lpi: 30 }), 22.5, 1);
    let on = 0;
    for (const t of T) if (0.3 > t) on++;
    const cov = on / T.length;
    if (style === "xerox") assert.ok(cov < 0.15);
    else assert.ok(Math.abs(cov - 0.3) < 0.04, `${style}: ${cov}`);
  });
}

test("ramp prints monotonic, binary alpha", () => {
  const { rgba, w, h } = ramp();
  const o = E.parseOptions({ width_in: 6, lpi: 30, min_dot: 0, max_dot: 1, sharpen: 0, remove_background: false, roughness: 0 });
  const r = E.renderFull(E.prepare(rgba, w, h, o), o, null, true);
  const alphas = new Set();
  for (let k = 3; k < r.rgba.length; k += 4) alphas.add(r.rgba[k]);
  assert.deepStrictEqual([...alphas].sort((a, b) => a - b), [0, 255]);
  const cols = Array.from({ length: 8 }, (_, c) => {
    let on = 0, n = 0;
    for (let y = 0; y < r.height; y++) for (let x = Math.floor(c * r.width / 8); x < Math.floor((c + 1) * r.width / 8); x++) { on += r.seps[0][y * r.width + x]; n++; }
    return on / n;
  });
  for (let i = 1; i < 8; i++) assert.ok(cols[i] > cols[i - 1], JSON.stringify(cols));
  assert.ok(cols[0] < 0.1 && cols[7] > 0.9);
});

test("loupe crop equals the full render (seamless strips)", () => {
  const { rgba, w, h } = box();
  const o = E.parseOptions({ width_in: 3, textures: [{ type: "worn", strength: 0.4 }, { type: "cracked", strength: 0.5 }] });
  const p = E.prepare(rgba, w, h, o);
  const full = E.renderFull(p, o, null, false, 97);
  const crop = E.renderPreview(p, o, 900, [150, 80, 200, 160]);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 200 * 4; x++) {
    assert.strictEqual(crop.rgba[y * 800 + x], full.rgba[((y + 80) * full.width + 150) * 4 + x]);
  }
});

test("fit to shirt swaps ink that would vanish", () => {
  const { rgba, w, h } = box();
  const o = E.parseOptions({ width_in: 3, garment: "#141414" });
  const p = E.prepare(rgba, w, h, o);
  const { plates } = E.plateSpecs(p, o);
  assert.deepStrictEqual(plates[0].rgb, E.CREAM);
  assert.deepStrictEqual(E.plateSpecs(p, E.parseOptions({ width_in: 3 })).plates[0].rgb, E.hex("#1d1d1f"));
});

test("underbase shows white and never changes the ink plates", () => {
  const { rgba, w, h } = box();
  const base = { mode: "cmyk", width_in: 2, garment: "#141414", target: "screen" };
  const p = E.prepare(rgba, w, h, E.parseOptions(base));
  const a = E.renderFull(p, E.parseOptions(base), null, true);
  const b = E.renderFull(p, E.parseOptions({ ...base, underbase: "off" }), null, true);
  assert.ok(a.plates[0].underbase);
  for (let i = 0; i < 4; i++) assert.deepStrictEqual(Buffer.from(a.seps[i + 1]), Buffer.from(b.seps[i]));
  let white = 0;
  for (let k = 0; k < a.rgba.length; k += 4) if (a.rgba[k + 3] && a.rgba[k] === 255 && a.rgba[k + 1] === 255 && a.rgba[k + 2] === 255) white++;
  assert.ok(white > 0);
});

test("ink switch and choke", () => {
  const { rgba, w, h } = ramp();
  const base = { mode: "cmyk", width_in: 3, remove_background: false };
  const p = E.prepare(rgba, w, h, E.parseOptions(base));
  const cover = (o, i) => { const r = E.renderFull(p, E.parseOptions(o), null, true); let n = 0; for (const v of r.seps[i]) n += v; return n; };
  assert.strictEqual(cover({ ...base, ink_edits: { Black: { on: false } } }, 3), 0);
  const plain = cover(base, 3);
  assert.ok(cover({ ...base, ink_edits: { Black: { choke_mm: 0.15 } } }, 3) < plain);
  assert.ok(cover({ ...base, ink_edits: { Black: { choke_mm: -0.15 } } }, 3) > plain);
  assert.throws(() => E.parseOptions({ ink_edits: { Black: { choke_mm: 3 } } }));
});

test("bad options are rejected", () => {
  for (const bad of [{ lpi: 0 }, { style: "nope" }, { inks: ["red"] }, { zzz: 1 }, { black_point: 0.6, white_point: 0.5 },
    { text: [{ text: "A", arc: 999 }] }]) {
    assert.throws(() => E.parseOptions(bad));
  }
  assert.throws(() => E.prepare(null, 0, 0, E.parseOptions({})), /picture or some text/);
});
