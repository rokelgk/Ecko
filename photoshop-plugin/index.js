/* Ecko Tone panel for Photoshop (UXP). The same engine and the same settings as the web app
   (tone-engine.js is shared): it halftones the selected layer onto a new layer at the same position,
   optionally with a shirt-colour fill layer underneath. With Live on, every later change repaints that
   same layer. Separations go out as layers or as 1-bit films named after each ink. No server, no network. */
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
    try { E.registerScans(require("./tone-scans.js")); } catch (e) { /* scans missing: those textures are skipped */ }
  } catch (e) {
    $("status").textContent = `Couldn't start: ${e.message || e}`;
    $("status").className = "err";
    return;
  }
  const { app, core, imaging, action, constants } = ps;
  const cat = E.CATALOG.api;
  const STORE = "ecko-tone-panel-v2";
  const clone = (x) => JSON.parse(JSON.stringify(x));

  // ---------------------------------------------------------------- state (same option names as the web app)

  let opts = clone(cat.defaults);
  let presetId = (cat.presets[0] || {}).id;
  let tex = {};             // texture type -> {on, strength, scale}; "image" = a layer of this document
  let texLayerId = null;
  let spotInks = null;      // spot mode: your own colour for each spot ink
  let solo = null;          // plate name shown alone on the result layer
  let lastReport = null, autoCuts = [], lastPalette = null;

  // ---------------------------------------------------------------- helpers

  function status(msg, isErr) {
    $("status").textContent = msg;
    $("status").className = isErr ? "err" : "";
  }
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function fill(el, items, label = (x) => x.name, value = (x) => x.id) {
    while (el.firstChild) el.removeChild(el.firstChild);
    for (const x of items) {
      const opt = document.createElement("option");
      opt.value = value(x);
      opt.setAttribute("value", value(x));
      opt.setAttribute("data-v", value(x));
      opt.textContent = label(x);
      el.appendChild(opt);
    }
  }
  // Photoshop's panel engine doesn't always report <select>.value: read the chosen option by index.
  function selVal(el) {
    const i = el.selectedIndex >= 0 ? el.selectedIndex : 0;
    const opt = el.options[i];
    return opt ? (opt.getAttribute("data-v") || opt.getAttribute("value") || opt.value) : undefined;
  }
  function setSel(el, v) {
    for (let i = 0; i < el.options.length; i++) {
      const opt = el.options[i];
      if ((opt.getAttribute("data-v") || opt.value) === String(v)) { el.selectedIndex = i; return; }
    }
  }
  function setRange(el, v) { el.setAttribute("value", String(v)); el.value = v; }
  const show = (id, on) => { $(id).style.display = on ? "block" : "none"; };
  const isGrain = (style) => !!(cat.styles.find((s) => s.id === style) || {}).grain;
  const fmt = (v, d = 2) => { const t = Number(v).toFixed(d); return t.includes(".") ? t.replace(/\.?0+$/, "") : t; };
  const validHex = (v) => { const m = String(v).trim().match(/^#?([0-9a-fA-F]{6})$/); return m ? `#${m[1].toLowerCase()}` : null; };

  // A colour field Photoshop panels can show (no colour picker there): swatch + hex text.
  function colourRow(tag, hexv, onSet) {
    const row = document.createElement("div");
    row.className = "colourRow";
    row.innerHTML = `${tag ? `<span class="tag">${esc(tag)}</span>` : ""}<span class="sw" style="background-color:${hexv}"></span><input type="text" maxlength="7" value="${hexv}">`;
    const inp = row.querySelector("input"), sw = row.querySelector(".sw");
    inp.addEventListener("change", () => {
      const h = validHex(inp.value);
      if (!h) { inp.value = hexv; return status("Colours are 6-digit hex, like #c8102e.", true); }
      inp.value = h; sw.style.backgroundColor = h; onSet(h);
    });
    return row;
  }

  // ---------------------------------------------------------------- folding sections

  const sections = Array.from(document.querySelectorAll(".sec"));
  function markHead(sec, open) {
    const h = sec.querySelector(".head");
    h.textContent = (open ? "▾ " : "▸ ") + h.textContent.replace(/^[▸▾] /, "");
  }
  // Fold-out boards: one open at a time, so the panel never gets long. The first (Look) starts open.
  function openSection(sec, open) {
    sec.querySelector(".body").style.display = open ? "block" : "none";
    markHead(sec, open);
  }
  sections.forEach((s, i) => {
    openSection(s, i === 0);
    s.querySelector(".head").addEventListener("click", () => {
      const open = s.querySelector(".body").style.display === "none";
      for (const o of sections) if (o !== s) openSection(o, false);
      openSection(s, open);
      if (open) $("steps").scrollTop = s.offsetTop - $("steps").offsetTop;
    });
  });

  // ---------------------------------------------------------------- bound controls (data-k = option name)

  const bound = Array.from(document.querySelectorAll("[data-k]"));
  for (const el of bound) {   // a value read-out next to every slider's title
    if (el.type !== "range") continue;
    const title = el.parentNode.querySelector(".title");
    const out = document.createElement("span");
    out.className = "value";
    title.appendChild(out);
    el._out = out;
  }
  function readChoice(el, ev) {   // the chosen option, preferring what the change event itself carries
    if (el.tagName !== "SELECT") return readEl(el);
    const t = ev && ev.target;
    const v = t && typeof t.value === "string" && t.value ? t.value : null;
    if (v && Array.from(el.options).some((o) => (o.getAttribute("data-v") || o.value) === v)) return v;
    return readEl(el);
  }
  function readEl(el) {
    if (el.tagName === "SELECT") return selVal(el);
    if (el.type === "checkbox") return !!el.checked;
    return Number(el.value);
  }
  function label(el) {
    const v = Number(el.value), f = el.getAttribute("data-fmt"), unit = el.getAttribute("data-unit") || "";
    if (f === "off") return v ? String(v) : "off";
    if (f === "offmm") return v ? `${fmt(v)} mm` : "off";
    if (f === "solid") return v ? fmt(v) : "solid";
    if (f === "pct") return v ? `${fmt(v * 100, 1)}% of width` : "off";
    if (f === "pct100") return `${Math.round(v * 100)}%`;
    return `${fmt(v)}${unit}`;
  }

  function syncUI() {   // state -> controls
    for (const el of bound) {
      const k = el.getAttribute("data-k"), v = opts[k];
      if (v === undefined) continue;
      if (el.tagName === "SELECT") setSel(el, v);
      else if (el.type === "checkbox") el.checked = !!v;
      else setRange(el, v);
    }
    setSel($("preset"), presetId);
    syncGarment();
    syncOutline();
    buildInkColours();
    buildCuts();
    buildTextures();
    labels();
  }

  function labels() {
    for (const el of bound) if (el._out) el._out.textContent = label(el);
    const m = opts.mode, thr = m === "threshold", grain = isGrain(opts.style);
    show("amRow", !grain);
    show("grainRow", grain);
    show("thresholdBox", thr);
    show("spotBox", m === "spot" || m === "index");
    show("softRow", m !== "index");
    show("paletteRow", m === "spot" || m === "index" || (thr && opts.threshold_colors === "palette"));
    show("inksBox", m === "mono" || m === "duotone" || (thr && opts.threshold_colors === "ink"));
    show("spotHint", m === "spot");
    show("borderOpts", opts.border !== "none");
    show("bgTolRow", !!opts.remove_background);
  }

  function changed(key, delay) {
    if (key === "mode") { opts.ink_edits = {}; opts.thresholds = []; spotInks = null; solo = null; buildInkColours(); }
    if (key === "spot_colors" || key === "palette") spotInks = null;
    if (key === "threshold_levels") opts.thresholds = [];
    if (key === "mode" || key === "threshold_levels") buildCuts();
    labels();
    save();
    scheduleLive(delay);
  }

  for (const el of bound) {
    const k = el.getAttribute("data-k");
    if (el.tagName === "SELECT" || el.type === "checkbox") {
      el.addEventListener("change", (ev) => {
        opts[k] = readChoice(el, ev);
        changed(k, 50);
        for (const ms of [60, 250]) {   // Photoshop can report the previous choice for a moment: check again
          setTimeout(() => { const v = readEl(el); if (v !== undefined && v !== opts[k]) { opts[k] = v; changed(k, 30); } }, ms);
        }
      });
    } else {
      el.addEventListener("input", () => { opts[k] = readEl(el); if (el._out) el._out.textContent = label(el); changed(k, 350); });
      el.addEventListener("change", () => { opts[k] = readEl(el); changed(k, 80); });
    }
  }

  // ---------------------------------------------------------------- ink colours (mono / duotone / threshold)

  function buildInkColours() {
    const box = $("inkColours");
    while (box.firstChild) box.removeChild(box.firstChild);
    const n = opts.mode === "duotone" ? 2 : 1;
    while (opts.inks.length < n) opts.inks.push(opts.inks.length ? "#e94e77" : "#1d1d1f");
    for (let i = 0; i < n; i++) {
      box.appendChild(colourRow(n === 2 ? (i ? "Second ink" : "Shadow ink") : "Ink", opts.inks[i], (h) => {
        opts.inks[i] = h; save(); scheduleLive(50);
      }));
    }
  }

  // ---------------------------------------------------------------- threshold cut points

  function currentCuts() {
    const n = opts.threshold_levels - 1;
    if (opts.thresholds.length === n) return opts.thresholds;
    if (autoCuts.length === n) return autoCuts;
    return Array.from({ length: n }, (_, i) => Math.round((i + 1) / (n + 1) * 100) / 100);
  }
  function buildCuts() {
    const box = $("cuts");
    while (box.firstChild) box.removeChild(box.firstChild);
    if (opts.mode !== "threshold") return;
    const cuts = currentCuts(), manual = opts.thresholds.length === cuts.length;
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = manual ? "Your cut points (Auto levels to reset)" : "Cut points: automatic from your picture";
    box.appendChild(hint);
    cuts.forEach((c, i) => {
      const f = document.createElement("div");
      f.className = "field";
      f.innerHTML = `<div class="title">Cut ${i + 1}<span class="value">${Math.round(c * 100)}%</span></div><input type="range" min="0.02" max="0.98" step="0.01" value="${c}">`;
      const inp = f.querySelector("input"), out = f.querySelector(".value");
      const set = (delay) => {
        const next = currentCuts().slice();
        next[i] = Number(inp.value);
        out.textContent = `${Math.round(next[i] * 100)}%`;
        opts.thresholds = next.slice().sort((a, b) => a - b);
        hint.textContent = "Your cut points (Auto levels to reset)";
        save(); scheduleLive(delay);
      };
      inp.addEventListener("input", () => set(350));
      inp.addEventListener("change", () => set(80));
      box.appendChild(f);
    });
  }

  // ---------------------------------------------------------------- textures

  // Textures work like a pattern overlay: pick one from the dropdown, then set strength, size and
  // rotation on its card. Pick again to stack another; Remove takes one off.
  function textureName(id) {
    if (id === "image") return "Your texture layer";
    const t = cat.textures.find((x) => x.id === id);
    const n = t ? t.name.replace(/^Scan: /, "") : id;
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  const canRotate = (id) => id === "image" || !!(cat.textures.find((x) => x.id === id) || {}).scan;

  function buildTexturePicker() {
    const sel = $("texAdd");
    while (sel.firstChild) sel.removeChild(sel.firstChild);
    const add = (v, label, disabled) => {
      const o = document.createElement("option");
      o.setAttribute("value", v); o.setAttribute("data-v", v); o.value = v; o.textContent = label;
      if (disabled) o.disabled = true;
      sel.appendChild(o);
    };
    add("", "Choose a texture…");
    add("-", "── Scanned from real worn prints ──", true);
    for (const t of cat.textures.filter((x) => x.scan)) add(t.id, textureName(t.id) + (tex[t.id] && tex[t.id].on ? "  (applied)" : ""));
    add("-", "── Generated wear ──", true);
    for (const t of cat.textures.filter((x) => !x.scan && x.id !== "image")) add(t.id, textureName(t.id) + (tex[t.id] && tex[t.id].on ? "  (applied)" : ""));
    sel.selectedIndex = 0;
  }

  function buildTextures() {
    buildTexturePicker();
    const box = $("textures");
    while (box.firstChild) box.removeChild(box.firstChild);
    const applied = Object.entries(tex).filter(([id, t]) => t.on && (id !== "image" || texLayerId));
    $("texEmpty").style.display = applied.length ? "none" : "block";
    for (const [id, st] of applied) {
      const el = document.createElement("div");
      el.className = "ink";
      el.innerHTML = `<div class="inkTop"><span class="nm">${esc(textureName(id))}</span><button class="rm">Remove</button></div>
        <div class="field"><div class="title">Strength<span class="value">${Math.round(st.strength * 100)}%</span></div><input type="range" min="0" max="1" step="0.02" value="${st.strength}" data-t="strength"></div>
        <div class="field"><div class="title">Size<span class="value">${fmt(st.scale)}×</span></div><input type="range" min="0.25" max="4" step="0.05" value="${st.scale}" data-t="scale"></div>
        ${canRotate(id) ? `<div class="field"><div class="title">Rotation<span class="value">${Math.round(st.rotate || 0)}°</span></div><input type="range" min="0" max="360" step="1" value="${st.rotate || 0}" data-t="rotate"></div>` : ""}`;
      el.querySelector(".rm").addEventListener("click", () => {
        st.on = false;
        if (id === "image") { texLayerId = null; setSel($("texLayer"), ""); }
        setTimeout(buildTextures, 0); save(); scheduleLive(50);
      });
      for (const inp of el.querySelectorAll("input[type=range]")) {
        const k = inp.getAttribute("data-t"), out = inp.parentNode.querySelector(".value");
        const show = () => { out.textContent = k === "strength" ? `${Math.round(st[k] * 100)}%` : k === "scale" ? `${fmt(st[k])}×` : `${Math.round(st[k])}°`; };
        inp.addEventListener("input", () => { st[k] = Number(inp.value); show(); save(); scheduleLive(350); });
        inp.addEventListener("change", () => { st[k] = Number(inp.value); show(); save(); scheduleLive(80); });
      }
      box.appendChild(el);
    }
  }

  function addTexture(id) {
    if (!id || id === "-") return;
    const old = tex[id] || { strength: 0.5, scale: 1, rotate: 0 };
    delete tex[id];   // re-adding puts it at the end of the stack
    tex[id] = { ...old, on: true };
    buildTextures(); save(); scheduleLive(50);
  }

  function allLayers(layers, depth = 0, out = []) {
    for (const l of layers || []) {
      if (l.layers) allLayers(l.layers, depth + 1, out);   // groups: list what's inside
      else out.push({ id: String(l.id), name: `${"  ".repeat(depth)}${l.name}` });
    }
    return out;
  }
  function fillTexLayers() {
    const doc = app.activeDocument;
    const items = [{ id: "", name: "None" }, ...(doc ? allLayers(doc.layers) : [])];
    fill($("texLayer"), items);
    if (texLayerId && !items.some((x) => x.id === texLayerId)) texLayerId = null;
    setSel($("texLayer"), texLayerId || "");
  }
  const texCache = new Map();   // layer id -> {data, w, h}
  async function texLayerImage(doc) {
    if (!texLayerId || !(tex.image && tex.image.on)) return null;
    if (texCache.has(texLayerId)) return texCache.get(texLayerId);
    const got = await imaging.getPixels({ documentID: doc.id, layerID: Number(texLayerId), componentSize: 8, colorSpace: "RGB" });
    const { width, height, components } = got.imageData;
    const px = await got.imageData.getData({ chunky: true });
    got.imageData.dispose();
    const data = new Float32Array(width * height);
    for (let p = 0; p < width * height; p++) {   // same as the web app: dark = wear, transparent = no wear
      const k = p * components, a = components === 4 ? px[k + 3] / 255 : 1;
      const l = (px[k] * 0.299 + px[k + 1] * 0.587 + px[k + 2] * 0.114) / 255;
      data[p] = l * a + (1 - a);
    }
    const img = { data, w: width, h: height };
    texCache.clear();
    texCache.set(texLayerId, img);
    return img;
  }

  // ---------------------------------------------------------------- shirt colour

  function syncGarment() {
    const h = validHex(opts.garment) || "#ffffff";
    $("garmentHex").value = h;
    $("garmentSw").style.backgroundColor = h;
    const match = cat.garments.find((g) => g.hex.toLowerCase() === h);
    setSel($("garmentSel"), match ? match.hex : "custom");
  }
  function syncOutline() {
    const auto = opts.outline_color === "auto";
    setSel($("outlineMode"), auto ? "auto" : "custom");
    if (!auto) $("outlineHex").value = opts.outline_color;
    $("outlineSw").style.backgroundColor = auto ? E.toHex(E.contrastInk(E.hex(opts.garment))) : opts.outline_color;
    $("outlineRow").style.display = auto ? "none" : "flex";
  }
  function setGarment(h) { opts.garment = h; syncGarment(); syncOutline(); save(); scheduleLive(50); }

  // ---------------------------------------------------------------- presets, save, restore

  function applyPreset(id) {
    const p = cat.presets.find((x) => x.id === id);
    if (!p) return;
    const keep = { remove_background: opts.remove_background, bg_tolerance: opts.bg_tolerance, seed: opts.seed,
      border: opts.border, border_mm: opts.border_mm, border_shape: opts.border_shape,
      shirt_fit: opts.shirt_fit, underbase: opts.underbase, choke_mm: opts.choke_mm, garment: opts.garment };
    opts = { ...clone(cat.defaults), ...keep, ...clone(p.options) };
    if (!p.options.garment) opts.garment = keep.garment;
    presetId = p.id;
    for (const k of Object.keys(tex)) if (k !== "image") tex[k].on = false;
    for (const t of p.options.textures || []) delete tex[t.type];   // keep the preset's order
    for (const t of p.options.textures || []) tex[t.type] = { on: true, strength: t.strength, scale: t.scale, rotate: t.rotate || 0 };
    spotInks = null; solo = null; autoCuts = [];
    syncUI();
    save();
    scheduleLive(50);
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ opts, presetId, tex, texLayerId, spotInks,
        shirtLayer: $("shirtLayer").checked, live }));
    } catch (e) { /* storage unavailable: settings just won't be remembered */ }
  }
  function restore() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE) || "null"); } catch (e) { s = null; }
    if (!s) { applyPreset(presetId); return; }
    opts = { ...clone(cat.defaults), ...(s.opts || {}) };
    try { E.parseOptions({ ...opts, text: [] }); } catch (e) { opts = clone(cat.defaults); }   // stored by an older version
    presetId = s.presetId || presetId;
    tex = s.tex || {};
    texLayerId = s.texLayerId || null;
    fillTexLayers();
    spotInks = Array.isArray(s.spotInks) ? s.spotInks : null;
    $("shirtLayer").checked = s.shirtLayer !== false;
    setLive(s.live !== false);
    syncUI();
  }

  // Options for the engine: everything above, plus size from the layer and DPI from the document.
  function options(doc, widthPx, forView) {
    const dpi = Math.round(Math.min(1200, Math.max(72, doc.resolution)));
    const o = clone(opts);
    o.dpi = dpi;
    o.width_in = Math.min(60, Math.max(0.5, widthPx / dpi));
    o.text = [];
    o.textures = Object.entries(tex).filter(([type, t]) => t.on && (type !== "image" || texLayerId))
      .map(([type, t]) => ({ type, strength: t.strength, scale: t.scale, rotate: t.rotate || 0, image_id: type === "image" ? `layer-${texLayerId}` : null }));
    if (o.mode === "spot") o.inks = spotInks && spotInks.length === o.spot_colors ? spotInks.slice() : ["#000000"];
    if (o.mode === "mono") o.inks = [o.inks[0]];
    if (o.mode === "duotone") o.inks = [o.inks[0], o.inks[1] || "#e94e77"];
    if (o.mode === "cmyk") o.inks = ["#000000"];
    if (o.mode !== "threshold") o.thresholds = [];
    if (forView && solo) {   // the result layer shows a soloed ink alone; files never do
      o.ink_edits = clone(o.ink_edits);
      for (const p of lastReport ? lastReport.inks : []) {
        o.ink_edits[p.name] = { ...(o.ink_edits[p.name] || { choke_mm: 0 }), on: p.name === solo };
      }
    }
    return E.parseOptions(o);
  }

  // ---------------------------------------------------------------- Inks list + print check (after each render)

  function edit(name) { return (opts.ink_edits[name] = opts.ink_edits[name] || { on: true, choke_mm: 0 }); }
  function chokeLabel(v) {
    v = Number(v) || 0;
    if (Math.abs(v) < 0.005) return "none";
    return v > 0 ? `choke ${fmt(v)} mm` : `spread ${fmt(-v)} mm`;
  }
  function syncUIValue(k) {
    for (const el of bound) if (el.getAttribute("data-k") === k) { setRange(el, opts[k]); if (el._out) el._out.textContent = label(el); }
  }

  function buildInkList() {
    const box = $("inkList");
    while (box.firstChild) box.removeChild(box.firstChild);
    box.className = "";
    if (!lastReport) { box.className = "hint"; box.textContent = "Apply once to see each ink here."; return; }
    if (solo && !lastReport.inks.some((i) => i.name === solo)) solo = null;
    for (const ink of lastReport.inks) {
      const e = opts.ink_edits[ink.name], on = !(e && e.on === false);
      const el = document.createElement("div");
      el.className = `ink${on ? "" : " off"}${solo === ink.name ? " solo" : ""}`;
      const chokeVal = ink.underbase ? opts.choke_mm : (ink.choke_mm || 0);
      el.innerHTML = `<div class="inkTop"><span class="sw" style="background-color:${ink.hex}"></span>
          <span class="nm">${esc(ink.label || ink.name)}</span>
          <button class="eye">${on ? "Printing" : "Off"}</button><button class="soloB">${solo === ink.name ? "Show all" : "Solo"}</button></div>
        <div class="small">${ink.underbase ? "White base under the colours" : `${ink.hex} · ${ink.angle}°`} · ${ink.coverage}% coverage</div>
        <div class="field"><div class="title">Ink name</div><input type="text" class="nameIn" maxlength="40" value="${esc((e && e.name) || "")}" placeholder="${esc(ink.label || ink.name)}"></div>
        <div class="colourSlot"></div>
        <div class="field"><div class="title">${ink.underbase ? "Underbase size (choke)" : "Spread ← → Choke"}<span class="value">${chokeLabel(chokeVal)}</span></div>
          <input type="range" class="chokeIn" min="${ink.underbase ? 0 : -0.3}" max="${ink.underbase ? 0.5 : 0.3}" step="0.01" value="${chokeVal}"></div>`;
      el.querySelector(".eye").addEventListener("click", () => { edit(ink.name).on = !on; save(); later(buildInkList); scheduleLive(50); });
      el.querySelector(".soloB").addEventListener("click", () => { solo = solo === ink.name ? null : ink.name; later(buildInkList); scheduleLive(50); });
      const nameIn = el.querySelector(".nameIn");
      nameIn.addEventListener("change", () => {   // your own ink name: on films, layers and in the README
        const v = nameIn.value.trim();
        if (v) edit(ink.name).name = v; else if (opts.ink_edits[ink.name]) delete opts.ink_edits[ink.name].name;
        save(); scheduleLive(50);
      });
      const ch = el.querySelector(".chokeIn"), chOut = ch.parentNode.querySelector(".value");
      const setChoke = (delay) => {
        const v = Number(ch.value);
        chOut.textContent = chokeLabel(v);
        if (ink.underbase) { opts.choke_mm = v; syncUIValue("choke_mm"); } else edit(ink.name).choke_mm = v;
        save(); scheduleLive(delay);
      };
      ch.addEventListener("input", () => setChoke(350));
      ch.addEventListener("change", () => setChoke(80));
      if (opts.mode === "spot" && !ink.underbase && lastPalette) {   // spot inks: your own colour for each one
        const n = parseInt(ink.name.replace(/\D+/g, ""), 10) - 1;
        if (n >= 0 && n < lastPalette.length) {
          el.querySelector(".colourSlot").appendChild(colourRow("Colour", ink.hex, (h) => {
            spotInks = (spotInks && spotInks.length === lastPalette.length ? spotInks : lastPalette).slice();
            spotInks[n] = h; save(); scheduleLive(50);
          }));
        }
      }
      box.appendChild(el);
    }
    buildCheck();
  }
  const later = (fn) => setTimeout(fn, 0);   // rebuild after the click handler finishes

  function buildCheck() {
    const box = $("check"), r = lastReport;
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!r) { box.textContent = "Apply once to check the print."; return; }
    const lines = [`Print size: ${r.inches[0]} × ${r.inches[1]} in (${r.cm[0]} × ${r.cm[1]} cm)`,
      `Pixels: ${r.pixels[0]} × ${r.pixels[1]} @ ${r.dpi} DPI`, `Ink area: ${r.ink_area_pct}%`];
    if (r.tone_levels) lines.push(`Tone levels: ${r.tone_levels}`);
    if (r.smallest_dot_mm) lines.push(`Smallest dot: ${r.smallest_dot_mm} mm`);
    for (const t of lines) { const d = document.createElement("div"); d.textContent = t; box.appendChild(d); }
    const items = r.warnings.length ? r.warnings : [{ level: "ok", text: "Looks printable. Transparency is pure on/off." }];
    for (const w of items) {
      const d = document.createElement("div");
      d.className = w.level === "ok" ? "ok" : "warn";
      d.style.marginTop = "4px";
      d.textContent = w.text;
      const fix = w.fix && Object.fromEntries(Object.entries(w.fix).filter(([k]) => k in opts && k !== "width_in" && k !== "dpi"));
      if (fix && Object.keys(fix).length) {
        const b = document.createElement("span");
        b.className = "link";
        b.textContent = " Fix it";
        b.addEventListener("click", () => { Object.assign(opts, fix); syncUI(); save(); scheduleLive(50); });
        d.appendChild(b);
      }
      box.appendChild(d);
    }
  }

  // ---------------------------------------------------------------- render + paint

  // One "session" per Apply: the source pixels are kept so Live updates only re-render and
  // repaint the same result layer (no re-reading the layer, no new layers).
  let session = null;   // {docId, srcId, bounds, rgba, w, h, opaque, resultId, shirtId, prepKey, prep, rect}
  let busy = false, pending = false, liveTimer = null;
  let gen = 0, retries = 0;   // gen counts setting changes: a render that started before the latest change runs again

  let live = true;
  function setLive(on) {
    live = !!on;
    const b = $("liveBtn");
    b.textContent = live ? "Live editing: ON · click to pause" : "Live editing: PAUSED · click to resume";
    b.className = `wide ${live ? "on" : "off"}`;
    if (!live) clearTimeout(liveTimer);
  }

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

  function pullFromControls() {
    for (const el of bound) {
      if (el.tagName === "SELECT" && !el.options.length) continue;
      const v = readEl(el), k = el.getAttribute("data-k");
      if (v !== undefined && !(typeof v === "number" && !Number.isFinite(v))) opts[k] = v;
    }
  }

  // -> {r, o, prep}; reuses the prepared picture when only look settings changed.
  async function render(doc, s, forView) {
    pullFromControls();
    let o = options(doc, s.w, forView);
    o.remove_background = o.remove_background && s.opaque;   // a layer with transparency is already cut out
    const key = E.prepareKey(o);
    if (!s.prep || s.prepKey !== key) { s.prep = null; s.prep = E.prepare(s.rgba, s.w, s.h, o, null); s.prepKey = key; }
    o = E.parseOptions({ ...o, width_in: Math.max(0.5, s.prep.crop[2] / o.dpi) });   // 1:1 with the layer's pixels
    const texImgs = {};
    const ti = await texLayerImage(doc);
    if (ti) texImgs[`layer-${texLayerId}`] = ti;
    const r = E.renderFull(s.prep, o, texImgs, true);
    return { r, o, prep: s.prep };
  }

  function afterRender(s, r, o) {   // inks list, print check and threshold cut points from this render
    lastReport = E.report(s.prep, o, r.plates, r.seps);
    for (const ink of lastReport.inks) { const e = opts.ink_edits[ink.name]; ink.on = !(e && e.on === false); }   // as in the files, not the solo view
    lastPalette = s.prep.palette ? s.prep.palette.map((c) => E.toHex(c)) : null;
    if (opts.mode === "threshold") {
      const was = autoCuts.join();
      autoCuts = E.thresholdCuts(s.prep, { ...o, thresholds: [] });
      if (opts.thresholds.length !== autoCuts.length && was !== autoCuts.join()) buildCuts();
    }
    r.seps = null;
    buildInkList();
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

  async function addShirtLayer(resultLayer) {
    const [r, g, b] = E.hex(opts.garment);
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

  async function setShirtColour(s) {
    if (!s.shirtId || s.shirtHex === opts.garment) return;
    s.shirtHex = opts.garment;
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
    if (busy) return status("Still working on the last change… click Apply again in a moment.");
    save();
    busy = true;
    status("Working… (big layers take a few seconds)");
    try {
      let notes = [];
      await core.executeAsModal(async () => {
        const s = await readSource(doc, layer);
        const { r, o, prep } = await render(doc, s, true);
        const presetName = $("preset").options[$("preset").selectedIndex].textContent;
        const newLayer = await doc.createLayer({ name: `Ecko Tone (${presetName})` });
        s.resultId = newLayer.id;
        await paint(doc, s, r);
        if ($("shirtLayer").checked) {
          try {
            await addShirtLayer(newLayer);
            const fillLayer = app.activeDocument.activeLayers[0];
            if (fillLayer && fillLayer.id !== newLayer.id) { s.shirtId = fillLayer.id; s.shirtHex = opts.garment; }
          } catch (e) { notes.push(`(Couldn't add the shirt-colour layer: ${e.message || e})`); }
        }
        notes = [...E.resolveFit(prep, o).notes, ...notes];
        session = s;
        afterRender(s, r, o);
      }, { commandName: "Ecko Tone" });
      fillTexLayers();
      status([live ? "Done. Live is on: change any setting and this layer updates." : "Done. The result is on a new layer.", ...notes].join(" "));
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
    }
    if (pending) { pending = false; liveUpdate(); }
  }

  // Live: re-render into the same result layer after each change (coalesced while one is running).
  function scheduleLive(delay = 80) {
    gen++;
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
    const startGen = gen;
    let failed = null;
    status("Updating…");
    try {
      let notes = [];
      await core.executeAsModal(async () => {
        const { r, o, prep } = await render(doc, s, true);
        await paint(doc, s, r);
        if (s.shirtId && findLayer(doc.layers, s.shirtId)) {
          try { await setShirtColour(s); } catch (e) { /* colour layer edited by hand: leave it */ }
        }
        notes = E.resolveFit(prep, o).notes;
        afterRender(s, r, o);
      }, { commandName: "Ecko Tone live update" });
      retries = 0;
      status([solo ? "Updated live (showing one ink: click Show all to see every ink)." : "Updated live.", ...notes].join(" "));
    } catch (e) {
      failed = e;
    } finally {
      busy = false;
    }
    if (failed) {
      // Photoshop refuses while it is busy (a menu closing, a tool in use): try again shortly, so the
      // change isn't lost. Real errors (bad settings) are shown after a few tries.
      const engineError = failed instanceof E.OptionError || failed instanceof E.ImageError;
      if (!engineError && retries < 6) { retries++; status("Photoshop is busy: retrying the update…"); setTimeout(liveUpdate, 250 * retries); return; }
      retries = 0;
      status(failed.message || String(failed), true);
    }
    if (pending || gen !== startGen) { pending = false; liveUpdate(); }   // settings changed while rendering
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
  function concat(parts) {
    let len = 0; for (const x of parts) len += x.length;
    const out = new Uint8Array(len); let off = 0;
    for (const x of parts) { out.set(x, off); off += x.length; }
    return out;
  }
  function png1bit(bits, w, h, dpi) {   // bits: 1 = ink -> black
    const rowLen = Math.ceil(w / 8) + 1, raw = new Uint8Array(rowLen * h);
    for (let y = 0; y < h; y++) {
      const o = y * rowLen;
      for (let x = 0; x < w; x++) if (!bits[y * w + x]) raw[o + 1 + (x >> 3)] |= 0x80 >> (x & 7);   // 1 = white
    }
    const blocks = [new Uint8Array([0x78, 0x01])], MAX = 65535;
    let a = 1, b = 0;
    for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; }
    for (let i = 0; i < raw.length; i += MAX) {
      const n = Math.min(MAX, raw.length - i), last = i + MAX >= raw.length ? 1 : 0;
      blocks.push(new Uint8Array([last, n & 255, n >> 8, ~n & 255, (~n >> 8) & 255]), raw.subarray(i, i + n));
    }
    blocks.push(new Uint8Array(be32(((b << 16) | a) >>> 0)));
    const ihdr = new Uint8Array([...be32(w), ...be32(h), 1, 0, 0, 0, 0]);   // 1-bit greyscale
    const ppm = Math.round(dpi / 0.0254);
    return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", ihdr),
      ...chunk("pHYs", new Uint8Array([...be32(ppm), ...be32(ppm), 1])), ...chunk("IDAT", concat(blocks)), ...chunk("IEND", new Uint8Array(0))]);
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
        const { r, o } = await render(doc, s, false);   // files: every ink that's on, never a solo view
        const kept = r.plates.map((p, i) => [p, r.seps[i]]).filter(([p]) => p.on);
        if (!kept.length) throw new Error("Every ink is switched off: nothing to separate.");
        const left = s.bounds.left + s.prep.crop[0], top = s.bounds.top + s.prep.crop[1];
        if (kind === "layers") {
          let group = null;
          try { group = await doc.createLayerGroup({ name: `Ecko separations (${kept.length})` }); } catch (e) { group = null; }
          for (let i = 0; i < kept.length; i++) {
            const [p, sep] = kept[i], n = String(i + 1).padStart(2, "0");
            const lay = await doc.createLayer({ name: `${n} ${p.label || p.name} ${E.toHex(p.rgb)}` });
            const buf = new Uint8Array(r.width * r.height * 4);
            for (let k = 0; k < sep.length; k++) if (sep[k]) { buf[k * 4] = p.rgb[0]; buf[k * 4 + 1] = p.rgb[1]; buf[k * 4 + 2] = p.rgb[2]; buf[k * 4 + 3] = 255; }
            const img = await imaging.createImageDataFromBuffer(buf, { width: r.width, height: r.height, components: 4, chunky: true,
              colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1" });
            await imaging.putPixels({ documentID: doc.id, layerID: lay.id, imageData: img, targetBounds: { left, top } });
            img.dispose();
            if (group) { try { await lay.move(group, constants.ElementPlacement.PLACEINSIDE); } catch (e) { /* stays loose */ } }
          }
          msg = `Done: ${kept.length} separation layer(s)${group ? " in the group \"Ecko separations\"" : ""}, first ink at the bottom: ` +
            `${kept.map(([p]) => p.label || p.name).join(", ")}.`;
        } else {
          const base = safeName((doc.title || doc.name || "ecko-tone").replace(/\.[^.]+$/, ""));
          const rep = E.report(s.prep, o, r.plates, r.seps);
          const lines = [`${base}: ${kept.length} separation(s)`, "",
            `Print size: ${rep.inches[0]} x ${rep.inches[1]} in (${rep.cm[0]} x ${rep.cm[1]} cm) at ${o.dpi} DPI`,
            `Screen: ${E.STYLES[o.style]}` + (E.GRAIN_STYLES.includes(o.style) ? `, grain ${o.grain_mm} mm` : `, ${o.lpi} LPI`), ""];
          for (let i = 0; i < kept.length; i++) {
            const [p, sep] = kept[i], f = film(sep, r.width, r.height, o), n = String(i + 1).padStart(2, "0");
            const ink = p.label || p.name, hx = E.toHex(p.rgb);
            const file = await folder.createFile(`${base}-${n}-${ink.replace(/[^A-Za-z0-9]/g, "-")}-${hx.slice(1)}.png`, { overwrite: true });
            await file.write(png1bit(f.data, f.w, f.h, o.dpi), { format: require("uxp").storage.formats.binary });
            let on = 0; for (const v of sep) on += v;
            lines.push(`${n} ${ink.padEnd(18)} ${hx}  RGB ${p.rgb.map((c) => Math.round(c)).join(",").padEnd(11)}  ` +
              `angle ${(((p.angle % 180) + 180) % 180).toFixed(1).padStart(5)}  coverage ${(on / sep.length * 100).toFixed(1)}%`);
          }
          lines.push("", o.registration_marks ? "Films are black = ink, 1-bit, with registration marks in a 0.5 in margin." : "Films are black = ink, 1-bit.",
            "Print order: as numbered (light inks first).");
          const readme = await folder.createFile(`${base}-README.txt`, { overwrite: true });
          await readme.write(lines.join("\n") + "\n");
          msg = `Saved ${kept.length} film(s) + README to "${folder.name}": ${kept.map(([p]) => p.label || p.name).join(", ")}.`;
        }
      }, { commandName: kind === "films" ? "Ecko Tone films" : "Ecko Tone separations" });
      status(msg);
    } catch (e) {
      status(e.message || String(e), true);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- settings height (S / M / L)

  // The settings live in a scrolling box with its own height, so a scroll bar always appears when they
  // don't fit. S / M / L picks the height (remembered); it never depends on Photoshop reporting sizes.
  const SIZES = { S: 240, M: 420, L: 640 };
  let boxSize = "S";
  function fitPanel() {
    const steps = $("steps");
    steps.style.height = `${SIZES[boxSize] || SIZES.S}px`;
    steps.style.overflowY = "scroll";
    for (const k of Object.keys(SIZES)) $(`size${k}`).style.fontWeight = k === boxSize ? "bold" : "normal";
  }
  function setSize(k) {
    boxSize = k;
    try { localStorage.setItem(`${STORE}-size`, k); } catch (e) { /* ignore */ }
    fitPanel();
  }

  // ---------------------------------------------------------------- start

  try {
    fill($("preset"), cat.presets);
    fill($("mode"), cat.modes);
    fill($("style"), cat.styles);
    fill($("palette"), [{ id: "image", name: "From the picture" }, ...cat.palettes]);
    fill($("shirt_fit"), cat.shirt_fits);
    fill($("border"), cat.borders);
    fill($("border_shape"), cat.border_shapes);
    fill($("target"), cat.targets);
    fill($("garmentSel"), [...cat.garments, { name: "Custom (type a hex below)", hex: "custom" }], (g) => g.name, (g) => g.hex);
    fillTexLayers();

    $("preset").addEventListener("change", () => applyPreset(selVal($("preset"))));
    $("simpleProcess").addEventListener("click", () => applyPreset("simple-process"));
    $("autoCuts").addEventListener("click", () => { opts.thresholds = []; buildCuts(); save(); scheduleLive(50); });
    $("resetTone").addEventListener("click", () => {
      for (const k of ["brightness", "contrast", "gamma", "black_point", "white_point", "invert", "sharpen"]) opts[k] = cat.defaults[k];
      syncUI(); save(); scheduleLive(50);
    });
    $("outlineMode").addEventListener("change", () => {
      opts.outline_color = selVal($("outlineMode")) === "auto" ? "auto" : (validHex($("outlineHex").value) || "#111111");
      syncOutline(); save(); scheduleLive(50);
    });
    $("outlineHex").addEventListener("change", () => {
      const h = validHex($("outlineHex").value);
      if (!h) { syncOutline(); return status("Colours are 6-digit hex, like #111111.", true); }
      opts.outline_color = h; syncOutline(); save(); scheduleLive(50);
    });
    $("garmentSel").addEventListener("change", () => { const v = selVal($("garmentSel")); if (v !== "custom") setGarment(v); });
    $("garmentHex").addEventListener("change", () => {
      const h = validHex($("garmentHex").value);
      if (!h) { syncGarment(); return status("Shirt colour is a 6-digit hex, like #1b2a4a.", true); }
      setGarment(h);
    });
    $("texAdd").addEventListener("change", () => addTexture(selVal($("texAdd"))));
    $("texLayer").addEventListener("change", () => {
      texLayerId = selVal($("texLayer")) || null;
      texCache.clear();
      if (texLayerId) tex.image = { ...(tex.image || { strength: 0.5, scale: 1 }), on: true };
      buildTextures(); save(); scheduleLive(50);
    });
    $("refreshLayers").addEventListener("click", () => { fillTexLayers(); texCache.clear(); status("Layer list refreshed."); });
    $("reseed").addEventListener("click", () => { opts.seed = Math.floor(Math.random() * 1e9); save(); scheduleLive(50); });
    $("shirtLayer").addEventListener("change", save);
    $("run").addEventListener("click", run);
    $("liveBtn").addEventListener("click", () => {
      setLive(!live); save();
      if (live) { status(session ? "Live editing on: catching up with your changes…" : "Live editing on. Click Apply once to start."); scheduleLive(50); }
      else status("Live editing paused. Change settings freely, then click the button again (or Apply) to update.");
    });
    for (const id of ["sepLayers", "sepLayers2"]) $(id).addEventListener("click", () => separations("layers"));
    for (const id of ["saveFilms", "saveFilms2"]) $(id).addEventListener("click", () => separations("films"));
    try { boxSize = localStorage.getItem(`${STORE}-size`) || localStorage.getItem("ecko-tone-panel-size") || "S"; } catch (e) { boxSize = "S"; }
    for (const k of Object.keys(SIZES)) $(`size${k}`).addEventListener("click", () => setSize(k));
    fitPanel();
    $("reset").addEventListener("click", () => {
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      opts = clone(cat.defaults); tex = {}; texLayerId = null; spotInks = null; solo = null; lastReport = null;
      applyPreset((cat.presets[0] || {}).id);
      buildInkList();
      status("Settings reset.");
    });
    restore();
  } catch (e) {
    status(`Couldn't start: ${e.message || e}`, true);
  }
})();
