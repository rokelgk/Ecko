/* Ecko Tone engine, JavaScript port of ecko/tone/engine.py (+ noise.py).
 *
 * Runs anywhere modern JavaScript runs: a browser page, a Web Worker, Node, or a
 * Photoshop UXP plug-in. No DOM is needed here; text rendering is passed in.
 * Every pattern is a function of global print-pixel coordinates, so previews, the
 * 1:1 loupe and full-size strips line up exactly (same as the Python engine).
 *
 * Built by tools/build_standalone.py, which fills in the catalog and blue-noise data.
 */
(function (root) {
  "use strict";

  const CATALOG = __CATALOG__;
  const BLUE_NOISE_B64 = "__BLUE_NOISE__";

  const STYLES = CATALOG.styles_map;
  const AM_STYLES = ["round", "euclid", "ellipse", "square", "diamond", "line", "cross", "modulation"];
  const DIFFUSION = CATALOG.diffusion;   // name -> [divisor, [[dx, dy, weight], ...]]
  const DIFFUSION_STYLES = Object.keys(DIFFUSION);
  const GRAIN_STYLES = ["fm", "xerox", "mezzotint", "bayer4", "bayer8", "random", ...DIFFUSION_STYLES];
  const PALETTES = Object.fromEntries(CATALOG.api.palettes.map((p) => [p.id, p]));
  const TEXTURES = CATALOG.textures_map;
  const TARGETS = CATALOG.targets_map;
  const PROCESS_INKS = CATALOG.process_inks;   // [name, [r,g,b], angleOffset]
  const SHIRT_FITS = CATALOG.shirt_fits_map;
  const FONT_IDS = CATALOG.fonts.map((f) => f.id);
  const DEFAULTS = CATALOG.defaults;
  const CREAM = [244, 241, 234];
  const INK_BLACK = [29, 29, 31];
  const MAX_OUTPUT_PX = 120000000;
  const MAX_SOURCE_SIDE = 4000;
  const LOUPE_MAX = 800;
  const MAX_TEXT_LAYERS = 6;

  class ImageError extends Error {}
  class OptionError extends Error {}

  // ================================================================ options

  function hex(value) {
    let v = String(value).trim().replace(/^#/, "");
    if (v.length === 3) v = v.split("").map((c) => c + c).join("");
    if (!/^[0-9a-fA-F]{6}$/.test(v)) throw new OptionError(`Not a colour: ${JSON.stringify(value)}. Use #rrggbb.`);
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  const toHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

  const RANGES = {
    width_in: [0.5, 60], dpi: [72, 1200], lpi: [3, 200], angle: [-360, 360],
    grain_mm: [0.02, 5], spot_colors: [2, 8], spot_softness: [1, 60],
    brightness: [-1, 1], contrast: [-1, 1], gamma: [0.2, 5],
    black_point: [0, 0.95], white_point: [0.05, 1], sharpen: [0, 3],
    min_dot: [0, 0.5], max_dot: [0.5, 1], dot_gain: [0, 0.4], roughness: [0, 1],
    misregister_mm: [0, 5], bg_tolerance: [1, 80], seed: [0, 2 ** 31 - 1], choke_mm: [0, 1],
    threshold_levels: [2, 8], threshold_soft: [0, 0.3], smooth_mm: [0, 3], denoise: [0, 3], border_mm: [1, 120],
    outline: [0, 0.06], shadow: [0, 0.1], ghost_mm: [0, 4], ghost_strength: [0, 1], highlight: [0, 1],
  };
  const TEXT_RANGES = { size: [0.02, 1.0], arc: [-340, 340], x: [-2, 2], y: [-2, 2], spacing: [-0.2, 1.0] };
  const TEXT_DEFAULTS = { font: "varsity", size: 0.12, arc: 0.0, x: 0.0, y: -0.7, spacing: 0.05, color: "#000000" };

  function parseOptions(data) {
    data = data || {};
    const unknown = Object.keys(data).filter((k) => !(k in DEFAULTS));
    if (unknown.length) throw new OptionError(`Unknown options: ${unknown.sort().join(", ")}`);
    const o = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), JSON.parse(JSON.stringify(data)));
    for (const [name, [lo, hi]] of Object.entries(RANGES)) {
      const v = Number(o[name]);
      if (!Number.isFinite(v) || v < lo || v > hi) throw new OptionError(`${name} must be between ${lo} and ${hi}.`);
      o[name] = ["dpi", "spot_colors", "seed", "threshold_levels", "denoise"].includes(name) ? Math.trunc(v) : v;
    }
    if (o.white_point <= o.black_point + 0.02) throw new OptionError("The white point must be above the black point.");
    const enums = { mode: CATALOG.modes_map, style: STYLES, target: TARGETS, shirt_fit: SHIRT_FITS,
      underbase: { auto: 1, on: 1, off: 1 }, palette: { image: 1, ...PALETTES }, threshold_colors: { image: 1, ink: 1, palette: 1 },
      border: Object.fromEntries(CATALOG.api.borders.map((b) => [b.id, 1])),
      border_shape: Object.fromEntries(CATALOG.api.border_shapes.map((b) => [b.id, 1])) };
    for (const [name, table] of Object.entries(enums)) {
      if (!(o[name] in table)) throw new OptionError(`Unknown ${name}: ${JSON.stringify(o[name])}`);
    }
    if (!Array.isArray(o.thresholds) || o.thresholds.length > 7) throw new OptionError("thresholds is a list of up to 7 cut points.");
    o.thresholds = o.thresholds.map(Number).sort((a, b) => a - b);
    if (o.thresholds.some((t) => !Number.isFinite(t) || t < 0.01 || t > 0.99)) throw new OptionError("Thresholds must be between 0.01 and 0.99.");
    for (const name of ["invert", "remove_background", "knockout", "registration_marks", "threshold_stack"]) o[name] = !!o[name];
    if (!Array.isArray(o.inks) || o.inks.length < 1 || o.inks.length > 8) throw new OptionError("Give between 1 and 8 ink colours.");
    o.inks.forEach(hex);
    if (o.mode === "duotone" && o.inks.length < 2) throw new OptionError("Duotone needs two ink colours.");
    hex(o.garment);
    if (o.outline_color !== "auto") o.outline_color = toHex(hex(o.outline_color));
    o.highlight_color = toHex(hex(o.highlight_color));
    o.regions = parseRegions(o.regions);
    if (!Array.isArray(o.textures) || o.textures.length > 8) throw new OptionError("Up to 8 textures are supported.");
    o.textures = o.textures.map((t) => {
      if (!t || typeof t !== "object" || !(t.type in TEXTURES)) throw new OptionError(`Unknown texture: ${JSON.stringify(t)}`);
      const strength = Number(t.strength ?? 0.5), scale = Number(t.scale ?? 1);
      if (!(strength >= 0 && strength <= 1 && scale >= 0.1 && scale <= 8)) {
        throw new OptionError("Texture strength must be 0-1 and scale 0.1-8.");
      }
      const rotate = Number(t.rotate ?? 0);
      if (!(Number.isFinite(rotate) && rotate >= -360 && rotate <= 360)) throw new OptionError("Texture rotation must be between -360 and 360 degrees.");
      return { type: t.type, strength, scale, rotate: ((rotate % 360) + 360) % 360, image_id: t.image_id || null };
    });
    o.text = parseText(o.text);
    o.ink_edits = parseInkEdits(o.ink_edits);
    return o;
  }

  function parseRegions(regions) {   // colour regions: [{mask_id, color, mode: tint|solid, on, name}]
    if (!Array.isArray(regions) || regions.length > 12) throw new OptionError("Up to 12 colour regions are supported.");
    return regions.map((r) => {
      if (!r || typeof r !== "object" || !r.mask_id) throw new OptionError("Each colour region needs a mask_id.");
      const unknown = Object.keys(r).filter((k) => !["mask_id", "color", "mode", "on", "name"].includes(k));
      if (unknown.length) throw new OptionError(`Unknown region settings: ${unknown.sort().join(", ")}`);
      const mode = r.mode || "tint";
      if (mode !== "tint" && mode !== "solid") throw new OptionError("Region mode is tint or solid.");
      return { mask_id: String(r.mask_id).slice(0, 80), color: toHex(hex(r.color || "#c8102e")), mode,
        on: r.on === undefined ? true : !!r.on, name: String(r.name || "").slice(0, 40) };
    });
  }

  function parseInkEdits(edits) {   // per ink: switch it off, or choke (> 0) / spread (< 0) its dots in mm
    if (!edits || typeof edits !== "object" || Array.isArray(edits) || Object.keys(edits).length > 16) {
      throw new OptionError("ink_edits must map up to 16 ink names to settings.");
    }
    const out = {};
    for (const [name, e] of Object.entries(edits)) {
      if (name.length > 40 || !e || typeof e !== "object") throw new OptionError("Each ink edit is {ink name: {on, choke_mm, name}}.");
      const unknown = Object.keys(e).filter((k) => !["on", "choke_mm", "name", "color"].includes(k));
      if (unknown.length) throw new OptionError(`Unknown ink settings: ${unknown.sort().join(", ")}`);
      const choke = Number(e.choke_mm ?? 0);
      if (!Number.isFinite(choke) || choke < -0.5 || choke > 0.5) throw new OptionError("Ink choke must be between -0.5 and 0.5 mm.");
      out[name] = { on: e.on === undefined ? true : !!e.on, choke_mm: Math.round(choke * 1e4) / 1e4 };
      const label = String(e.name ?? "").split(/\s+/).filter(Boolean).join(" ");
      if (label.length > 40) throw new OptionError("Ink names are limited to 40 characters.");
      if (label) out[name].name = label;
      if (e.color) out[name].color = toHex(hex(e.color));
    }
    return out;
  }

  function parseText(layers) {
    if (!Array.isArray(layers) || layers.length > MAX_TEXT_LAYERS) {
      throw new OptionError(`Up to ${MAX_TEXT_LAYERS} lines of text are supported.`);
    }
    const out = [];
    for (let t of layers) {
      if (!t || typeof t !== "object") throw new OptionError("Each text line must be an object.");
      const unknown = Object.keys(t).filter((k) => !(k in TEXT_DEFAULTS) && k !== "text");
      if (unknown.length) throw new OptionError(`Unknown text settings: ${unknown.sort().join(", ")}`);
      t = Object.assign({}, TEXT_DEFAULTS, t);
      const words = String(t.text ?? "").replace(/\n/g, " ").trim();
      if (!words) continue;
      if (words.length > 80) throw new OptionError("Each line of text is limited to 80 characters.");
      if (!FONT_IDS.includes(t.font)) throw new OptionError(`Unknown font: ${JSON.stringify(t.font)}`);
      const clean = { text: words, font: t.font, color: toHex(hex(t.color)) };
      for (const [k, [lo, hi]] of Object.entries(TEXT_RANGES)) {
        const v = Number(t[k]);
        if (!Number.isFinite(v) || v < lo || v > hi) throw new OptionError(`Text ${k} must be between ${lo} and ${hi}.`);
        clean[k] = Math.round(v * 1e4) / 1e4;
      }
      out.push(clean);
    }
    return out;
  }

  const textWorkWidth = (o) => Math.min(4000, Math.max(800, Math.round(o.width_in * o.dpi / 100) * 100));

  // The picture clean-up part of prepare (no text): cached separately so text edits don't redo it.
  function artKey(o) {
    return JSON.stringify([o.remove_background, o.bg_tolerance, o.sharpen, o.denoise, o.smooth_mm,
      o.smooth_mm ? Math.round(o.width_in * o.dpi) : 0, o.regions.filter((r) => r.on).map((r) => [r.mask_id, r.color, r.mode])]);
  }

  function prepareKey(o) {
    return JSON.stringify([o.remove_background, o.bg_tolerance, o.sharpen, o.mode === "spot" && o.spot_colors,
      o.text, o.text.length ? textWorkWidth(o) : 0, o.denoise, o.smooth_mm, o.smooth_mm ? Math.round(o.width_in * o.dpi) : 0,
      o.outline, o.shadow, (o.outline || o.shadow) ? outlineRgb(o) : 0,
      o.regions.filter((r) => r.on).map((r) => [r.mask_id, r.color, r.mode])]);
  }

  // ================================================================ noise (global coordinates)

  function hash2(ix, iy, seed) {
    let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041) + 0x9E3779B9) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return (h & 0xFFFFFF) / 16777216;
  }
  const smooth = (t) => t * t * (3 - 2 * t);

  function valueNoise(xs, ys, scaleX, scaleY, seed) {
    const gw = xs.length, gh = ys.length;
    const cx = new Int32Array(gw), fx = new Float32Array(gw), cy = new Int32Array(gh), fy = new Float32Array(gh);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let j = 0; j < gw; j++) {
      const X = xs[j] / scaleX, ix = Math.floor(X);
      cx[j] = ix; fx[j] = smooth(X - ix);
      if (ix < x0) x0 = ix; if (ix > x1) x1 = ix;
    }
    for (let i = 0; i < gh; i++) {
      const Y = ys[i] / scaleY, iy = Math.floor(Y);
      cy[i] = iy; fy[i] = smooth(Y - iy);
      if (iy < y0) y0 = iy; if (iy > y1) y1 = iy;
    }
    const Lw = x1 - x0 + 2, Lh = y1 - y0 + 2;
    const lat = new Float32Array(Lw * Lh);
    for (let ly = 0; ly < Lh; ly++) for (let lx = 0; lx < Lw; lx++) lat[ly * Lw + lx] = hash2(x0 + lx, y0 + ly, seed);
    const rows = new Float32Array(Lh * gw);
    for (let ly = 0; ly < Lh; ly++) {
      const base = ly * Lw, rb = ly * gw;
      for (let j = 0; j < gw; j++) {
        const c = cx[j] - x0, f = fx[j];
        rows[rb + j] = lat[base + c] * (1 - f) + lat[base + c + 1] * f;
      }
    }
    const out = new Float32Array(gh * gw);
    for (let i = 0; i < gh; i++) {
      const r0 = (cy[i] - y0) * gw, r1 = r0 + gw, f = fy[i], ob = i * gw;
      for (let j = 0; j < gw; j++) out[ob + j] = rows[r0 + j] * (1 - f) + rows[r1 + j] * f;
    }
    return out;
  }

  const fbmQuantileCache = {};
  function fbmQuantiles(octaves) {
    if (fbmQuantileCache[octaves]) return fbmQuantileCache[octaves];
    const n = 512, xs = new Float64Array(n);
    for (let i = 0; i < n; i++) xs[i] = i;
    const acc = new Float32Array(n * n);
    let amp = 1, tot = 0;
    for (let o = 0; o < octaves; o++) {
      const v = valueNoise(xs, xs, 32 / 2 ** o, 32 / 2 ** o, 7 + 101 * o);
      for (let k = 0; k < acc.length; k++) acc[k] += amp * v[k];
      tot += amp; amp *= 0.5;
    }
    for (let k = 0; k < acc.length; k++) acc[k] /= tot;
    acc.sort();
    const q = new Float32Array(257);
    for (let i = 0; i <= 256; i++) {
      const p = (i / 256) * (acc.length - 1), lo = Math.floor(p), hi = Math.min(acc.length - 1, lo + 1);
      q[i] = acc[lo] + (acc[hi] - acc[lo]) * (p - lo);
    }
    return (fbmQuantileCache[octaves] = q);
  }

  const fbmLutCache = {};
  function fbmLut(octaves) {
    if (!fbmLutCache[octaves]) {
      const q = fbmQuantiles(octaves), M = 8192, lut = new Float32Array(M + 1);
      for (let i = 0; i <= M; i++) lut[i] = interpSorted(i / M, q);
      fbmLutCache[octaves] = lut;
    }
    return fbmLutCache[octaves];
  }

  function interpSorted(v, q) {   // np.interp(v, q, linspace(0, 1, len(q)))
    const n = q.length;
    if (v <= q[0]) return 0;
    if (v >= q[n - 1]) return 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (q[mid] <= v) lo = mid; else hi = mid; }
    const span = q[hi] - q[lo];
    return (lo + (span > 0 ? (v - q[lo]) / span : 0)) / (n - 1);
  }

  function fbm(xs, ys, scale, seed, octaves = 4, stretch = 1) {
    const out = new Float32Array(xs.length * ys.length);
    let amp = 1, tot = 0, used = 0;
    for (let o = 0; o < octaves; o++) {
      const s = scale / 2 ** o;
      if (s < 0.75 && used) break;
      const s2 = Math.max(s, 0.75);
      const v = valueNoise(xs, ys, s2 * stretch, s2, seed + 101 * o);
      for (let k = 0; k < out.length; k++) out[k] += amp * v[k];
      tot += amp; amp *= 0.5; used++;
    }
    const lut = fbmLut(used), M = lut.length - 1;   // precomputed uniformising curve: O(1) per pixel
    for (let k = 0; k < out.length; k++) {
      const pos = Math.max(0, Math.min(1, out[k] / tot)) * M, i = Math.floor(pos);
      out[k] = i >= M ? lut[M] : lut[i] + (lut[i + 1] - lut[i]) * (pos - i);
    }
    return out;
  }

  let BLUE_TILE = null;
  function blueTile() {
    if (BLUE_TILE) return BLUE_TILE;
    const bin = typeof atob === "function" ? atob(BLUE_NOISE_B64)
      : Buffer.from(BLUE_NOISE_B64, "base64").toString("binary");
    const t = new Float32Array(128 * 128);
    for (let k = 0; k < t.length; k++) t[k] = (bin.charCodeAt(2 * k) | (bin.charCodeAt(2 * k + 1) << 8)) / 16384;
    return (BLUE_TILE = t);
  }

  function blueNoise(xs, ys, grain, seed) {
    const t = blueTile(), n = 128, gw = xs.length, gh = ys.length;
    const ox = Math.floor(hash2(seed, 1, 3) * n), oy = Math.floor(hash2(seed, 2, 3) * n);
    const ix = new Int32Array(gw);
    for (let j = 0; j < gw; j++) ix[j] = (((Math.floor(xs[j] / grain) + ox) % n) + n) % n;
    const out = new Float32Array(gw * gh);
    for (let i = 0; i < gh; i++) {
      const row = ((((Math.floor(ys[i] / grain) + oy) % n) + n) % n) * n, ob = i * gw;
      for (let j = 0; j < gw; j++) out[ob + j] = t[row + ix[j]];
    }
    return out;
  }

  function lattice(xs, ys, cell) {
    const cx = new Int32Array(xs.length), cy = new Int32Array(ys.length);
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
    for (let j = 0; j < xs.length; j++) { const c = Math.floor(xs[j] / cell); cx[j] = c; if (c < mnx) mnx = c; if (c > mxx) mxx = c; }
    for (let i = 0; i < ys.length; i++) { const c = Math.floor(ys[i] / cell); cy[i] = c; if (c < mny) mny = c; if (c > mxy) mxy = c; }
    const x0 = mnx - 1, y0 = mny - 1, Lw = mxx - x0 + 2, Lh = mxy - y0 + 2;
    const values = (seed) => {
      const v = new Float32Array(Lw * Lh);
      for (let ly = 0; ly < Lh; ly++) for (let lx = 0; lx < Lw; lx++) v[ly * Lw + lx] = hash2(x0 + lx, y0 + ly, seed);
      return v;
    };
    const points = (seed) => {
      const jx = values(seed), jy = values(seed + 17), PX = new Float32Array(Lw * Lh), PY = new Float32Array(Lw * Lh);
      for (let ly = 0; ly < Lh; ly++) for (let lx = 0; lx < Lw; lx++) {
        const k = ly * Lw + lx;
        PX[k] = (x0 + lx + jx[k]) * cell; PY[k] = (y0 + ly + jy[k]) * cell;
      }
      return [PX, PY];
    };
    return { cx, cy, x0, y0, Lw, Lh, values, points };
  }

  function voronoiEdge(xs, ys, cell, seed) {
    const L = lattice(xs, ys, cell), [PX, PY] = L.points(seed), gw = xs.length, out = new Float32Array(gw * ys.length);
    for (let i = 0; i < ys.length; i++) {
      const Y = ys[i], ly = L.cy[i] - L.y0;
      for (let j = 0; j < gw; j++) {
        const X = xs[j], lx = L.cx[j] - L.x0;
        let f1 = Infinity, f2 = Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const k = (ly + dy) * L.Lw + lx + dx, ddx = X - PX[k], ddy = Y - PY[k], d = ddx * ddx + ddy * ddy;
          f2 = Math.min(f2, Math.max(f1, d)); f1 = Math.min(f1, d);
        }
        out[i * gw + j] = (Math.sqrt(f2) - Math.sqrt(f1)) * 0.5;
      }
    }
    return out;
  }

  function scratches(xs, ys, cell, seed, density, width) {
    const L = lattice(xs, ys, cell), [PX, PY] = L.points(seed + 5);
    const on = L.values(seed + 29), angV = L.values(seed + 31), halfV = L.values(seed + 37);
    const gw = xs.length, out = new Uint8Array(gw * ys.length);
    for (let i = 0; i < ys.length; i++) {
      const Y = ys[i], ly = L.cy[i] - L.y0;
      for (let j = 0; j < gw; j++) {
        const X = xs[j], lx = L.cx[j] - L.x0;
        for (let dy = -1; dy <= 1 && !out[i * gw + j]; dy++) for (let dx = -1; dx <= 1; dx++) {
          const k = (ly + dy) * L.Lw + lx + dx;
          if (!(on[k] < density)) continue;
          const ang = (angV[k] - 0.5) * 1.2 + 0.6, ux = Math.cos(ang), uy = Math.sin(ang);
          const half = (0.3 + 0.7 * halfV[k]) * cell * 0.8;
          const rx = X - PX[k], ry = Y - PY[k];
          const t = Math.max(-half, Math.min(half, rx * ux + ry * uy));
          const ex = rx - t * ux, ey = ry - t * uy, w = width * (1 - (t / half) ** 2);
          if (ex * ex + ey * ey < w * Math.abs(w)) { out[i * gw + j] = 1; break; }
        }
      }
    }
    return out;
  }

  // ================================================================ colour + image helpers

  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const unlin = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const fLab = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  function rgbToLab(r, g, b) {   // r,g,b 0..1 -> L 0..100, a, b
    const R = lin(r), G = lin(g), B = lin(b);
    const X = (0.412453 * R + 0.357580 * G + 0.180423 * B) / 0.950456;
    const Y = 0.212671 * R + 0.715160 * G + 0.072169 * B;
    const Z = (0.019334 * R + 0.119193 * G + 0.950227 * B) / 1.088754;
    const fx = fLab(X), fy = fLab(Y), fz = fLab(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }
  function labToRgb(L, a, b) {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
    const inv = (f) => (f ** 3 > 0.008856 ? f ** 3 : (f - 16 / 116) / 7.787);
    const X = inv(fx) * 0.950456, Y = inv(fy), Z = inv(fz) * 1.088754;
    const R = 3.240479 * X - 1.53715 * Y - 0.498535 * Z;
    const G = -0.969256 * X + 1.875991 * Y + 0.041556 * Z;
    const B = 0.055648 * X - 0.204043 * Y + 1.057311 * Z;
    return [R, G, B].map((c) => Math.round(Math.max(0, Math.min(1, unlin(Math.max(0, c)))) * 255));
  }
  const lab1 = (rgb) => rgbToLab(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
  const lum = (rgb) => (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  const luma = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;

  // Area-average resize of an interleaved float image (like OpenCV INTER_AREA); bilinear when enlarging.
  function resize(src, sw, sh, dw, dh, C) {
    if (dw === sw && dh === sh) return src.slice();
    if (dw > sw || dh > sh) return resizeBilinear(src, sw, sh, dw, dh, C);
    const tmp = new Float32Array(dw * sh * C), out = new Float32Array(dw * dh * C);
    const sx = sw / dw, sy = sh / dh;
    // Per output column, its source columns and weights, in flat typed arrays (fast inner loop).
    const start = new Int32Array(dw + 1), cols = [], wts = [];
    for (let x = 0; x < dw; x++) {
      const a = x * sx, b = a + sx, i0 = Math.floor(a), i1 = Math.min(sw, Math.ceil(b));
      start[x] = cols.length;
      for (let i = i0; i < i1; i++) { cols.push(i * C); wts.push((Math.min(b, i + 1) - Math.max(a, i)) / sx); }
    }
    start[dw] = cols.length;
    const tc = Int32Array.from(cols), tw = Float32Array.from(wts);
    for (let y = 0; y < sh; y++) {   // row by row: memory is read in order
      const sb = y * sw * C, tb = y * dw * C;
      if (C === 1) {
        for (let x = 0; x < dw; x++) {
          let acc = 0;
          for (let j = start[x]; j < start[x + 1]; j++) acc += src[sb + tc[j]] * tw[j];
          tmp[tb + x] = acc;
        }
        continue;
      }
      if (C === 3 || C === 4) {   // unrolled: the common cases, several times faster
        for (let x = 0; x < dw; x++) {
          let r = 0, g = 0, bl = 0, al = 0;
          for (let j = start[x]; j < start[x + 1]; j++) {
            const q = sb + tc[j], w = tw[j];
            r += src[q] * w; g += src[q + 1] * w; bl += src[q + 2] * w;
            if (C === 4) al += src[q + 3] * w;
          }
          const o = tb + x * C;
          tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = bl;
          if (C === 4) tmp[o + 3] = al;
        }
        continue;
      }
      for (let x = 0; x < dw; x++) {
        const o = tb + x * C;
        for (let j = start[x]; j < start[x + 1]; j++) {
          const q = sb + tc[j], w = tw[j];
          for (let c = 0; c < C; c++) tmp[o + c] += src[q + c] * w;
        }
      }
    }
    for (let y = 0; y < dh; y++) {
      const a = y * sy, b = a + sy, i0 = Math.floor(a), i1 = Math.min(sh, Math.ceil(b));
      for (let i = i0; i < i1; i++) {
        const w = (Math.min(b, i + 1) - Math.max(a, i)) / sy;
        const ob = y * dw * C, ib = i * dw * C;
        for (let k = 0; k < dw * C; k++) out[ob + k] += tmp[ib + k] * w;
      }
    }
    return out;
  }

  function resizeBilinear(src, sw, sh, dw, dh, C) {
    const out = new Float32Array(dw * dh * C);
    for (let y = 0; y < dh; y++) {
      let fy = (y + 0.5) * sh / dh - 0.5; fy = Math.max(0, Math.min(sh - 1, fy));
      const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < dw; x++) {
        let fx = (x + 0.5) * sw / dw - 0.5; fx = Math.max(0, Math.min(sw - 1, fx));
        const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
        for (let c = 0; c < C; c++) {
          const a = src[(y0 * sw + x0) * C + c], b = src[(y0 * sw + x1) * C + c];
          const d = src[(y1 * sw + x0) * C + c], e = src[(y1 * sw + x1) * C + c];
          out[(y * dw + x) * C + c] = (a + (b - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
        }
      }
    }
    return out;
  }

  function fitMax(w, h, maxSide) {
    const s = maxSide / Math.max(w, h);
    return s >= 1 ? [w, h] : [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
  }

  function gaussianBlur3(rgb, w, h, sigma) {   // separable Gaussian on interleaved RGB, mirrored edges
    const r = Math.ceil(sigma * 3), n = 2 * r + 1, k = new Float32Array(n);
    let sum = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
    for (let i = 0; i < n; i++) k[i] /= sum;
    const refl = (i, len) => { if (len === 1) return 0; while (i < 0 || i >= len) i = i < 0 ? -i : 2 * len - 2 - i; return i; };
    const cols = new Int32Array(w + 2 * r), rows = new Int32Array(h + 2 * r);
    for (let i = -r; i < w + r; i++) cols[i + r] = refl(i, w) * 3;
    for (let i = -r; i < h + r; i++) rows[i + r] = refl(i, h) * w * 3;
    const tmp = new Float32Array(rgb.length), out = new Float32Array(rgb.length);
    for (let y = 0; y < h; y++) {
      const row = y * w * 3;
      for (let x = 0; x < w; x++) {
        let a = 0, b = 0, c = 0;
        for (let t = 0; t < n; t++) { const q = row + cols[x + t], kv = k[t]; a += rgb[q] * kv; b += rgb[q + 1] * kv; c += rgb[q + 2] * kv; }
        const o = row + x * 3;
        tmp[o] = a; tmp[o + 1] = b; tmp[o + 2] = c;
      }
    }
    for (let y = 0; y < h; y++) {
      const o0 = y * w * 3;
      for (let x3 = 0; x3 < w * 3; x3++) {
        let a = 0;
        for (let t = 0; t < n; t++) a += tmp[rows[y + t] + x3] * k[t];
        out[o0 + x3] = a;
      }
    }
    return out;
  }

  /** Wide blurs are done on a smaller copy (same look, many times faster on big layers). */
  function blurFast(rgb, w, h, sigma) {
    if (sigma <= 1.5) return gaussianBlur3(rgb, w, h, sigma);
    const f = sigma / 1.2, sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
    const small = gaussianBlur3(resize(rgb, w, h, sw, sh, 3), sw, sh, 1.2);
    return resizeBilinear(small, sw, sh, w, h, 3);
  }

  function mulberry32(a) {
    return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }

  function kmeansLab(labs, n, k) {   // labs: Float32Array n*3
    k = Math.max(1, Math.min(k, n));
    const rnd = mulberry32(1234), centers = new Float32Array(k * 3), d2 = new Float32Array(n).fill(Infinity);
    let first = Math.floor(rnd() * n);
    centers.set(labs.subarray(first * 3, first * 3 + 3), 0);
    for (let c = 1; c < k; c++) {
      let tot = 0;
      for (let p = 0; p < n; p++) {
        const dx = labs[p * 3] - centers[(c - 1) * 3], dy = labs[p * 3 + 1] - centers[(c - 1) * 3 + 1], dz = labs[p * 3 + 2] - centers[(c - 1) * 3 + 2];
        d2[p] = Math.min(d2[p], dx * dx + dy * dy + dz * dz); tot += d2[p];
      }
      let pick = rnd() * tot, idx = 0;
      for (; idx < n - 1; idx++) { pick -= d2[idx]; if (pick <= 0) break; }
      centers.set(labs.subarray(idx * 3, idx * 3 + 3), c * 3);
    }
    const assign = new Int32Array(n);
    for (let it = 0; it < 40; it++) {
      let moved = 0;
      for (let p = 0; p < n; p++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const dx = labs[p * 3] - centers[c * 3], dy = labs[p * 3 + 1] - centers[c * 3 + 1], dz = labs[p * 3 + 2] - centers[c * 3 + 2];
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bd) { bd = d; best = c; }
        }
        if (assign[p] !== best) { assign[p] = best; moved++; }
      }
      const sum = new Float64Array(k * 3), cnt = new Float64Array(k);
      for (let p = 0; p < n; p++) { const c = assign[p]; cnt[c]++; for (let q = 0; q < 3; q++) sum[c * 3 + q] += labs[p * 3 + q]; }
      for (let c = 0; c < k; c++) if (cnt[c]) for (let q = 0; q < 3; q++) centers[c * 3 + q] = sum[c * 3 + q] / cnt[c];
      if (!moved && it) break;
    }
    const list = [];
    for (let c = 0; c < k; c++) list.push([centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]]);
    return list;
  }

  // ================================================================ prepare

  function removeFlatBackground(rgba8, w, h, tol) {
    const [sw, sh] = fitMax(w, h, 1200);
    let small = new Float32Array(w * h * 3);
    for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) small[p * 3 + c] = rgba8[p * 4 + c] / 255;
    small = resize(small, w, h, sw, sh, 3);
    const lab = new Float32Array(sw * sh * 3);
    for (let p = 0; p < sw * sh; p++) lab.set(rgbToLab(small[p * 3], small[p * 3 + 1], small[p * 3 + 2]), p * 3);
    const border = [];
    for (let x = 0; x < sw; x++) border.push(x, (sh - 1) * sw + x);
    for (let y = 0; y < sh; y++) border.push(y * sw, y * sw + sw - 1);
    const ref = [0, 1, 2].map((c) => { const v = border.map((p) => lab[p * 3 + c]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const dist = (p) => Math.hypot(lab[p * 3] - ref[0], lab[p * 3 + 1] - ref[1], lab[p * 3 + 2] - ref[2]);
    const near = border.filter((p) => dist(p) < tol).length / border.length;
    if (near < 0.6) return null;   // busy border: a photo, not a logo on a backdrop
    const bg = new Uint8Array(sw * sh);
    for (let p = 0; p < sw * sh; p++) bg[p] = dist(p) < tol ? 1 : 0;
    const seen = new Uint8Array(sw * sh), stack = [];
    for (const p of border) if (bg[p] && !seen[p]) { seen[p] = 1; stack.push(p); }
    while (stack.length) {
      const p = stack.pop(), x = p % sw, y = (p / sw) | 0;
      const nb = [x > 0 ? p - 1 : -1, x < sw - 1 ? p + 1 : -1, y > 0 ? p - sw : -1, y < sh - 1 ? p + sw : -1];
      for (const q of nb) if (q >= 0 && bg[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    const keep = new Float32Array(sw * sh);
    for (let p = 0; p < sw * sh; p++) keep[p] = seen[p] ? 0 : 1;
    const full = resizeBilinear(keep, sw, sh, w, h, 1);
    for (let p = 0; p < full.length; p++) full[p] = Math.max(0, Math.min(1, (full[p] - 0.25) / 0.5));
    return full;
  }

  function photoLike(rgb, alpha, w, h) {
    const [sw, sh] = fitMax(w, h, 400);
    const r = resize(rgb, w, h, sw, sh, 3), a = resize(alpha, w, h, sw, sh, 1);
    let n = 0, mid = 0;
    const colours = new Set();
    for (let p = 0; p < sw * sh; p++) {
      if (!(a[p] > 0.5)) continue;
      n++;
      const L = luma(r[p * 3], r[p * 3 + 1], r[p * 3 + 2]);
      if (L > 0.12 && L < 0.88) mid++;
      colours.add((Math.floor(r[p * 3] * 15.99) << 8) | (Math.floor(r[p * 3 + 1] * 15.99) << 4) | Math.floor(r[p * 3 + 2] * 15.99));
    }
    return n >= 50 && mid / n > 0.3 && colours.size > 180;
  }

  function cropTo(rgb, alpha, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 0.02) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (x1 < 0) return null;
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, r2 = new Float32Array(cw * ch * 3), a2 = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      r2.set(rgb.subarray(((y + y0) * w + x0) * 3, ((y + y0) * w + x0 + cw) * 3), y * cw * 3);
      a2.set(alpha.subarray((y + y0) * w + x0, (y + y0) * w + x0 + cw), y * cw);
    }
    return { rgb: r2, alpha: a2, w: cw, h: ch, x0, y0 };
  }

  function composeText(art, o, renderText) {
    const aw = art ? art.w : 1, artH = art ? art.h / art.w : 0;
    const layout = (s) => o.text.map((t) => {
      const m = renderText(t, t.size * s);   // {mask, w, h, ax, ay}
      return { m, left: t.x * s - m.ax, top: t.y * s - m.ay, col: hex(t.color).map((c) => c / 255) };
    });
    const bounds = (items, s) => {
      const b = items.map((it) => [it.left, it.top, it.left + it.m.w, it.top + it.m.h]);
      if (art) b.push([-s / 2, -artH * s / 2, s / 2, artH * s / 2]);
      return [Math.min(...b.map((v) => v[0])), Math.min(...b.map((v) => v[1])),
        Math.max(...b.map((v) => v[2])), Math.max(...b.map((v) => v[3]))];
    };
    const probe = 1000;
    let [x0, y0, x1, y1] = bounds(layout(probe), probe);
    const wu = (x1 - x0) / probe, hu = (y1 - y0) / probe;
    let s = textWorkWidth(o) / Math.max(wu, 1e-3);
    s = Math.min(s, MAX_SOURCE_SIDE / Math.max(hu, 1e-3), MAX_SOURCE_SIDE / Math.max(wu, 1e-3));
    const items = layout(s);
    [x0, y0, x1, y1] = bounds(items, s);
    const W = Math.ceil(x1 - x0) + 2, H = Math.ceil(y1 - y0) + 2;
    const rgb = new Float32Array(W * H * 3), alpha = new Float32Array(W * H);
    if (art) {
      const w = Math.max(1, Math.round(s)), h = Math.max(1, Math.round(artH * s));
      const pm = new Float32Array(art.w * art.h * 4);
      for (let p = 0; p < art.w * art.h; p++) {
        const a = art.alpha[p];
        pm[p * 4] = art.rgb[p * 3] * a; pm[p * 4 + 1] = art.rgb[p * 3 + 1] * a; pm[p * 4 + 2] = art.rgb[p * 3 + 2] * a; pm[p * 4 + 3] = a;
      }
      const r2 = resize(pm, art.w, art.h, w, h, 4);
      const left = Math.round(-s / 2 - x0), top = Math.round(-artH * s / 2 - y0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const X = x + left, Y = y + top;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const a = Math.max(0, Math.min(1, r2[(y * w + x) * 4 + 3])), q = Y * W + X;
        alpha[q] = a;
        for (let c = 0; c < 3; c++) rgb[q * 3 + c] = Math.max(0, Math.min(1, r2[(y * w + x) * 4 + c] / Math.max(a, 1e-4)));
      }
    }
    for (const it of items) {
      const left = Math.round(it.left - x0), top = Math.round(it.top - y0);
      for (let y = 0; y < it.m.h; y++) for (let x = 0; x < it.m.w; x++) {
        const X = x + left, Y = y + top;
        if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const ta = it.m.mask[y * it.m.w + x] / 255;
        if (!ta) continue;
        const q = Y * W + X;
        for (let c = 0; c < 3; c++) rgb[q * 3 + c] = rgb[q * 3 + c] * (1 - ta) + it.col[c] * ta;
        alpha[q] = ta + alpha[q] * (1 - ta);
      }
    }
    return { rgb, alpha, w: W, h: H };
  }

  /** rgba8: Uint8ClampedArray/Uint8Array (straight alpha) or null for a text-only design. */
  // ---- bootleg keyline + drop shadow (same as the Python engine's _add_outline)
  function outlineRgb(o) { return o.outline_color !== "auto" ? hex(o.outline_color) : contrastInk(hex(o.garment)); }

  function edt1(f, n, d, v, z) {   // Felzenszwalb & Huttenlocher squared distance, one line
    let k = 0;
    v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < n; q++) {
      let sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (sv <= z[k]) { k--; sv = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = sv; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) ** 2 + f[v[k]]; }
  }
  function distanceToInside(inside, w, h) {   // exact Euclidean distance (pixels) to the nearest inside pixel
    const INF = 1e20, g = new Float64Array(w * h), n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = inside[y * w + x] ? 0 : INF;
      edt1(f, h, d, v, z);
      for (let y = 0; y < h; y++) g[y * w + x] = d[y];
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = g[y * w + x];
      edt1(f, w, d, v, z);
      for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]);
    }
    return out;
  }
  function addOutline(img, o) {   // -> {rgb, alpha, w, h, ox, oy}
    const w = img.w, h = img.h, r = o.outline * w, dd = o.shadow * w, pad = Math.ceil(r + dd) + 2;
    const W = w + 2 * pad, H = h + 2 * pad, A = new Float32Array(W * H), C = new Float32Array(W * H * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const q = (y + pad) * W + x + pad, p = y * w + x;
      A[q] = img.alpha[p]; C[q * 3] = img.rgb[p * 3]; C[q * 3 + 1] = img.rgb[p * 3 + 1]; C[q * 3 + 2] = img.rgb[p * 3 + 2];
    }
    let under = A;
    if (r > 0) {
      const inside = new Uint8Array(W * H);
      for (let k = 0; k < W * H; k++) inside[k] = A[k] > 0.5 ? 1 : 0;
      const dist = distanceToInside(inside, W, H);
      under = new Float32Array(W * H);
      for (let k = 0; k < W * H; k++) under[k] = Math.max(A[k], Math.min(1, Math.max(0, r + 0.5 - dist[k])));
    }
    if (dd > 0) {
      const kk = Math.round(dd * Math.sqrt(0.5)), moved = new Float32Array(W * H);
      for (let y = kk; y < H; y++) for (let x = kk; x < W; x++) moved[y * W + x] = under[(y - kk) * W + x - kk];
      const u2 = new Float32Array(W * H);
      for (let k = 0; k < W * H; k++) u2[k] = Math.max(under[k], moved[k]);
      under = u2;
    }
    const col = outlineRgb(o).map((c) => c / 255);
    const outA = new Float32Array(W * H), outC = new Float32Array(W * H * 3);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let k = 0; k < W * H; k++) {
      const a = A[k], u = under[k] * (1 - a), t = a + u;
      outA[k] = t;
      const div = Math.max(t, 1e-6);
      for (let c = 0; c < 3; c++) outC[k * 3 + c] = Math.min(1, Math.max(0, (C[k * 3 + c] * a + col[c] * u) / div));
      if (t > 0.02) { const x = k % W, y = (k - x) / W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1, rgb = new Float32Array(cw * ch * 3), alpha = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      alpha.set(outA.subarray((y + y0) * W + x0, (y + y0) * W + x0 + cw), y * cw);
      rgb.set(outC.subarray(((y + y0) * W + x0) * 3, ((y + y0) * W + x0 + cw) * 3), y * cw * 3);
    }
    return { rgb, alpha, w: cw, h: ch, ox: x0 - pad, oy: y0 - pad };
  }

  // Colour regions painted onto the picture before it is separated: tint multiplies (shading and black
  // lines stay), solid fills the area. masks: {id: {data: Uint8 0..255, w, h}}, stretched to fit.
  function applyRegions(rgb, w, h, o, masks) {
    for (const r of o.regions) {
      const m = (masks || {})[r.mask_id];
      if (!r.on || !m) continue;
      const col = hex(r.color).map((v) => v / 255), sx = m.w / w, sy = m.h / h;
      for (let y = 0; y < h; y++) {
        const fy = Math.min(m.h - 1, Math.max(0, (y + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(m.h - 1, y0 + 1), ty = fy - y0;
        for (let x = 0; x < w; x++) {
          const fx = Math.min(m.w - 1, Math.max(0, (x + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(m.w - 1, x0 + 1), tx = fx - x0;
          const a = m.data[y0 * m.w + x0] + (m.data[y0 * m.w + x1] - m.data[y0 * m.w + x0]) * tx;
          const b = m.data[y1 * m.w + x0] + (m.data[y1 * m.w + x1] - m.data[y1 * m.w + x0]) * tx;
          const k = (a + (b - a) * ty) / 255;
          if (k <= 0) continue;
          const q = (y * w + x) * 3;
          for (let c = 0; c < 3; c++) {
            const painted = r.mode === "tint" ? rgb[q + c] * col[c] : col[c];
            rgb[q + c] = rgb[q + c] * (1 - k) + painted * k;
          }
        }
      }
    }
  }

  function prepareArt(rgba8, width, height, o, masks) {   // -> {art, crop}; art is null when nothing is left
    let art = null, crop = [0, 0, 0, 0];
    if (rgba8) {
      let w = width, h = height, back = 1;
      let rgb = new Float32Array(w * h * 3), alpha = new Float32Array(w * h);
      for (let p = 0; p < w * h; p++) {
        rgb[p * 3] = rgba8[p * 4] / 255; rgb[p * 3 + 1] = rgba8[p * 4 + 1] / 255; rgb[p * 3 + 2] = rgba8[p * 4 + 2] / 255;
        alpha[p] = rgba8[p * 4 + 3] / 255;
      }
      const [fw, fh] = fitMax(w, h, MAX_SOURCE_SIDE);
      let src8 = rgba8;
      if (fw !== w) {
        back = w / fw;
        rgb = resize(rgb, w, h, fw, fh, 3); alpha = resize(alpha, w, h, fw, fh, 1);
        src8 = new Uint8Array(fw * fh * 4);
        for (let p = 0; p < fw * fh; p++) { for (let c = 0; c < 3; c++) src8[p * 4 + c] = rgb[p * 3 + c] * 255; src8[p * 4 + 3] = 255; }
        w = fw; h = fh;
      }
      if (o.regions.length) applyRegions(rgb, w, h, o, masks);
      let transparent = 0;
      for (let p = 0; p < w * h; p++) if (alpha[p] < 0.5) transparent++;
      if (o.remove_background && transparent / (w * h) <= 0.01) {
        const keep = removeFlatBackground(src8, w, h, o.bg_tolerance);
        if (keep) for (let p = 0; p < w * h; p++) alpha[p] *= keep[p];
      }
      if (o.denoise) rgb = median3(rgb, w, h, o.denoise);
      if (o.smooth_mm > 0) {
        let mn = w, mx = -1;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (alpha[y * w + x] > 0.02) { if (x < mn) mn = x; if (x > mx) mx = x; }
        const artW = mx >= mn ? mx - mn + 1 : w;
        rgb = blurFast(rgb, w, h, Math.max(0.3, o.smooth_mm * artW / (o.width_in * 25.4)));   // mm on the print -> source px
      }
      if (o.sharpen > 0) {
        const blur = blurFast(rgb, w, h, Math.max(0.8, Math.max(w, h) / 1500));
        for (let k = 0; k < rgb.length; k++) rgb[k] = Math.max(0, Math.min(1, rgb[k] + o.sharpen * (rgb[k] - blur[k])));
      }
      art = cropTo(rgb, alpha, w, h);
      if (art) crop = [Math.round(art.x0 * back), Math.round(art.y0 * back), Math.round(art.w * back), Math.round(art.h * back)];
    }
    return { art, crop, picture: !!rgba8 };
  }

  function prepare(rgba8, width, height, o, renderText, stage, masks) {
    const stg = stage || prepareArt(rgba8, width, height, o, masks), { art, picture } = stg;
    let crop = stg.crop;
    if (picture && !art && !o.text.length) {
      throw new ImageError("Nothing is left to print once the background is removed. " +
        "Turn off background removal or lower its tolerance.");
    }
    if (!picture && !o.text.length) throw new ImageError("Add a picture or some text.");

    const photo = !!art && photoLike(art.rgb, art.alpha, art.w, art.h);
    let img = art;
    if (o.text.length) {
      if (!renderText) throw new ImageError("Text needs a browser to draw it.");
      const comp = composeText(art, o, renderText);
      img = cropTo(comp.rgb, comp.alpha, comp.w, comp.h);
      if (!img) throw new ImageError("Nothing to print.");
    }
    if (o.outline > 0 || o.shadow > 0) {
      const back = art && art.w ? crop[2] / art.w : 1;
      img = addOutline(img, o);
      if (!o.text.length) crop = [Math.round(crop[0] + img.ox * back), Math.round(crop[1] + img.oy * back), Math.round(img.w * back), Math.round(img.h * back)];
    }
    const pm = new Float32Array(img.w * img.h * 4);
    for (let p = 0; p < img.w * img.h; p++) {
      const a = img.alpha[p];
      pm[p * 4] = img.rgb[p * 3] * a; pm[p * 4 + 1] = img.rgb[p * 3 + 1] * a; pm[p * 4 + 2] = img.rgb[p * 3 + 2] * a; pm[p * 4 + 3] = a;
    }
    const prep = { rgba: pm, srcW: img.w, srcH: img.h, palette: null, paletteLab: null, crop, photoLike: photo, levels: {},
      spotLab: null, palettes: {}, lumCounts: new Float64Array(256), lumRgb: new Float64Array(256 * 3),
      token: Math.random().toString(36).slice(2) };

    // Sample up to 40,000 art pixels without listing them all (big layers have millions).
    const total = img.w * img.h, idx = [];
    const step = Math.max(1, Math.floor(total / 160000));
    for (let p = 0; p < total; p += step) if (img.alpha[p] > 0.5) idx.push(p);
    if (!idx.length) for (let p = 0; p < total && idx.length < 40000; p++) if (img.alpha[p] > 0.5) idx.push(p);
    if (!idx.length) idx.push(0);
    const rnd = mulberry32(0), n = Math.min(idx.length, 40000), labs = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const p = idx.length > n ? idx[Math.floor(rnd() * idx.length)] : idx[k];
      const r = img.rgb[p * 3], g = img.rgb[p * 3 + 1], b = img.rgb[p * 3 + 2];
      labs.set(rgbToLab(r, g, b), k * 3);
      const bin = Math.max(0, Math.min(255, Math.round(luma(r, g, b) * 255)));   // tone histogram for threshold layers
      prep.lumCounts[bin]++;
      prep.lumRgb[bin * 3] += r * 255; prep.lumRgb[bin * 3 + 1] += g * 255; prep.lumRgb[bin * 3 + 2] += b * 255;
    }
    prep.spotLab = labs;
    if (o.mode === "spot") [prep.paletteLab, prep.palette] = spotPalette(prep, o.spot_colors);
    return prep;
  }

  function median3(rgb, w, h, level) {   // speckle removal: per-channel median, window 3/5/7
    const r = level, out = new Float32Array(rgb.length), win = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      win.length = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) win.push(rgb[(yy * w + Math.min(w - 1, Math.max(0, x + dx))) * 3 + c]);
      }
      win.sort((a, b) => a - b);
      out[(y * w + x) * 3 + c] = win[win.length >> 1];
    }
    return out;
  }

  /** k colours from a built-in palette: the ones closest to the art's own colours (light first). */
  function isGreyscale(prep) {   // black-and-white art (no real colour), e.g. a pencil or ink drawing
    const L = prep.spotLab;
    if (!L || !L.length) return false;
    const c = [];
    for (let i = 0; i < L.length; i += 3) c.push(Math.hypot(L[i + 1], L[i + 2]));
    c.sort((x, y) => x - y);
    const at = (q) => {   // linear interpolation, like numpy's percentile
      const p = q * (c.length - 1), lo = Math.floor(p), hi = Math.min(c.length - 1, lo + 1);
      return c[lo] + (c[hi] - c[lo]) * (p - lo);
    };
    return at(0.5) < 6 && at(0.9) < 14;
  }
  function paletteByTone(name, k, exclude = null) {   // k palette colours spread light -> dark
    let cols = PALETTES[name].colors.map(hex);
    if (exclude) { const kept = cols.filter((c) => labDist(lab1(c), lab1(exclude)) >= 20); if (kept.length) cols = kept; }
    cols = cols.map((c, i) => [c, lab1(c)[0], i]).sort((a, b) => b[1] - a[1] || a[2] - b[2]).map((x) => x[0]);
    if (cols.length <= k) return cols;
    if (k === 1) return [cols[Math.floor(cols.length / 2)]];
    return Array.from({ length: k }, (_, i) => cols[Math.round(i * (cols.length - 1) / (k - 1))]);
  }

  function fixedPalette(name, k, prep, exclude = null) {
    let cols = PALETTES[name].colors.map(hex);
    if (exclude) { const kept = cols.filter((c) => labDist(lab1(c), lab1(exclude)) >= 20); if (kept.length) cols = kept; }
    if (cols.length > k && prep && prep.spotLab) {
      const [want] = spotPalette(prep, k, exclude), labs = cols.map(lab1), chosen = [];
      for (const w of want) {
        let best = -1, bd = Infinity;
        labs.forEach((l, i) => { if (!chosen.includes(i)) { const d = labDist(l, w); if (d < bd) { bd = d; best = i; } } });
        chosen.push(best);
      }
      cols = chosen.map((i) => cols[i]);
    }
    cols = cols.slice(0, k).sort((a, b) => lab1(b)[0] - lab1(a)[0]);
    return [cols.map(lab1), cols];
  }

  function kmeans1d(values, weights, k) {
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    const v = order.map((i) => values[i]), w = order.map((i) => weights[i]), tot = w.reduce((a, b) => a + b, 0);
    if (tot <= 0) return Array.from({ length: k }, (_, i) => 0.1 + 0.8 * i / Math.max(1, k - 1));
    let acc = 0;
    const cdf = w.map((x) => (acc += x) / tot);
    let centers = Array.from({ length: k }, (_, i) => {
      const q = (i + 0.5) / k;
      let j = cdf.findIndex((c) => c >= q);
      if (j < 0) j = v.length - 1;
      return v[j];
    });
    for (let it = 0; it < 60; it++) {
      const sum = new Array(k).fill(0), cnt = new Array(k).fill(0);
      v.forEach((x, i) => {
        let best = 0;
        for (let c = 1; c < k; c++) if (Math.abs(x - centers[c]) < Math.abs(x - centers[best])) best = c;
        sum[best] += x * w[i]; cnt[best] += w[i];
      });
      const nw = centers.map((c, i) => (cnt[i] > 0 ? sum[i] / cnt[i] : c));
      const done = nw.every((c, i) => Math.abs(c - centers[i]) < 1e-5);
      centers = nw;
      if (done) break;
    }
    return centers.sort((a, b) => a - b);
  }

  /** Cut points between tones: yours, or automatic (weighted 1-D k-means on the art's tones). */
  function thresholdCuts(prep, o) {
    const n = o.threshold_levels;
    if (o.thresholds.length === n - 1) return o.thresholds.slice();
    const tone = toneFn(o), L = Array.from({ length: 256 }, (_, i) => { const t = tone(i / 255); return o.invert ? 1 - t : t; });
    const centers = kmeans1d(L, Array.from(prep.lumCounts), n), out = [];
    let last = 0;
    for (let i = 0; i < n - 1; i++) {
      const c = Math.min(0.98, Math.max(last + 0.02, (centers[i] + centers[i + 1]) / 2));
      out.push(Math.round(c * 1000) / 1000);
      last = c;
    }
    return out;
  }

  function bandColors(prep, o, cuts) {   // colour of each tone, darkest first
    const n = cuts.length + 1;
    if (o.threshold_colors === "ink") {
      const base = hex(o.inks[0]);
      return Array.from({ length: n }, (_, k) => base.map((v) => Math.round(v + (255 - v) * (0.85 * k / Math.max(1, n - 1)))));
    }
    if (o.threshold_colors === "palette" && o.palette !== "image") {
      const cols = PALETTES[o.palette].colors.map(hex).sort((a, b) => lum(a) - lum(b));
      return Array.from({ length: n }, (_, k) => cols[Math.round(k * (cols.length - 1) / Math.max(1, n - 1))]);
    }
    const tone = toneFn(o), edges = [-1, ...cuts, 2], out = [];
    for (let k = 0; k < n; k++) {
      let cnt = 0;
      const sum = [0, 0, 0];
      for (let b = 0; b < 256; b++) {
        let L = tone(b / 255);
        if (o.invert) L = 1 - L;
        if (L >= edges[k] && L < edges[k + 1]) { cnt += prep.lumCounts[b]; for (let c = 0; c < 3; c++) sum[c] += prep.lumRgb[b * 3 + c]; }
      }
      if (cnt > 0) out.push(sum.map((v) => Math.round(v / cnt)));
      else { const mid = (Math.max(edges[k], 0) + Math.min(edges[k + 1], 1)) / 2; out.push([0, 0, 0].map(() => Math.floor(mid * 255))); }
    }
    return out;
  }

  /** k spot colours from the art (light first). exclude: a shirt colour whose look-alikes are left out. */
  function spotPalette(prep, k, exclude = null) {
    const key = `${k}|${exclude ? exclude.join(",") : ""}`;
    if (!prep.palettes[key]) {
      let labs = prep.spotLab, n = labs.length / 3;
      if (exclude) {
        const ex = lab1(exclude), keep = [];
        for (let p = 0; p < n; p++) if (labDist([labs[p * 3], labs[p * 3 + 1], labs[p * 3 + 2]], ex) > 20) keep.push(p);
        if (keep.length >= Math.max(k, 16)) {
          const f = new Float32Array(keep.length * 3);
          keep.forEach((p, i) => f.set(labs.subarray(p * 3, p * 3 + 3), i * 3));
          labs = f; n = keep.length;
        }
      }
      const centers = kmeansLab(labs, n, Math.max(1, k)).sort((a, b) => b[0] - a[0]);
      prep.palettes[key] = [centers, centers.map((c) => labToRgb(c[0], c[1], c[2]))];
    }
    return prep.palettes[key];
  }

  function outSize(prep, o) {
    const w = Math.max(1, Math.round(o.width_in * o.dpi));
    return [w, Math.max(1, Math.round(w * prep.srcH / prep.srcW))];
  }

  function level(prep, factor) {
    const key = Math.round(Math.log2(factor) * 4) / 4;
    if (key <= 0.5) return { data: prep.rgba, w: prep.srcW, h: prep.srcH };
    if (!prep.levels[key]) {
      const f = 2 ** key, w = Math.max(1, Math.round(prep.srcW / f)), h = Math.max(1, Math.round(prep.srcH / f));
      prep.levels[key] = { data: resize(prep.rgba, prep.srcW, prep.srcH, w, h, 4), w, h };
    }
    return prep.levels[key];
  }

  // ================================================================ sample + tone

  function sample(prep, x0, y0, gw, gh, step, outW, dx = 0, dy = 0) {
    const k = prep.srcW / outW, src = level(prep, k * step);
    const sx = src.w / prep.srcW, sy = src.h / prep.srcH;
    const m00 = k * step * sx, m02 = ((x0 - dx) + 0.5 * step) * k * sx - 0.5;
    const m11 = k * step * sy, m12 = ((y0 - dy) + 0.5 * step) * k * sy - 0.5;
    const rgb = new Float32Array(gw * gh * 3), a = new Float32Array(gw * gh), d = src.data, W = src.w, H = src.h;
    for (let i = 0; i < gh; i++) {
      const fy = m11 * i + m12, yi = Math.floor(fy), ty = fy - yi;
      for (let j = 0; j < gw; j++) {
        const fx = m00 * j + m02, xi = Math.floor(fx), tx = fx - xi;
        let r = 0, g = 0, b = 0, al = 0;
        for (let q = 0; q < 4; q++) {
          const X = xi + (q & 1), Y = yi + (q >> 1);
          if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
          const w = ((q & 1) ? tx : 1 - tx) * ((q >> 1) ? ty : 1 - ty), o4 = (Y * W + X) * 4;
          r += d[o4] * w; g += d[o4 + 1] * w; b += d[o4 + 2] * w; al += d[o4 + 3] * w;
        }
        const p = i * gw + j, div = Math.max(al, 1e-4);
        a[p] = Math.max(0, Math.min(1, al));
        rgb[p * 3] = Math.max(0, Math.min(1, r / div)); rgb[p * 3 + 1] = Math.max(0, Math.min(1, g / div));
        rgb[p * 3 + 2] = Math.max(0, Math.min(1, b / div));
      }
    }
    return { rgb, a };
  }

  function toneFn(o) {
    const fac = o.contrast ? Math.tan((o.contrast * 0.98 + 1) * Math.PI / 4) : 1;
    return (v) => {
      v = Math.max(0, Math.min(1, (v - o.black_point) / (o.white_point - o.black_point)));
      if (o.gamma !== 1) v = v ** (1 / o.gamma);
      if (o.brightness) v += o.brightness * 0.5;
      if (o.contrast) v = (v - 0.5) * fac + 0.5;
      return Math.max(0, Math.min(1, v));
    };
  }

  function shapeDots(c, o) {
    const g = o.dot_gain;
    for (let k = 0; k < c.length; k++) {
      let v = c[k];
      if (g > 0) v = ((1 + 4 * g) - Math.sqrt(Math.max((1 + 4 * g) ** 2 - 16 * g * v, 0))) / (8 * g);
      if (o.min_dot > 0) v = v < o.min_dot * 0.5 ? 0 : Math.max(v, o.min_dot);
      if (o.max_dot < 1) v = v > (1 + o.max_dot) * 0.5 ? 1 : Math.min(v, o.max_dot);
      c[k] = v;
    }
    return c;
  }

  // ================================================================ fit to shirt + plates

  const contrastInk = (g) => (Math.abs(lum(CREAM) - lum(g)) >= Math.abs(lum(INK_BLACK) - lum(g)) ? CREAM : INK_BLACK);
  const labDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  function resolveFit(prep, o) {
    const g = hex(o.garment), lg = lum(g);
    let mode = o.shirt_fit;
    if (mode === "auto") mode = prep.photoLike ? "tones" : "recolor";
    const fit = { mode, inks: o.inks.map(hex), spot: [], underbase: false, notes: [] };
    const name = (c) => (c === CREAM ? "cream" : "black");
    if (mode !== "off" && (o.mode === "mono" || o.mode === "duotone") && Math.abs(lum(fit.inks[0]) - lg) < 0.3) {
      const nw = contrastInk(g);
      fit.notes.push(`Ink ${toHex(fit.inks[0])} would disappear on this shirt, so it prints in ${name(nw)}.`);
      fit.inks[0] = nw;
    }
    const printed0 = fit.inks.slice(0, o.mode === "duotone" ? 2 : 1);
    let auto = o.underbase === "auto" && o.target === "screen" && lg < 0.6;
    if (o.mode === "mono" || o.mode === "duotone") auto = auto && printed0.some((c) => lum(c) < 0.85);
    fit.underbase = o.underbase === "on" || auto;
    fit.shirtIsBlack = fit.underbase && lg < 0.35 && ["cmyk", "spot", "index", "threshold"].includes(o.mode);
    fit.palette = []; fit.paletteLab = null; fit.cuts = []; fit.bands = [];
    if (o.mode === "threshold") {
      fit.cuts = thresholdCuts(prep, o);
      let cols = bandColors(prep, o, fit.cuts);
      if (o.inks.length === cols.length) cols = o.inks.map(hex);
      let free = null;
      if (mode !== "off") {
        const d = cols.map((c) => Math.abs(lum(c) - lg)), j = d.indexOf(Math.min(...d));
        if (d[j] < 0.2) free = j;
      }
      fit.bands = cols.map((c, i) => (i === free ? null : c));
      if (free !== null) fit.notes.push(`Tone ${free + 1} (${toHex(cols[free])}) is the shirt colour, so the shirt shows through there.`);
    }
    if (o.mode === "spot" || o.mode === "index") {
      // With a white base, it counts as one of the screens: 4 colours = white + 3 spot colours.
      const k = fit.underbase ? Math.max(1, o.spot_colors - 1) : o.spot_colors;
      const exclude = fit.shirtIsBlack || o.mode === "index" ? g : null;
      let labs, pal;
      if (o.palette !== "image" && isGreyscale(prep)) {
        // Black-and-white art: match the picture's own tones, print them in the palette's colours (gradient map).
        pal = paletteByTone(o.palette, k, exclude);
        let grey;
        [labs, grey] = spotPalette(prep, pal.length, exclude);
        fit.match = grey.slice();
        fit.notes.push("Black-and-white art: the palette colours its tones, light to dark.");
      } else {
        [labs, pal] = o.palette !== "image" ? fixedPalette(o.palette, k, prep, exclude) : spotPalette(prep, k, exclude);
        fit.match = pal.slice();
      }
      fit.paletteLab = labs; fit.palette = pal.slice();
      const base = o.inks.length === pal.length ? o.inks.map(hex) : pal.slice();
      const glab = lab1(g);
      base.forEach((c, i) => {
        const close = mode !== "off" && labDist(lab1(c), glab) < 14;
        if (close && (mode === "tones" || fit.underbase || o.mode === "index")) {
          fit.spot.push(null);
          fit.notes.push(`Spot ${i + 1} (${toHex(c)}) matches the shirt, so the shirt shows through instead.`);
        } else if (close) {
          const nw = contrastInk(g);
          fit.spot.push(nw);
          fit.notes.push(`Spot ${i + 1} (${toHex(c)}) matches the shirt, so it prints in ${name(nw)}.`);
        } else fit.spot.push(c);
      });
    }
    if (fit.underbase) {
      if (o.mode === "cmyk" && fit.shirtIsBlack) {
        fit.notes.push("Dark shirt: prints as a white base + cyan, magenta, yellow. The shirt itself is the black, so there's no black ink.");
      } else if (o.mode === "cmyk") {
        fit.notes.push("White base under the process colours, solved for this shirt colour.");
      } else if (o.mode === "threshold") {
        fit.notes.push(`White base + ${fit.bands.filter((c) => c).length} tones` + (fit.shirtIsBlack ? " (the shirt is the black)." : "."));
      } else if (o.mode === "spot" || o.mode === "index") {
        fit.notes.push(`White base + ${fit.spot.filter((c) => c).length} spot colours` + (fit.shirtIsBlack ? " (the shirt is the black)." : "."));
      } else if (o.underbase === "auto") {
        fit.notes.push("Dark shirt: a choked white underbase is added under the colours so they stay bright.");
      }
    }
    return fit;
  }

  // Plain screen-print ink names (table from the Python engine); nearest by CIE76 in Lab.
  const INK_LABS = CATALOG.ink_names.map(([n, c]) => [n, rgbToLab(c[0] / 255, c[1] / 255, c[2] / 255)]);
  function inkName(rgb) {
    const [L, a, b] = rgbToLab(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
    let best = "Ink", bd = Infinity;
    for (const [n, [l2, a2, b2]] of INK_LABS) {
      const d = (L - l2) ** 2 + (a - a2) ** 2 + (b - b2) ** 2;
      if (d < bd) { best = n; bd = d; }
    }
    return best;
  }
  function labelPlates(plates) {   // process inks + underbase keep their names; repeats get 2, 3...
    const seen = {}, process = new Set(PROCESS_INKS.map((x) => x[0]));
    for (const p of plates) {
      if (!p.label) p.label = p.underbase || p.highlight || process.has(p.name) ? p.name : inkName(p.rgb);
      const base = p.label;
      seen[base] = (seen[base] || 0) + 1;
      if (seen[base] > 1) p.label = `${base} ${seen[base]}`;
    }
  }

  function plateSpecs(prep, o, fit) {
    fit = fit || resolveFit(prep, o);
    let plates, blend;
    const P = (name, rgb, angle, src = 0, underbase = false) => ({ name, rgb, angle, shift: [0, 0], src, underbase, on: true, choke_mm: 0, label: "", highlight: false });
    if (o.mode === "mono") { plates = [P("Ink", fit.inks[0], o.angle)]; blend = "opaque"; }
    else if (o.mode === "duotone") {
      plates = [P("Shadow ink", fit.inks[0], o.angle, 0), P("Second ink", fit.inks[1], o.angle + 30, 1)]; blend = "multiply";
    } else if (o.mode === "cmyk") {
      plates = PROCESS_INKS.map(([n, c, a], i) => P(n, c, o.angle + a, i)).filter((p) => !(fit.shirtIsBlack && p.name === "Black"));
      blend = "multiply";
    } else if (o.mode === "threshold") {
      const n = fit.bands.length;   // light tones print first, darker ones on top
      plates = [];
      for (let k = n - 1; k >= 0; k--) if (fit.bands[k]) plates.push(P(`Tone ${k + 1}`, fit.bands[k], o.angle + 15 * (n - 1 - k), k));
      blend = "opaque";
    } else if (o.mode === "index") {
      plates = [];
      fit.spot.forEach((c, i) => { if (c) plates.push(P(`Colour ${i + 1}`, c, o.angle, i)); });
      blend = "opaque";
    } else {
      plates = [];
      fit.spot.forEach((c, i) => { if (c) plates.push(P(`Spot ${i + 1}`, c, o.angle + 30 * i, i)); });
      blend = "opaque";
    }
    if (fit.underbase) {
      plates.unshift(Object.assign(P("White underbase", [255, 255, 255], o.angle + 7.5, o.mode === "cmyk" ? 4 : -1, true), { choke_mm: o.choke_mm }));
    }
    if (o.highlight > 0) plates.push(Object.assign(P("Highlight white", hex(o.highlight_color), o.angle + 15, -2), { highlight: true }));
    for (const p of plates) {
      const e = o.ink_edits[p.name];
      if (!e) continue;
      p.on = e.on;
      p.label = e.name || "";
      if (e.color && !p.underbase) p.rgb = hex(e.color);   // your own colour for this ink: same dots, new ink
      if (!p.underbase) p.choke_mm = e.choke_mm;
    }
    labelPlates(plates);
    return { plates, blend, fit };
  }

  function misregistration(plates, o) {
    const px = o.misregister_mm * o.dpi / 25.4;
    for (const p of plates) {
      const i = p.src;
      if (i <= 0 || px <= 0 || p.underbase) { p.shift = [0, 0]; continue; }
      const ang = hash2(i, o.seed, 911) * 2 * Math.PI, mag = px * (0.5 + 0.5 * hash2(i, o.seed, 913));
      p.shift = [mag * Math.cos(ang), mag * Math.sin(ang)];
    }
  }

  function coverages(s, prep, o, fit) {
    const n = s.a.length, rgb = s.rgb, a = s.a, tone = toneFn(o);
    if (o.mode === "mono" || o.mode === "duotone") {
      const c = new Float32Array(n);
      const tones = fit.mode === "tones" && o.mode === "mono";
      const li = lum(fit.inks[0]), lg = lum(hex(o.garment));
      for (let p = 0; p < n; p++) {
        const light = tone(luma(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]));
        // On a shirt you see coverage*ink + (1-coverage)*shirt: solve for the picture's lightness.
        let v = tones ? Math.max(0, Math.min(1, (light - lg) / (li - lg))) : (o.invert ? light : 1 - light);
        if (o.style === "xerox") v = Math.max(0, Math.min(1, (v - 0.5) * 1.3 + 0.5));
        c[p] = v;
      }
      if (o.mode === "mono") { for (let p = 0; p < n; p++) c[p] *= a[p]; return [c]; }
      const c1 = new Float32Array(n), c2 = new Float32Array(n);
      for (let p = 0; p < n; p++) { c1[p] = c[p] ** 1.6 * a[p]; c2[p] = Math.min(1, c[p] * 1.3) ** 0.8 * a[p]; }
      return [c1, c2];
    }
    if (o.mode === "threshold") {
      const cuts = fit.cuts, nb = cuts.length + 1, soft = o.threshold_soft, out = Array.from({ length: nb }, () => new Float32Array(n));
      const darker = new Float32Array(cuts.length);
      for (let p = 0; p < n; p++) {
        let L = tone(luma(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]));
        if (o.invert) L = 1 - L;
        for (let i = 0; i < cuts.length; i++) darker[i] = soft <= 0 ? (L < cuts[i] ? 1 : 0) : Math.max(0, Math.min(1, (cuts[i] - L) / soft + 0.5));
        for (let k = 0; k < nb; k++) {
          const cov = o.threshold_stack ? (k < nb - 1 ? darker[k] : 1)   // lighter tones run under darker ones
            : (k < nb - 1 ? darker[k] : 1) - (k > 0 ? darker[k - 1] : 0);   // knockout: one tone per spot
          out[k][p] = Math.max(0, Math.min(1, cov)) * a[p];
        }
      }
      return out;
    }
    if (o.mode === "index") return [new Float32Array(n)];   // separated on its pixel grid (indexGrids)
    if (o.mode === "cmyk") {
      const out = [0, 1, 2, 3, 4].map(() => new Float32Array(n)), g = hex(o.garment).map((v) => v / 255);
      for (let p = 0; p < n; p++) {
        let t = [tone(rgb[p * 3]), tone(rgb[p * 3 + 1]), tone(rgb[p * 3 + 2])];
        if (fit.shirtIsBlack) t = t.map((v, q) => Math.max(v, g[q]));   // darker than a black shirt is just the shirt
        let over = t, base = 0;
        if (fit.underbase) {
          // On a shirt with a white base you see base * (colour over white) + (1 - base) * shirt:
          // use the least base that can reach the wanted colour, then solve the colour over white.
          for (let q = 0; q < 3; q++) {
            const need = t[q] > g[q] ? (t[q] - g[q]) / Math.max(1 - g[q], 1e-4) : t[q] < g[q] ? 1 - t[q] / Math.max(g[q], 1e-4) : 0;
            base = Math.max(base, need);
          }
          base = Math.max(0, Math.min(1, base));
          over = base > 0.04 ? t.map((v, q) => Math.max(0, Math.min(1, (v - (1 - base) * g[q]) / base))) : [1, 1, 1];
        }
        const [c, m, y, k] = gcr(1 - over[0], 1 - over[1], 1 - over[2]);
        out[0][p] = c * a[p]; out[1][p] = m * a[p]; out[2][p] = y * a[p]; out[3][p] = k * a[p]; out[4][p] = base * a[p];
      }
      return fit.underbase ? out : out.slice(0, 4);
    }
    const pl = fit.paletteLab || prep.paletteLab, centers = pl.slice();
    if (fit.mode === "tones" || fit.shirtIsBlack) centers.push(lab1(hex(o.garment)));   // the shirt is a free extra "ink"
    const K = pl.length, out = Array.from({ length: K }, () => new Float32Array(n));
    const d2 = new Float64Array(centers.length), inv2 = 1 / (2 * o.spot_softness ** 2);
    for (let p = 0; p < n; p++) {
      const L = rgbToLab(rgb[p * 3], rgb[p * 3 + 1], rgb[p * 3 + 2]);
      let mn = Infinity;
      for (let c = 0; c < centers.length; c++) {
        d2[c] = (L[0] - centers[c][0]) ** 2 + (L[1] - centers[c][1]) ** 2 + (L[2] - centers[c][2]) ** 2;
        if (d2[c] < mn) mn = d2[c];
      }
      let tot = 0;
      for (let c = 0; c < centers.length; c++) { d2[c] = Math.exp(-(d2[c] - mn) * inv2); tot += d2[c]; }
      for (let c = 0; c < K; c++) out[c][p] = (d2[c] / tot) * a[p];
    }
    return out;
  }

  /** Black generation in dark colours only (no muddy black in light tones); total ink held under 300%. */
  function gcr(c, m, y) {
    const kmin = Math.min(c, m, y), k = 0.9 * kmin * Math.sqrt(Math.max(0, Math.min(1, (kmin - 0.15) / 0.85)));
    const inv = Math.max(1 - k, 1e-4);
    let C = Math.max(0, Math.min(1, (c - k) / inv)), M = Math.max(0, Math.min(1, (m - k) / inv)), Y = Math.max(0, Math.min(1, (y - k) / inv));
    const tot = C + M + Y;
    if (tot + k > 3) { const s = (3 - k) / Math.max(tot, 1e-4); C *= s; M *= s; Y *= s; }
    return [C, M, Y, k];
  }

  function highlightCov(s, o) {   // the brightest tones, strongest at pure white
    const tone = toneFn(o), n = s.a.length, out = new Float32Array(n), reach = 0.12 + 0.6 * o.highlight;
    for (let p = 0; p < n; p++) {
      let L = tone(luma(s.rgb[p * 3], s.rgb[p * 3 + 1], s.rgb[p * 3 + 2]));
      if (o.invert) L = 1 - L;
      out[p] = Math.max(0, Math.min(1, (L - (1 - reach)) / reach)) ** 1.5 * s.a[p];
    }
    return out;
  }

  function underbaseCov(covs, plates, o) {
    const base = plates.find((p) => p.underbase);
    if (base && base.src >= 0 && base.src < covs.length) return choke(covs[base.src], o.choke_mm, o);   // CMYK: solved with the colours
    let m = null;
    for (const p of plates) {
      if (p.underbase || !p.on || p.highlight) continue;
      const c = covs[p.src];
      if (!m) m = c.slice();
      else {
        const sum = o.mode === "spot" || (o.mode === "threshold" && !o.threshold_stack);   // the base goes under all of them
        for (let k = 0; k < m.length; k++) m[k] = sum ? Math.min(1, m[k] + c[k]) : Math.max(m[k], c[k]);
      }
    }
    if (!m) return new Float32Array(covs[0] ? covs[0].length : 0);
    return choke(m, o.choke_mm, o);
  }

  /** Shrink (mm > 0) or spread (mm < 0) every dot by about mm at its edge. */
  function choke(c, mm, o) {
    if (!mm) return c;
    const cell = AM_STYLES.includes(o.style) ? o.dpi / o.lpi : 2 * o.grain_mm * o.dpi / 25.4;
    const k = (mm * o.dpi / 25.4) / (cell * 0.5642), out = new Float32Array(c.length);
    for (let i = 0; i < c.length; i++) {   // spreading never adds ink where there was none
      out[i] = c[i] > 0 ? Math.max(0, Math.min(1, Math.sqrt(Math.min(1, c[i])) - k)) ** 2 : 0;
    }
    return out;
  }

  // ================================================================ screens

  function spotValue(style, u, v) {
    const au = Math.abs(u), av = Math.abs(v);
    switch (style) {
      case "round": return u * u + v * v;
      case "ellipse": return u * u + (v / 0.62) ** 2;
      case "square": return Math.max(au, av);
      case "diamond": return au + av;
      case "line": return av;
      case "cross": return Math.min(au, av);
      default: {   // euclid: dots grow to a checkerboard at 50%, then become holes
        const x = 2 * au, y = 2 * av;
        return x + y <= 1 ? x * x + y * y : 2 - ((1 - x) ** 2 + (1 - y) ** 2);
      }
    }
  }

  const spotLutCache = {};
  function spotLut(style) {   // value -> share of the cell that inks before it (uniformises the screen)
    if (spotLutCache[style]) return spotLutCache[style];
    const N = 512, vals = new Float32Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) vals[i * N + j] = spotValue(style, (j + 0.5) / N - 0.5, (i + 0.5) / N - 0.5);
    vals.sort();
    const lo = vals[0], hi = vals[vals.length - 1], M = 8192, lut = new Float32Array(M + 1);
    let a = 0, b = 0;
    for (let m = 0; m <= M; m++) {
      const x = lo + (hi - lo) * m / M;
      while (a < vals.length && vals[a] < x) a++;
      if (b < a) b = a;
      while (b < vals.length && vals[b] <= x) b++;
      lut[m] = (a + b) / 2 / vals.length;
    }
    return (spotLutCache[style] = { lut, lo, hi, M });
  }

  function threshold(xs, ys, o, angle, seed) {
    const gw = xs.length, gh = ys.length, ppm = o.dpi / 25.4;
    if (AM_STYLES.includes(o.style)) {
      const cell = o.dpi / o.lpi, t = angle * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
      const { lut, lo, hi, M } = spotLut(o.style), scale = M / (hi - lo || 1);
      const T = new Float32Array(gw * gh);
      for (let i = 0; i < gh; i++) {
        const Y = ys[i] / cell;
        for (let j = 0; j < gw; j++) {
          const X = xs[j] / cell;
          let u = X * c + Y * s, v = -X * s + Y * c;
          if (o.style === "modulation") {   // lines that wave; their width carries the tone
            const vw = v + 0.22 * Math.sin(2 * Math.PI * u * 0.5);
            T[i * gw + j] = Math.abs(vw - Math.floor(vw) - 0.5) * 2;
            continue;
          }
          u = u - Math.floor(u) - 0.5; v = v - Math.floor(v) - 0.5;
          const pos = Math.max(0, Math.min(M, (spotValue(o.style, u, v) - lo) * scale)), m = Math.floor(pos);
          T[i * gw + j] = m >= M ? lut[M] : lut[m] + (lut[m + 1] - lut[m]) * (pos - m);
        }
      }
      if (o.roughness > 0) {
        const r = Math.max(cell * 0.3, 1.5), n = valueNoise(xs, ys, r, r, seed + 71);
        for (let k = 0; k < T.length; k++) T[k] += o.roughness * 0.35 * (n[k] - 0.5);
      }
      for (let k = 0; k < T.length; k++) T[k] = Math.max(0.0005, Math.min(0.9995, T[k]));
      return T;
    }
    const g = Math.max(o.grain_mm * ppm, 0.5);
    if (o.style === "bayer4" || o.style === "bayer8") {
      const n = o.style === "bayer4" ? 4 : 8, mtx = bayerMatrix(n), T = new Float32Array(gw * gh);
      for (let i = 0; i < gh; i++) {
        const iy = (((Math.floor(ys[i] / g)) % n) + n) % n;
        for (let j = 0; j < gw; j++) T[i * gw + j] = mtx[iy * n + ((((Math.floor(xs[j] / g)) % n) + n) % n)];
      }
      return T;
    }
    if (o.style === "random") {
      const T = new Float32Array(gw * gh);
      for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
        T[i * gw + j] = Math.max(0.0005, Math.min(0.9995, hash2(Math.floor(xs[j] / g), Math.floor(ys[i] / g), seed)));
      }
      return T;
    }
    if (DIFFUSION_STYLES.includes(o.style)) return blueNoise(xs, ys, g, seed);   // plates use the diffusion grid
    if (o.style === "fm") return blueNoise(xs, ys, g, seed);
    if (o.style === "mezzotint") {
      const a = fbm(xs, ys, g * 2.5, seed + 3, 2, 3), b = blueNoise(xs, ys, Math.max(g * 0.6, 0.5), seed);
      for (let k = 0; k < a.length; k++) {
        const s2 = 0.5 * (a[k] + b[k]);   // sum of two uniforms is triangular: map back to uniform
        a[k] = s2 < 0.5 ? 2 * s2 * s2 : 1 - 2 * (1 - s2) ** 2;
      }
      return a;
    }
    // xerox: mottled toner edges and faint drum streaks
    const T = fbm(xs, ys, g * 3, seed + 5, 3), b = blueNoise(xs, ys, Math.max(g * 0.5, 0.5), seed);
    const streak = valueNoise(xs, new Float64Array([0]), g * 6, 1e6, seed + 9);
    for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
      const k = i * gw + j;
      T[k] = Math.max(0.0005, Math.min(0.9995, 0.5 + 0.42 * (T[k] - 0.5) + 0.22 * (b[k] - 0.5) + 0.12 * (streak[j] - 0.5)));
    }
    return T;
  }

  // ================================================================ textures

  // ================================================================ distress scans (packed by tools/make_textures.py)

  const SCAN_DATA = {};   // id -> base64 string or Uint8Array of the .etx file
  const scanCache = new Map();
  function registerScans(map) { Object.assign(SCAN_DATA, map || {}); }

  function fromBase64(str) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", lut = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) lut[A.charCodeAt(i)] = i;
    const clean = str.replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const a = lut[clean.charCodeAt(i)], b = lut[clean.charCodeAt(i + 1)];
      const c = i + 2 < clean.length ? lut[clean.charCodeAt(i + 2)] : -1, d = i + 3 < clean.length ? lut[clean.charCodeAt(i + 3)] : -1;
      out[o++] = (a << 2) | (b >> 4);
      if (c >= 0) out[o++] = ((b & 15) << 4) | (c >> 2);
      if (d >= 0) out[o++] = ((c & 3) << 6) | d;
    }
    return out.subarray(0, o);
  }

  // Small zlib inflate (RFC 1950/1951): Photoshop panels have no decompression built in.
  function inflate(src, outSize) {
    const out = new Uint8Array(outSize);
    let pos = 2, bit = 0, op = 0;   // skip the 2-byte zlib header
    const bits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) { v |= ((src[pos] >> bit) & 1) << i; if (++bit === 8) { bit = 0; pos++; } }
      return v;
    };
    function table(lengths) {   // canonical Huffman: counts + symbols
      const counts = new Uint16Array(16), offs = new Uint16Array(16), syms = new Uint16Array(lengths.length);
      for (const l of lengths) counts[l]++;
      counts[0] = 0;
      for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + counts[i - 1];
      lengths.forEach((l, s) => { if (l) syms[offs[l]++] = s; });
      return { counts, syms };
    }
    function decode(t) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len < 16; len++) {
        code |= bits(1);
        const c = t.counts[len];
        if (code - first < c) return t.syms[index + code - first];
        index += c; first = (first + c) << 1; code <<= 1;
      }
      throw new Error("Bad texture data");
    }
    const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    let fixedL = null, fixedD = null;
    for (;;) {
      const last = bits(1), type = bits(2);
      if (type === 0) {
        if (bit) { bit = 0; pos++; }
        const len = src[pos] | (src[pos + 1] << 8);
        pos += 4;
        out.set(src.subarray(pos, pos + len), op); op += len; pos += len;
      } else {
        let lt, dt;
        if (type === 1) {
          if (!fixedL) {
            const l = new Uint8Array(288);
            l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
            fixedL = table(l); fixedD = table(new Uint8Array(30).fill(5));
          }
          lt = fixedL; dt = fixedD;
        } else {
          const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
          const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
          const cl = new Uint8Array(19);
          for (let i = 0; i < hclen; i++) cl[ORDER[i]] = bits(3);
          const ct = table(cl), lens = new Uint8Array(hlit + hdist);
          for (let i = 0; i < hlit + hdist;) {
            const sym = decode(ct);
            if (sym < 16) lens[i++] = sym;
            else if (sym === 16) { const prev = lens[i - 1]; for (let r = 3 + bits(2); r > 0; r--) lens[i++] = prev; }
            else if (sym === 17) i += 3 + bits(3);
            else i += 11 + bits(7);
          }
          lt = table(lens.subarray(0, hlit)); dt = table(lens.subarray(hlit));
        }
        for (;;) {
          const sym = decode(lt);
          if (sym < 256) out[op++] = sym;
          else if (sym === 256) break;
          else {
            const li = sym - 257, len = LBASE[li] + bits(LEXT[li]);
            const di = decode(dt), dist = DBASE[di] + bits(DEXT[di]);
            for (let k = 0; k < len; k++, op++) out[op] = out[op - dist];
          }
        }
      }
      if (last) break;
    }
    return out;
  }

  function scanLevels(id) {   // -> {q (0..7 per pixel), w, h} or null when the scan isn't loaded
    if (scanCache.has(id)) return scanCache.get(id);
    let raw = SCAN_DATA[id];
    if (!raw) return null;
    if (typeof raw === "string") raw = fromBase64(raw);
    if (String.fromCharCode(raw[0], raw[1], raw[2], raw[3]) !== "ETX1") throw new Error(`Not a texture file: ${id}`);
    const w = raw[4] | (raw[5] << 8), h = raw[6] | (raw[7] << 8);
    const v = { q: inflate(raw.subarray(8), w * h), w, h };
    while (scanCache.size >= 4) scanCache.delete(scanCache.keys().next().value);
    scanCache.set(id, v);
    return v;
  }

  function sampleScan(id, xs, ys, tilePx, angle = 0) {   // bilinear, mirrored tiles; same maths as the Python engine
    const T = scanLevels(id);
    if (!T) return null;
    const { q, w: tw, h: th } = T, k = tw / tilePx, gw = xs.length, gh = ys.length, out = new Float64Array(gw * gh);
    const mir = (i, n) => { const t = ((i % (2 * n)) + 2 * n) % (2 * n); return t < n ? t : 2 * n - 1 - t; };
    if (angle) {   // turned: every pixel has its own texture position
      const a = angle * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
      for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
        const U = xs[j] * c + ys[i] * sn, V = ys[i] * c - xs[j] * sn;
        const u = U * k - 0.5, v = V * k - 0.5, x0 = Math.floor(u), y0 = Math.floor(v), fx = u - x0, fy = v - y0;
        const xa = mir(x0, tw), xb = mir(x0 + 1, tw), ra = mir(y0, th) * tw, rb = mir(y0 + 1, th) * tw;
        const t00 = q[ra + xa] / 7, t01 = q[ra + xb] / 7, t10 = q[rb + xa] / 7, t11 = q[rb + xb] / 7;
        const ta = t00 + (t01 - t00) * fx, tb = t10 + (t11 - t10) * fx;
        out[i * gw + j] = ta + (tb - ta) * fy;
      }
      return out;
    }
    const xa = new Int32Array(gw), xb = new Int32Array(gw), fx = new Float64Array(gw);
    for (let j = 0; j < gw; j++) { const u = xs[j] * k - 0.5, x0 = Math.floor(u); fx[j] = u - x0; xa[j] = mir(x0, tw); xb[j] = mir(x0 + 1, tw); }
    for (let i = 0; i < gh; i++) {
      const v = ys[i] * k - 0.5, y0 = Math.floor(v), fy = v - y0, ra = mir(y0, th) * tw, rb = mir(y0 + 1, th) * tw;
      for (let j = 0; j < gw; j++) {
        const t00 = q[ra + xa[j]] / 7, t01 = q[ra + xb[j]] / 7, t10 = q[rb + xa[j]] / 7, t11 = q[rb + xb[j]] / 7;
        const a = t00 + (t01 - t00) * fx[j], b = t10 + (t11 - t10) * fx[j];
        out[i * gw + j] = a + (b - a) * fy;
      }
    }
    return out;
  }

  function textureMasks(xs, ys, o, textureImages) {
    const n = xs.length * ys.length, remove = new Uint8Array(n), add = new Uint8Array(n), ppm = o.dpi / 25.4;
    o.textures.forEach((t, i) => {
      const s = t.strength, kind = t.type;
      if (s <= 0) return;
      const base = TEXTURES[kind].size_mm * t.scale * ppm, seed = o.seed * 7919 + i * 131;
      if (kind === "worn") {
        const a = fbm(xs, ys, base, seed, 5), b = fbm(xs, ys, base * 0.12, seed + 1, 3);
        for (let k = 0; k < n; k++) if (0.7 * a[k] + 0.3 * b[k] < s * 0.5) remove[k] = 1;
      } else if (kind === "cracked") {
        const e = voronoiEdge(xs, ys, base, seed), width = Math.max(0.6, base * 0.035 * (0.4 + s));
        const fade = fbm(xs, ys, base * 3, seed + 2, 3);
        for (let k = 0; k < n; k++) if (e[k] < width && fade[k] < 0.25 + 0.75 * s) remove[k] = 1;
      } else if (kind === "grunge") {
        const a = fbm(xs, ys, base, seed, 4), b = fbm(xs, ys, Math.max(base * 0.06, 0.8), seed + 3, 2);
        for (let k = 0; k < n; k++) if (a[k] > 1 - s * 0.3 || b[k] > 1 - s * 0.12) remove[k] = 1;
      } else if (kind === "paper") {
        const f = fbm(xs, ys, Math.max(base * 0.1, 0.8), seed, 2, 25);
        for (let k = 0; k < n; k++) if (f[k] > 1 - s * 0.14) remove[k] = 1;
      } else if (kind === "scratches") {
        const m = scratches(xs, ys, base, seed, 0.15 + 0.6 * s, Math.max(0.6, 0.1 * ppm));
        for (let k = 0; k < n; k++) if (m[k]) remove[k] = 1;
      } else if (kind === "toner") {
        const a = fbm(xs, ys, Math.max(base * 0.12, 0.8), seed, 2), b = fbm(xs, ys, base * 20, seed + 4, 2);
        for (let k = 0; k < n; k++) if (a[k] > 1 - s * 0.05 && b[k] > 0.45) add[k] = 1;
      } else if (kind === "washed") {   // fine, uneven dropouts: ink faded by years of washing
        const fine = fbm(xs, ys, Math.max(base * 0.08, 0.7), seed, 2), patch = fbm(xs, ys, base * 6, seed + 1, 3);
        for (let k = 0; k < n; k++) if (fine[k] < s * 0.5 * (0.45 + 0.9 * patch[k])) remove[k] = 1;
      } else if (kind === "fabric") {   // knit ribs and rows of the shirt showing through
        const pitch = Math.max(2, base), br = fbm(xs, ys, pitch * 0.6, seed, 2), gw = xs.length;
        for (let i2 = 0; i2 < ys.length; i2++) {
          const fy = (((ys[i2] / (pitch * 0.7)) % 1) + 1) % 1, row = fy < s * 0.16;
          for (let j = 0; j < gw; j++) {
            const fx = (((xs[j] / pitch) % 1) + 1) % 1, k = i2 * gw + j;
            if ((fx < s * 0.3 || row) && br[k] > 0.3) remove[k] = 1;
          }
        }
      } else if (kind === "streaks") {   // dry, uneven squeegee pulls
        const band = fbm(xs, ys, base, seed, 3, 8), speck = fbm(xs, ys, Math.max(base * 0.05, 0.7), seed + 5, 2);
        for (let k = 0; k < n; k++) if (band[k] < s * 0.5 && speck[k] < 0.35 + 0.5 * s) remove[k] = 1;
      } else if (kind === "pinholes") {   // tiny holes from dust and gaps in the emulsion
        const a = fbm(xs, ys, Math.max(base * 0.08, 0.7), seed, 2);
        for (let k = 0; k < n; k++) if (a[k] > 1 - s * 0.06) remove[k] = 1;
      } else if (TEXTURES[kind].scan) {
        const v = sampleScan(kind, xs, ys, base, t.rotate || 0);
        if (v) for (let k = 0; k < n; k++) if (v[k] < s) remove[k] = 1;   // strength 1 = all but clean areas
      } else if (kind === "image") {
        const tex = (textureImages || {})[t.image_id];
        if (!tex) return;
        const tw = tex.w, th = tex.h, gw = xs.length;
        if (t.rotate) {
          const a = t.rotate * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a), md = (v, n) => ((v % n) + n) % n;
          for (let i2 = 0; i2 < ys.length; i2++) for (let j = 0; j < gw; j++) {
            const U = xs[j] * c + ys[i2] * sn, V = ys[i2] * c - xs[j] * sn;
            const ix = md(Math.floor(U / base * tw), tw), iy = md(Math.floor(V / base * tw), th);
            if (tex.data[iy * tw + ix] < s * 0.75) remove[i2 * gw + j] = 1;
          }
          return;
        }
        for (let i2 = 0; i2 < ys.length; i2++) {
          const iy = (((Math.floor(ys[i2] / base * tw)) % th) + th) % th;
          for (let j = 0; j < gw; j++) {
            const ix = (((Math.floor(xs[j] / base * tw)) % tw) + tw) % tw;
            if (tex.data[iy * tw + ix] < s * 0.75) remove[i2 * gw + j] = 1;
          }
        }
      }
    });
    return { remove, add };
  }

  // ================================================================ render

  function grid(x0, n, step) {
    const a = new Float64Array(n);
    for (let k = 0; k < n; k++) a[k] = x0 + (k + 0.5) * step;
    return a;
  }

  function renderPlates(prep, o, x0, y0, gw, gh, step, plates, textureImages, fit) {
    fit = fit || resolveFit(prep, o);
    if (o.ghost_mm > 0 && o.ghost_strength > 0) {   // ghost / slur: a faint, broken second print, offset
      const plain = { ...o, ghost_mm: 0 };
      const main = renderPlates(prep, plain, x0, y0, gw, gh, step, plates, textureImages, fit);
      const g = o.ghost_mm * o.dpi / 25.4;
      const moved = plates.map((p) => ({ ...p, shift: [p.shift[0] + 0.6 * g, p.shift[1] + 0.8 * g] }));
      const ghost = renderPlates(prep, plain, x0, y0, gw, gh, step, moved, textureImages, fit);
      const keep = fbm(grid(x0, gw, step), grid(y0, gh, step), Math.max(0.35 * o.dpi / 25.4, 0.8), o.seed * 7 + 77, 2);
      const lim = o.ghost_strength * 0.8;
      main.forEach((m, i) => { const gb = ghost[i]; for (let k = 0; k < m.length; k++) if (gb[k] && keep[k] < lim) m[k] = 1; });
      return main;
    }
    const [outW] = outSize(prep, o), xs = grid(x0, gw, step), ys = grid(y0, gh, step);
    const samples = {}, result = [];
    const [, outH] = outSize(prep, o), border = borderMask(xs, ys, o, outW, outH);
    const gridded = o.mode === "index" || DIFFUSION_STYLES.includes(o.style);
    const igrids = o.mode === "index" ? indexGrids(prep, o, fit, plates) : null;
    for (const p of plates) {
      if (p.highlight) {   // screened on its own (stochastic for dithered looks), from the brightest tones
        if (!p.on) { result.push(new Uint8Array(gw * gh)); continue; }
        const s = sample(prep, x0, y0, gw, gh, step, outW, p.shift[0], p.shift[1]), cov = highlightCov(s, o);
        if (border) for (let k = 0; k < cov.length; k++) cov[k] *= border.soft[k];
        const sx = p.shift[0] ? xs.map((v) => v - p.shift[0]) : xs, sy = p.shift[1] ? ys.map((v) => v - p.shift[1]) : ys;
        const T = threshold(sx, sy, gridded ? { ...o, style: "fm" } : o, p.angle, o.seed * 31 + 211);
        const bm = new Uint8Array(gw * gh);
        for (let k = 0; k < bm.length; k++) bm[k] = cov[k] > T[k] && (!border || border.keep[k]) ? 1 : 0;
        result.push(bm);
        continue;
      }
      if (gridded) {
        if (!p.on) { result.push(new Uint8Array(gw * gh)); continue; }
        const G = igrids ? igrids[p.underbase ? "base" : p.src] : diffusionGrid(prep, o, fit, plates, p);
        const bm = lookupGrid(G, xs, ys, p.shift[0], p.shift[1]);
        if (border) for (let k = 0; k < bm.length; k++) bm[k] &= border.keep[k];
        result.push(bm);
        continue;
      }
      const key = p.shift.join(",");
      if (!samples[key]) {
        const s = sample(prep, x0, y0, gw, gh, step, outW, p.shift[0], p.shift[1]);
        samples[key] = coverages(s, prep, o, fit).map((c) => {
          shapeDots(c, o);
          if (border) for (let k = 0; k < c.length; k++) c[k] *= border.soft[k];   // fades shrink the dots
          return c;
        });
      }
      if (!p.on) { result.push(new Uint8Array(gw * gh)); continue; }
      const covs = samples[key], cov = p.underbase ? underbaseCov(covs, plates, o) : choke(covs[p.src], p.choke_mm, o);
      const sx = p.shift[0] ? xs.map((v) => v - p.shift[0]) : xs, sy = p.shift[1] ? ys.map((v) => v - p.shift[1]) : ys;
      // seed by ink, not list position, so adding an underbase never changes the other plates
      const T = threshold(sx, sy, o, p.angle, o.seed * 31 + (p.src >= 0 ? p.src : 97));
      const bm = new Uint8Array(gw * gh);
      for (let k = 0; k < bm.length; k++) bm[k] = cov[k] > T[k] && (!border || border.keep[k]) ? 1 : 0;
      result.push(bm);
    }
    if (o.textures.length) {
      const { remove, add } = textureMasks(xs, ys, o, textureImages);
      let anyAdd = false;
      for (let k = 0; k < add.length; k++) if (add[k]) { anyAdd = true; break; }
      for (const bm of result) for (let k = 0; k < bm.length; k++) if (remove[k]) bm[k] = 0;
      if (anyAdd) {
        const s = sample(prep, x0, y0, gw, gh, step, outW), inks = plates.map((p, i) => (p.underbase || !p.on || p.highlight ? -1 : i)).filter((i) => i >= 0);
        if (inks.length) {
          const top = result[inks[inks.length - 1]];
          for (let k = 0; k < top.length; k++) if (add[k] && s.a[k] > 0.5 && !remove[k] && (!border || border.keep[k])) top[k] = 1;
        }
      }
    }
    return result;
  }

  // ---------------------------------------------------------------- border knockouts

  /** Edge knockout in global print coordinates: {soft (ink multiplier), keep (0/1)}, or null for none.
   *  Soft fades go through the halftone, so the print stays strictly on/off. */
  function borderMask(xs, ys, o, outW, outH) {
    if (o.border === "none") return null;
    const gw = xs.length, gh = ys.length, n = gw * gh, W = outW, H = outH;
    const w = Math.max(1, o.border_mm * o.dpi / 25.4), seed = o.seed * 104729 + 7;
    const d = new Float32Array(n), along = new Float32Array(n);
    const R = Math.min(W, H) * 0.15;
    for (let i = 0; i < gh; i++) for (let j = 0; j < gw; j++) {
      const X = xs[j], Y = ys[i], k = i * gw + j, ax = Math.min(X, W - X), ay = Math.min(Y, H - Y);
      if (o.border_shape === "oval") {
        const nx = (X - W / 2) / (W / 2), ny = (Y - H / 2) / (H / 2);
        d[k] = (1 - Math.hypot(nx, ny)) * Math.min(W, H) / 2;
        along[k] = Math.atan2(ny, nx) * (W + H) / 4;
      } else {
        d[k] = Math.min(ax, ay);
        if (o.border_shape === "rounded" && ax < R && ay < R) d[k] = R - Math.hypot(R - ax, R - ay);
        along[k] = ax < ay ? Y : X;
      }
    }
    const soft = new Float32Array(n).fill(1), keep = new Uint8Array(n);
    const sm = (t) => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
    for (let k = 0; k < n; k++) keep[k] = d[k] > 0 ? 1 : 0;
    if (o.border === "fade") {
      for (let k = 0; k < n; k++) soft[k] = sm(d[k] / w);
    } else if (o.border === "grunge") {
      const a = fbm(xs, ys, w * 0.45, seed, 5), b = fbm(xs, ys, Math.max(w * 0.08, 0.8), seed + 1, 3);
      for (let k = 0; k < n; k++) {
        const dd = d[k] + w * (0.9 * (a[k] - 0.5) + 0.35 * (b[k] - 0.5));
        soft[k] = sm((dd - 0.15 * w) / (0.6 * w));
        if (!(dd > 0.1 * w)) keep[k] = 0;
      }
    } else if (o.border === "torn") {
      const a = fbm(xs, ys, w * 0.3, seed, 5), b = fbm(xs, ys, Math.max(w * 0.04, 0.8), seed + 2, 2);
      for (let k = 0; k < n; k++) if (!(d[k] + w * 0.5 * (a[k] - 0.5) + w * 0.12 * (b[k] - 0.5) > w * 0.35)) keep[k] = 0;
    } else if (o.border === "storm") {
      const a = fbm(xs, ys, w * 0.5, seed, 4, 7), b = fbm(xs, ys, Math.max(w * 0.07, 0.8), seed + 3, 3);
      const sp = fbm(xs, ys, Math.max(w * 0.03, 0.8), seed + 4, 2);
      for (let k = 0; k < n; k++) {
        const dd = d[k] + w * 1.1 * (a[k] - 0.5) + w * 0.3 * (b[k] - 0.5);
        soft[k] = sm((dd - 0.1 * w) / (0.8 * w));
        const speck = sp[k] > 1 - 0.18 * Math.max(0, Math.min(1, 1 - d[k] / (1.5 * w)));
        if (!(dd > 0) || speck) keep[k] = 0;
      }
    } else if (o.border === "barbwire") {
      const t = Math.max(1.5, w * 0.035), c = w * 0.55, amp = w * 0.08, period = w * 0.5, gap = w * 0.9, barb = w * 0.15;
      for (let k = 0; k < n; k++) {
        const wave = amp * Math.sin(2 * Math.PI * along[k] / period);
        const u = (((along[k] % gap) + gap) % gap) - gap / 2, v = d[k] - c;
        const wire = Math.abs(d[k] - c - wave) < t || Math.abs(d[k] - c + wave) < t ||
          (Math.hypot(u, v) < barb && (Math.abs(u - v) < t || Math.abs(u + v) < t));
        if (!(d[k] > c - amp - 3 * t) || wire) keep[k] = 0;
      }
    }
    if (o.border === "grunge" || o.border === "storm") {   // the noise never lets the art's straight edge show
      for (let k = 0; k < n; k++) { soft[k] *= sm(d[k] / (0.3 * w)); if (!(d[k] > 0.06 * w)) keep[k] = 0; }
    }
    return { soft, keep };
  }

  // ---------------------------------------------------------------- dither grids (error diffusion, index colour)

  function bayerMatrix(n) {
    let m = [0], size = 1;
    while (size < n) {
      const nm = new Array(4 * size * size), s2 = size * 2;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = 4 * m[y * size + x];
        nm[y * s2 + x] = v; nm[y * s2 + x + size] = v + 2; nm[(y + size) * s2 + x] = v + 3; nm[(y + size) * s2 + x + size] = v + 1;
      }
      m = nm; size = s2;
    }
    return Float32Array.from(m, (v) => (v + 0.5) / (n * n));
  }

  /** 1-bit error diffusion of ink amounts (0..1), serpentine scan. */
  function errorDiffuse(cov, W, H, style) {
    const [div, taps] = DIFFUSION[style], buf = new Float64Array((H + 3) * (W + 4)), out = new Uint8Array(W * H), BW = W + 4;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) buf[y * BW + x + 2] = cov[y * W + x];
    for (let y = 0; y < H; y++) {
      const rev = y & 1;
      for (let i = 0; i < W; i++) {
        const x = rev ? W - 1 - i : i, k = y * BW + x + 2, v = buf[k], bit = v >= 0.5 ? 1 : 0, err = v - bit;
        out[y * W + x] = bit;
        for (const [dx, dy, wt] of taps) buf[k + dy * BW + (rev ? -dx : dx)] += err * wt / div;
      }
    }
    return out;
  }

  /** Colour error diffusion: each cell gets one palette entry (index), or -1 where the art is transparent. */
  function errorDiffusePalette(rgb, a, W, H, colors, style) {
    const [div, taps] = DIFFUSION[style], BW = W + 4, buf = new Float64Array((H + 3) * BW * 3), out = new Int16Array(W * H).fill(-1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) buf[(y * BW + x + 2) * 3 + c] = rgb[(y * W + x) * 3 + c];
    for (let y = 0; y < H; y++) {
      const rev = y & 1;
      for (let i = 0; i < W; i++) {
        const x = rev ? W - 1 - i : i, k = y * BW + x + 2;
        if (a[y * W + x] < 0.5) continue;
        const v = [0, 1, 2].map((c) => Math.min(1.5, Math.max(-0.5, buf[k * 3 + c])));
        let best = 0, bd = Infinity;
        colors.forEach((p, j) => {
          const d = (v[0] - p[0]) ** 2 * 0.3 + (v[1] - p[1]) ** 2 * 0.59 + (v[2] - p[2]) ** 2 * 0.11;
          if (d < bd) { bd = d; best = j; }
        });
        out[y * W + x] = best;
        const e = v.map((val, c) => val - colors[best][c]);
        for (const [dx, dy, wt] of taps) {
          const q = (k + dy * BW + (rev ? -dx : dx)) * 3;
          for (let c = 0; c < 3; c++) buf[q + c] += e[c] * wt / div;
        }
      }
    }
    return out;
  }

  const gridCache = new Map();
  function cachedGrid(key, make) {
    if (gridCache.has(key)) { const v = gridCache.get(key); gridCache.delete(key); gridCache.set(key, v); return v; }
    const v = make();
    gridCache.set(key, v);
    while (gridCache.size > 24) gridCache.delete(gridCache.keys().next().value);
    return v;
  }
  function optsKey(o) {
    const d = { ...o };
    for (const k of ["textures", "registration_marks", "misregister_mm", "seed", "knockout"]) delete d[k];
    return JSON.stringify(d);
  }
  function gridGeometry(prep, o) {
    const [outW, outH] = outSize(prep, o), cell = Math.max(1, o.grain_mm * o.dpi / 25.4);
    return { outW, cell, GW: Math.ceil(outW / cell), GH: Math.ceil(outH / cell) };
  }

  /** Error diffusion runs once over the whole print (grain-sized cells), so every view reads the same dots. */
  function diffusionGrid(prep, o, fit, plates, p) {
    const key = ["diff", prep.token, optsKey(o), p.src, p.underbase, p.choke_mm, plates.map((q) => [q.src, q.on, q.underbase])].join("|");
    return cachedGrid(key, () => {
      const { outW, cell, GW, GH } = gridGeometry(prep, o);
      const s = sample(prep, 0, 0, GW, GH, cell, outW);
      const covs = coverages(s, prep, o, fit).map((c) => shapeDots(c, o));
      const bm = borderMask(grid(0, GW, cell), grid(0, GH, cell), o, outW, outSize(prep, o)[1]);
      if (bm) for (const c of covs) for (let k = 0; k < c.length; k++) c[k] *= bm.soft[k] * bm.keep[k];
      const cov = p.underbase ? underbaseCov(covs, plates, o) : choke(covs[p.src], p.choke_mm, o);
      return { G: errorDiffuse(cov, GW, GH, o.style), cell, GW, GH };
    });
  }

  /** Index colour: every grain cell gets exactly one ink (or the shirt) by colour error diffusion. */
  function indexGrids(prep, o, fit) {
    return cachedGrid(["index", prep.token, optsKey(o)].join("|"), () => {
      const { outW, cell, GW, GH } = gridGeometry(prep, o);
      const s = sample(prep, 0, 0, GW, GH, cell, outW), tone = toneFn(o);
      const t = s.rgb.map((v) => tone(v)), shirt = hex(o.garment).map((v) => v / 255);
      const bm = borderMask(grid(0, GW, cell), grid(0, GH, cell), o, outW, outSize(prep, o)[1]);
      if (bm) for (let k = 0; k < GW * GH; k++) {   // fade toward the shirt colour; cut where the border knocks out
        const f = bm.soft[k];
        for (let c = 0; c < 3; c++) t[k * 3 + c] = t[k * 3 + c] * f + shirt[c] * (1 - f);
        if (!bm.keep[k]) s.a[k] = 0;
      }
      // dither against the picture's own colours, so a recoloured ink keeps the same pixels
      const cols = [...fit.spot.map((c, i) => (c ? fit.match[i].map((v) => v / 255) : shirt)), shirt];
      const idx = errorDiffusePalette(t, s.a, GW, GH, cols, DIFFUSION_STYLES.includes(o.style) ? o.style : "fs");
      const grids = {}, base = new Uint8Array(GW * GH);
      fit.spot.forEach((c, i) => {
        if (!c) return;
        const G = new Uint8Array(GW * GH);
        for (let k = 0; k < G.length; k++) if (idx[k] === i) { G[k] = 1; base[k] = 1; }
        grids[i] = { G, cell, GW, GH };
      });
      const r = Math.round(o.choke_mm * o.dpi / 25.4 / cell);
      let b = base;
      if (r > 0) {   // choke the base by whole cells
        b = new Uint8Array(GW * GH);
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
          let all = base[y * GW + x];
          for (let dy = -r; dy <= r && all; dy++) for (let dx = -r; dx <= r; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy < 0 || xx < 0 || yy >= GH || xx >= GW || !base[yy * GW + xx]) { all = 0; break; }
          }
          b[y * GW + x] = all;
        }
      }
      grids.base = { G: b, cell, GW, GH };
      return grids;
    });
  }

  function lookupGrid(g, xs, ys, dx, dy) {
    const out = new Uint8Array(xs.length * ys.length), ix = new Int32Array(xs.length);
    for (let j = 0; j < xs.length; j++) ix[j] = Math.floor((xs[j] - dx) / g.cell);
    for (let i = 0; i < ys.length; i++) {
      const iy = Math.floor((ys[i] - dy) / g.cell);
      if (iy < 0 || iy >= g.GH) continue;
      for (let j = 0; j < xs.length; j++) if (ix[j] >= 0 && ix[j] < g.GW) out[i * xs.length + j] = g.G[iy * g.GW + ix[j]];
    }
    return out;
  }

  /** Straight-alpha composite. Returns {rgb: Float32Array, alpha: Uint8Array} (alpha strictly 0/1). */
  function composite(bitmaps, plates, blend, o) {
    const n = bitmaps.length ? bitmaps[0].length : 1, rgb = new Float32Array(n * 3), alpha = new Uint8Array(n);
    if (blend === "multiply") rgb.fill(1);
    bitmaps.forEach((b, i) => {
      const p = plates[i];
      if (!p.on) return;
      const c = p.rgb.map((v) => v / 255), white = p.underbase && blend === "multiply";   // base shows white where no colour covers it
      const top = p.highlight;   // highlight white: printed last, opaque, on top of everything
      for (let k = 0; k < n; k++) {
        if (!b[k]) continue;
        alpha[k] = 1;
        if (white) continue;
        if (blend === "multiply" && !top) { rgb[k * 3] *= c[0]; rgb[k * 3 + 1] *= c[1]; rgb[k * 3 + 2] *= c[2]; }
        else { rgb[k * 3] = c[0]; rgb[k * 3 + 1] = c[1]; rgb[k * 3 + 2] = c[2]; }
      }
    });
    const g = hex(o.garment).map((v) => v / 255);
    for (let k = 0; k < n; k++) {
      if (alpha[k] && o.knockout && Math.hypot(rgb[k * 3] - g[0], rgb[k * 3 + 1] - g[1], rgb[k * 3 + 2] - g[2]) <= 0.16) alpha[k] = 0;
      if (!alpha[k]) { rgb[k * 3] = 0; rgb[k * 3 + 1] = 0; rgb[k * 3 + 2] = 0; }
    }
    return { rgb, alpha };
  }

  function toRGBA8(c) {
    const n = c.alpha.length, out = new Uint8ClampedArray(n * 4);
    for (let k = 0; k < n; k++) {
      out[k * 4] = c.rgb[k * 3] * 255 + 0.5; out[k * 4 + 1] = c.rgb[k * 3 + 1] * 255 + 0.5;
      out[k * 4 + 2] = c.rgb[k * 3 + 2] * 255 + 0.5; out[k * 4 + 3] = c.alpha[k] ? 255 : 0;
    }
    return out;
  }

  /** Screen preview (antialiased) or, with region [x,y,w,h], a 1:1 crop of real print pixels. */
  function renderPreview(prep, o, maxPx = 900, region = null, textureImages = null) {
    const [outW, outH] = outSize(prep, o);
    const { plates, blend, fit } = plateSpecs(prep, o);
    misregistration(plates, o);
    if (region) {
      const x0 = Math.round(region[0]), y0 = Math.round(region[1]);
      const w = Math.max(1, Math.min(Math.round(region[2]), LOUPE_MAX)), h = Math.max(1, Math.min(Math.round(region[3]), LOUPE_MAX));
      const bm = renderPlates(prep, o, x0, y0, w, h, 1, plates, textureImages, fit);
      return { rgba: toRGBA8(composite(bm, plates, blend, o)), width: w, height: h, plates, bitmaps: bm };
    }
    const scale = Math.min(1, maxPx / Math.max(outW, outH)), ss = scale < 1 ? 1.5 : 1, step = 1 / (scale * ss);
    const gw = Math.max(1, Math.round(outW / step)), gh = Math.max(1, Math.round(outH / step));
    const bm = renderPlates(prep, o, 0, 0, gw, gh, step, plates, textureImages, fit);
    const c = composite(bm, plates, blend, o);
    const pw = Math.max(1, Math.round(outW * scale)), ph = Math.max(1, Math.round(outH * scale));
    let rgba;
    if (pw !== gw || ph !== gh) {
      const pm = new Float32Array(gw * gh * 4);
      for (let k = 0; k < gw * gh; k++) {
        const a = c.alpha[k];
        pm[k * 4] = c.rgb[k * 3] * a; pm[k * 4 + 1] = c.rgb[k * 3 + 1] * a; pm[k * 4 + 2] = c.rgb[k * 3 + 2] * a; pm[k * 4 + 3] = a;
      }
      const r = resize(pm, gw, gh, pw, ph, 4);
      rgba = new Uint8ClampedArray(pw * ph * 4);
      for (let k = 0; k < pw * ph; k++) {
        const a = r[k * 4 + 3], d = Math.max(a, 1e-4);
        rgba[k * 4] = r[k * 4] / d * 255 + 0.5; rgba[k * 4 + 1] = r[k * 4 + 1] / d * 255 + 0.5;
        rgba[k * 4 + 2] = r[k * 4 + 2] / d * 255 + 0.5; rgba[k * 4 + 3] = a * 255 + 0.5;
      }
    } else rgba = toRGBA8(c);
    return { rgba, width: pw, height: ph, plates, bitmaps: bm };
  }

  /** Full-resolution print, rendered in seamless horizontal strips. */
  function renderFull(prep, o, textureImages = null, keepPlates = false, strip = 384, onProgress = null) {
    const [outW, outH] = outSize(prep, o);
    if (outW * outH > MAX_OUTPUT_PX) {
      throw new ImageError(`That print would be ${outW} x ${outH} px. Lower the width or DPI ` +
        `(limit ${MAX_OUTPUT_PX / 1e6} megapixels).`);
    }
    const { plates, blend, fit } = plateSpecs(prep, o);
    misregistration(plates, o);
    const rgba = new Uint8ClampedArray(outW * outH * 4);
    const seps = keepPlates ? plates.map(() => new Uint8Array(outW * outH)) : null;
    for (let y0 = 0; y0 < outH; y0 += strip) {
      const h = Math.min(strip, outH - y0);
      const bm = renderPlates(prep, o, 0, y0, outW, h, 1, plates, textureImages, fit);
      rgba.set(toRGBA8(composite(bm, plates, blend, o)), y0 * outW * 4);
      if (seps) bm.forEach((b, i) => seps[i].set(b, y0 * outW));
      if (onProgress) onProgress(Math.min(1, (y0 + h) / outH));
    }
    return { rgba, width: outW, height: outH, plates, seps };
  }

  // ================================================================ report

  function minDotFor(o, tgt) {
    const cellMm = 25.4 / o.lpi, need = Math.PI * (tgt.min_dot_mm / cellMm) ** 2 / 4;
    return Math.round(Math.min(0.5, Math.max(0.02, need)) * 1000) / 1000;
  }

  function lostToShirt(prep, o, fit) {
    const src = level(prep, Math.max(1, prep.srcW / 300)), tone = toneFn(o);
    const li = lum(fit.inks[0]), lg = lum(hex(o.garment));
    let n = 0, lost = 0;
    for (let p = 0; p < src.w * src.h; p++) {
      const a = src.data[p * 4 + 3];
      if (!(a > 0.5)) continue;
      n++;
      const light = tone(luma(src.data[p * 4] / a, src.data[p * 4 + 1] / a, src.data[p * 4 + 2] / a));
      if ((light - lg) / (li - lg) < 0.02) lost++;
    }
    return n ? lost / n : 0;
  }

  const r1 = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  const fmtG = (v) => String(Math.round(v * 1e4) / 1e4);

  function report(prep, o, plates, bitmaps) {
    const [outW, outH] = outSize(prep, o), tgt = TARGETS[o.target], ppm = o.dpi / 25.4, warnings = [];
    const info = {
      pixels: [outW, outH], inches: [r1(outW / o.dpi, 2), r1(outH / o.dpi, 2)],
      cm: [r1(outW / o.dpi * 2.54), r1(outH / o.dpi * 2.54)], dpi: o.dpi, megapixels: r1(outW * outH / 1e6),
      target: tgt.label, binary_alpha: true,
    };
    const solid = o.mode === "threshold" && o.threshold_soft <= 0;
    if (o.mode === "threshold") info.thresholds = resolveFit(prep, o).cuts.map((c) => r1(c, 3));
    if (solid) {
      info.solid = true;   // solid tones: no dots to hold
    } else if (AM_STYLES.includes(o.style) && o.mode !== "index") {
      const cell = o.dpi / o.lpi, levels = Math.floor(cell * cell) + 1;
      info.cell_px = r1(cell, 2); info.tone_levels = Math.min(levels, 256);
      if (cell < 4) {
        warnings.push({ level: "error", text: `${fmtG(o.lpi)} LPI at ${o.dpi} DPI leaves only ${levels} tone ` +
          "levels, so gradients will band. Raise DPI or lower LPI.", fix: { dpi: Math.min(1200, Math.ceil(o.lpi * 6 / 50) * 50) } });
      } else if (cell < 6) {
        warnings.push({ level: "warn", text: `Only ${levels} tone levels at this LPI/DPI. Fine for bold art; raise DPI for smooth photos.` });
      }
      const [lo, hi] = tgt.lpi;
      if (o.lpi < lo || o.lpi > hi) {
        warnings.push({ level: "warn", text: `${tgt.label} usually holds ${lo}-${hi} LPI. ${fmtG(o.lpi)} LPI may ` +
          (o.lpi > hi ? "fill in or wash out." : "look very coarse (fine if that's the look)."),
          fix: { lpi: Math.min(Math.max(o.lpi, lo), hi) } });
      }
      const dotMm = o.min_dot > 0 ? (25.4 / o.lpi) * Math.sqrt(Math.max(o.min_dot, 1e-6) * 4 / Math.PI) : 0;
      info.smallest_dot_mm = r1(dotMm, 3);
      if (o.min_dot <= 0) {
        warnings.push({ level: "warn", text: `No minimum dot: the tiniest highlight dots may not hold on ${tgt.label}.`,
          fix: { min_dot: minDotFor(o, tgt) } });
      } else if (dotMm < tgt.min_dot_mm) {
        warnings.push({ level: "warn", text: `Smallest dot is ${dotMm.toFixed(2)} mm; ${tgt.label} reliably holds about ` +
          `${tgt.min_dot_mm} mm. Tiny dots may wash out or not stick.`, fix: { min_dot: minDotFor(o, tgt) } });
      }
    } else {
      const g = o.grain_mm;
      info.grain_mm = g;
      if (g < tgt.min_dot_mm * 0.8) {
        warnings.push({ level: "warn", text: `Grain of ${g.toFixed(2)} mm is finer than ${tgt.label} reliably holds ` +
          `(about ${tgt.min_dot_mm} mm).`, fix: { grain_mm: tgt.min_dot_mm } });
      }
      if (g * ppm < 1.5) warnings.push({ level: "warn", text: "Grain is under 2 pixels at this DPI; raise DPI or grain." });
    }
    if (o.dpi < 200 && o.target !== "paper") {
      warnings.push({ level: "warn", text: `${o.dpi} DPI is low for garment printing; 300 is standard.`, fix: { dpi: 300 } });
    }
    const inks = [], any = bitmaps.length ? new Uint8Array(bitmaps[0].length) : null;
    plates.forEach((p, i) => {
      const b = bitmaps[i];
      let on = 0;
      for (let k = 0; k < b.length; k++) if (b[k]) { on++; if (!p.underbase) any[k] = 1; }
      inks.push({ name: p.name, label: p.label, hex: toHex(p.rgb), angle: r1(((p.angle % 180) + 180) % 180), coverage: r1(on / b.length * 100),
        underbase: p.underbase, on: p.on, choke_mm: p.choke_mm });
    });
    let anyOn = 0;
    if (any) for (let k = 0; k < any.length; k++) anyOn += any[k];
    info.ink_area_pct = any ? r1(anyOn / any.length * 100) : 0;
    if (o.target === "dtf" && info.ink_area_pct > 60) {
      warnings.push({ level: "info", text: "Lots of solid film: the transfer will feel heavy. " +
        "More halftone (lower max dot, or a worn texture) makes it lighter and more breathable." });
    }
    const garment = hex(o.garment), fit = resolveFit(prep, o);
    info.fit = { mode: fit.mode, notes: fit.notes, underbase: fit.underbase, photo_like: prep.photoLike };
    if (o.shirt_fit === "off") {
      for (const ink of inks) {
        const c = hex(ink.hex);
        if (Math.hypot(c[0] - garment[0], c[1] - garment[1], c[2] - garment[2]) < 40 && !o.knockout && !ink.underbase) {
          warnings.push({ level: "info", text: `${ink.name} is almost the shirt colour. Turn on Fit to shirt to fix it automatically.`,
            fix: { shirt_fit: "auto" } });
          break;
        }
      }
    } else if (fit.mode === "tones" && o.mode === "mono") {
      const lost = lostToShirt(prep, o, fit);
      if (lost > 0.4) {
        warnings.push({ level: "warn", text: `${Math.round(lost * 100)}% of the picture is darker than this shirt, so it ` +
          "blends into the shirt. Recolor prints it as ink instead.", fix: { shirt_fit: "recolor" } });
      }
    }
    if (["cmyk", "spot", "duotone"].includes(o.mode) && lum(garment) < 0.6 && !fit.underbase && o.underbase !== "off") {
      warnings.push({ level: "warn", text: "Colours print dull and dark straight onto a dark shirt. " +
        "A white underbase underneath keeps them bright.", fix: { underbase: "on" } });
    }
    info.inks = inks;
    info.warnings = warnings;
    return info;
  }

  const api = {
    CATALOG, DEFAULTS, STYLES, AM_STYLES, GRAIN_STYLES, TEXTURES, TARGETS, CREAM, INK_BLACK, LOUPE_MAX, MAX_OUTPUT_PX,
    ImageError, OptionError, hex, toHex, parseOptions, prepareKey, artKey, prepareArt, prepare, outSize, resolveFit, plateSpecs,
    renderPreview, renderFull, renderPlates, composite, report, threshold, shapeDots, lum, contrastInk, spotPalette,
    thresholdCuts, fixedPalette, DIFFUSION_STYLES, PALETTES, inkName,
    registerScans,
    _internal: { textureMasks, scanLevels, hash2, valueNoise, fbm, blueNoise, voronoiEdge, scratches, rgbToLab, labToRgb, resize },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.EckoToneEngine = api;
})(typeof self !== "undefined" ? self : typeof globalThis !== "undefined" ? globalThis : this);
