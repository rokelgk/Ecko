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

test("black shirt process: white base + C, M, Y, base shows white", () => {
  const { rgba, w, h } = box();
  for (let k = 0; k < rgba.length; k += 4) if (rgba[k + 3]) { rgba[k] = 230; rgba[k + 1] = 200; rgba[k + 2] = 150; }   // light art
  const base = { mode: "cmyk", width_in: 2, garment: "#141414", target: "screen" };
  const p = E.prepare(rgba, w, h, E.parseOptions(base));
  const a = E.renderFull(p, E.parseOptions(base), null, true);
  assert.deepStrictEqual(a.plates.map((q) => q.name), ["White underbase", "Cyan", "Magenta", "Yellow"]);
  let white = 0;
  for (let k = 0; k < a.rgba.length; k += 4) if (a.rgba[k + 3] && a.rgba[k] === 255 && a.rgba[k + 1] === 255 && a.rgba[k + 2] === 255) white++;
  assert.ok(white > 0);
  const off = E.plateSpecs(p, E.parseOptions({ ...base, underbase: "off" })).plates.map((q) => q.name);
  assert.deepStrictEqual(off, ["Cyan", "Magenta", "Yellow", "Black"]);
});

test("grey ramp on a black shirt is white base only, fading out", () => {
  const { rgba, w, h } = ramp();
  const o = E.parseOptions({ mode: "cmyk", width_in: 6, garment: "#000000", underbase: "on", choke_mm: 0, min_dot: 0, max_dot: 1,
    sharpen: 0, remove_background: false, roughness: 0 });
  const r = E.renderFull(E.prepare(rgba, w, h, o), o, null, true);
  const col = (sep, c) => { let on = 0, n = 0; for (let y = 0; y < r.height; y++) for (let x = Math.floor(c * r.width / 8); x < Math.floor((c + 1) * r.width / 8); x++) { on += sep[y * r.width + x]; n++; } return on / n; };
  const cols = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => col(r.seps[0], c));
  assert.ok(cols[0] > 0.85 && cols[7] < 0.1, JSON.stringify(cols));
  for (let i = 1; i < 8; i++) assert.ok(cols[i] < cols[i - 1]);
  for (const sep of r.seps.slice(1)) { let on = 0; for (const v of sep) on += v; assert.ok(on / sep.length < 0.02); }
});

test("four spot colours on a black shirt = white base + three", () => {
  const w = 240, h = 120, rgba = new Uint8Array(w * h * 4);
  const cols = [[220, 40, 40], [40, 160, 60], [250, 220, 60], [10, 10, 10]];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = cols[Math.floor(x / 60)], k = (y * w + x) * 4; rgba.set([...c, 255], k); }
  const o = E.parseOptions({ mode: "spot", spot_colors: 4, width_in: 2, garment: "#111111", target: "screen", remove_background: false });
  const { plates } = E.plateSpecs(E.prepare(rgba, w, h, o), o);
  assert.strictEqual(plates.length, 4);
  assert.ok(plates[0].underbase);
  for (const q of plates.slice(1)) assert.ok(Math.hypot(q.rgb[0] - 17, q.rgb[1] - 17, q.rgb[2] - 17) > 40);
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

// ---------------------------------------------------------------- hybrid: threshold layers, dithers, index colour

function greys() {   // 30 / 128 / 225 thirds
  const w = 360, h = 120, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = x < 120 ? 30 : x < 240 ? 128 : 225, k = (y * w + x) * 4; rgba.set([v, v, v, 255], k); }
  return { rgba, w, h };
}
const mean = (a, x0, x1, W) => { let on = 0, n = 0; for (let k = 0; k < a.length; k++) { const x = k % W; if (x >= x0 && x < x1) { on += a[k]; n++; } } return on / n; };

test("threshold layers: auto cuts and knockout", () => {
  const { rgba, w, h } = greys();
  const o = E.parseOptions({ mode: "threshold", width_in: 3, remove_background: false, sharpen: 0 });
  const p = E.prepare(rgba, w, h, o), cuts = E.thresholdCuts(p, o);
  assert.ok(cuts.length === 2 && cuts[0] > 30 / 255 && cuts[0] < 128 / 255 && cuts[1] > 128 / 255 && cuts[1] < 225 / 255, JSON.stringify(cuts));
  const r = E.renderFull(p, o, null, true), W = r.width, t = W / 3;
  assert.deepStrictEqual(r.plates.map((q) => q.name), ["Tone 2", "Tone 1"]);
  const [tone2, tone1] = r.seps;
  assert.ok(mean(tone1, 0, t - 5, W) > 0.99 && mean(tone1, t + 5, W, W) < 0.01);
  assert.ok(mean(tone2, t + 5, 2 * t - 5, W) > 0.99 && mean(tone2, 0, t - 5, W) < 0.01);
  const st = E.renderFull(p, E.parseOptions({ ...o, threshold_stack: true }), null, true);
  assert.ok(mean(st.seps[0], 0, t - 5, W) > 0.99);
});

for (const style of ["fs", "atkinson", "jarvis", "stucki", "burkes", "sierra", "sierra_lite", "bayer4", "bayer8", "random", "modulation"]) {
  test(`${style} holds tone and lines up with the export`, () => {
    const w = 200, h = 150, rgba = new Uint8Array(w * h * 4).fill(180);
    for (let k = 3; k < rgba.length; k += 4) rgba[k] = 255;
    const o = E.parseOptions({ style, width_in: 2, dpi: 200, remove_background: false, sharpen: 0, min_dot: 0, max_dot: 1,
      roughness: 0, grain_mm: 0.3, lpi: 30 });
    const p = E.prepare(rgba, w, h, o), full = E.renderFull(p, o, null, true);
    let on = 0;
    for (const v of full.seps[0]) on += v;
    const cov = on / full.seps[0].length, tol = style === "atkinson" ? 0.12 : 0.05;
    assert.ok(Math.abs(cov - (1 - 180 / 255)) < tol, `${style} ${cov}`);
    const crop = E.renderPreview(p, o, 900, [37, 21, 120, 90]);
    for (let y = 0; y < 90; y++) for (let x = 0; x < 480; x++) assert.strictEqual(crop.rgba[y * 480 + x], full.rgba[((y + 21) * full.width + 37) * 4 + x]);
  });
}

test("index colour: each pixel one ink; fixed palettes", () => {
  const w = 240, h = 120, rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set([x, 255 - x, (x * 3) % 255, 255], (y * w + x) * 4);
  const o = E.parseOptions({ mode: "index", spot_colors: 4, width_in: 2, dpi: 150, remove_background: false });
  const p = E.prepare(rgba, w, h, o), r = E.renderFull(p, o, null, true);
  for (let k = 0; k < r.seps[0].length; k++) assert.ok(r.seps.reduce((s, q) => s + q[k], 0) <= 1);
  const pal = E.resolveFit(p, E.parseOptions({ ...o, palette: "gameboy" })).palette.map(E.toHex);
  for (const c of pal) assert.ok(E.PALETTES.gameboy.colors.includes(c), c);
});

// ---------------------------------------------------------------- border knockouts

for (const border of ["fade", "grunge", "torn", "storm", "barbwire"]) for (const shape of ["rect", "oval", "rounded"]) {
  test(`${border} ${shape} border knocks out the edge`, () => {
    const w = 300, h = 300, rgba = new Uint8Array(w * h * 4).fill(90);
    for (let k = 3; k < rgba.length; k += 4) rgba[k] = 255;
    const o = E.parseOptions({ width_in: 3, dpi: 150, remove_background: false, sharpen: 0, border, border_shape: shape, border_mm: 10 });
    const p = E.prepare(rgba, w, h, o), r = E.renderFull(p, o, null, true), ink = r.seps[0], W = r.width, H = r.height;
    let edge = 0, en = 0, mid = 0, mn = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = ink[y * W + x];
      if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) { edge += v; en++; }
      if (Math.abs(x - W / 2) < 20 && Math.abs(y - H / 2) < 20) { mid += v; mn++; }
    }
    assert.ok(edge / en < 0.05 && mid / mn > 0.45, `${edge / en} ${mid / mn}`);
    const crop = E.renderPreview(p, o, 900, [5, 7, 150, 90]);
    for (let y = 0; y < 90; y++) for (let x = 0; x < 600; x++) assert.strictEqual(crop.rgba[y * 600 + x], r.rgba[((y + 7) * W + 5) * 4 + x]);
  });
}
