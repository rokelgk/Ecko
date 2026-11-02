/* Ecko Tone panel for Photoshop (UXP). Halftones the selected layer with the built-in engine
   (tone-engine.js, the same one the web app uses), puts the result on a new layer at the same
   position and, optionally, a shirt-colour fill layer underneath. With Live on, later setting
   changes repaint that same layer (and recolour the shirt layer). No server, no network. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // Opened in a normal browser by mistake: say what this file is instead of showing a blank page.
  if (typeof require !== "function") {
    $("panel").style.display = "none";
    $("notPhotoshop").style.display = "block";
    return;
  }

  let ps, E;
  try {
    ps = require("photoshop");
    E = require("./tone-engine.js");
  } catch (e) {
    $("status").textContent = `Couldn't start: ${e.message || e}`;
    $("status").className = "err";
    return;
  }
  const { app, core, imaging, action, constants } = ps;
  const cat = E.CATALOG.api;
  const STORE = "ecko-tone-panel";

  // ---------------------------------------------------------------- helpers

  function status(msg, isErr) {
    $("status").textContent = msg;
    $("status").className = isErr ? "err" : "";
  }
  function fill(id, items, label = (x) => x.name, value = (x) => x.id) {
    const sel = $(id);
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    for (const x of items) {
      const opt = document.createElement("option");
      opt.value = value(x);
      opt.setAttribute("value", value(x));
      opt.setAttribute("data-v", value(x));
      opt.textContent = label(x);
      sel.appendChild(opt);
    }
  }
  // Panel sliders: set both property and attribute so thumb and number agree.
  function setSlider(id, v) { const el = $(id); el.setAttribute("value", String(v)); el.value = v; }
  const num = (id) => Number($(id).value);
  // Photoshop's panel engine doesn't always report <select>.value: read the chosen option by index.
  function sel(id) {
    const el = $(id);
    const i = el.selectedIndex >= 0 ? el.selectedIndex : 0;
    const opt = el.options[i];
    return opt ? (opt.getAttribute("data-v") || opt.getAttribute("value") || opt.value) : undefined;
  }
  function setSelect(id, v) {
    const el = $(id);
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if ((opt.getAttribute("data-v") || opt.value) === String(v)) { el.selectedIndex = i; return; }
    }
  }
  const show = (id, on) => { $(id).style.display = on ? "block" : "none"; };
  const isGrain = (style) => (cat.styles.find((s) => s.id === style) || {}).grain;

  // ---------------------------------------------------------------- folding sections (one open at a time)

  const sections = Array.from(document.querySelectorAll(".sec"));
  function markHead(sec, open) {
    const h = sec.querySelector(".head");
    h.textContent = (open ? "▾ " : "▸ ") + h.textContent.replace(/^[▸▾] /, "");
  }
  function toggleSection(sec) {   // each step folds on its own; all start open
    const body = sec.querySelector(".body"), open = body.style.display === "none";
    body.style.display = open ? "block" : "none";
    markHead(sec, open);
  }
  for (const s of sections) { s.querySelector(".body").style.display = "block"; markHead(s, true); s.querySelector(".head").addEventListener("click", () => toggleSection(s)); }

  // ---------------------------------------------------------------- labels + visibility

  function labels() {
    const t = (id, v) => { $(id).textContent = v; };
    t("brightnessOut", num("brightness").toFixed(2));
    t("contrastOut", num("contrast").toFixed(2));
    t("sharpenOut", num("sharpen").toFixed(1));
    t("denoiseOut", num("denoise") ? String(num("denoise")) : "off");
    t("smoothOut", num("smooth") ? `${num("smooth").toFixed(1)} mm` : "off");
    t("levelsOut", String(num("levels")));
    t("countOut", String(num("count")));
    t("lpiOut", String(Math.round(num("lpi"))));
    t("grainOut", `${num("grain").toFixed(2)} mm`);
    t("angleOut", `${num("angle")}°`);
    t("borderOut", `${Math.round(num("borderMm"))} mm`);
    const mode = sel("mode");
    show("levelsRow", mode === "threshold");
    show("countRow", mode === "spot" || mode === "index");
    show("paletteRow", mode === "spot" || mode === "index");
    show("lpiRow", !isGrain(sel("style")));
    show("grainRow", !!isGrain(sel("style")));
  }

  // ---------------------------------------------------------------- settings: preset, save, restore

  const FIELDS = { brightness: "brightness", contrast: "contrast", sharpen: "sharpen", denoise: "denoise", smooth: "smooth_mm",
    levels: "threshold_levels", count: "spot_colors", lpi: "lpi", grain: "grain_mm", angle: "angle", borderMm: "border_mm" };
  const SELECTS = { mode: "mode", palette: "palette", style: "style", garment: "garment", fit: "shirt_fit", underbase: "underbase",
    border: "border", borderShape: "border_shape", target: "target" };

  function applyOptions(o) {
    for (const [id, key] of Object.entries(FIELDS)) if (o[key] !== undefined) setSlider(id, o[key]);
    for (const [id, key] of Object.entries(SELECTS)) if (o[key] !== undefined) setSelect(id, o[key]);
    labels();
  }
  function applyPreset() {
    const p = cat.presets.find((x) => x.id === sel("preset"));
    if (!p) return;
    const keep = { garment: sel("garment"), shirt_fit: sel("fit"), border: sel("border"),
      border_shape: sel("borderShape"), border_mm: num("borderMm") };
    applyOptions({ ...cat.defaults, ...keep, ...p.options });
    save();
  }
  function save() {
    try {
      const s = { preset: sel("preset"), shirtLayer: $("shirtLayer").checked, live };
      for (const id of Object.keys(FIELDS)) s[id] = num(id);
      for (const id of Object.keys(SELECTS)) s[id] = sel(id);
      localStorage.setItem(STORE, JSON.stringify(s));
    } catch (e) { /* storage unavailable: settings just won't be remembered */ }
  }
  function restore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { s = null; }
    if (!s) { applyPreset(); return; }
    setSelect("preset", s.preset);
    for (const id of Object.keys(FIELDS)) if (s[id] !== undefined) setSlider(id, s[id]);
    for (const id of Object.keys(SELECTS)) if (s[id] !== undefined) setSelect(id, s[id]);
    $("shirtLayer").checked = s.shirtLayer !== false;
    setLive(s.live !== false);
    labels();
  }

  function options(doc, widthPx) {
    const p = cat.presets.find((x) => x.id === sel("preset"));
    const dpi = Math.round(Math.min(1200, Math.max(72, doc.resolution)));
    const o = { ...(p ? p.options : {}), dpi, width_in: Math.max(0.5, widthPx / dpi), text: [] };
    for (const [id, key] of Object.entries(FIELDS)) o[key] = num(id);
    for (const [id, key] of Object.entries(SELECTS)) { const v = sel(id); if (v) o[key] = v; }
    // Image textures need a file picker; the web app has them. Procedural textures work here.
    o.textures = (o.textures || []).filter((t) => t.type !== "image");
    if (o.mode !== "threshold") delete o.thresholds;
    return E.parseOptions(o);
  }

  // ---------------------------------------------------------------- apply

  async function addShirtLayer(resultLayer) {
    const [r, g, b] = E.hex(sel("garment"));
    await action.batchPlay([{
      _obj: "make",
      _target: [{ _ref: "contentLayer" }],
      using: { _obj: "contentLayer", name: "Ecko shirt colour",
        type: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: r, grain: g, blue: b } } },
    }], {});
    const fillLayer = app.activeDocument.activeLayers[0];
    if (fillLayer && resultLayer && fillLayer.id !== resultLayer.id) {
      await fillLayer.move(resultLayer, constants.ElementPlacement.PLACEAFTER);   // just below the result
    }
  }

  // One "session" per Apply: the source pixels are kept so Live updates only re-render and
  // repaint the same result layer (no re-reading the layer, no new layers).
  let live = true;
  function setLive(on) {
    live = !!on;
    const b = $("liveBtn");
    b.textContent = live ? "Live editing: ON · click to pause" : "Live editing: PAUSED · click to resume";
    b.className = `wide ${live ? "on" : "off"}`;
    if (!live) clearTimeout(liveTimer);
  }

  let session = null;   // {docId, srcId, bounds, rgba, w, h, opaque, resultId, shirtId, prepKey, prep, rect}
  let busy = false, pending = false, liveTimer = null;

  function findLayer(layers, id) {
    for (const l of layers || []) {
      if (l.id === id) return l;
      const inner = l.layers && findLayer(l.layers, id);
      if (inner) return inner;
    }
    return null;
  }

  async function readSource(doc, layer) {
    const got = await imaging.getPixels({ documentID: doc.id, layerID: layer.id, componentSize: 8, colorSpace: "RGB" });
    const { width, height, components } = got.imageData;
    const src = await got.imageData.getData({ chunky: true });
    const bounds = got.sourceBounds;
    got.imageData.dispose();
    let rgba = src;
    if (components === 3) {
      rgba = new Uint8Array(width * height * 4);
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        rgba[j] = src[i]; rgba[j + 1] = src[i + 1]; rgba[j + 2] = src[i + 2]; rgba[j + 3] = 255;
      }
    }
    let opaque = true;
    for (let k = 3; k < rgba.length; k += 4) if (rgba[k] !== 255) { opaque = false; break; }
    return { docId: doc.id, srcId: layer.id, bounds, rgba, w: width, h: height, opaque };
  }

  function render(doc, s) {   // -> {out, o, prep}; reuses the prepared picture when only look settings changed
    let o = options(doc, s.w);
    o.remove_background = o.remove_background && s.opaque;   // a layer with transparency is already cut out
    const key = E.prepareKey(o);
    if (!s.prep || s.prepKey !== key) { s.prep = null; s.prep = E.prepare(s.rgba, s.w, s.h, o, null); s.prepKey = key; }
    o = E.parseOptions({ ...o, width_in: Math.max(0.5, s.prep.crop[2] / o.dpi) });   // 1:1 with the layer's pixels
    return { out: E.renderFull(s.prep, o), o, prep: s.prep };
  }

  async function paint(doc, s, out) {
    const rect = { left: s.bounds.left + s.prep.crop[0], top: s.bounds.top + s.prep.crop[1], w: out.width, h: out.height };
    if (s.rect && (s.rect.w !== rect.w || s.rect.h !== rect.h || s.rect.left !== rect.left || s.rect.top !== rect.top)) {
      const clear = await imaging.createImageDataFromBuffer(new Uint8Array(s.rect.w * s.rect.h * 4), {   // wipe the old area
        width: s.rect.w, height: s.rect.h, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
      await imaging.putPixels({ documentID: doc.id, layerID: s.resultId, imageData: clear, targetBounds: { left: s.rect.left, top: s.rect.top } });
      clear.dispose();
    }
    const imageData = await imaging.createImageDataFromBuffer(new Uint8Array(out.rgba.buffer, out.rgba.byteOffset, out.rgba.byteLength), {
      width: out.width, height: out.height, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
    });
    await imaging.putPixels({ documentID: doc.id, layerID: s.resultId, imageData, targetBounds: { left: rect.left, top: rect.top } });
    imageData.dispose();
    s.rect = rect;
  }

  async function setShirtColour(s) {
    if (!s.shirtId || s.shirtHex === sel("garment")) return;
    s.shirtHex = sel("garment");
    const [r, g, b] = E.hex(s.shirtHex);
    await action.batchPlay([{
      _obj: "set",
      _target: [{ _ref: "contentLayer", _id: s.shirtId }],
      to: { _obj: "solidColorLayer", color: { _obj: "RGBColor", red: r, grain: g, blue: b } },
    }], {});
  }

  async function run() {
    const doc = app.activeDocument;
    if (!doc) return status("Open a document first.", true);
    const layer = doc.activeLayers[0];
    if (!layer) return status("Select a layer first.", true);
    if (busy) { pending = false; return status("Still working on the last change…"); }
    save();
    busy = true;
    status("Working… (big layers take a few seconds)");
    try {
      let notes = [];
      await core.executeAsModal(async () => {
        const s = await readSource(doc, layer);
        const { out, o, prep } = render(doc, s);
        const name = `Ecko Tone (${$("preset").options[$("preset").selectedIndex].textContent})`;
        const newLayer = await doc.createLayer({ name });
        s.resultId = newLayer.id;
        await paint(doc, s, out);
        if ($("shirtLayer").checked) {
          try {
            await addShirtLayer(newLayer);
            const fillLayer = app.activeDocument.activeLayers[0];
            if (fillLayer && fillLayer.id !== newLayer.id) { s.shirtId = fillLayer.id; s.shirtHex = sel("garment"); }
          } catch (e) { notes.push(`(Couldn't add the shirt-colour layer: ${e.message || e})`); }
        }
        notes = [...E.resolveFit(prep, o).notes, ...notes];
        session = s;
      }, { commandName: "Ecko Tone" });
      status([live ? "Done. Live is on: change any setting and this layer updates." : "Done. The result is on a new layer.", ...notes].join(" "));
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
    }
    if (pending) { pending = false; liveUpdate(); }
  }

  // Live: re-render into the same result layer after each change (coalesced while one is running).
  function scheduleLive(delay) {
    if (!session || !live) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(liveUpdate, delay);
  }

  async function liveUpdate() {
    const s = session;
    if (!s || !live) return;
    if (busy) { pending = true; return; }
    const doc = app.activeDocument;
    if (!doc || doc.id !== s.docId || !findLayer(doc.layers, s.resultId)) {
      session = null;
      return status("Live stopped: the result layer or document changed. Select a layer and Apply again.");
    }
    busy = true;
    status("Updating…");
    try {
      let notes = [];
      await core.executeAsModal(async () => {
        const { out, o, prep } = render(doc, s);
        await paint(doc, s, out);
        if (s.shirtId && findLayer(doc.layers, s.shirtId)) {
          try { await setShirtColour(s); } catch (e) { /* colour layer edited by hand: leave it */ }
        }
        notes = E.resolveFit(prep, o).notes;
      }, { commandName: "Ecko Tone live update" });
      status(["Updated live.", ...notes].join(" "));
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
    }
    if (pending) { pending = false; liveUpdate(); }
  }

  // ---------------------------------------------------------------- separations

  function film(bitmap, w, h, o) {   // same films as the web app: optional registration marks in a 0.5 in margin
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

  // 1-bit PNG writer (Photoshop panels have no canvas). Rows are packed 8 px per byte and stored
  // without compression: at 1 bit a film is still small, and this is exact and fast.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(parts) { let c = 0xFFFFFFFF; for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  function chunk(type, data) {
    const t = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
    return [new Uint8Array(be32(data.length)), t, data, new Uint8Array(be32(crc32([t, data])))];
  }
  function png1bit(bits, w, h, dpi) {   // bits: 1 = ink -> black
    const rowLen = Math.ceil(w / 8) + 1, raw = new Uint8Array(rowLen * h);
    for (let y = 0; y < h; y++) {
      const o = y * rowLen; raw[o] = 0;
      for (let x = 0; x < w; x++) if (!bits[y * w + x]) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);   // 1 = white
    }
    const blocks = [], MAX = 65535;
    let a = 1, b = 0;
    for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    blocks.push(new Uint8Array([0x78, 0x01]));
    for (let i = 0; i < raw.length; i += MAX) {
      const n = Math.min(MAX, raw.length - i), last = i + MAX >= raw.length ? 1 : 0;
      blocks.push(new Uint8Array([last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255]), raw.subarray(i, i + n));
    }
    blocks.push(new Uint8Array(be32(((b << 16) | a) >>> 0)));
    let len = 0; for (const x of blocks) len += x.length;
    const z = new Uint8Array(len); let off = 0; for (const x of blocks) { z.set(x, off); off += x.length; }
    const ihdr = new Uint8Array([...be32(w), ...be32(h), 1, 0, 0, 0, 0]);   // 1-bit greyscale
    const ppm = Math.round(dpi / 0.0254);
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", ihdr),
      ...chunk("pHYs", new Uint8Array([...be32(ppm), ...be32(ppm), 1])), ...chunk("IDAT", z), ...chunk("IEND", new Uint8Array(0))];
    let total = 0; for (const x of parts) total += x.length;
    const out = new Uint8Array(total); off = 0; for (const x of parts) { out.set(x, off); off += x.length; }
    return out;
  }
  const safeName = (t) => String(t || "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ecko-tone";

  async function separations(kind) {
    const doc = app.activeDocument;
    if (!doc) return status("Open a document first.", true);
    if (busy) return status("Still working on the last change… try again in a moment.");
    let folder = null;
    if (kind === "films") {
      try { folder = await require("uxp").storage.localFileSystem.getFolder(); }
      catch (e) { return status(`Couldn't open a folder picker: ${e.message || e}`, true); }
      if (!folder) return status("No folder chosen: nothing saved.");
    }
    // Use the layer from the last Apply (so it matches what you see); otherwise the selected layer.
    let s = session && session.docId === doc.id && findLayer(doc.layers, session.srcId) ? session : null;
    const layer = s ? null : doc.activeLayers[0];
    if (!s && !layer) return status("Select a layer first.", true);
    busy = true;
    status(kind === "films" ? "Making films…" : "Making separation layers…");
    try {
      let msg = "";
      await core.executeAsModal(async () => {
        if (!s) s = await readSource(doc, layer);
        let o = options(doc, s.w);
        o.remove_background = o.remove_background && s.opaque;
        const key = E.prepareKey(o);
        if (!s.prep || s.prepKey !== key) { s.prep = E.prepare(s.rgba, s.w, s.h, o, null); s.prepKey = key; }
        o = E.parseOptions({ ...o, width_in: Math.max(0.5, s.prep.crop[2] / o.dpi) });
        const r = E.renderFull(s.prep, o, null, true);
        const kept = r.plates.map((p, i) => [p, r.seps[i]]).filter(([p]) => p.on);
        if (!kept.length) throw new Error("Every ink is switched off: nothing to separate.");
        const left = s.bounds.left + s.prep.crop[0], top = s.bounds.top + s.prep.crop[1];
        if (kind === "layers") {
          let group = null;
          try { group = await doc.createLayerGroup({ name: `Ecko separations (${kept.length})` }); } catch (e) { group = null; }
          for (let i = 0; i < kept.length; i++) {
            const [p, sep] = kept[i], n = String(i + 1).padStart(2, "0");
            const lay = await doc.createLayer({ name: `${n} ${p.name} ${E.toHex(p.rgb)}` });
            const buf = new Uint8Array(r.width * r.height * 4);
            for (let k = 0; k < sep.length; k++) if (sep[k]) { buf[k * 4] = p.rgb[0]; buf[k * 4 + 1] = p.rgb[1]; buf[k * 4 + 2] = p.rgb[2]; buf[k * 4 + 3] = 255; }
            const img = await imaging.createImageDataFromBuffer(buf, { width: r.width, height: r.height, components: 4, chunky: true,
              colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
            await imaging.putPixels({ documentID: doc.id, layerID: lay.id, imageData: img, targetBounds: { left, top } });
            img.dispose();
            if (group) { try { await lay.move(group, constants.ElementPlacement.PLACEINSIDE); } catch (e) { /* stays loose */ } }
          }
          msg = `Done: ${kept.length} separation layer(s)${group ? " in the group \"Ecko separations\"" : ""}, first ink at the bottom.`;
        } else {
          const base = safeName((doc.title || doc.name || "ecko-tone").replace(/\.[^.]+$/, ""));
          const rep = E.report(s.prep, o, r.plates, r.seps);
          const lines = [`${base}: ${kept.length} separation(s)`, "",
            `Print size: ${rep.inches[0]} x ${rep.inches[1]} in (${rep.cm[0]} x ${rep.cm[1]} cm) at ${o.dpi} DPI`,
            `Screen: ${E.STYLES[o.style]}` + (E.GRAIN_STYLES.includes(o.style) ? `, grain ${o.grain_mm} mm` : `, ${o.lpi} LPI`), ""];
          for (let i = 0; i < kept.length; i++) {
            const [p, sep] = kept[i], f = film(sep, r.width, r.height, o), n = String(i + 1).padStart(2, "0");
            const file = await folder.createFile(`${base}-${n}-${p.name.replace(/[^A-Za-z0-9]/g, "-")}.png`, { overwrite: true });
            await file.write(png1bit(f.data, f.w, f.h, o.dpi), { format: require("uxp").storage.formats.binary });
            let on = 0; for (const v of sep) on += v;
            lines.push(`${n} ${p.name.padEnd(16)} ${E.toHex(p.rgb)}  angle ${(((p.angle % 180) + 180) % 180).toFixed(1).padStart(5)}  coverage ${(on / sep.length * 100).toFixed(1)}%`);
          }
          lines.push("", o.registration_marks ? "Films are black = ink, 1-bit, with registration marks in a 0.5 in margin." : "Films are black = ink, 1-bit.",
            "Print order: as numbered (light inks first).");
          const readme = await folder.createFile(`${base}-README.txt`, { overwrite: true });
          await readme.write(lines.join("\n") + "\n");
          msg = `Saved ${kept.length} film(s) + README to "${folder.name}".`;
        }
      }, { commandName: kind === "films" ? "Ecko Tone films" : "Ecko Tone separations" });
      status(msg);
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- fit the panel / full window

  // The settings live in a scrolling box with its own height, so a scroll bar always appears when they
  // don't fit. S / M / L picks the height (remembered); it never depends on Photoshop reporting sizes.
  const SIZES = { S: 240, M: 420, L: 640 };
  let boxSize = "M";
  function fitPanel() {
    const h = SIZES[boxSize] || SIZES.S;
    const steps = $("steps");
    steps.style.height = `${h}px`;
    steps.style.overflowY = "scroll";
    for (const k of Object.keys(SIZES)) {
      const b = $(`size${k}`);
      if (b) b.style.fontWeight = k === boxSize ? "bold" : "normal";
    }
  }
  function setSize(k) {
    boxSize = k;
    try { localStorage.setItem(`${STORE}-size`, k); } catch (e) { /* ignore */ }
    fitPanel();
  }

  // ---------------------------------------------------------------- start

  try {
    fill("preset", cat.presets);
    fill("mode", cat.modes);
    fill("palette", [{ id: "image", name: "From the picture" }, ...cat.palettes]);
    fill("style", cat.styles);
    fill("garment", cat.garments, (g) => g.name, (g) => g.hex);
    fill("fit", cat.shirt_fits);
    fill("border", cat.borders);
    fill("borderShape", cat.border_shapes);
    fill("target", cat.targets);
    for (const id of Object.keys(FIELDS)) {
      $(id).addEventListener("input", () => { labels(); scheduleLive(350); });   // while dragging
      $(id).addEventListener("change", () => { labels(); save(); scheduleLive(80); });
    }
    for (const id of Object.keys(SELECTS)) $(id).addEventListener("change", () => { labels(); save(); scheduleLive(50); });
    $("shirtLayer").addEventListener("change", save);
    $("preset").addEventListener("change", () => { applyPreset(); scheduleLive(50); });
    $("liveBtn").addEventListener("click", () => {
      setLive(!live); save();
      if (live) { status(session ? "Live editing on: catching up with your changes…" : "Live editing on. Click Apply once to start."); scheduleLive(50); }
      else status("Live editing paused. Change settings freely, then click the button again (or Apply) to update.");
    });
    for (const id of ["sepLayers", "sepLayers2"]) $(id).addEventListener("click", () => separations("layers"));
    for (const id of ["saveFilms", "saveFilms2"]) $(id).addEventListener("click", () => separations("films"));
    $("run").addEventListener("click", run);
    try { boxSize = localStorage.getItem(`${STORE}-size`) || "S"; } catch (e) { boxSize = "S"; }
    for (const k of Object.keys(SIZES)) $(`size${k}`).addEventListener("click", () => setSize(k));
    fitPanel();
    $("reset").addEventListener("click", () => {
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      $("preset").selectedIndex = 0;
      applyPreset();
      scheduleLive(50);
      status("Settings reset.");
    });
    restore();
  } catch (e) {
    status(`Couldn't start: ${e.message || e}`, true);
  }
})();
