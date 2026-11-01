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
};

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
  if (p.sharpen > 0) img = ops.unsharpMask(img, p.sharpen, Math.max(0.35, p.sharpenRadius * s), p.sharpenThreshold);
  img = Object.assign({}, img, { dpi: info.outputPpi * s });
  return { image: img, info };
}

module.exports = { prepareArt, artInfo, PREP_DEFAULTS };
