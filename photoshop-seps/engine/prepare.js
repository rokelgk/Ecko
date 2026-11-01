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
  saturation: 1, // 0..2
};

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
function prepareArt(image, prep, scale) {
  const p = Object.assign({}, PREP_DEFAULTS, prep || {});
  const info = artInfo(image, p);
  const s = scale || 1;
  const w = Math.max(1, Math.round(info.outWidth * s)), h = Math.max(1, Math.round(info.outHeight * s));
  let img = image;
  if (w !== image.width || h !== image.height) {
    img = w > image.width ? ops.resizeBicubic(image, w, h) : ops.resizeImage(image, w, h);
  }
  for (let i = 0; i < (p.denoise | 0); i++) img = ops.median3(img);
  img = toneArt(img, p.levels, p.saturation);
  if (p.sharpen > 0) img = ops.unsharpMask(img, p.sharpen, Math.max(0.35, p.sharpenRadius * s), p.sharpenThreshold);
  img = Object.assign({}, img, { dpi: info.outputPpi * s });
  return { image: img, info };
}

module.exports = { prepareArt, artInfo, toneArt, PREP_DEFAULTS };
