/* Ecko Tone panel for Photoshop (UXP). Halftones the selected layer with the built-in engine
   (tone-engine.js, the same one the web app uses), puts the result on a new layer at the same
   position and, optionally, a shirt-colour fill layer underneath. No server, no network. */
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
      opt.textContent = label(x);
      sel.appendChild(opt);
    }
  }
  // Panel sliders: set both property and attribute so thumb and number agree.
  function setSlider(id, v) { const el = $(id); el.setAttribute("value", String(v)); el.value = v; }
  const num = (id) => Number($(id).value);
  function setSelect(id, v) {
    const sel = $(id);
    for (let i = 0; i < sel.options.length; i++) if (sel.options[i].value === String(v)) { sel.selectedIndex = i; return; }
  }
  const show = (id, on) => { $(id).style.display = on ? "block" : "none"; };
  const isGrain = (style) => (cat.styles.find((s) => s.id === style) || {}).grain;

  // ---------------------------------------------------------------- folding sections (one open at a time)

  const sections = Array.from(document.querySelectorAll(".sec"));
  let openNow = "look";
  function openSection(name) {
    openNow = name;
    for (const s of sections) {
      const body = s.querySelector(".body"), on = s.getAttribute("data-sec") === name;
      body.style.display = on ? "block" : "none";
      s.querySelector(".head").textContent = s.querySelector(".head").textContent.replace(/^[▸▾] /, "").replace(/^/, on ? "▾ " : "▸ ");
    }
  }
  for (const s of sections) s.querySelector(".head").addEventListener("click", () => openSection(s.getAttribute("data-sec")));

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
    const mode = $("mode").value;
    show("levelsRow", mode === "threshold");
    show("countRow", mode === "spot" || mode === "index");
    show("paletteRow", mode === "spot" || mode === "index");
    show("lpiRow", !isGrain($("style").value));
    show("grainRow", !!isGrain($("style").value));
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
    const p = cat.presets.find((x) => x.id === $("preset").value);
    if (!p) return;
    const keep = { garment: $("garment").value, shirt_fit: $("fit").value, border: $("border").value,
      border_shape: $("borderShape").value, border_mm: num("borderMm") };
    applyOptions({ ...cat.defaults, ...keep, ...p.options });
    save();
  }
  function save() {
    try {
      const s = { preset: $("preset").value, shirtLayer: $("shirtLayer").checked };
      for (const id of Object.keys(FIELDS)) s[id] = num(id);
      for (const id of Object.keys(SELECTS)) s[id] = $(id).value;
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
    labels();
  }

  function options(doc, widthPx) {
    const p = cat.presets.find((x) => x.id === $("preset").value);
    const dpi = Math.round(Math.min(1200, Math.max(72, doc.resolution)));
    const o = { ...(p ? p.options : {}), dpi, width_in: Math.max(0.5, widthPx / dpi), text: [] };
    for (const [id, key] of Object.entries(FIELDS)) o[key] = num(id);
    for (const [id, key] of Object.entries(SELECTS)) o[key] = $(id).value;
    // Image textures need a file picker; the web app has them. Procedural textures work here.
    o.textures = (o.textures || []).filter((t) => t.type !== "image");
    if (o.mode !== "threshold") delete o.thresholds;
    return E.parseOptions(o);
  }

  // ---------------------------------------------------------------- apply

  async function addShirtLayer(resultLayer) {
    const [r, g, b] = E.hex($("garment").value);
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

  async function run() {
    const doc = app.activeDocument;
    if (!doc) return status("Open a document first.", true);
    const layer = doc.activeLayers[0];
    if (!layer) return status("Select a layer first.", true);
    save();
    status("Working… (big layers take a few seconds)");
    try {
      let notes = [];
      await core.executeAsModal(async () => {
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

        let o = options(doc, width);
        o.remove_background = o.remove_background && opaque;   // a layer with transparency is already cut out
        const prep = E.prepare(rgba, width, height, o, null);
        o = E.parseOptions({ ...o, width_in: Math.max(0.5, prep.crop[2] / o.dpi) });   // 1:1 with the layer's pixels
        const out = E.renderFull(prep, o);

        const name = `Ecko Tone (${$("preset").options[$("preset").selectedIndex].textContent})`;
        const newLayer = await doc.createLayer({ name });
        const imageData = await imaging.createImageDataFromBuffer(new Uint8Array(out.rgba.buffer), {
          width: out.width, height: out.height, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
        });
        await imaging.putPixels({ documentID: doc.id, layerID: newLayer.id, imageData,
          targetBounds: { left: bounds.left + prep.crop[0], top: bounds.top + prep.crop[1] } });
        imageData.dispose();
        if ($("shirtLayer").checked) {
          try { await addShirtLayer(newLayer); }
          catch (e) { notes.push(`(Couldn't add the shirt-colour layer: ${e.message || e})`); }
        }
        notes = [...E.resolveFit(prep, o).notes, ...notes];
      }, { commandName: "Ecko Tone" });
      status(["Done. The result is on a new layer.", ...notes].join(" "));
    } catch (e) {
      status(e.message || String(e), true);
    }
  }

  // ---------------------------------------------------------------- fit the panel / full window

  // Photoshop panels don't scroll by themselves: size the steps area to the space the panel has left,
  // and re-check often, because panels can be resized at any time.
  let inBigWindow = false;
  function fitPanel() {
    if (inBigWindow) return;
    const h = window.innerHeight || document.documentElement.clientHeight || document.body.clientHeight || 0;
    const steps = $("steps"), top = document.querySelector(".top");
    if (h > 150 && top) {
      const room = Math.max(120, h - top.offsetHeight - 24);
      steps.style.height = `${room}px`;
      steps.style.overflowY = "scroll";
    } else {
      steps.style.height = "";
    }
  }

  // "Open in full window": all steps in one big, resizable window. Applying from it closes the window
  // first, then works on the layer (Photoshop won't edit documents while a window is open on top).
  async function openBigWindow() {
    const dlg = $("bigWindow"), body = $("bigBody"), steps = $("steps"), home = steps.parentNode;
    if (!dlg || typeof dlg.uxpShowModal !== "function") { status("This Photoshop version can't open a separate window.", true); return; }
    const runBig = document.createElement("button");
    runBig.textContent = "Apply to selected layer";
    runBig.style.width = "100%"; runBig.style.padding = "8px"; runBig.style.fontWeight = "bold"; runBig.style.marginBottom = "10px";
    let applyAfter = false;
    runBig.addEventListener("click", () => { applyAfter = true; dlg.close("apply"); });
    body.appendChild(runBig);
    body.appendChild(steps);
    inBigWindow = true;
    steps.style.height = ""; steps.style.overflowY = "visible";
    for (const s of sections) s.querySelector(".body").style.display = "block";   // every step open in the big window
    try {
      await dlg.uxpShowModal({ title: "Ecko Tone", resize: "both", size: { width: 460, height: 760 } });
    } catch (e) { /* closed */ }
    home.appendChild(steps);
    runBig.remove();
    inBigWindow = false;
    openSection(openNow);
    fitPanel();
    save();
    if (applyAfter) run();
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
    for (const id of Object.keys(FIELDS)) { $(id).addEventListener("input", labels); $(id).addEventListener("change", () => { labels(); save(); }); }
    for (const id of Object.keys(SELECTS)) $(id).addEventListener("change", () => { labels(); save(); });
    $("shirtLayer").addEventListener("change", save);
    $("preset").addEventListener("change", applyPreset);
    $("run").addEventListener("click", run);
    $("popout").addEventListener("click", openBigWindow);
    window.addEventListener("resize", fitPanel);
    setInterval(fitPanel, 700);
    setTimeout(fitPanel, 50);
    $("reset").addEventListener("click", () => {
      try { localStorage.removeItem(STORE); } catch (e) { /* ignore */ }
      $("preset").selectedIndex = 0;
      applyPreset();
      status("Settings reset.");
    });
    restore();
    openSection("look");
  } catch (e) {
    status(`Couldn't start: ${e.message || e}`, true);
  }
})();
