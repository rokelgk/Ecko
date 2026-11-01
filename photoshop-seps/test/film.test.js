'use strict';
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../engine');
const { renderFilm, renderBitmap, recommendMesh } = engine.halftone;

const flat = (v, w = 60, h = 60) => new Uint8Array(w * h).fill(v);
const share = (f) => f.data.reduce((s, v) => s + (v ? 1 : 0), 0) / f.data.length;

test('AM halftone tone is linear for every dot shape', () => {
  for (const dot of ['round', 'ellipse', 'square', 'diamond', 'line']) {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const f = renderBitmap(flat(Math.round(t * 255)), 60, 60, 100, { type: 'am', lpi: 30, angle: 22.5, dot, dpi: 600 });
      assert.ok(Math.abs(share(f) - t) < 0.03, `${dot} ${t}: ${share(f)}`);
    }
  }
});

test('0% and 100% stay clean', () => {
  for (const type of ['am', 'fm', 'threshold']) {
    assert.strictEqual(share(renderBitmap(flat(0), 40, 40, 100, { type, dpi: 300 })), 0, type);
    assert.strictEqual(share(renderBitmap(flat(255), 40, 40, 100, { type, dpi: 300 })), 1, type);
  }
});

test('frequency sets the dot pitch', () => {
  // 50% dots at 0 degrees: count dot starts along a row.
  const f = renderBitmap(flat(64, 100, 10), 100, 10, 100, { type: 'am', lpi: 20, angle: 0, dot: 'round', dpi: 400 });
  const y = 10; // centre of the first dot row (cell = 20 px)
  let runs = 0;
  for (let x = 1; x < f.width; x++) if (f.data[y * f.width + x] && !f.data[y * f.width + x - 1]) runs++;
  // 1 inch wide at 20 lpi -> 20 dots (± one at the edge).
  assert.ok(Math.abs(runs - 20) <= 1, String(runs));
});

test('FM keeps a minimum dot size', () => {
  const f = renderBitmap(flat(30), 40, 40, 100, { type: 'fm', fmDot: 4, dpi: 400 });
  for (let y = 0; y < f.height; y += 4) for (let x = 0; x < f.width - 4; x += 4) {
    const v = f.data[y * f.width + x];
    for (let k = 1; k < 4; k++) assert.strictEqual(f.data[y * f.width + x + k], v);
  }
  assert.ok(Math.abs(share(f) - 30 / 255) < 0.03);
});

test('film gets margin, registration targets, label and mirroring', () => {
  const plate = new Uint8Array(100 * 50);
  for (let y = 0; y < 50; y++) for (let x = 0; x < 20; x++) plate[y * 100 + x] = 255; // left bar
  const f = renderFilm(plate, 100, 50, 100, { type: 'threshold', dpi: 200, marginIn: 0.5, label: '1/4 RED 55 LPI', mirror: true });
  assert.strictEqual(f.width, 200 + 200);
  const m = 100;
  // Mirrored: bar is now on the right side of the art area.
  assert.strictEqual(f.data[(m + 10) * f.width + m + 195], 255);
  assert.strictEqual(f.data[(m + 10) * f.width + m + 5], 0);
  // Registration target centre (top middle) is black.
  assert.strictEqual(f.data[50 * f.width + f.width / 2], 255);
});

test('TIFF round-trips 1-bit and 8-bit films with resolution', () => {
  const plate = new Uint8Array(37 * 23).map((_, i) => (i * 37) % 256);
  for (const type of ['am', 'continuous']) {
    const film = renderFilm(plate, 37, 23, 300, { type, dpi: 720, marginIn: 0.1, label: 'TEST' });
    const back = engine.tiff.readTiff(engine.tiff.writeTiff(film));
    assert.strictEqual(back.width, film.width);
    assert.strictEqual(back.dpi, film.dpi);
    assert.deepStrictEqual(Array.from(back.data), Array.from(film.data.map((v) => (film.bits === 1 ? (v >= 128 ? 255 : 0) : v))));
  }
});

test('mesh recommendations follow line count', () => {
  assert.strictEqual(recommendMesh({ role: 'color' }, { type: 'am', lpi: 55 }).mesh, 255);
  assert.ok(recommendMesh({ role: 'underbase' }, { type: 'am', lpi: 55 }).mesh <= 200);
  assert.strictEqual(recommendMesh({ role: 'color' }, { type: 'index' }).mesh, 230);
});

test('every glyph in the label font is 5x7', () => {
  const src = require('fs').readFileSync(require.resolve('../engine/halftone'), 'utf8');
  const glyphs = [...src.matchAll(/'([01]{6,})'/g)].map((m) => m[1]);
  assert.ok(glyphs.length > 40);
  for (const g of glyphs) assert.strictEqual(g.length, 35);
});

test('film label stays clear of the bottom registration target', () => {
  const f = renderFilm(new Uint8Array(300 * 100), 300, 100, 100, { type: 'threshold', dpi: 100, marginIn: 0.5, label: 'A VERY LONG LABEL THAT WOULD NOT FIT ANYWHERE NEAR THE TARGET 55 LPI' });
  const m = 50, cx = f.width / 2, r = Math.round(m * 0.32);
  // Nothing inked between the end of the label zone and the target, on the label rows.
  for (let y = f.height - m; y < f.height; y++) {
    for (let x = cx - r - 8; x < cx - r - 1; x++) assert.strictEqual(f.data[y * f.width + x], 0, `${x},${y}`);
  }
});

test('ZIP holds every film intact (one download in the browser)', () => {
  const zlib = require('zlib');
  const files = [{ name: '01-White.tif', data: new Uint8Array([1, 2, 3, 4]) }, { name: 'job-sheet.txt', data: new TextEncoder().encode('hello') }];
  const z = engine.zip.makeZip(files);
  const buf = Buffer.from(z);
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50);
  const end = buf.length - 22;
  assert.strictEqual(buf.readUInt32LE(end), 0x06054b50);
  assert.strictEqual(buf.readUInt16LE(end + 10), 2);
  // Stored data and CRC are right.
  const nameLen = buf.readUInt16LE(26);
  assert.deepStrictEqual(Array.from(buf.subarray(30 + nameLen, 30 + nameLen + 4)), [1, 2, 3, 4]);
  assert.strictEqual(buf.readUInt32LE(14), zlib.crc32 ? zlib.crc32(Buffer.from([1, 2, 3, 4])) : engine.zip.crc32(new Uint8Array([1, 2, 3, 4])));
});

test('registered results keep the preview size separate from the padded plates', () => {
  const r = engine.separate(require('../tools/png').readPng(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'logo.png'))), Object.assign({}, engine.presets.getPreset('spot').options));
  const reg = engine.applyRegistration(r, engine.presets.getPreset('spot').film, { marks: true });
  assert.ok(reg.width > r.width);
  assert.strictEqual(reg.previewWidth * reg.previewHeight * 4, reg.preview.length);
});
