'use strict';
// The separation engine. Takes an RGB(A) image and returns one plate per
// screen, in print order, plus an on-garment preview and a quality report.
//
// Modes
//   simulated  Halftone-friendly plates for photo-real art (sim process).
//   index      Every pixel is one ink (square-pixel diffusion dither).
//   spot       Solid, vector-style plates with speck clean-up and trapping.
//   cmyk       Four-color process with GCR and a total-ink limit.
//   grayscale  One ink carrying the image's tone.
//
// Simulated process model: each pixel is an area mix of garment and up to
// `maxInksPerPixel` inks, solved by least squares in Yule-Nielsen space
// (n = 2) on a 33^3 lookup table, then converted from "visible area" to
// plate coverage knowing the print order (a later ink covers part of an
// earlier one). The preview stacks the plates in the same order, so what
// you see is what the plates will print.

const C = require('./color');
const { pickColors, pickColorsDiverse } = require('./palette');
const { nearestInk, makeInk } = require('./inks');
const ops = require('./image-ops');
const { applyTexture } = require('./texture');

// Lookup-table resolution per axis. 33 for output; the live preview uses a
// smaller table (lutGrid option) so edits redraw quickly.
let GRID = 33;

// Recently built lookup tables, so tweaks that keep the same inks (dot
// limits, choke, film settings) don't rebuild them.
const lutCache = new Map();
function cachedLut(key, build) {
  if (lutCache.has(key)) { const v = lutCache.get(key); lutCache.delete(key); lutCache.set(key, v); return v; }
  const v = build();
  lutCache.set(key, v);
  while (lutCache.size > 6) lutCache.delete(lutCache.keys().next().value);
  return v;
}

const DEFAULTS = {
  mode: 'simulated',
  screens: 6,
  garment: '#000000',
  underbase: 'auto', // 'auto' | true | false
  underbaseStrength: 1.0,
  choke: 1, // px, underbase choke
  highlightWhite: 'auto',
  maxInksPerPixel: 3,
  minDot: 0.04,
  maxDot: 0.96,
  dotGain: 0,
  matchLibrary: false,
  library: null,
  lockedInks: [],
  inks: null, // explicit ink list from a previous run (user edits)
  cleanup: 1, // spot mode speck removal passes
  trap: 0, // spot mode trap (spread) px
  smoothEdges: true,
  indexDpi: 0, // 0 = keep document resolution
  gcr: 0.7,
  totalInk: 2.8,
  overlap: 'stack', // 'stack' (full color) | 'side' (dots side by side: less ink, softer hand)
  inkOpacity: 0.97,
  bareOpacity: 0.75, // ink opacity on a dark garment without underbase
  lutGrid: 33,
  underbaseStyle: 'tonal', // 'tonal' (follows the art's light) | 'inks' (solid under every ink)
  refine: true, // accuracy pass on fresh sim/index separations
  seed: 1234,
};

function isDark(garmentLab) {
  return garmentLab[0] < 55;
}

function opaqueMask(image) {
  if (image.channels !== 4) return null;
  const n = image.width * image.height;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = image.data[i * 4 + 3];
  return m;
}

// Composite RGBA over the garment so transparent areas read as garment.
function flatten(image, garmentRgb) {
  const n = image.width * image.height;
  const out = new Uint8ClampedArray(n * 3);
  const c = image.channels;
  for (let i = 0; i < n; i++) {
    const a = c === 4 ? image.data[i * 4 + 3] / 255 : 1;
    for (let k = 0; k < 3; k++) {
      out[i * 3 + k] = a === 1 ? image.data[i * c + k] : image.data[i * c + k] * a + garmentRgb[k] * (1 - a);
    }
  }
  return { data: out, width: image.width, height: image.height, channels: 3, dpi: image.dpi };
}

function shareAbove(image, minL) {
  const { data, width, height } = image;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
  let n = 0, hit = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 3;
      n++;
      if (C.rgbToLab([data[i], data[i + 1], data[i + 2]])[0] >= minL) hit++;
    }
  }
  return hit / Math.max(1, n);
}

// How much white a given ink needs beneath it on this garment (0..1).
// Saturated mid-tone inks (red, royal blue) need a strong base even though
// their lightness is only medium; a lightness-only underbase leaves them dull.
function underbaseNeed(inkLab, garmentLab) {
  const lift = (inkLab[0] - garmentLab[0]) / Math.max(1, 100 - garmentLab[0]);
  const chromaNeed = C.chroma(inkLab) / 55;
  return Math.max(0, Math.min(1, Math.max(lift * 1.15, chromaNeed * 0.9)));
}

// Tonal underbase amount for one art color: graded by lightness above the
// shirt, with saturation adding a little so bright reds and blues still
// pop. Unlike underbaseNeed (per ink, mostly 0 or 1) this keeps the art's
// shading, so the plate looks like a fuller version of the highlight white.
function tonalNeed(lab, garmentLab) {
  const lift = Math.max(0, (lab[0] - garmentLab[0]) / Math.max(1, 100 - garmentLab[0]));
  const chromaPart = C.chroma(lab) / 85;
  return Math.max(0, Math.min(1, Math.max(lift * 1.05, chromaPart)));
}

function screen(name, hex, role, extra) {
  const rgb = C.parseHex(hex);
  return Object.assign({ name, hex: C.toHex(rgb), rgb, lab: C.rgbToLab(rgb), role, code: '', library: '' }, extra || {});
}

// ---------- ink planning ----------

function planInks(img, o, garment) {
  const dark = isDark(garment.lab);
  const wantUb = o.underbase === 'auto' ? dark : !!o.underbase;
  if (o.inks && o.inks.length) {
    const colors = o.inks.filter((i) => i.role !== 'underbase').map((i) => screen(i.name, i.hex, i.role || 'color', { code: i.code || '', library: i.library || '', locked: !!i.locked, adjust: i.adjust || null, film: i.film || null, mergeInto: i.mergeInto || null, erase: i.erase || null }));
    return { colors, wantUb: o.inks.some((i) => i.role === 'underbase') || (o.underbase === true), dark };
  }
  if (o.mode === 'cmyk') {
    const colors = [
      screen('Process Cyan', '#00a0e9', 'process'), screen('Process Magenta', '#e4007f', 'process'),
      screen('Process Yellow', '#fff000', 'process'), screen('Process Black', '#1a1a1a', 'process'),
    ];
    if (dark) colors.push(screen('Highlight White', '#ffffff', 'highlight'));
    return { colors, wantUb, dark };
  }
  if (o.mode === 'grayscale') {
    const ink = dark ? screen('White', '#ffffff', 'color') : screen('Black', '#111111', 'color');
    return { colors: [ink], wantUb: false, dark };
  }
  let total = Math.max(1, Math.min(14, o.screens | 0));
  const fixed = [garment.lab];
  const colors = [];
  let ub = wantUb && total >= 3;
  if (ub) total -= 1;
  const highlight = o.highlightWhite === 'auto' ? dark && shareAbove(img, 82) > 0.001 : !!o.highlightWhite;
  for (const li of o.lockedInks || []) {
    if (total <= 0) break;
    const s = screen(li.name, li.hex, 'color', { code: li.code || '', library: li.library || '', locked: true });
    colors.push(s); fixed.push(s.lab); total--;
  }
  if (highlight && total > 0 && !colors.some((c) => c.lab[0] > 95 && C.chroma(c.lab) < 6)) {
    const role = ub || !dark ? 'highlight' : 'color';
    // With few screens, white comes from the underbase itself: the highlight
    // is still used to work out the colors, then merged into the underbase
    // so it doesn't cost a screen.
    const share = shareAbove(img, 88);
    const ownScreen = !ub || (o.screens | 0) >= 6 || ((o.screens | 0) >= 5 && share > 0.03);
    const w = screen(ub ? 'Highlight White' : 'White', '#ffffff', role, ownScreen ? {} : { mergeInto: 'Underbase White' });
    colors.push(w); fixed.push(w.lab);
    if (ownScreen) total--;
  }
  if (total > 0) {
    const flat = o.mode === 'spot';
    const pickOpts = { seed: o.seed, skipEdges: true, mergeDeltaE: flat ? 8 : 0, strongFrom: o.mode === 'simulated' || o.mode === 'index' ? garment.lab : null, strongFraction: o.strongFraction || (o.mode === 'index' ? 0.5 : 0.1) };
    let picked;
    if (o.picker === 'kmeans') picked = pickColors(img, total, fixed, pickOpts);
    else if (o.picker === 'diverse') picked = pickColorsDiverse(img, total, fixed, pickOpts);
    else if (o.mode === 'spot') picked = pickColorsDiverse(img, total, fixed, pickOpts);
    else picked = pickColors(img, total, fixed, pickOpts);
    picked.forEach((p) => colors.push(screen(C.colorName(p.lab), C.toHex(C.labToRgb(p.lab)), 'color', { share: p.share })));
  }
  if (o.matchLibrary && o.library && o.library.length) {
    const used = new Set(colors.filter((c) => c.locked).map((c) => c.name));
    for (const c of colors) {
      if (c.locked) continue;
      const m = nearestInk(c.lab, o.library, used);
      if (!m) continue;
      used.add(m.ink.name);
      Object.assign(c, { name: m.ink.name, hex: m.ink.hex, rgb: m.ink.rgb, lab: m.ink.lab, code: m.ink.code, library: m.ink.library, matchDeltaE: m.deltaE });
    }
  }
  uniqueNames(colors);
  return { colors, wantUb: ub, dark };
}

function uniqueNames(colors) {
  const base = (n) => n.replace(/ \d+$/, '');
  const total = new Map(), seen = new Map();
  for (const c of colors) if (!c.locked) total.set(base(c.name), (total.get(base(c.name)) || 0) + 1);
  for (const c of colors) {
    if (c.locked) continue;
    const b = base(c.name);
    const k = (seen.get(b) || 0) + 1;
    seen.set(b, k);
    c.name = total.get(b) > 1 && k > 1 ? `${b} ${k}` : b;
  }
}

// Two ways of choosing inks (area-weighted k-means, and the diversity
// picker that protects small distinct colors) are tried on a quick low-res
// separation; the palette whose print matches better wins. The score adds
// the worst-matched 5% so a missing color (a yellow lost to a second blue)
// counts even when it covers little area.
function bestPalette(image, o, ub, candidates) {
  const scale = Math.min(1, 160 / Math.max(image.width, image.height));
  const small = ops.resizeImage(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  small.dpi = (image.dpi || 300) * scale;
  const savedGrid = GRID;
  let best = candidates[0], bestScore = Infinity;
  for (const cand of candidates) {
    if (!cand.length) continue;
    const inks = (ub ? [{ name: 'Underbase White', hex: '#f4f4f0', role: 'underbase' }] : [])
      .concat(cand.map((c) => ({ name: c.name, hex: c.hex, role: c.role, locked: c.locked, mergeInto: c.mergeInto || null })));
    const r = separate(small, Object.assign({}, o, { inks, lutGrid: 13, refine: false, minDot: 0, maxDot: 1, despeckle: false, matchLibrary: false, _pruned: true }));
    let score = r.report.match.avgDeltaE + 0.35 * r.report.match.p95DeltaE;
    // A distinct, saturated color the other palette has but this one lacks
    // (a small red eye is nearly invisible at trial size) costs extra.
    for (const other of candidates) for (const c of other) {
      if (c.role === 'color' && C.chroma(c.lab) >= 35 && !cand.some((x) => C.deltaE2000(x.lab, c.lab) < 25)) score += 1.5;
    }
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  GRID = savedGrid;
  return best;
}

// Print order: underbase, colors light to dark, highlight white last.
function orderColors(colors) {
  const hl = colors.filter((c) => c.role === 'highlight');
  const rest = colors.filter((c) => c.role !== 'highlight');
  if (rest.every((c) => c.role === 'process')) return rest.concat(hl); // CMYK keeps C, M, Y, K
  rest.sort((a, b) => b.lab[0] - a.lab[0]);
  return rest.concat(hl);
}

// ---------- simulated process solver ----------

function solveSimplex(verts, target) {
  // verts: array of [y0,y1,y2]; minimise ||sum w v - t||, w >= 0, sum w = 1.
  const k = verts.length;
  let best = null, bestErr = Infinity;
  for (let mask = 1; mask < 1 << k; mask++) {
    const idx = [];
    for (let i = 0; i < k; i++) if (mask & (1 << i)) idx.push(i);
    const v0 = verts[idx[0]];
    const m = idx.length - 1;
    let t = [];
    if (m > 0) {
      const D = idx.slice(1).map((i) => [verts[i][0] - v0[0], verts[i][1] - v0[1], verts[i][2] - v0[2]]);
      const r = [target[0] - v0[0], target[1] - v0[1], target[2] - v0[2]];
      const A = [], b = [];
      for (let p = 0; p < m; p++) {
        A.push([]);
        for (let q = 0; q < m; q++) A[p].push(D[p][0] * D[q][0] + D[p][1] * D[q][1] + D[p][2] * D[q][2] + (p === q ? 1e-9 : 0));
        b.push(D[p][0] * r[0] + D[p][1] * r[1] + D[p][2] * r[2]);
      }
      t = gaussSolve(A, b);
      if (!t) continue;
    }
    const w0 = 1 - t.reduce((s, x) => s + x, 0);
    if (w0 < -1e-7 || t.some((x) => x < -1e-7)) continue;
    const w = new Array(k).fill(0);
    w[idx[0]] = Math.max(0, w0);
    idx.slice(1).forEach((i, j) => { w[i] = Math.max(0, t[j]); });
    let e = 0;
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let i = 0; i < k; i++) s += w[i] * verts[i][c];
      e += (s - target[c]) ** 2;
    }
    // Prefer less ink and fewer inks when the match is equally good.
    let inkSum = 0;
    for (let i = 1; i < k; i++) inkSum += w[i];
    e += 1e-5 * inkSum + 1e-6 * idx.length;
    if (e < bestErr) { bestErr = e; best = w; }
  }
  return best;
}

function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let q = c; q <= n; q++) M[r][q] -= f * M[c][q];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function buildSimLut(garment, colors, maxPer, pm) {
  const N = colors.length;
  const nodes = GRID * GRID * GRID;
  const lut = new Float32Array(nodes * N);
  const gY = pm.gY;
  const inkY = colors.map((c) => pm.appear(C.rgbToYn(c.rgb), pm.plannedOnUb(c.lab)));
  const per = Math.max(1, Math.min(N, maxPer));
  for (let ri = 0; ri < GRID; ri++) {
    for (let gi = 0; gi < GRID; gi++) {
      for (let bi = 0; bi < GRID; bi++) {
        const rgb = [ri, gi, bi].map((v) => Math.round((v * 255) / (GRID - 1)));
        const lab = C.rgbToLab(rgb);
        const target = C.rgbToYn(rgb);
        const order = colors.map((c, i) => [C.deltaE76(lab, c.lab), i]).sort((a, b) => a[0] - b[0]).slice(0, per).map((x) => x[1]);
        const w = solveSimplex([gY].concat(order.map((i) => inkY[i])), target);
        const base = ((ri * GRID + gi) * GRID + bi) * N;
        if (w) order.forEach((i, j) => { lut[base + i] = w[j + 1]; });
      }
    }
  }
  return lut;
}

// Tetrahedral interpolation of the LUT for one pixel into `out` (length N).
function lutLookup(lut, N, r, g, b, out) {
  const s = (GRID - 1) / 255;
  const fr = r * s, fg = g * s, fb = b * s;
  const x = Math.min(GRID - 2, fr | 0), y = Math.min(GRID - 2, fg | 0), z = Math.min(GRID - 2, fb | 0);
  const dx = fr - x, dy = fg - y, dz = fb - z;
  const idx = (i, j, k) => (((x + i) * GRID + (y + j)) * GRID + (z + k)) * N;
  const c000 = idx(0, 0, 0), c111 = idx(1, 1, 1);
  let a, b1, c1, d, wa, wb, wc, wd;
  if (dx >= dy) {
    if (dy >= dz) { a = c000; b1 = idx(1, 0, 0); c1 = idx(1, 1, 0); d = c111; wa = 1 - dx; wb = dx - dy; wc = dy - dz; wd = dz; }
    else if (dx >= dz) { a = c000; b1 = idx(1, 0, 0); c1 = idx(1, 0, 1); d = c111; wa = 1 - dx; wb = dx - dz; wc = dz - dy; wd = dy; }
    else { a = c000; b1 = idx(0, 0, 1); c1 = idx(1, 0, 1); d = c111; wa = 1 - dz; wb = dz - dx; wc = dx - dy; wd = dy; }
  } else {
    if (dz >= dy) { a = c000; b1 = idx(0, 0, 1); c1 = idx(0, 1, 1); d = c111; wa = 1 - dz; wb = dz - dy; wc = dy - dx; wd = dx; }
    else if (dz >= dx) { a = c000; b1 = idx(0, 1, 0); c1 = idx(0, 1, 1); d = c111; wa = 1 - dy; wb = dy - dz; wc = dz - dx; wd = dx; }
    else { a = c000; b1 = idx(0, 1, 0); c1 = idx(1, 1, 0); d = c111; wa = 1 - dy; wb = dy - dx; wc = dx - dz; wd = dz; }
  }
  for (let i = 0; i < N; i++) out[i] = lut[a + i] * wa + lut[b1 + i] * wb + lut[c1 + i] * wc + lut[d + i] * wd;
}

function separateSimulated(img, garment, colors, o, hasUb) {
  const N = colors.length;
  const n = img.width * img.height;
  const key = JSON.stringify(['sim', GRID, garment.hex, colors.map((c) => c.hex), o.maxInksPerPixel, hasUb, o.inkOpacity, o.bareOpacity, o.underbaseStrength]);
  const lut = cachedLut(key, () => buildSimLut(garment, colors, o.maxInksPerPixel, pressModel(garment, o, hasUb)));
  const plates = colors.map(() => new Uint8Array(n));
  const vis = new Float32Array(N);
  const d = img.data;
  const side = o.overlap === 'side';
  for (let p = 0; p < n; p++) {
    lutLookup(lut, N, d[p * 3], d[p * 3 + 1], d[p * 3 + 2], vis);
    if (side) {
      for (let i = 0; i < N; i++) plates[i][p] = Math.round(Math.max(0, Math.min(1, vis[i])) * 255);
      continue;
    }
    // Visible area -> plate coverage, top (last printed) down: a later ink
    // hides part of an earlier one, so earlier plates carry a little more.
    let rem = 1;
    for (let i = N - 1; i >= 0; i--) {
      const v = vis[i] > 0 ? vis[i] : 0;
      const a = rem > 1e-4 ? Math.min(1, v / rem) : 0;
      plates[i][p] = Math.round(a * 255);
      rem *= 1 - a;
    }
  }
  return plates;
}

// ---------- spot / index ----------

function nearestLabelLut(garment, colors, bits) {
  const size = 1 << bits;
  const pal = [garment.lab].concat(colors.map((c) => c.lab));
  const lut = new Uint8Array(size * size * size);
  const shift = 8 - bits;
  for (let r = 0; r < size; r++) {
    for (let g = 0; g < size; g++) {
      for (let b = 0; b < size; b++) {
        const rgb = [r, g, b].map((v) => (v << shift) + (1 << shift) / 2);
        const lab = C.rgbToLab(rgb);
        let best = 0, bd = Infinity;
        for (let i = 0; i < pal.length; i++) {
          const dd = C.deltaE2000(lab, pal[i]);
          if (dd < bd) { bd = dd; best = i; }
        }
        lut[(r * size + g) * size + b] = best;
      }
    }
  }
  return { lut, bits, shift, size };
}

function separateSpot(img, garment, colors, o) {
  const n = img.width * img.height;
  const L = cachedLut(JSON.stringify(['spot', garment.hex, colors.map((c) => c.hex)]), () => nearestLabelLut(garment, colors, 6));
  let labels = new Int16Array(n);
  const d = img.data;
  for (let p = 0; p < n; p++) {
    labels[p] = L.lut[(((d[p * 3] >> L.shift) * L.size) + (d[p * 3 + 1] >> L.shift)) * L.size + (d[p * 3 + 2] >> L.shift)];
  }
  if (o.cleanup > 0) labels = ops.modeFilter(labels, img.width, img.height, o.cleanup);
  let plates = colors.map((_, i) => {
    const pl = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (labels[p] === i + 1) pl[p] = 255;
    return pl;
  });
  if (o.trap > 0) {
    // Spread each ink under its neighbours (never onto bare garment) so a
    // little misregistration doesn't open gaps.
    plates = plates.map((pl, i) => {
      if (colors[i].role === 'highlight') return pl;
      const grown = ops.dilate(pl, img.width, img.height, o.trap);
      const out = new Uint8Array(n);
      for (let p = 0; p < n; p++) out[p] = labels[p] !== 0 ? Math.max(pl[p], grown[p]) : pl[p];
      return out;
    });
  }
  if (o.smoothEdges) plates = plates.map((pl) => ops.boxBlur3(pl, img.width, img.height));
  return { plates, labels };
}

function separateIndex(img, garment, colors, o, hasUb) {
  const w = img.width, h = img.height, n = w * h;
  const pal = [garment].concat(colors);
  const pm = pressModel(garment, o, hasUb);
  // Each index pixel prints one ink, on full underbase or none.
  const palY = [pm.gY].concat(colors.map((c) => pm.appear(C.rgbToYn(c.rgb), hasUb && indexNeedsUb(c, garment, o) ? 1 : 0)));
  const palLab = palY.map((y) => C.linearRgbToLab(C.ynToLinear(y[0]), C.ynToLinear(y[1]), C.ynToLinear(y[2])));
  // Each pixel may only use the garment and the few inks closest to its
  // own color. Unrestricted error diffusion reaches for far-off inks (green
  // dots in a yellow highlight), which is the classic index-sep artifact.
  const per = Math.max(1, Math.min(colors.length, o.maxInksPerPixel));
  const allowCache = new Int32Array(32768).fill(-1);
  const allowed = (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let m = allowCache[key];
    if (m < 0) {
      const lab = C.rgbToLab([(r & 248) + 4, (g & 248) + 4, (b & 248) + 4]);
      const order = palLab.slice(1).map((pl, i) => [C.deltaE76(lab, pl), i + 1]).sort((x, y) => x[0] - y[0]).slice(0, per);
      m = 1;
      for (const [, i] of order) m |= 1 << i;
      allowCache[key] = m;
    }
    return m;
  };
  const nearest = (v, mask) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < palY.length; i++) {
      if (!(mask & (1 << i))) continue;
      const d0 = v[0] - palY[i][0], d1 = v[1] - palY[i][1], d2 = v[2] - palY[i][2];
      const dd = d0 * d0 + d1 * d1 + d2 * d2;
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  };
  const err = new Float32Array((w + 2) * 2 * 3);
  const labels = new Int16Array(n);
  const d = img.data;
  for (let y = 0; y < h; y++) {
    const cur = (y & 1) * (w + 2) * 3, nxt = ((y + 1) & 1) * (w + 2) * 3;
    for (let i = 0; i < (w + 2) * 3; i++) err[nxt + i] = 0;
    const ltr = (y & 1) === 0;
    for (let k = 0; k < w; k++) {
      const x = ltr ? k : w - 1 - k;
      const p = y * w + x;
      const e = cur + (x + 1) * 3;
      const v = [0, 1, 2].map((c) => Math.max(0, Math.min(1, C.SRGB_TO_YN[d[p * 3 + c]] + err[e + c])));
      const li = nearest(v, allowed(d[p * 3], d[p * 3 + 1], d[p * 3 + 2]));
      labels[p] = li;
      const dir = ltr ? 1 : -1;
      for (let c = 0; c < 3; c++) {
        const q = v[c] - palY[li][c];
        err[e + dir * 3 + c] += q * 7 / 16;
        err[nxt + (x + 1 - dir) * 3 + c] += q * 3 / 16;
        err[nxt + (x + 1) * 3 + c] += q * 5 / 16;
        err[nxt + (x + 1 + dir) * 3 + c] += q * 1 / 16;
      }
    }
  }
  const plates = colors.map((_, i) => {
    const pl = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (labels[p] === i + 1) pl[p] = 255;
    return pl;
  });
  return { plates, labels };
}

// ---------- cmyk / grayscale ----------

// CMYK by inverting the same transparent-ink model the preview uses, with
// the actual ink colors, instead of the textbook 1-RGB formula (which turns
// royal blue teal and red orange with real process inks).
function cmykModelLab(a, inkLin, wLin) {
  const lin = [wLin[0], wLin[1], wLin[2]];
  for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) lin[k] *= 1 - a[i] + a[i] * inkLin[i][k];
  return C.linearRgbToLab(lin[0], lin[1], lin[2]);
}

function solveCmy(target, a, inkLin, wLin) {
  const free = [0, 1, 2];
  for (let iter = 0; iter < 14; iter++) {
    const f = cmykModelLab(a, inkLin, wLin);
    const r = [f[0] - target[0], f[1] - target[1], f[2] - target[2]];
    if (r[0] * r[0] + r[1] * r[1] + r[2] * r[2] < 0.01) break;
    const J = [[], [], []];
    for (const j of free) {
      const b = a.slice(); const h = a[j] > 0.5 ? -1e-3 : 1e-3; b[j] += h;
      const g = cmykModelLab(b, inkLin, wLin);
      for (let k = 0; k < 3; k++) J[k][j] = (g[k] - f[k]) / h;
    }
    // Levenberg-Marquardt step on (J^T J + lambda I) d = -J^T r.
    const A = [0, 1, 2].map((p) => [0, 1, 2].map((q) => J[0][p] * J[0][q] + J[1][p] * J[1][q] + J[2][p] * J[2][q] + (p === q ? 0.5 : 0)));
    const bb = [0, 1, 2].map((p) => -(J[0][p] * r[0] + J[1][p] * r[1] + J[2][p] * r[2]));
    const d = gaussSolve(A, bb);
    if (!d) break;
    for (const j of free) a[j] = Math.max(0, Math.min(1, a[j] + d[j]));
  }
  return a;
}

function buildCmykLut(colors, garment, o) {
  const inkLin = colors.slice(0, 4).map((c) => c.rgb.map((v) => C.srgbToLinear(v)));
  const wLin = garment.rgb.map((v) => C.srgbToLinear(v));
  const lut = new Float32Array(GRID * GRID * GRID * 4);
  for (let ri = 0; ri < GRID; ri++) {
    for (let gi = 0; gi < GRID; gi++) {
      for (let bi = 0; bi < GRID; bi++) {
        const rgb = [ri, gi, bi].map((v) => Math.round((v * 255) / (GRID - 1)));
        const target = C.rgbToLab(rgb);
        let a = [1 - rgb[0] / 255, 1 - rgb[1] / 255, 1 - rgb[2] / 255, 0];
        a = solveCmy(target, a, inkLin, wLin);
        // Gray component replacement: black takes over the shared gray part.
        const kMin = Math.min(a[0], a[1], a[2]);
        const t = Math.max(0, (kMin - 0.15) / 0.85);
        const k = Math.min(1, kMin * (o.gcr * t + (1 - o.gcr) * t * t) * 1.15);
        if (k > 0.005) {
          a = [Math.max(0, a[0] - k), Math.max(0, a[1] - k), Math.max(0, a[2] - k), k];
          a = solveCmy(target, a, inkLin, wLin);
        }
        const sum = a[0] + a[1] + a[2] + a[3];
        if (sum > o.totalInk) { const f = Math.max(0, o.totalInk - a[3]) / Math.max(1e-6, a[0] + a[1] + a[2]); a[0] *= f; a[1] *= f; a[2] *= f; }
        lut.set(a, ((ri * GRID + gi) * GRID + bi) * 4);
      }
    }
  }
  return lut;
}

function separateCmyk(img, o, colors, garment) {
  const n = img.width * img.height;
  const plates = [0, 1, 2, 3].map(() => new Uint8Array(n));
  const lut = cachedLut(JSON.stringify(['cmyk', GRID, garment.hex, colors.map((c) => c.hex), o.gcr, o.totalInk]), () => buildCmykLut(colors, garment, o));
  const v = new Float32Array(4);
  const d = img.data;
  for (let p = 0; p < n; p++) {
    lutLookup(lut, 4, d[p * 3], d[p * 3 + 1], d[p * 3 + 2], v);
    for (let i = 0; i < 4; i++) plates[i][p] = Math.round(Math.max(0, Math.min(1, v[i])) * 255);
  }
  return plates;
}

function separateGrayscale(img, garment, ink) {
  const n = img.width * img.height;
  const pl = new Uint8Array(n);
  const gy = C.rgbToYn(garment.rgb), iy = C.rgbToYn(ink.rgb);
  const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  const g = lum(gy), k = lum(iy);
  const d = img.data;
  for (let p = 0; p < n; p++) {
    const v = lum([C.SRGB_TO_YN[d[p * 3]], C.SRGB_TO_YN[d[p * 3 + 1]], C.SRGB_TO_YN[d[p * 3 + 2]]]);
    pl[p] = Math.round(Math.max(0, Math.min(1, (v - g) / (k - g || 1e-6))) * 255);
  }
  return [pl];
}

// ---------- underbase ----------

function indexNeedsUb(ink, garment, o) {
  return underbaseNeed(ink.lab, garment.lab) * o.underbaseStrength >= 0.25;
}

function buildUnderbase(plates, colors, garment, img, o) {
  const n = img.width * img.height;
  const ub = new Uint8Array(n);
  if (o.mode === 'index') {
    const on = colors.map((c) => indexNeedsUb(c, garment, o));
    for (let p = 0; p < n; p++) for (let i = 0; i < plates.length; i++) if (on[i] && plates[i][p] >= 128) { ub[p] = 255; break; }
    return ub;
  }
  const need = colors.map((c) => underbaseNeed(c.lab, garment.lab) * o.underbaseStrength);
  const tonal = o.underbaseStyle !== 'inks';
  const cache = new Map();
  const d = img.data;
  for (let p = 0; p < n; p++) {
    let open = 1;
    for (let i = 0; i < plates.length; i++) open *= 1 - Math.min(1, (plates[i][p] / 255) * need[i]);
    let v = 1 - open; // white under every ink that needs it
    if (tonal) {
      // Tonal underbase: follows the art's own light and color, like a
      // fuller version of the highlight white. Dark and dull areas get a
      // thin base (the shirt does the work), bright and saturated areas a
      // full one. Never more than the inks above it cover.
      const key = (d[p * 3] << 16) | (d[p * 3 + 1] << 8) | d[p * 3 + 2];
      let t = cache.get(key);
      if (t === undefined) {
        t = Math.min(1, tonalNeed(C.rgbToLab([d[p * 3], d[p * 3 + 1], d[p * 3 + 2]]), garment.lab) * o.underbaseStrength);
        cache.set(key, t);
      }
      v = Math.min(v, t);
    }
    ub[p] = Math.round(v * 255);
  }
  return o.choke > 0 && o.mode !== 'index' ? ops.erode(ub, img.width, img.height, o.choke) : ub;
}

// ---------- plate finishing ----------

function compensateDotGain(v, g) {
  if (g <= 0 || v <= 0 || v >= 1) return v;
  const a = 4 * g, b = 1 + 4 * g;
  return (b - Math.sqrt(b * b - 4 * a * v)) / (2 * a);
}

// Lone inked pixels (0-1 inked neighbours) come from anti-aliased edges
// picking up a trace of an unrelated ink. On film they become specks.
function despeckle(plate, w, h) {
  const out = new Uint8Array(plate);
  let removed = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!plate[i]) continue;
      let nb = 0;
      for (let dy = -1; dy <= 1 && nb < 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((dx || dy) && xx >= 0 && xx < w && plate[yy * w + xx]) nb++;
        }
      }
      if (nb < 2) { out[i] = 0; removed++; }
    }
  }
  return { plate: out, removed };
}

function finishPlate(plate, o, binary) {
  if (binary) return { plate, removed: 0 };
  const lut = new Uint8Array(256);
  const lo = o.minDot, hi = o.maxDot;
  for (let i = 0; i < 256; i++) {
    let v = compensateDotGain(i / 255, o.dotGain);
    // Dots smaller than the screen can hold are rounded to nothing or to the
    // smallest holdable dot, so tone is kept on average and no specks burn.
    if (lo > 0 && v > 0 && v < lo) v = v < lo / 2 ? 0 : lo;
    if (hi < 1 && v < 1 && v > hi) v = v > (1 + hi) / 2 ? 1 : hi;
    lut[i] = Math.round(v * 255);
  }
  let removed = 0;
  const out = new Uint8Array(plate.length);
  for (let p = 0; p < plate.length; p++) {
    const v = lut[plate[p]];
    if (plate[p] > 0 && v === 0) removed++;
    out[p] = v;
  }
  return { plate: out, removed };
}

// ---------- preview + report ----------

// ---------- press model (shared by solver and preview) ----------
//
// An ink printed on a dark garment looks like itself only where there is
// underbase beneath it; on bare fabric it lets some of the shirt through.
// The solver mixes these "as printed" ink colors, and the preview uses the
// same rules, so the match score is a fair prediction of the print.

const UB_WHITE = [244, 244, 240];

function pressModel(garment, o, hasUb) {
  const gY = C.rgbToYn(garment.rgb);
  const dark = isDark(garment.lab);
  const ubY = C.rgbToYn(UB_WHITE).map((v, k) => v * 0.9 + gY[k] * 0.1);
  // Appearance of an ink (YN) given how much of it sits on underbase (0..1).
  const appear = (inkY, onUb) => {
    const op = dark ? o.bareOpacity + (o.inkOpacity - o.bareOpacity) * onUb : o.inkOpacity;
    const under = [0, 1, 2].map((k) => gY[k] + (ubY[k] - gY[k]) * onUb);
    return [0, 1, 2].map((k) => inkY[k] * op + under[k] * (1 - op));
  };
  const plannedOnUb = (lab) => (hasUb ? Math.min(1, underbaseNeed(lab, garment.lab) * o.underbaseStrength) : 0);
  return { gY, ubY, dark, appear, plannedOnUb };
}

function gainCurve(g) {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const a = i / 255; lut[i] = Math.min(1, a + 4 * g * a * (1 - a)); }
  return lut;
}

function composite(screens, garment, w, h, o, opts) {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  const ubIdx = screens.findIndex((s) => s.role === 'underbase');
  const pm = pressModel(garment, o, ubIdx >= 0);
  const { gY, ubY } = pm;
  const inkY = screens.map((s) => C.rgbToYn(s.rgb));
  const inkLin = screens.map((s) => s.rgb.map((v) => C.srgbToLinear(v)));
  const side = o.mode === 'simulated' && o.overlap === 'side';
  // Transparent process inks show the whole underbase beneath them.
  const hasProcess = screens.some((x) => x.role === 'process');
  // Continuous plates get press dot gain (they were compensated for it).
  const gain = gainCurve(opts && opts.binary ? 0 : o.dotGain);
  // Ink appearance by how much of it sits on underbase, 0..1 in 64 steps.
  const Q = 64;
  const appearTab = screens.map((_, i) => {
    const t = new Float32Array((Q + 1) * 3);
    for (let q = 0; q <= Q; q++) t.set(pm.appear(inkY[i], q / Q), q * 3);
    return t;
  });
  const OUT = 4096;
  const toByte = new Uint8Array(OUT + 1);
  for (let i = 0; i <= OUT; i++) toByte[i] = C.linearToSrgb(C.ynToLinear(i / OUT));
  const byte = (v) => toByte[v <= 0 ? 0 : v >= 1 ? OUT : (v * OUT + 0.5) | 0];
  const N = screens.length;
  const a = new Float32Array(N);
  const mix = new Float32Array(3);
  let c0, c1, c2;
  for (let p = 0; p < n; p++) {
    let open = 1, sum = 0;
    for (let i = 0; i < N; i++) {
      a[i] = gain[screens[i].plate[p]];
      if (i !== ubIdx) { open *= 1 - a[i]; sum += a[i]; }
    }
    const union = side ? Math.min(1, sum) : 1 - open;
    const ub = ubIdx >= 0 ? a[ubIdx] : 0;
    // Same angle and frequency on every screen, so underbase dots sit under
    // the color dots; only underbase beyond the color coverage shows.
    const ubShow = hasProcess ? ub : ub > union ? ub - union : 0;
    const q = (union > 1e-4 ? Math.min(1, ub / union) * Q + 0.5 : 0) | 0;
    c0 = gY[0] + (ubY[0] - gY[0]) * ubShow;
    c1 = gY[1] + (ubY[1] - gY[1]) * ubShow;
    c2 = gY[2] + (ubY[2] - gY[2]) * ubShow;
    if (side) {
      const norm = sum > 1 ? 1 / sum : 1;
      const keep = 1 - union;
      mix[0] = c0 * keep; mix[1] = c1 * keep; mix[2] = c2 * keep;
      for (let i = 0; i < N; i++) {
        if (i === ubIdx || a[i] <= 0) continue;
        const t = appearTab[i], f = a[i] * norm, b = q * 3;
        mix[0] += f * t[b]; mix[1] += f * t[b + 1]; mix[2] += f * t[b + 2];
      }
      c0 = mix[0]; c1 = mix[1]; c2 = mix[2];
    } else {
      for (let i = 0; i < N; i++) {
        const ai = a[i];
        if (i === ubIdx || ai <= 0) continue;
        if (screens[i].role === 'process') {
          // Process inks are transparent: they filter what is under them.
          const L = inkLin[i];
          c0 = Math.sqrt(c0 * c0 * (1 - ai + ai * L[0]));
          c1 = Math.sqrt(c1 * c1 * (1 - ai + ai * L[1]));
          c2 = Math.sqrt(c2 * c2 * (1 - ai + ai * L[2]));
          continue;
        }
        const t = appearTab[i], b = q * 3;
        c0 += (t[b] - c0) * ai; c1 += (t[b + 1] - c1) * ai; c2 += (t[b + 2] - c2) * ai;
      }
    }
    out[p * 4] = byte(c0); out[p * 4 + 1] = byte(c1); out[p * 4 + 2] = byte(c2); out[p * 4 + 3] = 255;
  }
  return out;
}

// Compares art and preview as seen from a short distance: both are averaged
// over a 5x5 neighbourhood so dither and halftone patterns are judged by
// the color they make, not pixel by pixel.
function matchStats(img, preview, mask, lightnessOnly) {
  const w = img.width, h = img.height, n = w * h;
  const step = Math.max(1, Math.floor(n / 30000));
  const ds = [];
  const avgAt = (data, c, x, y) => {
    const s = [0, 0, 0];
    let k = 0;
    for (let dy = -2; dy <= 2; dy++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy));
      for (let dx = -2; dx <= 2; dx++) {
        const xx = Math.min(w - 1, Math.max(0, x + dx));
        const i = (yy * w + xx) * c;
        s[0] += C.SRGB_TO_LINEAR[data[i]]; s[1] += C.SRGB_TO_LINEAR[data[i + 1]]; s[2] += C.SRGB_TO_LINEAR[data[i + 2]]; k++;
      }
    }
    return C.linearRgbToLab(s[0] / k, s[1] / k, s[2] / k);
  };
  for (let p = 0; p < n; p += step) {
    if (mask && mask[p] < 128) continue;
    const x = p % w, y = (p / w) | 0;
    const a = avgAt(img.data, 3, x, y);
    const b = avgAt(preview, 4, x, y);
    ds.push(lightnessOnly ? Math.abs(a[0] - b[0]) : C.deltaE2000(a, b));
  }
  ds.sort((x, y) => x - y);
  const avg = ds.reduce((s, v) => s + v, 0) / Math.max(1, ds.length);
  return { avg, p95: ds[Math.floor(ds.length * 0.95)] || 0, max: ds[ds.length - 1] || 0 };
}

// ---------- per-screen adjustments ----------
//
// adjust = { amount: 0..2 (how much of this ink), levels: { inBlack, inWhite,
// gamma, outBlack, outWhite } (0..1, like Photoshop Levels on the plate),
// spread: -4..4 px (negative chokes, positive spreads) }.

function adjustLut(adj) {
  const lv = Object.assign({ inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }, adj.levels || {});
  const amount = adj.amount == null ? 1 : adj.amount;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    if (i === 0) { lut[i] = Math.round(Math.max(0, lv.outBlack) * 255 * (lv.inBlack <= 0 ? 1 : 0)); continue; }
    v = Math.max(0, Math.min(1, (v - lv.inBlack) / Math.max(1e-3, lv.inWhite - lv.inBlack)));
    v = Math.pow(v, 1 / Math.max(0.1, lv.gamma));
    v = lv.outBlack + v * (lv.outWhite - lv.outBlack);
    v = Math.max(0, Math.min(1, v * amount));
    lut[i] = Math.round(v * 255);
  }
  lut[0] = 0; // never add ink where the plate has none
  return lut;
}

function isIdentity(adj) {
  if (!adj) return true;
  const lv = adj.levels || {};
  return (adj.amount == null || adj.amount === 1) && !adj.spread &&
    (lv.inBlack || 0) === 0 && (lv.inWhite == null || lv.inWhite === 1) && (lv.gamma == null || lv.gamma === 1) &&
    (lv.outBlack || 0) === 0 && (lv.outWhite == null || lv.outWhite === 1);
}

function applyAdjust(plate, adj, w, h, binary) {
  if (isIdentity(adj)) return plate;
  let out = plate;
  if (!binary) {
    const lut = adjustLut(adj);
    out = new Uint8Array(plate.length);
    for (let p = 0; p < plate.length; p++) out[p] = lut[plate[p]];
  } else if (adj.amount != null && adj.amount < 0.5) {
    out = new Uint8Array(plate.length); // index: "amount" under 50% drops the ink
  }
  if (adj.spread > 0) out = ops.dilate(out, w, h, Math.round(adj.spread));
  else if (adj.spread < 0) out = ops.erode(out, w, h, Math.round(-adj.spread));
  return out;
}

// Histogram of a plate (64 bins, ink pixels only) for the Levels UI.
function plateHistogram(plate) {
  const bins = new Array(64).fill(0);
  const step = Math.max(1, Math.floor(plate.length / 200000));
  for (let p = 0; p < plate.length; p += step) if (plate[p]) bins[plate[p] >> 2]++;
  return bins;
}

// ---------- local clean-up (eraser) ----------
//
// Edits are stored in art coordinates (0..1 of width/height), so they apply
// the same to the fast proof and the full-size output.
//   { type: 'brush', r, pts: [[x, y], ...] }  erase ink along a painted path
//   { type: 'area', x, y, limit, tol }       erase the connected patch of ink
//                                            around a clicked point (within
//                                            `limit` of it), not the whole color
function regionMask(img, w, h, e) {
  // Connected pixels of the art whose color is close to the clicked color.
  const sx = Math.min(w - 1, Math.max(0, Math.round(e.x * w))), sy = Math.min(h - 1, Math.max(0, Math.round(e.y * h)));
  const d = img.data, cache = new Map();
  const labAt = (i) => {
    const key = (d[i * 3] << 16) | (d[i * 3 + 1] << 8) | d[i * 3 + 2];
    let v = cache.get(key);
    if (!v) { v = C.rgbToLab([d[i * 3], d[i * 3 + 1], d[i * 3 + 2]]); cache.set(key, v); }
    return v;
  };
  const seed = sy * w + sx, ref = labAt(seed), tol = e.tol == null ? 14 : e.tol;
  const lim = (e.limit == null ? 0.25 : e.limit) * w, lim2 = lim * lim;
  const mask = new Uint8Array(w * h);
  const stack = [seed];
  mask[seed] = 1;
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (mask[j] || (nx - sx) * (nx - sx) + (ny - sy) * (ny - sy) > lim2) continue;
      if (C.deltaE76(labAt(j), ref) > tol) continue;
      mask[j] = 1;
      stack.push(j);
    }
  }
  // Grow by one pixel so anti-aliased edges of the patch go too.
  return ops.dilate(mask, w, h, 1);
}

function applyErase(plate, w, h, list, img) {
  const out = new Uint8Array(plate);
  for (const e of list) {
    if (e.type === 'region') {
      if (!img) continue;
      if (!e._mask || e._mask.length !== w * h) Object.defineProperty(e, '_mask', { value: regionMask(img, w, h, e), enumerable: false, writable: true, configurable: true });
      for (let p = 0; p < out.length; p++) if (e._mask[p]) out[p] = 0;
      continue;
    }
    if (e.type === 'area') {
      const sx = Math.min(w - 1, Math.max(0, Math.round(e.x * w))), sy = Math.min(h - 1, Math.max(0, Math.round(e.y * h)));
      const thr = Math.round((e.tol == null ? 0.03 : e.tol) * 255);
      // Start at the nearest inked pixel to the click (within a few px).
      let seed = -1, best = Infinity;
      const look = Math.max(3, Math.round(w * 0.01));
      for (let dy = -look; dy <= look; dy++) for (let dx = -look; dx <= look; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h || out[y * w + x] <= thr) continue;
        const d = dx * dx + dy * dy;
        if (d < best) { best = d; seed = y * w + x; }
      }
      if (seed < 0) continue;
      const lim = (e.limit == null ? 0.25 : e.limit) * w, lim2 = lim * lim;
      const stack = [seed];
      const seen = new Uint8Array(w * h);
      seen[seed] = 1;
      while (stack.length) {
        const i = stack.pop();
        out[i] = 0;
        const x = i % w, y = (i / w) | 0;
        for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (seen[j] || out[j] <= thr) continue;
          if ((nx - sx) * (nx - sx) + (ny - sy) * (ny - sy) > lim2) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    } else {
      const r = Math.max(0.5, (e.r || 0.01) * w);
      const pts = e.pts || [];
      // Densify the path so fast strokes leave no gaps.
      const path = [];
      for (let k = 0; k < pts.length; k++) {
        const [x1, y1] = pts[k];
        if (k === 0) { path.push([x1 * w, y1 * h]); continue; }
        const [x0, y0] = pts[k - 1];
        const steps = Math.max(1, Math.ceil(Math.hypot((x1 - x0) * w, (y1 - y0) * h) / Math.max(1, r / 2)));
        for (let t = 1; t <= steps; t++) path.push([(x0 + (x1 - x0) * t / steps) * w, (y0 + (y1 - y0) * t / steps) * h]);
      }
      for (const [cx, cy] of path) {
        const x0 = Math.max(0, Math.floor(cx - r - 1)), x1 = Math.min(w - 1, Math.ceil(cx + r + 1));
        const y0 = Math.max(0, Math.floor(cy - r - 1)), y1 = Math.min(h - 1, Math.ceil(cy + r + 1));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          if (d <= r) out[y * w + x] = 0;
          else if (d < r + 1) out[y * w + x] = Math.round(out[y * w + x] * (d - r)); // soft 1 px edge
        }
      }
    }
  }
  return out;
}

// ---------- CMYK on dark garments ----------
// A white underbase goes down where the art needs to be lighter or more
// colorful than the shirt; the process inks then filter that white. Each
// pixel's target is divided by its base (white over underbase, shirt
// elsewhere) before looking up CMYK, so partial underbase tones stay true.

function separateCmykDark(img, o, colors, garment) {
  const n = img.width * img.height, w = img.width, h = img.height;
  // Same press model as the preview: underbase is a halftone mixed with the
  // shirt in YN space, then the transparent process inks filter that base.
  const pm = pressModel(garment, o, true);
  const white = Object.assign({}, garment, { hex: '#ffffff', rgb: [255, 255, 255] });
  const lut = cachedLut(JSON.stringify(['cmyk', GRID, white.hex, colors.slice(0, 4).map((c) => c.hex), o.gcr, o.totalInk]), () => buildCmykLut(colors, white, o));
  const inkLin = colors.slice(0, 4).map((c) => c.rgb.map((x) => C.srgbToLinear(x)));
  const v = new Float32Array(4);
  const d = img.data;
  const baseFor = (u) => [0, 1, 2].map((k) => { const y = pm.gY[k] + (pm.ubY[k] - pm.gY[k]) * u; return y * y; });
  const filterFor = (T, base) => [0, 1, 2].map((k) => C.linearToSrgb(Math.min(1, T[k] / Math.max(1e-5, base[k]))));

  // Pass 1: best underbase per color (tried at 17 levels; ties go to less white).
  const uCache = new Map();
  const uField = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const key = ((d[p * 3] >> 2) << 12) | ((d[p * 3 + 1] >> 2) << 6) | (d[p * 3 + 2] >> 2);
    let u = uCache.get(key);
    if (u === undefined) {
      const lab = C.rgbToLab([d[p * 3], d[p * 3 + 1], d[p * 3 + 2]]);
      const T = [0, 1, 2].map((k) => C.SRGB_TO_LINEAR[d[p * 3 + k]]);
      let bestErr = Infinity;
      u = 0;
      for (let step = 0; step <= 16; step++) {
        const uu = step / 16;
        const base = baseFor(uu);
        const f = filterFor(T, base);
        lutLookup(lut, 4, f[0], f[1], f[2], v);
        const out = base.slice();
        for (let i = 0; i < 4; i++) for (let k = 0; k < 3; k++) out[k] *= 1 - v[i] + v[i] * inkLin[i][k];
        const err = C.deltaE2000(lab, C.linearRgbToLab(out[0], out[1], out[2])) + uu * 0.3;
        if (err < bestErr - 1e-6) { bestErr = err; u = uu; }
      }
      uCache.set(key, u);
    }
    uField[p] = Math.round(Math.min(1, u * o.underbaseStrength) * 255);
  }
  // Smooth the underbase so neighbouring pixels can't flip between two
  // equally good answers (that shows up as thin streaks): a 5x5 max then
  // 5x5 mean keeps base under every color and removes the seams.
  const ub = ops.boxBlur3(ops.boxBlur3(ops.dilate(uField, w, h, 2), w, h), w, h);

  // Pass 2: process inks for each pixel over its (smoothed) base.
  const plates = [0, 1, 2, 3].map(() => new Uint8Array(n));
  const hl = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const u = ub[p] / 255;
    const T = [0, 1, 2].map((k) => C.SRGB_TO_LINEAR[d[p * 3 + k]]);
    const f = filterFor(T, baseFor(u));
    lutLookup(lut, 4, f[0], f[1], f[2], v);
    for (let i = 0; i < 4; i++) plates[i][p] = Math.round(Math.max(0, Math.min(1, v[i])) * 255);
    const Y = T[0] * 0.2126 + T[1] * 0.7152 + T[2] * 0.0722;
    hl[p] = Math.round(Math.max(0, Math.min(1, (Y - 0.72) / 0.25)) * 255);
  }
  return { plates: plates.concat(colors.length > 4 ? [hl] : []), ub };
}

// ---------- accuracy pass ----------
// After the first ink pick, look at where the print matches the art worst
// and try giving that color its own ink (in place of the least useful
// one). Each trial is a quick low-res separation; a swap is kept only if
// the whole print matches better.

function refineInks(image, o, colors) {
  const scale = Math.min(1, 150 / Math.max(image.width, image.height));
  const small = ops.resizeImage(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  small.dpi = (image.dpi || 300) * scale;
  const trialOpts = (inks) => Object.assign({}, o, { inks, screens: inks.length, lutGrid: 13, refine: false, minDot: 0, maxDot: 1, despeckle: false, matchLibrary: false });
  const asInks = (cs, ub) => (ub ? [{ name: 'Underbase White', hex: '#f4f4f0', role: 'underbase' }] : []).concat(cs.map((c) => ({ name: c.name, hex: c.hex, role: c.role, locked: c.locked })));
  const hasUb = o._wantUb;
  let best = separate(small, trialOpts(asInks(colors, hasUb)));
  let cur = colors.slice();
  for (let round = 0; round < 3; round++) {
    const flat = flatten(small, C.parseHex(o.garment));
    const errs = [];
    const n = small.width * small.height;
    for (let p = 0; p < n; p++) {
      if (small.channels === 4 && small.data[p * 4 + 3] < 128) continue;
      const a = C.rgbToLab([flat.data[p * 3], flat.data[p * 3 + 1], flat.data[p * 3 + 2]]);
      const b = C.rgbToLab([best.preview[p * 4], best.preview[p * 4 + 1], best.preview[p * 4 + 2]]);
      errs.push([C.deltaE76(a, b), a]);
    }
    errs.sort((x, y) => y[0] - x[0]);
    const worst = errs.slice(0, Math.max(10, Math.round(errs.length * 0.04)));
    if (!worst.length || worst[0][0] < 8) break;
    // Strongest-chroma half of the worst pixels: the color that's missing.
    worst.sort((x, y) => C.chroma(y[1]) - C.chroma(x[1]));
    const take = worst.slice(0, Math.max(5, Math.round(worst.length / 2)));
    const m = [0, 0, 0];
    for (const [, lab] of take) { m[0] += lab[0]; m[1] += lab[1]; m[2] += lab[2]; }
    const want = m.map((x) => x / take.length);
    if (cur.some((c) => C.deltaE2000(c.lab, want) < 6)) break;
    // Only inks with a close neighbour can go: a distinct, saturated accent
    // (the red eye, a logo dot) is kept even if it covers very little.
    const swappable = cur.map((c, i) => [c, i]).filter(([c]) => {
      if (c.locked || c.role !== 'color') return false;
      const near = Math.min(...cur.filter((x) => x !== c && x.role === 'color').map((x) => C.deltaE2000(x.lab, c.lab)));
      return near < 22 || C.chroma(c.lab) < 20;
    });
    if (!swappable.length) break;
    let improved = false;
    // Try replacing each of the two least-used inks.
    const usage = best.screens.filter((s) => s.role !== 'underbase');
    swappable.sort((a, b) => (usage[a[1]] ? usage[a[1]].coverage : 0) - (usage[b[1]] ? usage[b[1]].coverage : 0));
    for (const [, i] of swappable.slice(0, 2)) {
      const trial = cur.slice();
      trial[i] = screen(C.colorName(want), C.toHex(C.labToRgb(want)), 'color');
      const r = separate(small, trialOpts(asInks(orderColors(trial), hasUb)));
      if (r.report.match.avgDeltaE < best.report.match.avgDeltaE * 0.97) { best = r; cur = trial; improved = true; break; }
    }
    if (!improved) break;
  }
  uniqueNames(cur);
  return cur;
}

// ---------- main ----------

function separate(image, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  GRID = o.lutGrid || 33;
  const garment = screen('Garment', o.garment, 'garment');
  let img = flatten(image, garment.rgb);
  let mask = opaqueMask(image);
  let dpi = image.dpi || 300;
  if (o.mode === 'index' && o.indexDpi && o.indexDpi !== dpi) {
    const f = o.indexDpi / dpi;
    const w = Math.max(1, Math.round(img.width * f)), h = Math.max(1, Math.round(img.height * f));
    img = ops.resizeImage(img, w, h);
    if (mask) mask = ops.resizeImage({ data: mask, width: image.width, height: image.height, channels: 1 }, w, h).data;
    dpi = o.indexDpi;
  }
  if (o.screens === 'auto' && !(o.inks && o.inks.length) && ['simulated', 'index', 'spot'].includes(o.mode)) {
    o.screens = autoScreenCount(image, o);
  }
  const plan = planInks(img, o, garment);
  // An ink list from the user keeps the user's print order.
  let colors = o.inks && o.inks.length ? plan.colors : orderColors(plan.colors);
  if (o.refine && !(o.inks && o.inks.length) && (o.mode === 'simulated' || o.mode === 'index') && colors.length > 1) {
    colors = orderColors(refineInks(image, Object.assign({}, o, { _wantUb: plan.wantUb }), colors));
    if (!o.picker) {
      // Second opinion: the diversity picker (protects small distinct colors
      // like a yellow among blues), refined the same way; keep the better.
      const alt = planInks(img, Object.assign({}, o, { picker: 'diverse' }), garment);
      const altColors = orderColors(refineInks(image, Object.assign({}, o, { _wantUb: plan.wantUb }), orderColors(alt.colors)));
      colors = bestPalette(image, o, plan.wantUb, [colors, altColors]);
    }
    GRID = o.lutGrid || 33; // trials ran with a smaller table
    if (o.matchLibrary && o.library && o.library.length) {
      const used = new Set(colors.filter((c) => c.locked).map((c) => c.name));
      for (const c of colors) {
        if (c.locked || c.role !== 'color' || c.matchDeltaE != null) continue;
        const m = nearestInk(c.lab, o.library, used);
        if (!m) continue;
        used.add(m.ink.name);
        Object.assign(c, { name: m.ink.name, hex: m.ink.hex, rgb: m.ink.rgb, lab: m.ink.lab, code: m.ink.code, library: m.ink.library, matchDeltaE: m.deltaE });
      }
    }
  }
  const ubInk = o.inks && o.inks.find((i) => i.role === 'underbase');
  let platesRaw, binary = false, cmykUb = null;
  if (!colors.length) platesRaw = [];
  else if (o.mode === 'simulated') platesRaw = separateSimulated(img, garment, colors, o, plan.wantUb);
  else if (o.mode === 'spot') platesRaw = separateSpot(img, garment, colors, o).plates;
  else if (o.mode === 'index') { platesRaw = separateIndex(img, garment, colors, o, plan.wantUb).plates; binary = true; }
  else if (o.mode === 'cmyk' && plan.wantUb) {
    const r = separateCmykDark(img, o, colors, garment);
    platesRaw = r.plates;
    cmykUb = r.ub;
  } else if (o.mode === 'cmyk') {
    platesRaw = separateCmyk(img, o, colors, garment);
    if (colors.length > 4) {
      const hl = new Uint8Array(img.width * img.height);
      for (let p = 0; p < hl.length; p++) {
        const L = C.rgbToLab([img.data[p * 3], img.data[p * 3 + 1], img.data[p * 3 + 2]])[0];
        hl[p] = Math.round(Math.max(0, Math.min(1, (L - 80) / 18)) * 255);
      }
      platesRaw.push(hl);
    }
  } else if (o.mode === 'grayscale') platesRaw = separateGrayscale(img, garment, colors[0]);
  else throw new Error(`Unknown mode: ${o.mode}`);

  // Transparent pixels never get ink.
  if (mask) for (const pl of platesRaw) for (let p = 0; p < pl.length; p++) if (mask[p] < 8) pl[p] = 0;

  // The user's per-screen adjustments (amount, levels, spread).
  platesRaw = platesRaw.map((pl, i) => (colors[i] && colors[i].adjust ? applyAdjust(pl, colors[i].adjust, img.width, img.height, binary) : pl));
  // Local clean-ups the user painted or clicked on a screen (stray pixels in
  // one area), applied before the underbase is built so it follows.
  platesRaw = platesRaw.map((pl, i) => (colors[i] && colors[i].erase && colors[i].erase.length ? applyErase(pl, img.width, img.height, colors[i].erase, img) : pl));

  const screens = [];
  let ubScreen = null;
  if (plan.wantUb && colors.length) {
    let ubPlate = cmykUb ? (o.choke > 0 ? ops.erode(cmykUb, img.width, img.height, o.choke) : cmykUb) : buildUnderbase(platesRaw, colors, garment, img, o);
    if (mask) for (let p = 0; p < ubPlate.length; p++) if (mask[p] < 8) ubPlate[p] = 0;
    if (ubInk && ubInk.adjust) ubPlate = applyAdjust(ubPlate, ubInk.adjust, img.width, img.height, binary);
    if (ubInk && ubInk.erase && ubInk.erase.length) ubPlate = applyErase(ubPlate, img.width, img.height, ubInk.erase, img);
    ubScreen = screen(ubInk ? ubInk.name : 'Underbase White', '#f4f4f0', 'underbase', { plate: ubPlate, adjust: ubInk ? ubInk.adjust || null : null, film: ubInk ? ubInk.film || null : null });
    screens.push(ubScreen);
  }
  colors.forEach((c, i) => screens.push(Object.assign(c, { plate: platesRaw[i] })));

  // Merged screens: a screen with mergeInto prints on its target's screen
  // (plates combined), e.g. highlight white folded into the underbase.
  for (const src of screens.filter((x) => x.mergeInto)) {
    const t = screens.find((x) => x !== src && !x.mergeInto && x.name === src.mergeInto);
    if (!t) { src.mergeInto = null; continue; }
    const a = t.plate, b = src.plate, m = new Uint8Array(a.length);
    for (let p = 0; p < a.length; p++) m[p] = 255 - (((255 - a[p]) * (255 - b[p])) / 255 | 0);
    t.plate = m;
    t.merged = (t.merged || []).concat([{ name: src.name, hex: src.hex, role: src.role, adjust: src.adjust || null }]);
    screens.splice(screens.indexOf(src), 1);
  }

  // Clean-ups made on "All screens": that spot prints nothing at all.
  if (o.erase && o.erase.length) for (const sc of screens) sc.plate = applyErase(sc.plate, img.width, img.height, o.erase, img);

  // Distress texture knockout (grunge, cracks, your own texture...).
  let texMask = null;
  if (o.texture && o.texture.type && o.texture.type !== 'none') texMask = applyTexture(screens, o.texture, img.width, img.height, dpi);

  const spotBinary = o.mode === 'spot' && !o.smoothEdges;
  let removedTotal = 0;
  for (const s of screens) {
    const f = finishPlate(s.plate, o, binary || spotBinary);
    s.plate = f.plate;
    s.removedSpecks = f.removed;
    if (!binary && !spotBinary && o.despeckle !== false) {
      const d = despeckle(s.plate, img.width, img.height);
      s.plate = d.plate;
      s.removedSpecks += d.removed;
    }
    removedTotal += s.removedSpecks;
  }

  const preview = composite(screens, garment, img.width, img.height, o, { binary: binary || spotBinary });
  // The match is judged where the design prints; areas a texture knocks out
  // on purpose don't count against it.
  let matchMask = mask, matchImg = img;
  if (texMask && (o.texture.apply || 'all') === 'all') {
    // Compare with the art distressed the same way (shirt where knocked out).
    const d = new Uint8ClampedArray(img.data.length);
    for (let p = 0; p < texMask.length; p++) {
      const k = texMask[p] / 255;
      for (let c = 0; c < 3; c++) d[p * 3 + c] = img.data[p * 3 + c] * (1 - k) + garment.rgb[c] * k;
    }
    matchImg = Object.assign({}, img, { data: d });
  } else if (texMask) {
    matchMask = new Uint8Array(texMask.length);
    for (let p = 0; p < texMask.length; p++) matchMask[p] = texMask[p] < 64 && (!mask || mask[p] >= 128) ? 255 : 0;
  }
  const report = buildReport(matchImg, preview, matchMask, screens, garment, o, removedTotal);
  // A fresh separation never hands back an empty screen: drop inks that
  // ended up printing nothing and separate again with the rest.
  if (!(o.inks && o.inks.length) && !o._pruned) {
    // ...and inks that are practically the same color as a busier one.
    const dead = screens.filter((x) => x.role === 'color' && !x.locked && (x.coverage < 0.0005 ||
      screens.some((y) => y !== x && y.role !== 'underbase' && y.coverage >= x.coverage && C.deltaE2000(x.lab, y.lab) < 4)));
    if (dead.length && screens.length - dead.length >= 1) {
      const keep = [];
      for (const x of screens.filter((y) => !dead.includes(y))) {
        keep.push({ name: x.name, hex: x.hex, role: x.role, code: x.code, library: x.library, locked: x.locked, erase: x.erase || null });
        for (const m of x.merged || []) keep.push(Object.assign({}, m, { mergeInto: x.name }));
      }
      uniqueNames(keep);
      return separate(image, Object.assign({}, options, { inks: keep, _pruned: true, screens: keep.length }));
    }
  }
  screens.forEach((s, i) => { s.order = i + 1; s.id = `s${i + 1}`; s.histogram = plateHistogram(s.plate); });
  return {
    width: img.width, height: img.height, dpi, mode: o.mode,
    garment: { hex: garment.hex, rgb: garment.rgb, dark: isDark(garment.lab) },
    screens, preview, report, options: o,
  };
}

function buildReport(img, preview, mask, screens, garment, o, removedTotal) {
  const n = img.width * img.height;
  const stats = matchStats(img, preview, mask, o.mode === 'grayscale');
  const warnings = [];
  const ink = screens.filter((s) => s.role !== 'underbase');
  for (let i = 0; i < ink.length; i++) {
    for (let j = i + 1; j < ink.length; j++) {
      const d = C.deltaE2000(ink[i].lab, ink[j].lab);
      if (d < 6) warnings.push({ level: 'tip', text: `"${ink[i].name}" and "${ink[j].name}" look almost the same (ΔE ${d.toFixed(1)}). Merge them to save a screen.` });
    }
  }
  for (const s of screens) {
    let sum = 0;
    for (let p = 0; p < n; p++) sum += s.plate[p];
    s.coverage = sum / (255 * n);
    if (s.role !== 'underbase' && s.coverage < 0.002) warnings.push({ level: 'tip', text: `"${s.name}" covers only ${(s.coverage * 100).toFixed(2)}% of the design (a small detail). Keep it if that detail matters; remove it to save a screen.` });
    if (s.matchDeltaE > 5) warnings.push({ level: 'warn', text: `Nearest library ink for "${s.name}" is ΔE ${s.matchDeltaE.toFixed(1)} away from the art color. Check it on press or lock a custom ink.` });
  }
  if (stats.p95 > 10) warnings.push({ level: 'warn', text: `Some areas can't be matched with these inks (95% of pixels within ΔE ${stats.p95.toFixed(1)}). Add a screen or lock the missing color.` });
  // Ink pile-up: total coverage where several plates stack.
  let heavy = 0;
  const step = Math.max(1, Math.floor(n / 20000));
  let samples = 0;
  for (let p = 0; p < n; p += step) {
    samples++;
    let s = 0;
    for (const sc of screens) if (sc.role !== 'underbase') s += sc.plate[p] / 255;
    if (s > 2.2) heavy++;
  }
  if (heavy / samples > 0.05) warnings.push({ level: 'warn', text: `${Math.round((heavy / samples) * 100)}% of the print stacks more than 220% color ink on top of the base. Expect a heavy hand; switch Ink build-up to "Soft hand" or use fewer screens.` });
  const rating = stats.avg < 2.5 ? 'Excellent' : stats.avg < 4.5 ? 'Good' : stats.avg < 7 ? 'Fair' : 'Poor';
  return {
    match: { avgDeltaE: +stats.avg.toFixed(2), p95DeltaE: +stats.p95.toFixed(2), rating },
    screenCount: screens.length,
    speckPixelsRemoved: removedTotal,
    warnings,
  };
}

// Fewest screens that still match the art well, from a quick low-res trial.
function autoScreenCount(image, o) {
  const scale = Math.min(1, 220 / Math.max(image.width, image.height));
  const small = ops.resizeImage(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  small.dpi = image.dpi;
  const garmentLab = C.rgbToLab(C.parseHex(o.garment));
  const dark = (o.underbase === 'auto' ? isDark(garmentLab) : !!o.underbase);
  const start = o.mode === 'simulated' && dark ? 3 : 1;
  let best = 10;
  for (let n = start; n <= 10; n++) {
    const r = separate(small, Object.assign({}, o, { screens: n, indexDpi: 0, minDot: 0, maxDot: 1, refine: false }));
    if (r.report.match.avgDeltaE < (o.autoTarget || 3.2) && r.report.match.p95DeltaE < 9) { best = n; break; }
  }
  return best;
}

module.exports = { separate, applyErase, plateHistogram, adjustLut, DEFAULTS, underbaseNeed, solveSimplex, compensateDotGain, composite, autoScreenCount, isDark };
