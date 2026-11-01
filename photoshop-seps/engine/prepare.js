'use strict';
// Gets artwork ready to separate: print size, resolution (upscale low-res
// art to the target ppi), noise clean-up and sharpening. Separating
// 72-150 ppi web art straight to 720 dpi film gives soft, jagged edges;
// this is where that gets fixed.

const ops = require('./image-ops');

const PREP_DEFAULTS = {
  printWidthIn: 0, // 0 = keep the document's own size
  targetPpi: 300,
  upscale: true, // enlarge art below targetPpi
  denoise: 0, // median passes 0..2
  sharpen: 0, // unsharp amount 0..3
  sharpenRadius: 1.0, // px at output resolution
  sharpenThreshold: 3,
  levels: null, // { black: 0..255, white: 0..255, gamma: 0.2..5 } on the art
  removeBg: false, // drop the picture's background (made transparent = shirt shows)
  bgTolerance: 12, // ΔE: how different from the background color still counts as background
  bgEdgesOnly: true, // only background connected to the picture's edges
  bgColor: null, // '#rrggbb' to force the background color, else detected
  feather: 1, // px soft edge after removal
  knockout: false, // let the shirt color show through where the art matches it
  knockoutTolerance: 10,
  garment: null, // '#rrggbb', set by the caller for knockout
  saturation: 1, // 0..2
};

const color = require('./color');

// The background color: most common color along the picture's border.
function detectBackground(img) {
  const { width: w, height: h, channels: c, data } = img;
  const bins = new Map();
  const add = (x, y) => {
    const i = (y * w + x) * c;
    if (c === 4 && data[i + 3] < 128) return;
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = bins.get(k) || [0, 0, 0, 0];
    b[0] += data[i]; b[1] += data[i + 1]; b[2] += data[i + 2]; b[3]++;
    bins.set(k, b);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  let best = null;
  for (const b of bins.values()) if (!best || b[3] > best[3]) best = b;
  if (!best) return null;
  const total = 2 * (w + h);
  return { rgb: [best[0] / best[3], best[1] / best[3], best[2] / best[3]].map(Math.round), share: best[3] / total };
}

// Distance (ΔE76) of every pixel to a color, cached per color.
function distanceMap(img, targetLab) {
  const { width: w, height: h, channels: c, data } = img;
  const out = new Float32Array(w * h);
  const cache = new Map();
  for (let p = 0; p < w * h; p++) {
    const key = (data[p * c] << 16) | (data[p * c + 1] << 8) | data[p * c + 2];
    let d = cache.get(key);
    if (d === undefined) { d = color.deltaE76(color.rgbToLab([data[p * c], data[p * c + 1], data[p * c + 2]]), targetLab); cache.set(key, d); }
    out[p] = d;
  }
  return out;
}

function withAlpha(img) {
  if (img.channels === 4) return Object.assign({}, img, { data: new Uint8ClampedArray(img.data) });
  const n = img.width * img.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let p = 0; p < n; p++) { out[p * 4] = img.data[p * 3]; out[p * 4 + 1] = img.data[p * 3 + 1]; out[p * 4 + 2] = img.data[p * 3 + 2]; out[p * 4 + 3] = 255; }
  return Object.assign({}, img, { data: out, channels: 4 });
}

// Background removal: flood-fill from the edges through pixels close to the
// background color (or every such pixel when edgesOnly is off), then a soft
// edge so anti-aliased outlines don't leave a halo.
function removeBackground(img, p) {
  const bg = p.bgColor ? { rgb: color.parseHex(p.bgColor) } : detectBackground(img);
  if (!bg) return { image: img, bg: null };
  const out = withAlpha(img);
  const { width: w, height: h } = out;
  const dist = distanceMap(out, color.rgbToLab(bg.rgb));
  const tol = p.bgTolerance;
  const isBg = new Uint8Array(w * h);
  if (p.bgEdgesOnly) {
    const stack = [];
    const push = (x, y) => { const i = y * w + x; if (!isBg[i] && dist[i] < tol) { isBg[i] = 1; stack.push(i); } };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      if (x > 0) push(x - 1, y);
      if (x < w - 1) push(x + 1, y);
      if (y > 0) push(x, y - 1);
      if (y < h - 1) push(x, y + 1);
    }
  } else {
    for (let i = 0; i < w * h; i++) if (dist[i] < tol) isBg[i] = 1;
  }
  // Edge pixels next to the background fade by how close they are to it.
  const r = Math.max(0, Math.round(p.feather || 0));
  const fill = p.garment ? color.parseHex(p.garment) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (isBg[i]) {
        out.data[i * 4 + 3] = 0;
        // Hidden color = the shirt, so sharpening can't pull a halo of the
        // old background into the edge.
        if (fill) { out.data[i * 4] = fill[0]; out.data[i * 4 + 1] = fill[1]; out.data[i * 4 + 2] = fill[2]; }
        continue;
      }
      if (!r) continue;
      let near = false;
      for (let dy = -r; dy <= r && !near; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && isBg[yy * w + xx]) { near = true; break; }
      }
      if (near) {
        const a = Math.max(0, Math.min(1, (dist[i] - tol) / (tol * 1.5)));
        out.data[i * 4 + 3] = Math.round(out.data[i * 4 + 3] * a);
        // Un-mix the background from edge pixels (anti-aliasing blended the
        // two), so no light or dark halo is left around the design.
        if (a > 0.05 && a < 1) {
          for (let k = 0; k < 3; k++) out.data[i * 4 + k] = (out.data[i * 4 + k] - (1 - a) * bg.rgb[k]) / a;
        }
      }
    }
  }
  return { image: out, bg: color.toHex(bg.rgb) };
}

// Knockout: where the art is (almost) the shirt color, print nothing and
// let the shirt be that color. Saves ink and keeps the print soft.
function knockoutGarment(img, p) {
  if (!p.garment) return img;
  const out = withAlpha(img);
  const dist = distanceMap(out, color.rgbToLab(color.parseHex(p.garment)));
  const tol = p.knockoutTolerance;
  for (let i = 0; i < out.width * out.height; i++) {
    const a = Math.max(0, Math.min(1, (dist[i] - tol * 0.6) / (tol * 0.8)));
    out.data[i * 4 + 3] = Math.round(out.data[i * 4 + 3] * a);
  }
  return out;
}

// Art levels + saturation as one pass.
function toneArt(img, levels, saturation) {
  const lv = Object.assign({ black: 0, white: 255, gamma: 1 }, levels || {});
  const ident = lv.black === 0 && lv.white === 255 && lv.gamma === 1 && (saturation == null || saturation === 1);
  if (ident) return img;
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const v = Math.max(0, Math.min(1, (i - lv.black) / Math.max(1, lv.white - lv.black)));
    lut[i] = Math.round(Math.pow(v, 1 / Math.max(0.1, lv.gamma)) * 255);
  }
  const sat = saturation == null ? 1 : saturation;
  const c = img.channels, n = img.width * img.height;
  const out = new Uint8ClampedArray(img.data);
  for (let p = 0; p < n; p++) {
    const r = lut[img.data[p * c]], g = lut[img.data[p * c + 1]], b = lut[img.data[p * c + 2]];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    out[p * c] = y + (r - y) * sat; out[p * c + 1] = y + (g - y) * sat; out[p * c + 2] = y + (b - y) * sat;
  }
  return Object.assign({}, img, { data: out });
}

function artInfo(image, prep) {
  const p = Object.assign({}, PREP_DEFAULTS, prep || {});
  const widthIn = p.printWidthIn > 0 ? p.printWidthIn : image.width / (image.dpi || 300);
  const ppi = image.width / widthIn;
  const upscaled = p.upscale && ppi < p.targetPpi - 1;
  const outPpi = upscaled ? p.targetPpi : ppi;
  return {
    widthIn, heightIn: widthIn * (image.height / image.width), sourcePpi: ppi, outputPpi: outPpi, upscaled,
    outWidth: Math.round(widthIn * outPpi), outHeight: Math.round(widthIn * outPpi * (image.height / image.width)),
    lowRes: ppi < 200,
  };
}

// scale < 1 prepares a smaller proof with the same look (radius scaled).
// Background removal / knockout at the art's own resolution (before any
// upscale, so anti-aliased edges are cleaned where they really are), cached
// so live edits to other settings don't redo it.
let cutCache = { image: null, key: '', result: null };
function cutArt(image, p) {
  if (!p.removeBg && !p.knockout) return { image, bg: null };
  const key = JSON.stringify([p.removeBg, p.bgTolerance, p.bgEdgesOnly, p.bgColor, p.feather, p.knockout, p.knockoutTolerance, p.garment]);
  if (cutCache.image === image && cutCache.key === key) return cutCache.result;
  let img = image, bg = null;
  if (p.removeBg) { const r = removeBackground(img, p); img = r.image; bg = r.bg; }
  if (p.knockout) img = knockoutGarment(img, p);
  const result = { image: img, bg };
  cutCache = { image, key, result };
  return result;
}

// scale < 1 prepares a smaller proof with the same look (radius scaled).
function prepareArt(image, prep, scale) {
  const p = Object.assign({}, PREP_DEFAULTS, prep || {});
  const info = artInfo(image, p);
  const s = scale || 1;
  const cut = cutArt(image, p);
  let img = cut.image;
  const w = Math.max(1, Math.round(info.outWidth * s)), h = Math.max(1, Math.round(info.outHeight * s));
  if (w !== img.width || h !== img.height) {
    img = w > img.width ? ops.resizeBicubic(img, w, h) : ops.resizeImage(img, w, h);
  }
  for (let i = 0; i < (p.denoise | 0); i++) img = ops.median3(img);
  img = toneArt(img, p.levels, p.saturation);
  if (p.sharpen > 0) img = ops.unsharpMask(img, p.sharpen, Math.max(0.35, p.sharpenRadius * s), p.sharpenThreshold);
  img = Object.assign({}, img, { dpi: info.outputPpi * s });
  return { image: img, info: Object.assign({}, info, { background: cut.bg }) };
}

module.exports = { prepareArt, artInfo, toneArt, detectBackground, removeBackground, knockoutGarment, PREP_DEFAULTS };
