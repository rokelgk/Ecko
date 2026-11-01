'use strict';
// Small raster helpers on typed arrays. Images are { data, width, height,
// channels } with Uint8 data. Plates are Uint8Array(width*height), 0..255
// ink coverage (255 = solid ink).

function resizeImage(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const { data, channels: c } = img;
  const out = new Uint8ClampedArray(width * height * c);
  const sx = img.width / width, sy = img.height / height;
  if (sx >= 2 || sy >= 2) {
    // Box filter for strong downscales (avoids aliasing in the analysis).
    for (let y = 0; y < height; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
      for (let x = 0; x < width; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
        const acc = new Array(c).fill(0);
        let n = 0;
        for (let yy = y0; yy < y1 && yy < img.height; yy++) {
          for (let xx = x0; xx < x1 && xx < img.width; xx++) {
            const i = (yy * img.width + xx) * c;
            for (let k = 0; k < c; k++) acc[k] += data[i + k];
            n++;
          }
        }
        const o = (y * width + x) * c;
        for (let k = 0; k < c; k++) out[o + k] = acc[k] / n;
      }
    }
  } else {
    for (let y = 0; y < height; y++) {
      const fy = Math.max(0, (y + 0.5) * sy - 0.5);
      const y0 = Math.min(img.height - 1, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1), ty = fy - y0;
      for (let x = 0; x < width; x++) {
        const fx = Math.max(0, (x + 0.5) * sx - 0.5);
        const x0 = Math.min(img.width - 1, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1), tx = fx - x0;
        const o = (y * width + x) * c;
        const i00 = (y0 * img.width + x0) * c, i10 = (y0 * img.width + x1) * c;
        const i01 = (y1 * img.width + x0) * c, i11 = (y1 * img.width + x1) * c;
        for (let k = 0; k < c; k++) {
          out[o + k] = (data[i00 + k] * (1 - tx) + data[i10 + k] * tx) * (1 - ty) +
            (data[i01 + k] * (1 - tx) + data[i11 + k] * tx) * ty;
        }
      }
    }
  }
  return { data: out, width, height, channels: c };
}

// Separable square min (erode) or max (dilate) filter with radius r.
function morph(plate, width, height, r, useMax) {
  if (r <= 0) return plate;
  const tmp = new Uint8Array(plate.length);
  const out = new Uint8Array(plate.length);
  const pick = useMax ? Math.max : Math.min;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let v = plate[row + x];
      for (let d = 1; d <= r; d++) {
        if (x - d >= 0) v = pick(v, plate[row + x - d]);
        if (x + d < width) v = pick(v, plate[row + x + d]);
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      let v = tmp[y * width + x];
      for (let d = 1; d <= r; d++) {
        if (y - d >= 0) v = pick(v, tmp[(y - d) * width + x]);
        if (y + d < height) v = pick(v, tmp[(y + d) * width + x]);
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

const erode = (p, w, h, r) => morph(p, w, h, r, false);
const dilate = (p, w, h, r) => morph(p, w, h, r, true);

// 3x3 majority filter on a label map: removes lone stray pixels that would
// burn as specks on the screen.
function modeFilter(labels, width, height, passes) {
  let cur = labels;
  const counts = new Int32Array(256);
  const seen = new Int32Array(9);
  for (let p = 0; p < (passes || 1); p++) {
    const out = new Int16Array(cur.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const me = cur[i];
        let same = 0, ns = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx === 0 && dy === 0) || xx < 0 || xx >= width) continue;
            const l = cur[yy * width + xx] & 255;
            if (l === me) same++;
            if (counts[l]++ === 0) seen[ns++] = l;
          }
        }
        let best = me, bestN = -1;
        for (let s = 0; s < ns; s++) {
          const l = seen[s];
          if (counts[l] > bestN) { bestN = counts[l]; best = l; }
          counts[l] = 0;
        }
        out[i] = same >= 2 ? me : best;
      }
    }
    cur = out;
  }
  return cur;
}

function boxBlur3(plate, width, height) {
  const out = new Uint8Array(plate.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          s += plate[yy * width + xx]; n++;
        }
      }
      out[y * width + x] = Math.round(s / n);
    }
  }
  return out;
}

// Bilinear sample of a plate at fractional source coordinates (0..1 result).
function samplePlate(plate, width, height, fx, fy) {
  fx = Math.max(0, Math.min(width - 1, fx - 0.5));
  fy = Math.max(0, Math.min(height - 1, fy - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  const a = plate[y0 * width + x0], b = plate[y0 * width + x1];
  const c = plate[y1 * width + x0], d = plate[y1 * width + x1];
  return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) / 255;
}

module.exports = { resizeImage, erode, dilate, modeFilter, boxBlur3, samplePlate };
