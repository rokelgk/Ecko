'use strict';
// Ink libraries: a built-in set of common plastisol colors, importers for
// the user's own PMS / supplier libraries (.ase, .aco, .csv, .gpl), and
// nearest-ink matching with CIEDE2000.
//
// The built-in library uses generic names on purpose. Pantone values are
// licensed, and Adobe stopped shipping the Pantone books in 2022. Printers
// who need PMS numbers import the library they already license (Pantone
// Connect export, or an ink maker's PMS mixing chart) and every match then
// carries the PMS name onto the spot channel.

const { parseHex, rgbToLab, labToRgb, deltaE2000, toHex } = require('./color');

const BUILT_IN = [
  ['White', '#ffffff'], ['Bright White (Highlight)', '#fdfdfb'], ['Black', '#111111'],
  ['Cool Gray 2', '#d0d0ce'], ['Cool Gray 7', '#97999b'], ['Cool Gray 11', '#53565a'],
  ['Warm Gray', '#8c8279'], ['Silver Gray', '#a7a8aa'],
  ['Lemon Yellow', '#fff200'], ['Bright Yellow', '#ffe100'], ['Golden Yellow', '#ffc72c'],
  ['Athletic Gold', '#ffb81c'], ['Orange', '#ff8200'], ['Bright Orange', '#ff6a13'],
  ['Texas Orange', '#c75b12'], ['Scarlet Red', '#e4002b'], ['Bright Red', '#da291c'],
  ['Fire Red', '#c8102e'], ['Cardinal', '#a6192e'], ['Maroon', '#6f263d'],
  ['Hot Pink', '#e31c79'], ['Pink', '#f4a6c4'], ['Magenta', '#d0006f'],
  ['Purple', '#5f259f'], ['Violet', '#7d55c7'], ['Lavender', '#b4a7d6'],
  ['Navy', '#13294b'], ['Royal Blue', '#0033a0'], ['Process Blue', '#0085ca'],
  ['Columbia Blue', '#9bcbeb'], ['Turquoise', '#00a3ad'], ['Teal', '#00777f'],
  ['Kelly Green', '#00843d'], ['Forest Green', '#154734'], ['Lime Green', '#78be20'],
  ['Neon Green', '#44d62c'], ['Olive', '#5e6738'], ['Military Green', '#4b5320'],
  ['Brown', '#4e3629'], ['Tan', '#c5a882'], ['Flesh / Skin Tone', '#e0b394'],
  ['Cream', '#f1e6b2'], ['Vegas Gold', '#c4b581'],
].map(([name, hex]) => makeInk(name, hex, 'Built-in plastisol'));

function makeInk(name, hex, library, code) {
  const rgb = parseHex(hex);
  return { name, code: code || '', hex: toHex(rgb), rgb, lab: rgbToLab(rgb), library: library || '' };
}

function inkFromLab(name, lab, library) {
  const rgb = labToRgb(lab);
  return { name, code: '', hex: toHex(rgb), rgb, lab: rgbToLab(rgb), library: library || '' };
}

function cmykToRgb(c, m, y, k) {
  return [255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k)].map(Math.round);
}

// ---------- importers ----------

function parseCsv(text, library) {
  const inks = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') && !/^#[0-9a-f]{6}\b/i.test(line)) continue;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
    const hexCell = cells.find((c) => /^#?[0-9a-fA-F]{6}$/.test(c));
    const name = cells.find((c) => c && !/^#?[0-9a-fA-F]{6}$/.test(c) && isNaN(Number(c))) || '';
    if (/^(name|color|ink)$/i.test(name) && !hexCell) continue; // header row
    const nums = cells.filter((c) => c !== '' && !isNaN(Number(c))).map(Number);
    let ink = null;
    if (hexCell) ink = makeInk(name || hexCell, hexCell.startsWith('#') ? hexCell : '#' + hexCell, library);
    else if (nums.length >= 3 && /\blab\b/i.test(line)) ink = inkFromLab(name, nums.slice(0, 3), library);
    else if (nums.length >= 3) ink = makeInk(name, toHex(nums.slice(0, 3)), library);
    if (ink) inks.push(ink);
  }
  return inks;
}

function parseGpl(text, library) {
  const inks = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/);
    if (m) inks.push(makeInk(m[4].trim() || 'Color', toHex([+m[1], +m[2], +m[3]]), library));
  }
  return inks;
}

// Adobe Swatch Exchange (.ase).
function parseAse(buffer, library) {
  const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'ASEF') throw new Error('Not an Adobe Swatch Exchange (.ase) file');
  const blocks = dv.getUint32(8);
  let p = 12;
  const inks = [];
  for (let i = 0; i < blocks && p < dv.byteLength; i++) {
    const type = dv.getUint16(p); const len = dv.getUint32(p + 2);
    const start = p + 6;
    if (type === 0x0001) {
      const nameLen = dv.getUint16(start);
      let name = '';
      for (let j = 0; j < nameLen - 1; j++) name += String.fromCharCode(dv.getUint16(start + 2 + j * 2));
      let q = start + 2 + nameLen * 2;
      const model = String.fromCharCode(dv.getUint8(q), dv.getUint8(q + 1), dv.getUint8(q + 2), dv.getUint8(q + 3)).trim();
      q += 4;
      const f = (k) => dv.getFloat32(q + k * 4);
      if (model === 'RGB') inks.push(makeInk(name, toHex([f(0) * 255, f(1) * 255, f(2) * 255]), library));
      else if (model === 'CMYK') inks.push(makeInk(name, toHex(cmykToRgb(f(0), f(1), f(2), f(3))), library));
      else if (model === 'LAB') inks.push(inkFromLab(name, [f(0) * 100, f(1), f(2)], library));
      else if (model === 'Gray') inks.push(makeInk(name, toHex([f(0) * 255, f(0) * 255, f(0) * 255]), library));
    }
    p = start + len;
  }
  return inks;
}

// Photoshop swatches (.aco), version 1 or 2.
function parseAco(buffer, library) {
  const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer, buffer.byteOffset || 0, buffer.byteLength);
  const readSection = (p) => {
    const version = dv.getUint16(p); const count = dv.getUint16(p + 2);
    let q = p + 4;
    const out = [];
    for (let i = 0; i < count; i++) {
      const space = dv.getUint16(q);
      const w = [dv.getUint16(q + 2), dv.getUint16(q + 4), dv.getUint16(q + 6), dv.getUint16(q + 8)];
      q += 10;
      let name = '';
      if (version === 2) {
        q += 2;
        const n = dv.getUint16(q); q += 2;
        for (let j = 0; j < n; j++) { const c = dv.getUint16(q + j * 2); if (c) name += String.fromCharCode(c); }
        q += n * 2;
      }
      let ink = null;
      if (space === 0) ink = makeInk(name || 'Color', toHex([w[0] / 257, w[1] / 257, w[2] / 257]), library);
      else if (space === 2) ink = makeInk(name || 'Color', toHex(cmykToRgb(1 - w[0] / 65535, 1 - w[1] / 65535, 1 - w[2] / 65535, 1 - w[3] / 65535)), library);
      else if (space === 7) ink = inkFromLab(name || 'Color', [w[0] / 100, (w[1] << 16 >> 16) / 100, (w[2] << 16 >> 16) / 100], library);
      else if (space === 8) ink = makeInk(name || 'Color', toHex([255 - w[0] / 39.2, 255 - w[0] / 39.2, 255 - w[0] / 39.2]), library);
      if (ink) out.push(ink);
    }
    return { version, out, end: q };
  };
  const first = readSection(0);
  if (first.version === 1 && first.end + 4 <= dv.byteLength) {
    try { const second = readSection(first.end); if (second.version === 2) return second.out; } catch (e) { /* v1 only */ }
  }
  return first.out;
}

function parseLibrary(fileName, data, library) {
  const lib = library || fileName.replace(/\.[^.]+$/, '');
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const asText = () => (typeof data === 'string' ? data : new TextDecoder().decode(data));
  let inks;
  if (ext === 'ase') inks = parseAse(data, lib);
  else if (ext === 'aco') inks = parseAco(data, lib);
  else if (ext === 'gpl') inks = parseGpl(asText(), lib);
  else inks = parseCsv(asText(), lib);
  if (!inks.length) throw new Error(`No colors found in ${fileName}`);
  return inks;
}

function nearestInk(lab, library, exclude) {
  let best = null, bestD = Infinity;
  for (const ink of library) {
    if (exclude && exclude.has(ink.name)) continue;
    const d = deltaE2000(lab, ink.lab);
    if (d < bestD) { bestD = d; best = ink; }
  }
  return best ? { ink: best, deltaE: bestD } : null;
}

module.exports = { BUILT_IN, makeInk, inkFromLab, parseCsv, parseGpl, parseAse, parseAco, parseLibrary, nearestInk };
