'use strict';
// Film output: turns a continuous-tone plate into a bitmap at film
// resolution. Options:
//   type   'am'         Conventional halftone dots (frequency + angle + shape)
//          'fm'         Stochastic / diffusion dither with a minimum dot size
//          'threshold'  Solid art (50% cut), for spot colors
//          'index'      Already-bitmapped plate, scaled with hard pixels
//          'continuous' No bitmapping (let your RIP do the halftone)
//   lpi, angle, dot ('round'|'ellipse'|'square'|'diamond'|'line'), dpi,
//   fmDot (px at film dpi), mirror, marginIn, marks, label

const { samplePlate } = require('./image-ops');

const M = 64; // threshold cell resolution
const thresholdCache = new Map();

function spot(shape, x, y) {
  const ax = Math.abs(x), ay = Math.abs(y);
  switch (shape) {
    case 'square': return -Math.max(ax, ay);
    case 'diamond': return -(ax + ay);
    case 'line': return -ay;
    case 'ellipse': return ax + ay * 0.8 > 1 ? (ax - 1) ** 2 + ((ay - 1) ** 2) * 1.6 - 1 : 1 - (ax * ax + 1.6 * ay * ay);
    case 'round':
    default:
      // PostScript Euclidean dot: round in highlights and shadows, checker at 50%.
      return ax + ay > 1 ? (ax - 1) ** 2 + (ay - 1) ** 2 - 1 : 1 - (ax * ax + ay * ay);
  }
}

function thresholdMatrix(shape) {
  if (thresholdCache.has(shape)) return thresholdCache.get(shape);
  const vals = [];
  for (let j = 0; j < M; j++) {
    for (let i = 0; i < M; i++) {
      const x = ((i + 0.5) / M) * 2 - 1, y = ((j + 0.5) / M) * 2 - 1;
      // Tiny deterministic jitter breaks ties so tone steps are even.
      vals.push([spot(shape, x, y) + ((i * 7919 + j * 104729) % 997) * 1e-9, j * M + i]);
    }
  }
  vals.sort((a, b) => b[0] - a[0]);
  const t = new Float32Array(M * M);
  vals.forEach(([, idx], rank) => { t[idx] = (rank + 0.5) / (M * M); });
  thresholdCache.set(shape, t);
  return t;
}

function renderBitmap(plate, srcW, srcH, srcDpi, o) {
  const dpi = o.type === 'continuous' ? srcDpi : (o.dpi || 720);
  const scale = dpi / srcDpi;
  // o.region {x, y, w, h} renders only that window of the film (previews).
  const R = o.region && o.type !== 'continuous' ? o.region : null;
  const ox = R ? R.x : 0, oy = R ? R.y : 0;
  const w = R ? R.w : Math.max(1, Math.round(srcW * scale)), h = R ? R.h : Math.max(1, Math.round(srcH * scale));
  const out = new Uint8Array(w * h);
  const inv = 1 / scale;
  if (o.type === 'continuous') {
    out.set(plate);
    return { data: out, width: w, height: h, dpi, bits: 8 };
  }
  if (o.type === 'index') {
    for (let y = 0; y < h; y++) {
      const sy = Math.min(srcH - 1, Math.floor((y + oy) * inv));
      for (let x = 0; x < w; x++) out[y * w + x] = plate[sy * srcW + Math.min(srcW - 1, Math.floor((x + ox) * inv))] >= 128 ? 255 : 0;
    }
    return { data: out, width: w, height: h, dpi, bits: 1 };
  }
  if (o.type === 'threshold') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[y * w + x] = samplePlate(plate, srcW, srcH, (x + ox + 0.5) * inv, (y + oy + 0.5) * inv) >= 0.5 ? 255 : 0;
    }
    return { data: out, width: w, height: h, dpi, bits: 1 };
  }
  if (o.type === 'fm') {
    const dot = Math.max(1, Math.round(o.fmDot || 3));
    const gw = Math.ceil(w / dot), gh = Math.ceil(h / dot);
    const err = new Float32Array((gw + 2) * 2);
    const bits = new Uint8Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      const cur = (gy & 1) * (gw + 2), nxt = ((gy + 1) & 1) * (gw + 2);
      err.fill(0, nxt, nxt + gw + 2);
      const ltr = (gy & 1) === 0;
      for (let k = 0; k < gw; k++) {
        const gx = ltr ? k : gw - 1 - k;
        const v = samplePlate(plate, srcW, srcH, ((gx + 0.5) * dot + ox) * inv, ((gy + 0.5) * dot + oy) * inv) + err[cur + gx + 1];
        const on = v >= 0.5 ? 1 : 0;
        bits[gy * gw + gx] = on;
        const q = v - on, d = ltr ? 1 : -1;
        err[cur + gx + 1 + d] += q * 7 / 16;
        err[nxt + gx + 1 - d] += q * 3 / 16;
        err[nxt + gx + 1] += q * 5 / 16;
        err[nxt + gx + 1 + d] += q / 16;
      }
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = bits[Math.floor(y / dot) * gw + Math.floor(x / dot)] ? 255 : 0;
    return { data: out, width: w, height: h, dpi, bits: 1 };
  }
  // AM halftone. Tones under the smallest holdable dot (after smoothing up
  // to film resolution) are dropped or raised, so no specks reach the screen.
  const lo = o.minDot || 0;
  const t = thresholdMatrix(o.dot || 'round');
  const cell = dpi / (o.lpi || 55);
  const a = ((o.angle == null ? 22.5 : o.angle) * Math.PI) / 180;
  const ca = Math.cos(a) / cell, sa = Math.sin(a) / cell;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const X = x + ox, Y = y + oy;
      const u = X * ca + Y * sa, v = -X * sa + Y * ca;
      const fu = u - Math.floor(u), fv = v - Math.floor(v);
      const thr = t[((fv * M) | 0) * M + ((fu * M) | 0)];
      let c = samplePlate(plate, srcW, srcH, (X + 0.5) * inv, (Y + 0.5) * inv);
      if (c < lo) c = c < lo / 2 ? 0 : lo;
      out[y * w + x] = c > thr ? 255 : 0;
    }
  }
  return { data: out, width: w, height: h, dpi, bits: 1 };
}

// ---------- marks and labels ----------

const FONT = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111', 0: '01110100011001110101110011000101110',
  1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111', 3: '11111000100010000010000011000101110',
  4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110', 6: '00110010001000011110100011000101110',
  7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100',
  '.': '00000000000000000000000000110001100', '-': '00000000000000011111000000000000000', '/': '00001000100001000100010000100010000',
  '%': '11000110010001000100010001001100011', ':': '00000011000110000000011000110000000', '#': '01010010101111101010111110101001010',
  '°': '01100100101001001100000000000000000', '(': '00010001000100001000010000010000010', ')': '01000001000001000010000100010001000',
  '+': '00000001000010011111001000010000000', ' ': '00000000000000000000000000000000000',
};

function drawText(img, text, x0, y0, scale) {
  let x = x0;
  for (const ch of String(text).toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (g[r * 5 + c] !== '1') continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) setPx(img, x + c * scale + dx, y0 + r * scale + dy);
      }
    }
    x += 6 * scale;
  }
  return x - x0;
}

function setPx(img, x, y) {
  if (x >= 0 && y >= 0 && x < img.width && y < img.height) img.data[y * img.width + x] = 255;
}

function drawTarget(img, cx, cy, r, lw) {
  for (let y = -r - lw; y <= r + lw; y++) {
    for (let x = -r - lw; x <= r + lw; x++) {
      const d = Math.hypot(x, y);
      const ring = Math.abs(d - r * 0.6) <= lw / 2;
      const cross = (Math.abs(x) <= lw / 2 && Math.abs(y) <= r) || (Math.abs(y) <= lw / 2 && Math.abs(x) <= r);
      if (ring || cross) setPx(img, cx + x, cy + y);
    }
  }
}

// Wrap a film in a margin with registration targets and a label.
function addMarks(film, o) {
  const margin = Math.round((o.marginIn == null ? 0.5 : o.marginIn) * film.dpi);
  if (margin <= 0 && !o.mirror) return film;
  const w = film.width + margin * 2, h = film.height + margin * 2;
  const out = { data: new Uint8Array(w * h), width: w, height: h, dpi: film.dpi, bits: film.bits };
  for (let y = 0; y < film.height; y++) {
    const row = film.data.subarray(y * film.width, (y + 1) * film.width);
    if (o.mirror) for (let x = 0; x < film.width; x++) out.data[(y + margin) * w + margin + x] = row[film.width - 1 - x];
    else out.data.set(row, (y + margin) * w + margin);
  }
  if (o.marks !== false && margin > 8) {
    const r = Math.round(margin * 0.32), lw = Math.max(1, Math.round(film.dpi / 300));
    const m2 = Math.round(margin / 2);
    drawTarget(out, Math.round(w / 2), m2, r, lw);
    drawTarget(out, Math.round(w / 2), h - m2, r, lw);
    drawTarget(out, m2, Math.round(h / 2), r, lw);
    drawTarget(out, w - m2, Math.round(h / 2), r, lw);
  }
  const lw = Math.max(1, Math.round(film.dpi / 300));
  const line = (x0, y0, x1, y1) => {
    for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) setPx(out, x, y);
  };
  if (o.crops && margin > 8) {
    // Corner crop marks just outside the art: they show the print area and
    // line up the films on a pre-registration board.
    const gap = Math.round(margin * 0.15), len = Math.round(margin * 0.45);
    const L = margin, T = margin, R = w - margin - 1, B = h - margin - 1;
    for (const [cx, cy, sx, sy] of [[L, T, -1, -1], [R, T, 1, -1], [L, B, -1, 1], [R, B, 1, 1]]) {
      line(cx + sx * gap, cy, cx + sx * (gap + len), cy + lw - 1);
      line(cx, cy + sy * gap, cx + lw - 1, cy + sy * (gap + len));
    }
  }
  if (o.center && margin > 8) {
    // Centre ticks on all four sides (pre-registration center line).
    const len = Math.round(margin * 0.18), cx = Math.round(w / 2), cy = Math.round(h / 2);
    const half = Math.floor(lw / 2);
    line(cx - half, margin - len, cx + half, margin - 2);
    line(cx - half, h - margin + 1, cx + half, h - margin + len);
    line(margin - len, cy - half, margin - 2, cy + half);
    line(w - margin + 1, cy - half, w - margin + len, cy + half);
  }
  if (o.label && margin > 10) {
    // Bottom-left, kept clear of the centre registration target.
    const room = Math.round(w / 2 - margin * 0.32 - margin * 0.25) - margin;
    let scale = Math.max(1, Math.floor((margin * 0.22) / 7));
    let text = String(o.label);
    while (scale > 1 && text.length * 6 * scale > room) scale--;
    while (text.length > 4 && text.length * 6 * scale > room) text = text.slice(0, -1);
    drawText(out, text, margin, h - Math.round(margin / 2) - Math.round(3.5 * scale), scale);
  }
  return out;
}

function renderFilm(plate, srcW, srcH, srcDpi, o) {
  const film = renderBitmap(plate, srcW, srcH, srcDpi, o || {});
  return addMarks(film, o || {});
}

// Standard mesh counts and a recommendation per screen.
const MESHES = [86, 110, 125, 140, 156, 160, 180, 196, 200, 230, 255, 280, 305, 355];

function nearestMesh(v) {
  return MESHES.reduce((b, m) => (Math.abs(m - v) < Math.abs(b - v) ? m : b), MESHES[0]);
}

function recommendMesh(screen, film) {
  const type = film.type;
  if (type === 'index') return { mesh: screen.role === 'underbase' ? 200 : 230, range: '200–305' };
  if (type === 'threshold') return screen.role === 'underbase' ? { mesh: 156, range: '125–160' } : { mesh: 156, range: '110–200' };
  if (type === 'fm') return { mesh: 280, range: '230–305' };
  const lpi = film.lpi || 55;
  if (screen.role === 'underbase') return { mesh: nearestMesh(lpi * 3.6), range: `${nearestMesh(lpi * 3)}–${nearestMesh(lpi * 4.2)}` };
  if (screen.role === 'highlight') return { mesh: nearestMesh(lpi * 3.6), range: `${nearestMesh(lpi * 3)}–${nearestMesh(lpi * 4.5)}` };
  return { mesh: nearestMesh(lpi * 4.5), range: `${nearestMesh(lpi * 4)}–${nearestMesh(lpi * 5.5)}` };
}

module.exports = { renderFilm, renderBitmap, addMarks, thresholdMatrix, recommendMesh, drawText, MESHES };
