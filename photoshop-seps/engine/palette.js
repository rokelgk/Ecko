'use strict';
// Picks the ink colors for a design: weighted k-means in Lab with fixed
// centers (garment, locked inks, highlight white) and "accent rescue", so a
// small bright detail (an eye, a logo dot) is not averaged into its
// neighbours, which is the usual cause of "my red disappeared".

const { rgbToLab, deltaE76, deltaE2000, labToRgb, toHex } = require('./color');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sample opaque pixels as Lab. Returns { labs: Float32Array(n*3), n }.
function sampleLab(image, maxSamples, skipEdges) {
  const { data, width, height, channels } = image;
  const edgeAt = (x, y) => {
    const i = (y * width + x) * channels;
    let m = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const j = (yy * width + xx) * channels;
      m = Math.max(m, Math.abs(data[i] - data[j]) + Math.abs(data[i + 1] - data[j + 1]) + Math.abs(data[i + 2] - data[j + 2]));
    }
    return m > 60;
  };
  const total = width * height;
  const step = Math.max(1, Math.floor(Math.sqrt(total / (maxSamples || 60000))));
  const out = [];
  const cache = new Map();
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * channels;
      if (channels === 4 && data[i + 3] < 128) continue;
      // Anti-aliased edges are blends of two inks, not a color of their own.
      if (skipEdges && edgeAt(x, y)) continue;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      let lab = cache.get(key);
      if (!lab) { lab = rgbToLab([data[i], data[i + 1], data[i + 2]]); cache.set(key, lab); }
      out.push(lab[0], lab[1], lab[2]);
    }
  }
  return { labs: Float32Array.from(out), n: out.length / 3 };
}

function nearestCenter(labs, i, centers) {
  let best = 0, bestD = Infinity;
  const L = labs[i * 3], A = labs[i * 3 + 1], B = labs[i * 3 + 2];
  for (let c = 0; c < centers.length; c++) {
    const d0 = L - centers[c][0], d1 = A - centers[c][1], d2 = B - centers[c][2];
    const d = d0 * d0 + d1 * d1 + d2 * d2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return [best, bestD];
}

// k-means where `fixed` centers never move. Returns the free centers only,
// with their pixel share.
function kmeans(samples, k, fixed, opts) {
  const { labs, n } = samples;
  const rand = mulberry32((opts && opts.seed) || 1234);
  const centers = fixed.map((c) => c.slice());
  const nFixed = centers.length;
  if (n === 0 || k === 0) return [];
  // k-means++ seeding, biased toward chroma so saturated accents get seeds.
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) dist[i] = nFixed ? nearestCenter(labs, i, centers)[1] : 1;
  for (let c = 0; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += dist[i];
    let pick = 0;
    if (sum > 0) {
      let r = rand() * sum;
      for (let i = 0; i < n; i++) { r -= dist[i]; if (r <= 0) { pick = i; break; } }
    } else pick = Math.floor(rand() * n);
    centers.push([labs[pick * 3], labs[pick * 3 + 1], labs[pick * 3 + 2]]);
    for (let i = 0; i < n; i++) {
      const d = nearestCenter(labs, i, [centers[centers.length - 1]])[1];
      if (d < dist[i]) dist[i] = d;
    }
  }
  const assign = new Int32Array(n);
  for (let iter = 0; iter < (opts && opts.iterations || 20); iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const [c] = nearestCenter(labs, i, centers);
      if (assign[i] !== c) moved++;
      assign[i] = c;
      const s = sums[c];
      s[0] += labs[i * 3]; s[1] += labs[i * 3 + 1]; s[2] += labs[i * 3 + 2]; s[3]++;
    }
    for (let c = nFixed; c < centers.length; c++) {
      const s = sums[c];
      if (s[3] > 0) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
    if (moved === 0 && iter > 0) break;
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  return { centers, counts, assign, nFixed };
}

// Replace near-duplicate free centers with poorly represented accents.
function rescueAccents(samples, result, opts) {
  const { labs, n } = samples;
  const minShare = (opts && opts.minAccentShare) || 0.0004;
  const threshold = (opts && opts.accentDeltaE) || 18;
  for (let round = 0; round < 3; round++) {
    const { centers, nFixed } = result;
    if (centers.length - nFixed < 2) return result;
    // Pixels that no center represents well.
    const far = [];
    for (let i = 0; i < n; i++) {
      const [, d] = nearestCenter(labs, i, centers);
      if (Math.sqrt(d) > threshold) far.push(i);
    }
    if (far.length < Math.max(8, n * minShare)) return result;
    // Mean of the strongest-chroma group among the far pixels.
    far.sort((a, b) => Math.hypot(labs[b * 3 + 1], labs[b * 3 + 2]) - Math.hypot(labs[a * 3 + 1], labs[a * 3 + 2]));
    const seed = far[0];
    const group = far.filter((i) => deltaE76([labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]],
      [labs[seed * 3], labs[seed * 3 + 1], labs[seed * 3 + 2]]) < threshold * 1.5);
    if (group.length < Math.max(8, n * minShare)) return result;
    const accent = [0, 0, 0];
    for (const i of group) { accent[0] += labs[i * 3]; accent[1] += labs[i * 3 + 1]; accent[2] += labs[i * 3 + 2]; }
    accent[0] /= group.length; accent[1] /= group.length; accent[2] /= group.length;
    // Merge the two most similar free centers to make room.
    let bi = -1, bj = -1, bd = Infinity;
    for (let i = nFixed; i < centers.length; i++) {
      for (let j = i + 1; j < centers.length; j++) {
        const d = deltaE2000(centers[i], centers[j]);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    }
    if (bd > threshold) return result; // every slot is already doing real work
    const wi = result.counts[bi] || 1, wj = result.counts[bj] || 1;
    centers[bi] = centers[bi].map((v, k) => (v * wi + centers[bj][k] * wj) / (wi + wj));
    centers[bj] = accent;
    result = refine(samples, centers, nFixed);
  }
  return result;
}

function refine(samples, centers, nFixed, iterations) {
  const { labs, n } = samples;
  const assign = new Int32Array(n);
  for (let iter = 0; iter < (iterations || 8); iter++) {
    const sums = centers.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const [c] = nearestCenter(labs, i, centers);
      assign[i] = c;
      const s = sums[c];
      s[0] += labs[i * 3]; s[1] += labs[i * 3 + 1]; s[2] += labs[i * 3 + 2]; s[3]++;
    }
    for (let c = nFixed; c < centers.length; c++) {
      const s = sums[c];
      if (s[3] > 0) centers[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
    }
  }
  const counts = new Array(centers.length).fill(0);
  for (let i = 0; i < n; i++) counts[assign[i]]++;
  return { centers, counts, assign, nFixed };
}

// The strong end of a cluster: the mean of the members farthest from the
// garment. Halftones fade an ink toward the shirt color, so an ink must be
// the most intense version of its color, not the average, or the print
// comes out chalky (light shirts) or muddy (dark shirts).
function strongEnd(samples, result, c, garmentLab, fraction) {
  const { labs, n } = samples;
  const members = [];
  for (let i = 0; i < n; i++) {
    if (result.assign[i] !== c) continue;
    const lab = [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]];
    members.push([deltaE76(lab, garmentLab), lab]);
  }
  if (members.length < 4) return result.centers[c];
  members.sort((a, b) => b[0] - a[0]);
  const top = members.slice(0, Math.max(2, Math.round(members.length * fraction)));
  const m = [0, 0, 0];
  for (const [, lab] of top) { m[0] += lab[0]; m[1] += lab[1]; m[2] += lab[2]; }
  return m.map((v) => v / top.length);
}

// Main entry. fixedLabs: centers that must exist (garment first).
// Returns [{ lab, share }] for the free centers, most used first.
function pickColors(image, count, fixedLabs, opts) {
  const samples = sampleLab(image, opts && opts.maxSamples, opts && opts.skipEdges);
  if (count <= 0) return [];
  let result = kmeans(samples, count, fixedLabs, opts);
  if (!result.centers) return [];
  result = rescueAccents(samples, result, opts);
  const out = [];
  const strong = opts && opts.strongFrom;
  for (let c = result.nFixed; c < result.centers.length; c++) {
    const lab = strong ? strongEnd(samples, result, c, strong, opts.strongFraction || 0.3) : result.centers[c];
    out.push({ lab, share: result.counts[c] / Math.max(1, samples.n) });
  }
  // Drop centers nobody uses (k bigger than the number of real colors), and
  // with `mergeDeltaE` fold near-duplicates (flat art has fewer real colors
  // than screens asked for).
  let kept = out.filter((c) => c.share > 0.0005).sort((a, b) => b.share - a.share);
  const merge = opts && opts.mergeDeltaE;
  if (merge) {
    const res = [];
    for (const c of kept) {
      if (fixedLabs.some((f) => deltaE2000(f, c.lab) < merge)) continue;
      const twin = res.find((r) => deltaE2000(r.lab, c.lab) < merge);
      if (twin) twin.share += c.share; else res.push(c);
    }
    kept = res;
  }
  return kept;
}

function describeLab(lab) {
  return toHex(labToRgb(lab));
}

module.exports = { pickColors, sampleLab, kmeans, mulberry32, describeLab };
