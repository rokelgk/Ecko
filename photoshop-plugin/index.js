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
      const s = { preset: sel("preset"), shirtLayer: $("shirtLayer").checked, live: $("live").checked };
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
    $("live").checked = s.live !== false;
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
      status([$("live").checked ? "Done. Live is on: change any setting and this layer updates." : "Done. The result is on a new layer.", ...notes].join(" "));
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
    }
    if (pending) { pending = false; liveUpdate(); }
  }

  // Live: re-render into the same result layer after each change (coalesced while one is running).
  function scheduleLive(delay) {
    if (!session || !$("live").checked) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(liveUpdate, delay);
  }

  async function liveUpdate() {
    const s = session;
    if (!s || !$("live").checked) return;
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
    $("live").addEventListener("change", () => { save(); if ($("live").checked) scheduleLive(50); });
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
