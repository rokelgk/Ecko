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

// Per-screen film settings from a preset/global film setting.
function filmSettingsFor(screen, film) {
  const f = Object.assign({}, film);
  delete f.angles;
  if (film.angles && film.angles[screen.name] != null) f.angle = film.angles[screen.name];
  if (screen.film) Object.assign(f, screen.film);
  return f;
}

function filmLabel(result, screen, f) {
  const parts = [`${screen.order}/${result.screens.length}`, screen.name];
  if (f.type === 'am') parts.push(`${f.lpi} LPI`, `${f.angle}°`, f.dot);
  else if (f.type === 'fm') parts.push('FM');
  else if (f.type === 'index') parts.push('INDEX');
  const mesh = halftone.recommendMesh(screen, f);
  parts.push(`MESH ${mesh.mesh}`);
  return parts.join('  ');
}

function renderScreenFilm(result, screen, film) {
  const f = filmSettingsFor(screen, film);
  const label = film.label === false ? '' : filmLabel(result, screen, f);
  const minDot = result.options && result.options.minDot ? result.options.minDot : 0;
  return halftone.renderFilm(screen.plate, result.width, result.height, result.dpi, Object.assign({ minDot }, f, { label }));
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
      id: s.id, order: s.order, name: s.name, hex: s.hex, role: s.role, code: s.code, library: s.library,
      coverage: s.coverage, mesh: mesh.mesh, meshRange: mesh.range, film: f, matchDeltaE: s.matchDeltaE,
    };
  });
}

module.exports = Object.assign(
  { separate: sep.separate, DEFAULTS: sep.DEFAULTS, autoScreenCount: sep.autoScreenCount, filmSettingsFor, filmLabel, renderScreenFilm, screenSummary, dotPreview, prepareArt: prepare.prepareArt, artInfo: prepare.artInfo, PREP_DEFAULTS: prepare.PREP_DEFAULTS },
  { color, inks, palette, halftone, tiff, presets, ops },
);
