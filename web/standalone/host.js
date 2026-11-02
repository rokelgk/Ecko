/* Ecko Tone browser host: everything the Python server did, done in the browser.
 *
 * Runs inside a Web Worker (preferred: the page stays smooth) or on the page itself as a
 * fallback. Handles: upload, preview, mockup, export (PNG / separations ZIP) and batch.
 * Needs: EckoToneEngine (tone-engine.js), OffscreenCanvas or a DOM canvas, CompressionStream.
 */
(function (root) {
  "use strict";
  const E = root.EckoToneEngine;
  const MAX_BATCH_ITEMS = 25, MAX_BATCH_GARMENTS = 12, MAX_BATCH_RENDERS = 60, MAX_BATCH_MEGAPIXELS = 2500;

  class HttpError extends Error { constructor(status, detail) { super(detail); this.status = status; } }

  // ---------------------------------------------------------------- canvas + fonts

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    return c;
  }
  function freeCanvas(c) { try { c.width = 1; c.height = 1; } catch (e) { /* ignore */ } }   // see TEXT_CANVAS_PX
  const canDraw = () => typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";

  async function loadFonts(fonts) {
    const set = root.fonts || (typeof document !== "undefined" ? document.fonts : null);
    if (!set || typeof FontFace === "undefined") return false;
    // A font that won't load falls back to the system font: text still works, it never blocks the app.
    const results = await Promise.all(Object.entries(fonts).map(async ([id, b64]) => {
      try {
        const face = new FontFace(`ecko-${id}`, `url(data:font/woff;base64,${b64})`);
        set.add(await face.load());
        return true;
      } catch (e) {
        try {
          const bin = atob(b64), bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          set.add(await new FontFace(`ecko-${id}`, bytes.buffer).load());
          return true;
        } catch (e2) { return false; }
      }
    }));
    return results.some(Boolean) || true;
  }

  /** One line of text bent along an arc (port of ecko/arctext.py). Returns coverage + baseline-centre anchor. */
  // Safari caps the total memory of all canvases on a page. Making a new canvas on every keystroke
  // or colour change used up that budget and the page crashed, so text uses one reused canvas
  // that is shrunk back after each use, and is never larger than TEXT_CANVAS_PX.
  const TEXT_CANVAS_PX = 12e6, TEXT_CANVAS_SIDE = 6000;
  let probeCtx = null, textCanvas = null;
  function textCtx(w, h) {
    if (!textCanvas) textCanvas = makeCanvas(w, h);
    else { textCanvas.width = w; textCanvas.height = h; }   // resizing also clears it
    const ctx = textCanvas.getContext("2d");
    if (!ctx) throw new Error("The browser ran out of drawing memory. Try a smaller picture or less text.");
    return ctx;
  }

  function renderText(t, capPx) {
    const fam = `"ecko-${t.font}"`;
    if (!probeCtx) probeCtx = makeCanvas(8, 8).getContext("2d");
    const probe = probeCtx;
    probe.font = `200px ${fam}`;
    const mH = probe.measureText("H"), hH = mH.actualBoundingBoxAscent + mH.actualBoundingBoxDescent;
    const size = Math.max(4, Math.round(200 * capPx / Math.max(1, hH)));
    probe.font = `${size}px ${fam}`;
    const chars = Array.from(t.text), adv = chars.map((ch) => probe.measureText(ch).width);
    const extra = t.spacing * size, total = adv.reduce((a, b) => a + b, 0) + extra * (chars.length - 1);
    const curved = Math.abs(t.arc) >= 1 && chars.length >= 2, R = curved ? total / (Math.abs(t.arc) * Math.PI / 180) : 0;
    const glyphs = [];
    let s = 0;
    chars.forEach((ch, i) => {
      const mid = s + adv[i] / 2;
      s += adv[i] + extra;
      if (!ch.trim()) return;
      if (!curved) { glyphs.push([ch, mid - total / 2, 0, 0]); return; }
      const th = (mid - total / 2) / R;
      if (t.arc > 0) glyphs.push([ch, R * Math.sin(th), R * (1 - Math.cos(th)), th]);
      else glyphs.push([ch, R * Math.sin(th), -R * (1 - Math.cos(th)), -th]);
    });
    if (!glyphs.length) return { mask: new Uint8Array(1), w: 1, h: 1, ax: 0, ay: 0 };
    const pad = size * 1.3;
    const x0 = Math.min(...glyphs.map((g) => g[1])) - pad, y0 = Math.min(...glyphs.map((g) => g[2])) - pad;
    const W = Math.ceil(Math.max(...glyphs.map((g) => g[1])) + pad - x0), H = Math.ceil(Math.max(...glyphs.map((g) => g[2])) + pad - y0);
    if (W * H > TEXT_CANVAS_PX || W > TEXT_CANVAS_SIDE || H > TEXT_CANVAS_SIDE) {   // too big: draw smaller, scale up
      const k = Math.min(Math.sqrt(TEXT_CANVAS_PX / (W * H)), TEXT_CANVAS_SIDE / W, TEXT_CANVAS_SIDE / H) * 0.98;
      return scaleMask(renderText(t, capPx * k), 1 / k);
    }
    const ctx = textCtx(W, H);
    ctx.font = `${size}px ${fam}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#000";
    for (const [ch, x, y, rot] of glyphs) {
      ctx.save(); ctx.translate(x - x0, y - y0); ctx.rotate(rot); ctx.fillText(ch, 0, 0); ctx.restore();
    }
    const px = ctx.getImageData(0, 0, W, H).data;
    textCanvas.width = 1; textCanvas.height = 1;   // hand the memory back straight away
    let mx = W, my = H, Mx = -1, My = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (px[(y * W + x) * 4 + 3]) {
      if (x < mx) mx = x; if (x > Mx) Mx = x; if (y < my) my = y; if (y > My) My = y;
    }
    if (Mx < 0) return { mask: new Uint8Array(1), w: 1, h: 1, ax: 0, ay: 0 };
    mx = Math.max(0, mx - 2); my = Math.max(0, my - 2); Mx = Math.min(W - 1, Mx + 2); My = Math.min(H - 1, My + 2);
    const w = Mx - mx + 1, h = My - my + 1, mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) mask[y * w + x] = px[((y + my) * W + x + mx) * 4 + 3];
    return { mask, w, h, ax: -x0 - mx, ay: -y0 - my };
  }

  function scaleMask(m, f) {   // bilinear enlarge of a text mask
    const w = Math.max(1, Math.round(m.w * f)), h = Math.max(1, Math.round(m.h * f)), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const sy = Math.min(m.h - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = Math.floor(sy), y1 = Math.min(m.h - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.min(m.w - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = Math.floor(sx), x1 = Math.min(m.w - 1, x0 + 1), fx = sx - x0;
        const a = m.mask[y0 * m.w + x0] * (1 - fx) + m.mask[y0 * m.w + x1] * fx;
        const b = m.mask[y1 * m.w + x0] * (1 - fx) + m.mask[y1 * m.w + x1] * fx;
        out[y * w + x] = Math.round(a * (1 - fy) + b * fy);
      }
    }
    return { mask: out, w, h, ax: m.ax * f, ay: m.ay * f };
  }

  async function decodeImage(bytes) {
    let bmp;
    try {
      bmp = await createImageBitmap(new Blob([bytes]));
    } catch (e) {
      throw new HttpError(422, "That file isn't an image we can read. Try PNG or JPG.");
    }
    if (bmp.width < 16 || bmp.height < 16) throw new HttpError(422, "The image is too small. Upload at least 200 x 200 pixels.");
    const c = makeCanvas(bmp.width, bmp.height), ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data, w = bmp.width, h = bmp.height;
    freeCanvas(c);
    if (bmp.close) bmp.close();
    return { rgba: data, w, h };
  }

  // ---------------------------------------------------------------- PNG + ZIP writers

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes, crc = 0xFFFFFFFF) {
    for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return crc;
  }
  async function zlib(u8) {
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function be32(v) { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length), t = [...type].map((c) => c.charCodeAt(0));
    out.set(be32(data.length), 0); out.set(t, 4); out.set(data, 8);
    const crc = crc32(data, crc32(Uint8Array.from(t))) ^ 0xFFFFFFFF;
    out.set(be32(crc >>> 0), 8 + data.length);
    return out;
  }
  /** RGBA (colorType 6) or 1-bit film (bits: 1 = ink, written black). Real DPI goes in pHYs. */
  async function encodePNG(w, h, data, dpi, oneBit = false) {
    if (typeof CompressionStream === "undefined") return encodePNGCanvas(w, h, data, dpi, oneBit);
    const stride = oneBit ? Math.ceil(w / 8) : w * 4, raw = new Uint8Array((stride + 1) * h);
    for (let y = 0; y < h; y++) {
      const o = y * (stride + 1) + 1;
      if (oneBit) {
        for (let x = 0; x < w; x++) if (!data[y * w + x]) raw[o + (x >> 3)] |= 0x80 >> (x & 7);   // 0 = black ink, 1 = clear
      } else raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), o);
    }
    const ihdr = new Uint8Array([...be32(w), ...be32(h), oneBit ? 1 : 8, oneBit ? 0 : 6, 0, 0, 0]);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr)];
    if (dpi) { const ppm = Math.round(dpi / 0.0254); parts.push(chunk("pHYs", new Uint8Array([...be32(ppm), ...be32(ppm), 1]))); }
    parts.push(chunk("IDAT", await zlib(raw)), chunk("IEND", new Uint8Array(0)));
    return new Blob(parts, { type: "image/png" });
  }
  /** Fallback for browsers without CompressionStream (older Safari): let the canvas write the PNG,
   *  then add the DPI chunk ourselves. Films come out as black-and-white RGBA rather than 1-bit. */
  async function encodePNGCanvas(w, h, data, dpi, oneBit) {
    let rgba = data;
    if (oneBit) {
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let k = 0; k < w * h; k++) { const v = data[k] ? 0 : 255; rgba[k * 4] = rgba[k * 4 + 1] = rgba[k * 4 + 2] = v; rgba[k * 4 + 3] = 255; }
    }
    const c = makeCanvas(w, h);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
    const blob = c.convertToBlob ? await c.convertToBlob({ type: "image/png" }) : await new Promise((r) => c.toBlob(r, "image/png"));
    freeCanvas(c);
    if (!dpi) return blob;
    const bytes = new Uint8Array(await blob.arrayBuffer()), ppm = Math.round(dpi / 0.0254);
    const phys = chunk("pHYs", new Uint8Array([...be32(ppm), ...be32(ppm), 1]));
    return new Blob([bytes.subarray(0, 33), phys, bytes.subarray(33)], { type: "image/png" });   // right after IHDR
  }

  async function zipBlob(files) {   // [{name, blob}] -> stored (uncompressed) ZIP; PNG/JPEG are already compressed
    const enc = new TextEncoder(), local = [], central = [], now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    let offset = 0;
    for (const f of files) {
      const data = new Uint8Array(await f.blob.arrayBuffer()), name = enc.encode(f.name), crc = (crc32(data) ^ 0xFFFFFFFF) >>> 0;
      const le16 = (v) => [v & 255, (v >>> 8) & 255], le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
      const common = [...le16(20), ...le16(0x0800), ...le16(0), ...le16(dosTime), ...le16(dosDate), ...le32(crc), ...le32(data.length), ...le32(data.length), ...le16(name.length)];
      const lh = new Uint8Array([...le32(0x04034b50), ...common, ...le16(0)]);
      local.push(lh, name, data);
      central.push(new Uint8Array([...le32(0x02014b50), ...le16(20), ...common, ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset)]), name);
      offset += lh.length + name.length + data.length;
    }
    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const le16 = (v) => [v & 255, (v >>> 8) & 255], le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    const end = new Uint8Array([...le32(0x06054b50), 0, 0, 0, 0, ...le16(files.length), ...le16(files.length), ...le32(cdSize), ...le32(offset), 0, 0]);
    return new Blob([...local, ...central, end], { type: "application/zip" });
  }
  const textBlob = (s) => new Blob([s], { type: "text/plain" });
  const safeName = (s) => (String(s || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)) || "ecko-tone";

  // ---------------------------------------------------------------- films + mockup

  function film(bitmap, w, h, o) {
    if (!o.registration_marks) return { data: bitmap, w, h };
    const m = Math.round(o.dpi * 0.5), W = w + 2 * m, H = h + 2 * m, out = new Uint8Array(W * H);
    for (let y = 0; y < h; y++) out.set(bitmap.subarray(y * w, (y + 1) * w), (y + m) * W + m);
    const r = Math.max(6, Math.round(o.dpi * 0.12)), lw = Math.max(1, Math.round(o.dpi / 150));
    const marks = [[m / 2, m + h / 2], [w + m + m / 2, m + h / 2], [m + w / 2, m / 2], [m + w / 2, h + m + m / 2]];
    for (const [cx, cy] of marks) {
      for (let y = Math.floor(cy - r * 1.5); y <= cy + r * 1.5; y++) for (let x = Math.floor(cx - r * 1.5); x <= cx + r * 1.5; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (Math.abs(d - r) < lw / 2 + 0.5 || Math.abs(y - cy) < lw / 2 + 0.5 || Math.abs(x - cx) < lw / 2 + 0.5) out[y * W + x] = 1;
      }
    }
    return { data: out, w: W, h: H };
  }

  const SHIRT = (() => {
    const neck = [];
    for (let i = 0; i < 24; i++) { const t = i / 23; neck.push([670 - 340 * t, 80 + 95 * 4 * t * (1 - t)]); }
    return [[330, 80], [195, 125], [35, 335], [150, 425], [232, 345], [232, 1060], [768, 1060], [768, 345], [850, 425],
      [965, 335], [805, 125], ...neck];
  })();

  async function mockupJpeg(prep, o, size, tex) {
    const s = size / 1000, W = size, H = Math.round(1100 * s), g = E.hex(o.garment);
    const c = makeCanvas(W, H), ctx = c.getContext("2d");
    const bg = Math.round((E.lum(g) < 0.75 ? 0.93 : 0.82) * 255);
    ctx.fillStyle = `rgb(${bg},${bg},${bg})`;
    ctx.fillRect(0, 0, W, H);
    const path = () => { ctx.beginPath(); SHIRT.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s))); ctx.closePath(); };
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.16)"; ctx.shadowBlur = 28 * s; ctx.shadowOffsetX = 6 * s; ctx.shadowOffsetY = 10 * s;
    path(); ctx.fillStyle = `rgb(${g.join(",")})`; ctx.fill();
    ctx.restore();
    ctx.save(); path(); ctx.clip();
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, "rgba(0,0,0,0.09)");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    const side = ctx.createLinearGradient(0, 0, W, 0);
    side.addColorStop(0, "rgba(0,0,0,0.06)"); side.addColorStop(0.5, "rgba(0,0,0,0)"); side.addColorStop(1, "rgba(0,0,0,0.06)");
    ctx.fillStyle = side; ctx.fillRect(0, 0, W, H);
    ctx.restore();
    const edge = `rgb(${g.map((v) => Math.round(v * 0.8)).join(",")})`;
    ctx.strokeStyle = edge; ctx.lineWidth = Math.max(1, 2 * s); path(); ctx.stroke();
    ctx.lineWidth = Math.max(1, 3 * s); ctx.beginPath();
    SHIRT.slice(-24).forEach(([x, y], i) => (i ? ctx.lineTo(x * s, (y + 14) * s) : ctx.moveTo(x * s, (y + 14) * s)));
    ctx.stroke();

    const [outW, outH] = E.outSize(prep, o);
    let pw = Math.max(8, Math.round(o.width_in * 27 * s));   // body is 540 units = 20 in, so 27 units per inch
    pw = Math.min(pw, Math.round(520 * s));
    let ph = Math.max(1, Math.round(pw * outH / outW));
    if (ph > 780 * s) { ph = Math.round(780 * s); pw = Math.max(1, Math.round(ph * outW / outH)); }
    const r = E.renderPreview(prep, o, Math.max(pw, ph), null, tex);
    const art = makeCanvas(r.width, r.height);
    art.getContext("2d").putImageData(new ImageData(r.rgba, r.width, r.height), 0, 0);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(art, Math.round((W - pw) / 2), Math.round(235 * s), pw, ph);
    freeCanvas(art);
    const blob = c.convertToBlob ? await c.convertToBlob({ type: "image/jpeg", quality: 0.88 })
      : await new Promise((res) => c.toBlob(res, "image/jpeg", 0.88));
    freeCanvas(c);
    return blob;
  }

  // ---------------------------------------------------------------- state + handlers

  const images = new Map();      // id -> {rgba, w, h}
  const prepared = new Map();    // key -> Prepared (LRU)
  const textures = new Map();    // id -> {data, w, h}
  const arts = new Map();        // image id + clean-up settings -> cleaned picture (before text)

  function options(raw) {
    try { return E.parseOptions(raw && typeof raw === "object" ? raw : {}); }
    catch (e) { throw new HttpError(400, e.message); }
  }

  function getPrepared(iid, o) {
    if (iid == null && !o.text.length) throw new HttpError(400, "Upload a picture or add some text.");
    const key = `${iid}|${E.prepareKey(o)}`;
    if (prepared.has(key)) { const p = prepared.get(key); prepared.delete(key); prepared.set(key, p); return p; }
    let img = null;
    if (iid != null) {
      img = images.get(iid);
      if (!img) throw new HttpError(410, "Image expired; upload it again.");
    }
    let prep;
    try {
      const ak = `${iid}|${E.artKey(o)}`;
      let stage = arts.get(ak);
      if (!stage) {
        arts.clear();   // one cleaned-up picture at a time: they are big
        stage = E.prepareArt(img && img.rgba, img && img.w, img && img.h, o);
        arts.set(ak, stage);
      }
      prep = E.prepare(img && img.rgba, img && img.w, img && img.h, o, renderText, stage);
    }
    catch (e) { throw new HttpError(e instanceof E.ImageError ? 422 : 500, e.message); }
    prepared.set(key, prep);
    trimPrepared();
    return prep;
  }

  // Each prepared picture holds full-size float copies (often 100+ MB). Keep only a few, and
  // stay under a byte budget, so typing text or changing colours can't exhaust the tab's memory.
  const PREP_MAX = 2, PREP_BUDGET = 500e6;
  function bytesOf(v, depth = 0) {
    if (!v || depth > 3) return 0;
    if (ArrayBuffer.isView(v)) return v.byteLength;
    if (v instanceof ArrayBuffer) return v.byteLength;
    if (typeof v !== "object") return 0;
    let n = 0;
    for (const k in v) n += bytesOf(v[k], depth + 1);
    return n;
  }
  function trimPrepared() {
    while (prepared.size > PREP_MAX) prepared.delete(prepared.keys().next().value);
    let total = 0;
    for (const p of prepared.values()) total += (p.__bytes ??= bytesOf(p));
    while (prepared.size > 1 && total > PREP_BUDGET) {
      const k = prepared.keys().next().value;
      total -= prepared.get(k).__bytes || 0;
      prepared.delete(k);
    }
  }
  function forgetImage(id) {
    for (const k of [...prepared.keys()]) if (k.startsWith(`${id}|`)) prepared.delete(k);
    for (const k of [...arts.keys()]) if (k.startsWith(`${id}|`)) arts.delete(k);
    textures.delete(id);
  }
  function trimImages() {   // uploads are kept under ~1 GB (a batch needs all its designs at once)
    let total = 0;
    for (const im of images.values()) total += im.rgba.byteLength;
    while (images.size > 1 && (images.size > 30 || total > 1e9)) {
      const k = images.keys().next().value;
      total -= images.get(k).rgba.byteLength;
      images.delete(k); forgetImage(k);
    }
  }

  function textureImages(o) {
    const out = {};
    for (const t of o.textures) {
      if (t.type !== "image" || !t.image_id) continue;
      if (!textures.has(t.image_id)) {
        const img = images.get(t.image_id);
        if (!img) throw new HttpError(410, "Image expired; upload it again.");
        const data = new Float32Array(img.w * img.h);
        for (let p = 0; p < data.length; p++) {
          const a = img.rgba[p * 4 + 3] / 255;
          const l = (img.rgba[p * 4] * 0.299 + img.rgba[p * 4 + 1] * 0.587 + img.rgba[p * 4 + 2] * 0.114) / 255;
          data[p] = l * a + (1 - a);   // transparent = no wear
        }
        textures.set(t.image_id, { data, w: img.w, h: img.h });
      }
      out[t.image_id] = textures.get(t.image_id);
    }
    return out;
  }

  function guard(fn) {
    try { return fn(); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(e instanceof E.ImageError ? 422 : e instanceof E.OptionError ? 400 : 500, e.message);
    }
  }

  async function upload({ bytes }) {
    const img = await decodeImage(bytes);
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    images.set(id, img);
    trimImages();
    return { id, width: img.w, height: img.h };
  }

  function uploadRGBA({ rgba, w, h, origW, origH }) {   // already decoded by the page
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    images.set(id, { rgba: new Uint8ClampedArray(rgba), w, h });
    trimImages();
    return { id, width: origW || w, height: origH || h };
  }

  async function preview(body) {
    const o = options(body.options), prep = getPrepared(body.image_id ?? null, o);
    const region = body.region;
    if (region != null && !(Array.isArray(region) && region.length === 4 && region.every((v) => typeof v === "number"))) {
      throw new HttpError(400, "region is [x, y, width, height] in print pixels.");
    }
    const maxPx = Math.max(200, Math.min(parseInt(body.max_px ?? 900, 10) || 900, 1600));
    const r = guard(() => E.renderPreview(prep, o, maxPx, region, textureImages(o)));
    const rep = E.report(prep, o, r.plates, r.bitmaps);
    const png = await encodePNG(r.width, r.height, r.rgba, 0);
    return { png, size: rep.pixels, report: rep, palette: o.mode === "spot" || o.mode === "index" ? E.resolveFit(prep, o).palette.map(E.toHex) : null };
  }

  async function mockup(body) {
    const o = options(body.options), prep = getPrepared(body.image_id ?? null, o);
    const size = Math.max(400, Math.min(parseInt(body.size ?? 1000, 10) || 1000, 2000));
    return { blob: await mockupJpeg(prep, o, size, textureImages(o)) };
  }

  async function exportFile(body) {
    const o = options(body.options), fmt = body.format || "png";
    if (fmt !== "png" && fmt !== "zip") throw new HttpError(400, "format is png or zip.");
    const prep = getPrepared(body.image_id ?? null, o), name = safeName(body.name);
    const r = guard(() => E.renderFull(prep, o, textureImages(o), fmt === "zip"));
    if (fmt === "png" && body.shirt_background) {   // flatten onto the shirt colour: a preview, not a print file
      const g = E.hex(o.garment), px = r.rgba;
      for (let k = 0; k < px.length; k += 4) if (!px[k + 3]) { px[k] = g[0]; px[k + 1] = g[1]; px[k + 2] = g[2]; px[k + 3] = 255; }
      return { blob: await encodePNG(r.width, r.height, px, o.dpi), filename: `${name}-on-shirt.png` };
    }
    const png = await encodePNG(r.width, r.height, r.rgba, o.dpi);
    if (fmt === "png") return { blob: png, filename: `${name}.png` };
    const rep = E.report(prep, o, r.plates, r.seps);
    const files = [{ name: `${name}-composite.png`, blob: png }];
    const grain = E.GRAIN_STYLES.includes(o.style);
    const kept = r.plates.map((p, i) => [p, r.seps[i]]).filter(([p]) => p.on);   // inks switched off get no film
    const lines = [`${name}: ${kept.length} separation(s)`, "",
      `Print size: ${rep.inches[0]} x ${rep.inches[1]} in (${rep.cm[0]} x ${rep.cm[1]} cm) at ${o.dpi} DPI`,
      `Screen: ${E.STYLES[o.style]}` + (grain ? `, grain ${o.grain_mm} mm` : `, ${o.lpi} LPI`), ""];
    for (let i = 0; i < kept.length; i++) {
      const [p, sep] = kept[i], f = film(sep, r.width, r.height, o), n = String(i + 1).padStart(2, "0");
      const ink = p.label || p.name;
      files.push({ name: `${name}-${n}-${ink.replace(/[^A-Za-z0-9]/g, "-")}-${E.toHex(p.rgb).slice(1)}.png`, blob: await encodePNG(f.w, f.h, f.data, o.dpi, true) });
      let on = 0;
      for (const v of sep) on += v;
      lines.push(`${n} ${ink.padEnd(18)} ${E.toHex(p.rgb)}  RGB ${p.rgb.map((c) => Math.round(c)).join(",").padEnd(11)}  ` +
        `angle ${(((p.angle % 180) + 180) % 180).toFixed(1).padStart(5)}  coverage ${(on / sep.length * 100).toFixed(1)}%`);
    }
    lines.push("", o.registration_marks ? "Films are black = ink, 1-bit, with registration marks in a 0.5 in margin."
      : "Films are black = ink, 1-bit.", "Print order: as numbered (light inks first).");
    files.push({ name: "README.txt", blob: textBlob(lines.join("\n") + "\n") });
    return { blob: await zipBlob(files), filename: `${name}-separations.zip` };
  }

  async function batch(body) {
    const base = body.options && typeof body.options === "object" ? body.options : {};
    options(base);
    const items = body.items;
    const garments = body.garments && body.garments.length ? body.garments : [{ hex: base.garment || "#ffffff", name: "" }];
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, "Add at least one design.");
    if (items.length > MAX_BATCH_ITEMS || garments.length > MAX_BATCH_GARMENTS) {
      throw new HttpError(400, `Batches are limited to ${MAX_BATCH_ITEMS} designs and ${MAX_BATCH_GARMENTS} colours.`);
    }
    if (items.length * garments.length > MAX_BATCH_RENDERS) {
      throw new HttpError(400, `That's ${items.length * garments.length} prints; the limit is ${MAX_BATCH_RENDERS} per batch.`);
    }
    const catalogGarments = E.CATALOG.api.garments;
    const shirts = garments.map((g) => {
      let h;
      try { h = E.toHex(E.hex(g.hex || "")); } catch (e) { throw new HttpError(400, e.message); }
      return [h, safeName(g.name || (catalogGarments.find((x) => x.hex === h) || {}).name || h.slice(1))];
    });
    const zipName = safeName(body.name || "ecko-batch"), withMockups = body.mockups !== false;
    const files = [], lines = [], errors = [], seen = new Set();
    let totalMp = 0;
    for (let n = 0; n < items.length; n++) {
      let name = safeName(items[n].name || `design-${n + 1}`);
      while (seen.has(name)) name = `${name}-${n + 1}`;
      seen.add(name);
      for (const [hexv, label] of shirts) {
        const o = options({ ...base, garment: hexv });
        try {
          const prep = getPrepared(items[n].image_id ?? null, o), [w, h] = E.outSize(prep, o);
          totalMp += w * h / 1e6;
          if (totalMp > MAX_BATCH_MEGAPIXELS) {
            throw new HttpError(400, "This batch is too big to render at once. Use fewer designs or colours, or a smaller size or DPI.");
          }
          const tex = textureImages(o), r = guard(() => E.renderFull(prep, o, tex));
          const stem = `${name}/${name}-${label}`;
          files.push({ name: `${stem}.png`, blob: await encodePNG(r.width, r.height, r.rgba, o.dpi) });
          if (withMockups) files.push({ name: `${stem}-mockup.jpg`, blob: await mockupJpeg(prep, o, 1000, tex) });
          const fit = E.resolveFit(prep, o);
          lines.push(`${stem}.png  ${w}x${h}px  fit=${fit.mode}  inks: ${r.plates.filter((p) => !p.underbase).map((p) => E.toHex(p.rgb)).join(", ")}`);
          for (const note of fit.notes) lines.push(`    ${note}`);
          prepared.delete(`${items[n].image_id ?? null}|${E.prepareKey(o)}`);   // free memory between prints
        } catch (e) {
          if (e instanceof HttpError && e.status === 400 && /batch/.test(e.message)) throw e;
          errors.push(`${name} on ${label}: ${e.message}`);
        }
      }
    }
    if (!lines.length) throw new HttpError(422, "Nothing could be rendered: " + errors.join("; "));
    const readme = [`${zipName}: ${items.length} design(s) x ${shirts.length} shirt colour(s)`, "", ...lines];
    if (errors.length) readme.push("", "Skipped:", ...errors.map((e) => `  ${e}`));
    files.push({ name: "README.txt", blob: textBlob(readme.join("\n") + "\n") });
    return { blob: await zipBlob(files), filename: `${zipName}.zip` };
  }

  async function handle(cmd, args) {
    switch (cmd) {
      case "init": E.registerScans(args.scans); return { fonts: await loadFonts(args.fonts), canDraw: canDraw() };
      case "upload": return upload(args);
      case "uploadRGBA": return uploadRGBA(args);
      case "preview": return preview(args);
      case "mockup": return mockup(args);
      case "export": return exportFile(args);
      case "batch": return batch(args);
      default: throw new HttpError(404, `Unknown command ${cmd}`);
    }
  }

  const host = { handle, HttpError, encodePNG, zipBlob, renderText };
  root.EckoToneHost = host;

  // Inside a Web Worker: answer messages from the page.
  if (typeof WorkerGlobalScope !== "undefined" && root instanceof WorkerGlobalScope) {
    root.onmessage = async (ev) => {
      const { id, cmd, args } = ev.data;
      try {
        const result = await handle(cmd, args);
        root.postMessage({ id, ok: true, result });
      } catch (e) {
        root.postMessage({ id, ok: false, status: e.status || 500, detail: e.message || String(e) });
      }
    };
  }
})(typeof self !== "undefined" ? self : globalThis);
