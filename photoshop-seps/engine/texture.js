'use strict';
// Distress textures used as knockouts: wherever the texture is "on", ink is
// removed from the chosen screens, so the shirt shows through like a worn
// vintage print. Built-in textures are procedural (resolution independent:
// sizes are in inches, so the proof and the full-size output match), or use
// your own grayscale texture image.
//
// texture = {
//   type: 'none'|'grunge'|'cracks'|'scratches'|'speckle'|'worn'|'halftone-grain'|'custom',
//   density 0..1   how much of the print is knocked out
//   scale          feature size in inches
//   softness 0..1  hard edges (0) to soft fades (1)
//   strength 0..1  1 = full knockout, lower = partial
//   seed           any number, changes the pattern
//   invert         swap knocked-out and kept areas
//   apply          'all' | 'underbase' | 'colors'
//   image          { data: Uint8Array gray, width, height } for 'custom' (white = knock out)
//   fit            'tile' | 'stretch' for 'custom'
// }

function hash(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10), uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * ux) * (1 - uy) + (c + (d - c) * ux) * uy;
}

function fbm(x, y, seed, octaves) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < octaves; o++) { v += valueNoise(x * f, y * f, seed + o * 17) * amp; norm += amp; amp *= 0.5; f *= 2.03; }
  return v / norm;
}

// Distance to cell edges (Worley F2 - F1): thin lines along cell borders.
function cellEdges(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i + hash(ix + i, iy + j, seed), cy = iy + j + hash(ix + i, iy + j, seed + 91);
      const d = Math.hypot(x - cx, y - cy);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  }
  return f2 - f1;
}

// Raw texture value 0..1 at a point in inches; high = knock out.
function rawAt(type, u, v, seed, scale) {
  const s = 1 / Math.max(0.01, scale);
  switch (type) {
    case 'cracks': {
      const warp = fbm(u * s * 0.7, v * s * 0.7, seed + 5, 3) - 0.5;
      const e = cellEdges(u * s + warp * 0.8, v * s + warp * 0.8, seed);
      return 1 - Math.min(1, e / 0.18);
    }
    case 'scratches': {
      // Long thin streaks: noise stretched along a slanted direction.
      const a = 0.35 + hash(seed, 3, 7) * 0.5;
      const ca = Math.cos(a), sa = Math.sin(a);
      const x = (u * ca + v * sa) * s * 0.15, y = (-u * sa + v * ca) * s * 9;
      const n = fbm(x, y, seed + 11, 3);
      return Math.max(0, (n - 0.5) * 2.2);
    }
    case 'speckle': {
      const cell = s * 6;
      const ix = Math.floor(u * cell), iy = Math.floor(v * cell);
      const r = hash(ix, iy, seed + 23);
      const dx = u * cell - ix - 0.5, dy = v * cell - iy - 0.5;
      const size = 0.15 + 0.3 * hash(ix, iy, seed + 29);
      return r > 0.82 && Math.hypot(dx, dy) < size ? 1 : fbm(u * s * 3, v * s * 3, seed + 31, 2) * 0.5;
    }
    case 'halftone-grain':
      return valueNoise(u * s * 40, v * s * 40, seed + 41) * 0.6 + fbm(u * s, v * s, seed + 43, 3) * 0.4;
    case 'worn': {
      const g = fbm(u * s, v * s, seed, 5);
      const sc = rawAt('scratches', u, v, seed + 101, scale * 1.5);
      const sp = rawAt('speckle', u, v, seed + 202, scale);
      return Math.min(1, Math.max(g, sc * 0.9, sp * 0.95));
    }
    case 'grunge':
    default:
      return fbm(u * s, v * s, seed, 5);
  }
}

// Spread of each built-in texture's raw values, so "density" means roughly
// the share of the print that gets knocked out.
const quantileCache = new Map();
function quantiles(type, seed, scale) {
  const key = `${type}:${seed}:${scale}`;
  if (quantileCache.has(key)) return quantileCache.get(key);
  const vals = [];
  for (let i = 0; i < 4096; i++) vals.push(rawAt(type, hash(i, 1, 5) * 8 * scale, hash(i, 2, 5) * 8 * scale, seed, scale));
  vals.sort((a, b) => a - b);
  quantileCache.set(key, vals);
  return vals;
}

function customAt(t, u, v, widthIn, heightIn) {
  const img = t.image;
  let fx, fy;
  if (t.fit === 'stretch') { fx = u / widthIn; fy = v / heightIn; } else { const s = Math.max(0.05, t.scale || 2); fx = u / s; fy = v / s * (img.width / img.height); }
  fx -= Math.floor(fx); fy -= Math.floor(fy);
  const x = Math.min(img.width - 1, Math.floor(fx * img.width)), y = Math.min(img.height - 1, Math.floor(fy * img.height));
  return img.data[y * img.width + x] / 255;
}

// Knockout mask for a plate-sized area: Uint8Array, 255 = remove all ink.
function textureMask(t, width, height, dpi) {
  const n = width * height;
  const mask = new Uint8Array(n);
  if (!t || !t.type || t.type === 'none') return null;
  if (t.type === 'custom' && !(t.image && t.image.data)) return null;
  const density = t.density == null ? 0.35 : t.density;
  const soft = Math.max(0.01, (t.softness == null ? 0.25 : t.softness) * 0.5);
  const strength = t.strength == null ? 1 : t.strength;
  const seed = (t.seed | 0) || 1;
  const scale = t.scale || 0.4;
  const widthIn = width / dpi, heightIn = height / dpi;
  let thr;
  if (t.type === 'custom') thr = 1 - density;
  else { const q = quantiles(t.type, seed, scale); thr = q[Math.min(q.length - 1, Math.floor((1 - density) * q.length))]; }
  for (let y = 0; y < height; y++) {
    const v = y / dpi;
    for (let x = 0; x < width; x++) {
      const u = x / dpi;
      let r = t.type === 'custom' ? customAt(t, u, v, widthIn, heightIn) : rawAt(t.type, u, v, seed, scale);
      if (t.invert) r = 1 - r;
      // Smooth step around the threshold: values above it knock out.
      const k = Math.max(0, Math.min(1, (r - thr) / soft + 0.5));
      mask[y * width + x] = Math.round(k * strength * 255);
    }
  }
  return mask;
}

function applyTexture(screens, t, width, height, dpi) {
  const mask = textureMask(t, width, height, dpi);
  if (!mask) return null;
  const target = t.apply || 'all';
  for (const s of screens) {
    if (target === 'underbase' && s.role !== 'underbase') continue;
    if (target === 'colors' && s.role === 'underbase') continue;
    const out = new Uint8Array(s.plate.length);
    for (let p = 0; p < out.length; p++) out[p] = (s.plate[p] * (255 - mask[p])) / 255 | 0;
    s.plate = out;
  }
  return mask;
}

const TEXTURES = [
  ['none', 'None'], ['grunge', 'Grunge (blotchy)'], ['worn', 'Worn vintage (mix)'], ['cracks', 'Cracked'],
  ['scratches', 'Scratches'], ['speckle', 'Speckle / dust'], ['halftone-grain', 'Fine grain'], ['custom', 'My texture image'],
];

module.exports = { textureMask, applyTexture, TEXTURES, rawAt };
