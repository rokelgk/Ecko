'use strict';
// Minimal ZIP writer (stored, no compression) so a browser can hand over
// many films in one download. Safari and other browsers block a burst of
// separate downloads, which used to leave only the job sheet. Films are
// already PackBits-compressed TIFFs, so storing them costs little.

const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function makeZip(files, date) {
  const d = date || new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const enc = new TextEncoder();
  const entries = files.map((f) => ({ name: enc.encode(f.name), data: f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data) }));
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  for (const e of entries) {
    e.crc = crc32(e.data);
    e.offset = p;
    dv.setUint32(p, 0x04034b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 0x0800, true); dv.setUint16(p + 8, 0, true);
    dv.setUint16(p + 10, dosTime, true); dv.setUint16(p + 12, dosDate, true);
    dv.setUint32(p + 14, e.crc, true); dv.setUint32(p + 18, e.data.length, true); dv.setUint32(p + 22, e.data.length, true);
    dv.setUint16(p + 26, e.name.length, true); dv.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30); out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }
  const cdStart = p;
  for (const e of entries) {
    dv.setUint32(p, 0x02014b50, true); dv.setUint16(p + 4, 20, true); dv.setUint16(p + 6, 20, true); dv.setUint16(p + 8, 0x0800, true);
    dv.setUint16(p + 10, 0, true); dv.setUint16(p + 12, dosTime, true); dv.setUint16(p + 14, dosDate, true);
    dv.setUint32(p + 16, e.crc, true); dv.setUint32(p + 20, e.data.length, true); dv.setUint32(p + 24, e.data.length, true);
    dv.setUint16(p + 28, e.name.length, true); dv.setUint16(p + 30, 0, true); dv.setUint16(p + 32, 0, true);
    dv.setUint16(p + 34, 0, true); dv.setUint16(p + 36, 0, true); dv.setUint32(p + 38, 0, true); dv.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }
  dv.setUint32(p, 0x06054b50, true); dv.setUint16(p + 4, 0, true); dv.setUint16(p + 6, 0, true);
  dv.setUint16(p + 8, entries.length, true); dv.setUint16(p + 10, entries.length, true);
  dv.setUint32(p + 12, p - cdStart, true); dv.setUint32(p + 16, cdStart, true); dv.setUint16(p + 20, 0, true);
  return out;
}

module.exports = { makeZip, crc32 };
