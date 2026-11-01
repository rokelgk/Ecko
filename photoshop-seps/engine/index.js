'use strict';
// Public API of the separation engine. Pure JavaScript, no Photoshop
// dependency: the Photoshop panel, the browser preview and the tests all use it.

const color = require('./color');
const inks = require('./inks');
const palette = require('./palette');
const sep = require('./separate');
const halftone = require('./halftone');
const tiff = require('./tiff');
const presets = require('./presets');
const ops = require('./image-ops');
const prepare = require('./prepare');
const texture = require('./texture');
const zip = require('./zip');

// Per-screen film settings from a preset/global film setting.
function filmSettingsFor(screen, film) {
  const f = Object.assign({}, film);
  delete f.angles;
  if (film.angles && film.angles[screen.name] != null) f.angle = film.angles[screen.name];
  if (screen.film) Object.assign(f, screen.film);
  return f;
}

// Pre-registration options shared by films, the Photoshop document and the
// plate previews: { marks, crops, center, names, details, marginIn }.
const REG_DEFAULTS = { marks: true, crops: true, center: false, names: true, details: true, marginIn: 0.5 };

function filmLabel(result, screen, f, reg) {
  const r = Object.assign({}, REG_DEFAULTS, reg || {});
  if (!r.names) return '';
  const parts = [`${screen.order}/${result.screens.length}`, screen.name];
  if (!r.details) return parts.join('  ');
  if (f.type === 'am') parts.push(`${f.lpi} LPI`, `${f.angle}°`, f.dot);
  else if (f.type === 'fm') parts.push('FM');
  else if (f.type === 'index') parts.push('INDEX');
  const mesh = halftone.recommendMesh(screen, f);
  parts.push(`MESH ${mesh.mesh}`);
  return parts.join('  ');
}

function regFor(film, reg) {
  const r = Object.assign({}, REG_DEFAULTS, reg || {});
  if (film && film.marks === false) r.marks = false;
  if (film && film.label === false) r.names = false;
  return r;
}

function renderScreenFilm(result, screen, film, reg) {
  const f = filmSettingsFor(screen, film);
  const r = regFor(film, reg);
  const label = filmLabel(result, screen, f, r);
  const minDot = result.options && result.options.minDot ? result.options.minDot : 0;
  return halftone.renderFilm(screen.plate, result.width, result.height, result.dpi, Object.assign({ minDot }, f, { label, marks: r.marks, crops: r.crops, center: r.center, marginIn: r.marginIn }));
}

// The same separation with marks and ink names drawn into every plate,
// on a canvas grown by the margin: used for the Photoshop document and the
// plate previews. Returns a new result; the original is untouched.
function applyRegistration(result, film, reg) {
  const r = regFor(film, reg);
  if (!r.marks && !r.crops && !r.center && !r.names) return result;
  let w = result.width, h = result.height;
  const screens = result.screens.map((s) => {
    const f = filmSettingsFor(s, film);
    const out = halftone.addMarks({ data: s.plate, width: result.width, height: result.height, dpi: result.dpi, bits: 8 },
      { marks: r.marks, crops: r.crops, center: r.center, marginIn: r.marginIn, label: filmLabel(result, s, f, r) });
    w = out.width; h = out.height;
    return Object.assign({}, s, { plate: out.data });
  });
  // The preview stays the unregistered size: keep its own dimensions.
  return Object.assign({}, result, { width: w, height: h, screens, registered: true, previewWidth: result.previewWidth || result.width, previewHeight: result.previewHeight || result.height });
}

// Close-up of the print with real film dots: the region around (cx, cy)
// (0..1 of the design) at film resolution, each screen halftoned with its
// film settings and stacked on the garment.
function dotPreview(result, film, cx, cy, size) {
  const W = size || 360;
  const screens = result.screens.map((s) => {
    const f = filmSettingsFor(s, film);
    const type = f.type === 'continuous' ? 'am' : f.type;
    const dpi = f.dpi || 720;
    const scale = dpi / result.dpi;
    const fullW = result.width * scale, fullH = result.height * scale;
    const x0 = Math.max(0, Math.min(fullW - W, Math.round(cx * fullW - W / 2)));
    const y0 = Math.max(0, Math.min(fullH - W, Math.round(cy * fullH - W / 2)));
    const bm = halftone.renderBitmap(s.plate, result.width, result.height, result.dpi, Object.assign({ minDot: result.options.minDot || 0 }, f, { type, region: { x: x0, y: y0, w: W, h: W } }));
    return Object.assign({}, s, { plate: bm.data, w: bm.width, h: bm.height });
  });
  const w = screens.length ? screens[0].w : W, h = screens.length ? screens[0].h : W;
  const rgba = sep.composite(screens, { hex: result.garment.hex, rgb: result.garment.rgb, lab: color.rgbToLab(result.garment.rgb) }, w, h, result.options, { binary: true });
  return { rgba, width: w, height: h };
}

// Summary rows for UI and job sheets.
function screenSummary(result, film) {
  return result.screens.map((s) => {
    const f = filmSettingsFor(s, film);
    const mesh = halftone.recommendMesh(s, f);
    return {
      histogram: s.histogram, adjust: s.adjust || null,
      id: s.id, order: s.order, name: s.name, hex: s.hex, role: s.role, code: s.code, library: s.library,
      coverage: s.coverage, mesh: mesh.mesh, meshRange: mesh.range, film: f, matchDeltaE: s.matchDeltaE,
    };
  });
}

module.exports = Object.assign(
  { separate: sep.separate, DEFAULTS: sep.DEFAULTS, autoScreenCount: sep.autoScreenCount, filmSettingsFor, filmLabel, renderScreenFilm, applyRegistration, REG_DEFAULTS, screenSummary, dotPreview, prepareArt: prepare.prepareArt, artInfo: prepare.artInfo, PREP_DEFAULTS: prepare.PREP_DEFAULTS },
  { color, inks, palette, halftone, tiff, presets, ops, texture, zip },
);
