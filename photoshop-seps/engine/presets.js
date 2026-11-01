'use strict';
// One-click starting points. Every value can be changed afterwards.

const PRESETS = [
  {
    id: 'dark-sim', label: 'Sim Process · Dark Shirt',
    blurb: 'Photo-real art on black or colored shirts. Underbase + highlight white.',
    options: { mode: 'simulated', garment: '#111111', screens: 8, underbase: 'auto', choke: 1, maxInksPerPixel: 4, dotGain: 0.1, minDot: 0.05, maxDot: 0.95 },
    film: { type: 'am', lpi: 55, angle: 22.5, dot: 'ellipse', dpi: 720 },
  },
  {
    id: 'light-sim', label: 'Sim Process · Light Shirt',
    blurb: 'Photo-real art on white or light shirts. No underbase.',
    options: { mode: 'simulated', garment: '#ffffff', screens: 6, underbase: false, maxInksPerPixel: 4, dotGain: 0.12, minDot: 0.04, maxDot: 0.96 },
    film: { type: 'am', lpi: 55, angle: 22.5, dot: 'ellipse', dpi: 720 },
  },
  {
    id: 'dark-index', label: 'Index · Dark Shirt',
    blurb: 'Square-pixel separations. No moiré, easy registration.',
    options: { mode: 'index', garment: '#111111', screens: 8, underbase: 'auto', indexDpi: 240 },
    film: { type: 'index', dpi: 720 },
  },
  {
    id: 'light-index', label: 'Index · Light Shirt',
    blurb: 'Square-pixel separations for white or light shirts.',
    options: { mode: 'index', garment: '#ffffff', screens: 6, underbase: false, indexDpi: 240 },
    film: { type: 'index', dpi: 720 },
  },
  {
    id: 'spot', label: 'Spot Color · Vector / Logo',
    blurb: 'Solid colors with clean edges, speck removal and trapping.',
    options: { mode: 'spot', garment: '#ffffff', screens: 4, underbase: 'auto', cleanup: 2, trap: 1, smoothEdges: true, choke: 2 },
    film: { type: 'threshold', dpi: 720 },
  },
  {
    id: 'cmyk', label: 'CMYK Process · White Shirt',
    blurb: 'Four-color process with GCR. Best on white garments.',
    options: { mode: 'cmyk', garment: '#ffffff', underbase: false, gcr: 0.7, totalInk: 2.8, dotGain: 0.15, minDot: 0.04, maxDot: 0.96 },
    film: { type: 'am', lpi: 65, dot: 'round', dpi: 720, angles: { 'Process Cyan': 15, 'Process Magenta': 75, 'Process Yellow': 0, 'Process Black': 45 } },
  },
  {
    id: 'cmyk-dark', label: 'CMYK Process · Dark Shirt',
    blurb: 'Four-color process over a white underbase, plus highlight white.',
    options: { mode: 'cmyk', garment: '#111111', underbase: 'auto', choke: 1, gcr: 0.6, totalInk: 2.6, dotGain: 0.15, minDot: 0.04, maxDot: 0.96 },
    film: { type: 'am', lpi: 55, dot: 'round', dpi: 720, angles: { 'Underbase White': 22.5, 'Process Cyan': 15, 'Process Magenta': 75, 'Process Yellow': 0, 'Process Black': 45, 'Highlight White': 22.5 } },
  },
  {
    id: 'one-color', label: 'One Color · Grayscale',
    blurb: 'One ink carries the whole image as halftones.',
    options: { mode: 'grayscale', garment: '#ffffff', dotGain: 0.12, minDot: 0.05, maxDot: 0.95 },
    film: { type: 'am', lpi: 45, angle: 22.5, dot: 'round', dpi: 720 },
  },
];

const SCREEN_COUNTS = [2, 4, 6, 8, 10];
const LPI_CHOICES = [25, 35, 45, 55, 65, 75, 85];
const DPI_CHOICES = [300, 600, 720, 1200, 1440, 2400];
const ANGLE_CHOICES = [22.5, 25, 45, 15, 75, 0];
const DOT_SHAPES = ['ellipse', 'round', 'square', 'diamond', 'line'];

function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

module.exports = { PRESETS, SCREEN_COUNTS, LPI_CHOICES, DPI_CHOICES, ANGLE_CHOICES, DOT_SHAPES, getPreset };
