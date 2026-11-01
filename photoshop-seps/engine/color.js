'use strict';
// Color math: sRGB <-> linear <-> CIE Lab (D65), CIEDE2000, hex helpers.
// "YN space" is linear reflectance raised to 1/2 (Yule-Nielsen, n = 2).
// Averaging halftone coverage in YN space predicts printed tone better than
// averaging in plain linear light, because ink dots spread into the paper.

const YN_N = 2;

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function srgbToLinear(c255) {
  return SRGB_TO_LINEAR[c255 | 0];
}

function linearToSrgb(l) {
  if (l <= 0) return 0;
  if (l >= 1) return 255;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

function linearToYn(l) {
  return Math.pow(Math.max(0, l), 1 / YN_N);
}

function ynToLinear(v) {
  return Math.pow(Math.max(0, v), YN_N);
}

// sRGB byte -> YN value lookup.
const SRGB_TO_YN = new Float32Array(256);
for (let i = 0; i < 256; i++) SRGB_TO_YN[i] = linearToYn(SRGB_TO_LINEAR[i]);

function rgbToYn(rgb) {
  return [SRGB_TO_YN[rgb[0]], SRGB_TO_YN[rgb[1]], SRGB_TO_YN[rgb[2]]];
}

function ynToRgb(v) {
  return [linearToSrgb(ynToLinear(v[0])), linearToSrgb(ynToLinear(v[1])), linearToSrgb(ynToLinear(v[2]))];
}

const XN = 0.95047, YN = 1.0, ZN = 1.08883;

function labF(t) {
  return t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
}

function linearRgbToLab(r, g, b) {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / XN;
  const y = (0.2126729 * r + 0.7151522 * g + 0.0721750 * b) / YN;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / ZN;
  const fx = labF(x), fy = labF(y), fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function rgbToLab(rgb) {
  return linearRgbToLab(SRGB_TO_LINEAR[rgb[0]], SRGB_TO_LINEAR[rgb[1]], SRGB_TO_LINEAR[rgb[2]]);
}

function labToLinearRgb(lab) {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const inv = (f) => (f * f * f > 216 / 24389 ? f * f * f : (116 * f - 16) / (24389 / 27));
  const x = inv(fx) * XN, y = inv(fy) * YN, z = inv(fz) * ZN;
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

function labToRgb(lab) {
  const l = labToLinearRgb(lab);
  return [linearToSrgb(l[0]), linearToSrgb(l[1]), linearToSrgb(l[2])];
}

function deltaE76(a, b) {
  const d0 = a[0] - b[0], d1 = a[1] - b[1], d2 = a[2] - b[2];
  return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
}

// CIEDE2000 (Sharma, Wu, Dalal 2005).
function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const Cbar7 = Math.pow(Cbar, 7);
  const G = 0.5 * (1 - Math.sqrt(Cbar7 / (Cbar7 + 6103515625)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hp = (a, b) => {
    if (a === 0 && b === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hp(a1p, b1), h2p = hp(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
    else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) +
    0.32 * Math.cos((3 * hbp + 6) * rad) - 0.20 * Math.cos((4 * hbp - 63) * rad);
  const dTheta = 30 * Math.exp(-Math.pow((hbp - 275) / 25, 2));
  const Cbp7 = Math.pow(Cbp, 7);
  const Rc = 2 * Math.sqrt(Cbp7 / (Cbp7 + 6103515625));
  const Sl = 1 + (0.015 * Math.pow(Lbp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbp - 50, 2));
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  const tl = dLp / Sl, tc = dCp / Sc, th = dHp / Sh;
  return Math.sqrt(tl * tl + tc * tc + th * th + Rt * tc * th);
}

function parseHex(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`Not a hex color: ${hex}`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function chroma(lab) {
  return Math.hypot(lab[1], lab[2]);
}

// Plain-language name for a color, e.g. "Royal Blue", "Light Gray".
function colorName(lab) {
  const [L, a, b] = lab;
  const C = Math.hypot(a, b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  if (C < 9) return L > 92 ? 'White' : L > 72 ? 'Light Gray' : L > 45 ? 'Gray' : L > 22 ? 'Dark Gray' : 'Black';
  if (h >= 30 && h < 95 && L < 52 && C < 50) return L < 28 ? 'Dark Brown' : 'Brown';
  if (h >= 45 && h < 95 && C < 38 && L >= 52) return L > 82 ? 'Cream' : 'Tan';
  let base;
  if (h < 20 || h >= 350) base = L > 68 ? 'Pink' : 'Red';
  else if (h < 50) base = L < 38 ? 'Maroon' : 'Red';
  else if (h < 75) base = 'Orange';
  else if (h < 95) base = 'Gold';
  else if (h < 115) base = 'Yellow';
  else if (h < 170) base = L > 75 ? 'Lime' : 'Green';
  else if (h < 225) base = 'Teal';
  else if (h < 312) base = L < 22 ? 'Navy' : C > 55 ? 'Royal Blue' : 'Blue';
  else if (h < 335) base = 'Purple';
  else base = 'Magenta';
  if (['Navy', 'Maroon', 'Pink', 'Cream'].includes(base)) return base;
  if (L > 78 && C < 50) return 'Light ' + base;
  if (L < 32) return 'Dark ' + base;
  return base;
}

module.exports = { colorName,
  srgbToLinear, linearToSrgb, linearToYn, ynToLinear, rgbToYn, ynToRgb, SRGB_TO_YN, SRGB_TO_LINEAR,
  linearRgbToLab, rgbToLab, labToRgb, labToLinearRgb, deltaE76, deltaE2000, parseHex, toHex, chroma,
};
