'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const { readPng } = require('../tools/png');

const fx = (n) => readPng(fs.readFileSync(path.join(__dirname, 'fixtures', n)));
const art = fx('sim-art.png');
const logo = fx('logo.png');
const ramp = fx('ramp.png');
const preset = (id, extra) => Object.assign({}, engine.presets.getPreset(id).options, extra || {});
const avgPlate = (p) => p.reduce((s, v) => s + v, 0) / (255 * p.length);

test('CIEDE2000 matches published reference pairs (Sharma et al.)', () => {
  const pairs = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
  ];
  for (const [a, b, want] of pairs) assert.ok(Math.abs(engine.color.deltaE2000(a, b) - want) < 1e-3, `${a} vs ${b}`);
});

test('every screen count from 2 to 10 returns exactly that many screens', () => {
  for (const n of [2, 4, 6, 8, 10]) {
    const r = engine.separate(art, preset('dark-sim', { screens: n }));
    assert.strictEqual(r.screens.length, n, `asked for ${n}`);
    const light = engine.separate(art, preset('light-sim', { screens: n }));
    assert.ok(light.screens.length <= n && light.screens.length >= Math.min(n, 2));
  }
});

test('dark shirt sim process: underbase first, highlight white last, good match', () => {
  const r = engine.separate(art, preset('dark-sim', { screens: 10 }));
  assert.strictEqual(r.screens[0].role, 'underbase');
  assert.strictEqual(r.screens[r.screens.length - 1].role, 'highlight');
  assert.ok(r.report.match.avgDeltaE < 3, JSON.stringify(r.report.match));
  // Plate order numbers are 1..n.
  assert.deepStrictEqual(r.screens.map((s) => s.order), r.screens.map((_, i) => i + 1));
});

test('small saturated accents get their own ink', () => {
  const r = engine.separate(art, preset('dark-sim', { screens: 8 }));
  const red = r.screens.find((s) => s.lab[1] > 50 && s.lab[0] < 60);
  assert.ok(red, `no red ink in ${r.screens.map((s) => s.name)}`);
});

test('underbase is choked inside the color it supports', () => {
  const choked = engine.separate(art, preset('dark-sim', { choke: 2 }));
  const open = engine.separate(art, preset('dark-sim', { choke: 0 }));
  assert.ok(avgPlate(choked.screens[0].plate) < avgPlate(open.screens[0].plate));
});

test('saturated mid-tone inks get a strong underbase, dark inks a weak one', () => {
  const black = [12, 0, 0];
  const red = engine.color.rgbToLab([218, 41, 28]);
  const royal = engine.color.rgbToLab([0, 51, 160]);
  const navy = engine.color.rgbToLab([19, 30, 55]);
  assert.ok(engine.separate.length || true);
  const need = require('../engine/separate').underbaseNeed;
  assert.ok(need(red, black) > 0.85);
  assert.ok(need(royal, black) > 0.85);
  assert.ok(need(navy, black) < 0.5);
});

test('transparent pixels never receive ink', () => {
  const r = engine.separate(art, preset('dark-sim'));
  // Corner pixel of the art is transparent.
  for (const s of r.screens) assert.strictEqual(s.plate[0], 0, s.name);
});

test('spot mode finds the real colors of a flat logo and ignores anti-aliased edges', () => {
  const r = engine.separate(logo, preset('spot', { screens: 6 }));
  assert.strictEqual(r.screens.length, 3, r.screens.map((s) => `${s.name} ${s.hex}`).join(', '));
  assert.ok(r.report.match.avgDeltaE < 4);
});

test('index plates are pure bitmaps and every pixel prints at most one ink', () => {
  const r = engine.separate(art, preset('dark-index'));
  const colors = r.screens.filter((s) => s.role !== 'underbase');
  for (const s of r.screens) for (const v of s.plate) assert.ok(v === 0 || v === 255);
  for (let p = 0; p < r.width * r.height; p += 7) {
    let n = 0;
    for (const s of colors) if (s.plate[p]) n++;
    assert.ok(n <= 1);
  }
  assert.strictEqual(r.dpi, 240);
});

test('CMYK reproduces flat logo colors through the ink model', () => {
  const r = engine.separate(logo, preset('cmyk'));
  assert.deepStrictEqual(r.screens.map((s) => s.name), ['Process Cyan', 'Process Magenta', 'Process Yellow', 'Process Black']);
  assert.ok(r.report.match.avgDeltaE < 6, JSON.stringify(r.report.match));
});

test('grayscale plate follows tone', () => {
  const r = engine.separate(ramp, preset('one-color', { minDot: 0, maxDot: 1, dotGain: 0 }));
  const pl = r.screens[0].plate;
  assert.ok(pl[5] > 240 && pl[250] < 15, `${pl[5]} ${pl[250]}`);
  for (let x = 1; x < 256; x++) assert.ok(pl[x] <= pl[x - 1] + 1, 'monotonic');
});

test('min dot and max dot remove unholdable dots', () => {
  const r = engine.separate(ramp, preset('one-color', { minDot: 0.1, maxDot: 0.9, dotGain: 0 }));
  for (const v of r.screens[0].plate) assert.ok(v === 0 || v === 255 || (v >= 25 && v <= 230), String(v));
});

test('dot gain compensation inverts the press curve', () => {
  const { compensateDotGain } = require('../engine/separate');
  for (const want of [0.1, 0.3, 0.5, 0.8]) {
    const c = compensateDotGain(want, 0.15);
    assert.ok(Math.abs(c + 0.6 * c * (1 - c) - want) < 1e-9);
    assert.ok(c < want);
  }
});

test('library matching renames inks to the imported PMS names', () => {
  const csv = 'name,hex\nPMS 186 C,#c8102e\nPMS 286 C,#0033a0\nPMS 123 C,#ffc72c\nPMS 1505 C,#ff6900\nPMS 7730 C,#4c9c2e\n';
  const lib = engine.inks.parseLibrary('pms.csv', csv);
  const r = engine.separate(logo, preset('spot', { library: lib, matchLibrary: true }));
  const names = r.screens.map((s) => s.name).sort();
  assert.deepStrictEqual(names, ['PMS 123 C', 'PMS 186 C', 'PMS 286 C']);
});

test('locked inks are kept exactly', () => {
  const r = engine.separate(art, preset('dark-sim', { lockedInks: [{ name: 'PMS 802 C', hex: '#44d62c' }] }));
  const s = r.screens.find((x) => x.name === 'PMS 802 C');
  assert.ok(s && s.hex === '#44d62c');
});

test('re-running with edited inks uses exactly those inks', () => {
  const first = engine.separate(art, preset('dark-sim', { screens: 6 }));
  const edited = first.screens.map((s) => ({ name: s.name, hex: s.hex, role: s.role }));
  edited[1].name = 'My Gold'; edited[1].hex = '#ffb81c';
  const again = engine.separate(art, preset('dark-sim', { inks: edited }));
  assert.ok(again.screens.some((s) => s.name === 'My Gold' && s.hex === '#ffb81c'));
  assert.strictEqual(again.screens.length, 6);
});

test('auto screen count picks the fewest screens that look right', () => {
  const r = engine.separate(logo, preset('spot', { screens: 'auto' }));
  assert.strictEqual(r.screens.length, 3);
});

test('soft-hand overlap lays down less ink than stacked', () => {
  const stack = engine.separate(art, preset('dark-sim', { overlap: 'stack' }));
  const side = engine.separate(art, preset('dark-sim', { overlap: 'side' }));
  const total = (r) => r.screens.filter((s) => s.role !== 'underbase').reduce((t, s) => t + avgPlate(s.plate), 0);
  assert.ok(total(side) < total(stack));
  assert.ok(side.report.match.avgDeltaE < 4.5);
});

test('lone anti-aliased pixels do not reach the plates', () => {
  const img = { width: 40, height: 40, channels: 3, dpi: 300, data: new Uint8ClampedArray(40 * 40 * 3).fill(255) };
  // One blue square plus a single stray blue-ish pixel.
  for (let y = 5; y < 20; y++) for (let x = 5; x < 20; x++) img.data.set([0, 51, 160], (y * 40 + x) * 3);
  img.data.set([60, 90, 190], (30 * 40 + 30) * 3);
  const r = engine.separate(img, preset('light-sim', { screens: 2 }));
  for (const s of r.screens) assert.strictEqual(s.plate[30 * 40 + 30], 0, s.name);
  assert.ok(r.report.speckPixelsRemoved > 0);
});

test('user print order is kept on re-separation', () => {
  const first = engine.separate(art, preset('dark-sim', { screens: 6 }));
  const inks = first.screens.map((s) => ({ name: s.name, hex: s.hex, role: s.role }));
  const swapped = [inks[0], inks[2], inks[1]].concat(inks.slice(3));
  const again = engine.separate(art, preset('dark-sim', { inks: swapped }));
  assert.deepStrictEqual(again.screens.map((s) => s.name), swapped.map((s) => s.name));
});

test('the browser/Photoshop bundle exposes the same engine', () => {
  delete globalThis.EckoEngine;
  require('../engine.bundle.js');
  const r = globalThis.EckoEngine.separate(logo, preset('spot'));
  assert.strictEqual(r.screens.length, 3);
});
