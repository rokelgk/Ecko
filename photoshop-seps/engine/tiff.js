'use strict';
// Minimal TIFF writer for film output: 1-bit or 8-bit grayscale,
// PackBits compression, resolution in dots per inch. WhiteIsZero, so a
// value of 255 (or bit 1) is black on film: ink prints where film is black.

function packBits(row) {
  const out = [];
  let i = 0;
  const n = row.length;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 2) {
      out.push(257 - run, row[i]);
      i += run;
      continue;
    }
    let j = i;
    while (j < n && j - i < 128 && !(j + 1 < n && row[j] === row[j + 1])) j++;
    if (j === i) j = i + 1;
    out.push(j - i - 1);
    for (let k = i; k < j; k++) out.push(row[k]);
    i = j;
  }
  return out;
}

function writeTiff(film) {
  const { width, height, dpi } = film;
  const bits = film.bits === 1 ? 1 : 8;
  const rowBytes = bits === 1 ? Math.ceil(width / 8) : width;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(65536 / rowBytes) || 1));
  const strips = [];
  const row = new Uint8Array(rowBytes);
  for (let s = 0; s < height; s += rowsPerStrip) {
    const chunk = [];
    for (let y = s; y < Math.min(height, s + rowsPerStrip); y++) {
      const src = film.data.subarray(y * width, (y + 1) * width);
      if (bits === 1) {
        row.fill(0);
        for (let x = 0; x < width; x++) if (src[x] >= 128) row[x >> 3] |= 0x80 >> (x & 7);
      } else row.set(src);
      const packed = packBits(row);
      for (let k = 0; k < packed.length; k++) chunk.push(packed[k]);
    }
    strips.push(Uint8Array.from(chunk));
  }
  const entries = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, bits], [259, 3, 1, 32773], [262, 3, 1, 0],
    [273, 4, strips.length, null], [277, 3, 1, 1], [278, 4, 1, rowsPerStrip], [279, 4, strips.length, null],
    [282, 5, 1, null], [283, 5, 1, null], [296, 3, 1, 2],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  let offset = 8 + ifdSize;
  const alloc = (bytes) => { const o = offset; offset += bytes; if (offset & 1) offset++; return o; };
  const resOff = alloc(16);
  const offsetsOff = strips.length > 1 ? alloc(strips.length * 4) : 0;
  const countsOff = strips.length > 1 ? alloc(strips.length * 4) : 0;
  const stripOffsets = strips.map((s) => alloc(s.length));
  const buf = new Uint8Array(offset);
  const dv = new DataView(buf.buffer);
  buf[0] = 0x49; buf[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, count, value], i) => {
    const p = 10 + i * 12;
    dv.setUint16(p, tag, true); dv.setUint16(p + 2, type, true); dv.setUint32(p + 4, count, true);
    if (tag === 273) dv.setUint32(p + 8, strips.length > 1 ? offsetsOff : stripOffsets[0], true);
    else if (tag === 279) dv.setUint32(p + 8, strips.length > 1 ? countsOff : strips[0].length, true);
    else if (tag === 282) dv.setUint32(p + 8, resOff, true);
    else if (tag === 283) dv.setUint32(p + 8, resOff + 8, true);
    else if (type === 3) dv.setUint16(p + 8, value, true);
    else dv.setUint32(p + 8, value, true);
  });
  dv.setUint32(10 + entries.length * 12, 0, true);
  dv.setUint32(resOff, Math.round(dpi * 100), true); dv.setUint32(resOff + 4, 100, true);
  dv.setUint32(resOff + 8, Math.round(dpi * 100), true); dv.setUint32(resOff + 12, 100, true);
  strips.forEach((s, i) => {
    if (strips.length > 1) {
      dv.setUint32(offsetsOff + i * 4, stripOffsets[i], true);
      dv.setUint32(countsOff + i * 4, s.length, true);
    }
    buf.set(s, stripOffsets[i]);
  });
  return buf;
}

// Reader for the files writeTiff makes (used by tests).
function readTiff(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const tag = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true);
    const val = type === 3 && count === 1 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true);
    tags[tag] = { type, count, val };
  }
  const width = tags[256].val, height = tags[257].val, bits = tags[258].val;
  const readArr = (t) => (t.count === 1 ? [t.val] : Array.from({ length: t.count }, (_, i) => dv.getUint32(t.val + i * 4, true)));
  const offs = readArr(tags[273]), counts = readArr(tags[279]);
  const rowBytes = bits === 1 ? Math.ceil(width / 8) : width;
  const raw = [];
  offs.forEach((o, i) => {
    let p = o;
    const end = o + counts[i];
    while (p < end) {
      const h = buf[p++];
      if (h < 128) { for (let k = 0; k <= h; k++) raw.push(buf[p++]); } else if (h > 128) { const v = buf[p++]; for (let k = 0; k < 257 - h; k++) raw.push(v); }
    }
  });
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = bits === 1 ? ((raw[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0) : raw[y * rowBytes + x];
    }
  }
  const xres = dv.getUint32(tags[282].val, true) / dv.getUint32(tags[282].val + 4, true);
  return { width, height, bits, dpi: xres, data };
}

module.exports = { writeTiff, readTiff, packBits };
