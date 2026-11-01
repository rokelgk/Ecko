/* Ecko Tone front end: plain JS, no build step. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SLIDERS = ["bg_tolerance", "lpi", "grain_mm", "angle", "spot_colors", "spot_softness", "brightness",
    "contrast", "gamma", "black_point", "white_point", "sharpen", "min_dot", "max_dot", "dot_gain",
    "roughness", "misregister_mm", "choke_mm"];
  const CHECKS = ["remove_background", "invert", "knockout", "registration_marks"];
  const SELECTS = ["mode", "style", "target", "shirt_fit", "underbase"];
  const TONE_KEYS = ["brightness", "contrast", "gamma", "black_point", "white_point", "sharpen", "invert"];
  const STORE_KEY = "ecko-tone-options";

  let catalog = null;
  let opts = null;
  let tex = {};            // type -> {on, strength, scale, image_id}
  let file = null, imageId = null, texFile = null;
  let palette = null, spotInks = null;
  let report = null, loupeAt = null;
  let seq = 0, loupeSeq = 0, mockSeq = 0, timer = null, view = "print";
  let batch = [];          // extra designs: {file, id, name, url}
  let batchShirts = null;  // Set of garment hexes for the batch
  let batchTouched = false;  // until the user picks colours, the batch follows the garment

  // ---------------------------------------------------------------- helpers

  const post = (url, body) => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  async function detail(r) {
    try { const j = await r.json(); return typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); }
    catch { return `Request failed (${r.status})`; }
  }

  function showError(msg) {
    $("error").textContent = msg || "";
    $("error").hidden = !msg;
  }

  async function uploadFile(f) {
    const fd = new FormData();
    fd.append("file", f);
    const r = await fetch("/api/tone/images", { method: "POST", body: fd });
    if (!r.ok) throw new Error(await detail(r));
    return (await r.json()).id;
  }

  const hasText = () => (opts.text || []).some((t) => t.text && t.text.trim());
  const hasDesign = () => !!file || hasText();

  async function ensureUploads() {
    if (file && !imageId) imageId = await uploadFile(file);
    for (const b of batch) if (!b.id) b.id = await uploadFile(b.file);
    if (texFile && tex.image && !tex.image.image_id) tex.image.image_id = await uploadFile(texFile);
  }

  // Server keeps uploads in memory; on 410 the browser re-sends its copy and retries once.
  async function postWithReupload(url, build) {
    await ensureUploads();
    let r = await post(url, build());
    if (r.status === 410) {
      imageId = null;
      for (const b of batch) b.id = null;
      if (tex.image) tex.image.image_id = null;
      await ensureUploads();
      r = await post(url, build());
    }
    return r;
  }

  const fmt = (v, d = 2) => {
    const t = Number(v).toFixed(d);
    return t.includes(".") ? t.replace(/\.?0+$/, "") : t;  // 120 stays 120, 0.50 becomes 0.5
  };

  function widthIn() {
    const w = parseFloat($("width").value) || 10;
    return $("units").value === "cm" ? w / 2.54 : w;
  }

  function payload() {
    const o = { ...opts };
    o.width_in = Math.min(60, Math.max(0.5, widthIn()));
    o.dpi = parseInt($("dpi").value, 10);
    o.textures = Object.entries(tex).filter(([, t]) => t.on && (t.type !== "image" || t.image_id))
      .map(([type, t]) => ({ type, strength: t.strength, scale: t.scale, image_id: t.image_id || null }));
    if (o.mode === "spot") o.inks = spotInks && spotInks.length === o.spot_colors ? spotInks : ["#000000"];
    if (o.mode === "mono") o.inks = [o.inks[0]];
    if (o.mode === "duotone") o.inks = [o.inks[0], o.inks[1] || "#e94e77"];
    if (o.mode === "cmyk") o.inks = ["#000000"];
    return o;
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ opts, tex: stripTex(), width: $("width").value,
      units: $("units").value, dpi: $("dpi").value })); } catch { /* private mode */ }
  }
  function stripTex() {
    const out = {};
    for (const [k, t] of Object.entries(tex)) if (k !== "image") out[k] = t;
    return out;
  }

  // ---------------------------------------------------------------- UI build

  function buildSelect(id, items) {
    $(id).innerHTML = items.map((i) => `<option value="${i.id}">${i.name}</option>`).join("");
  }

  function buildPresets() {
    $("presets").innerHTML = "";
    for (const p of catalog.presets) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.id = p.id;
      b.innerHTML = `${p.name}<small>${p.blurb}</small>`;
      b.addEventListener("click", () => applyPreset(p));
      $("presets").appendChild(b);
    }
  }

  function buildTextures() {
    const box = $("textures");
    box.innerHTML = "";
    for (const t of catalog.textures) {
      if (t.id === "image" && !tex.image) continue;
      tex[t.id] = tex[t.id] || { type: t.id, on: false, strength: 0.4, scale: 1 };
      const st = tex[t.id];
      const el = document.createElement("div");
      el.className = "tex" + (st.on ? " on" : "");
      el.innerHTML = `<label class="check"><input type="checkbox" ${st.on ? "checked" : ""}> ${t.name}</label>
        <div class="sliders">
          <label>Strength <input type="range" min="0" max="1" step="0.02" value="${st.strength}" data-k="strength"></label>
          <label>Size <input type="range" min="0.25" max="4" step="0.05" value="${st.scale}" data-k="scale"></label>
        </div>`;
      el.querySelector("input[type=checkbox]").addEventListener("change", (e) => {
        st.on = e.target.checked;
        el.classList.toggle("on", st.on);
        changed();
      });
      el.querySelectorAll("input[type=range]").forEach((inp) => inp.addEventListener("input", () => {
        st[inp.dataset.k] = parseFloat(inp.value);
        changed();
      }));
      box.appendChild(el);
    }
  }

  function buildGarments() {
    const box = $("garments");
    box.innerHTML = "";
    for (const { name, hex } of catalog.garments) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.background = hex;
      b.title = name;
      b.setAttribute("aria-label", name);
      b.dataset.hex = hex;
      b.addEventListener("click", () => setGarment(hex));
      box.appendChild(b);
    }
  }

  function setGarment(hex) {
    opts.garment = hex;
    $("garment").value = hex;
    $("stage").style.backgroundColor = view === "shirt" ? "" : hex;
    document.querySelectorAll("#garments button").forEach((b) => b.classList.toggle("on", b.dataset.hex === hex));
    buildBatchShirts();
    changed();
  }

  function buildInks() {
    const box = $("inks");
    box.innerHTML = "";
    const n = opts.mode === "duotone" ? 2 : 1;
    while (opts.inks.length < n) opts.inks.push(opts.inks.length ? "#e94e77" : "#1d1d1f");
    for (let i = 0; i < n; i++) {
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = opts.inks[i];
      inp.title = n === 2 ? (i ? "Second ink" : "Shadow ink") : "Ink";
      inp.addEventListener("input", () => { opts.inks[i] = inp.value; changed(); });
      box.appendChild(inp);
    }
  }

  // ---------------------------------------------------------------- text

  const TEXT_DEFAULT = { text: "YOUR TEXT", font: "varsity", size: 0.15, arc: 0, x: 0, y: -0.75, spacing: 0.05, color: "#000000" };

  function buildText() {
    const box = $("textLayers");
    box.innerHTML = "";
    (opts.text || []).forEach((t, i) => {
      const el = document.createElement("div");
      el.className = "layer textLayer";
      el.innerHTML = `
        <input type="text" maxlength="80" aria-label="Text" data-k="text">
        <div class="row">
          <select data-k="font" aria-label="Font">${catalog.fonts.map((f) => `<option value="${f.id}">${f.name}</option>`).join("")}</select>
          <input type="color" data-k="color" aria-label="Text colour">
          <button type="button" class="link" data-del>Remove</button>
        </div>
        <div class="row">
          <label>Size <input type="range" data-k="size" min="0.03" max="0.6" step="0.005"></label>
          <label>Curve <input type="range" data-k="arc" min="-300" max="300" step="5"></label>
        </div>
        <div class="row">
          <label>Up / down <input type="range" data-k="y" min="-1.6" max="1.6" step="0.01"></label>
          <label>Left / right <input type="range" data-k="x" min="-1.2" max="1.2" step="0.01"></label>
          <label>Spacing <input type="range" data-k="spacing" min="-0.1" max="0.8" step="0.01"></label>
        </div>`;
      el.querySelectorAll("[data-k]").forEach((inp) => {
        const k = inp.dataset.k;
        inp.value = t[k];
        inp.addEventListener("input", () => {
          t[k] = inp.type === "range" ? parseFloat(inp.value) : inp.value;
          changed();
        });
      });
      el.querySelector("[data-del]").addEventListener("click", () => {
        opts.text.splice(i, 1);
        buildText();
        changed();
      });
      box.appendChild(el);
    });
    $("addText").disabled = (opts.text || []).length >= 6;
  }

  // ---------------------------------------------------------------- batch

  function buildBatchShirts() {
    if (!catalog || !opts) return;
    if (!batchShirts || !batchTouched) batchShirts = new Set([opts.garment]);
    const box = $("batchShirts");
    box.innerHTML = "";
    const list = [...catalog.garments];
    if (!list.some((g) => g.hex === opts.garment)) list.push({ name: "Custom", hex: opts.garment });
    for (const g of list) {
      const lab = document.createElement("label");
      lab.innerHTML = `<input type="checkbox" ${batchShirts.has(g.hex) ? "checked" : ""}><span class="dot" style="background:${g.hex}"></span>${g.name}`;
      lab.querySelector("input").addEventListener("change", (e) => {
        batchTouched = true;
        if (e.target.checked) batchShirts.add(g.hex); else batchShirts.delete(g.hex);
        batchHint();
      });
      box.appendChild(lab);
    }
    batchHint();
  }

  function buildBatchList() {
    const ul = $("batchList");
    ul.innerHTML = "";
    batch.forEach((b, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<img alt=""><input type="text" aria-label="Name"><button type="button" class="link">Remove</button>`;
      li.querySelector("img").src = b.url;
      const inp = li.querySelector("input");
      inp.value = b.name;
      inp.addEventListener("input", () => { b.name = inp.value; });
      li.querySelector("button").addEventListener("click", () => {
        URL.revokeObjectURL(b.url);
        batch.splice(i, 1);
        buildBatchList();
      });
      ul.appendChild(li);
    });
    batchHint();
  }

  function batchHint() {
    const designs = (hasDesign() ? 1 : 0) + batch.length;
    const shirts = batchShirts ? batchShirts.size : 0;
    const max = catalog.limits.batch_renders;
    $("batchHint").textContent = `${designs} design(s) × ${shirts} colour(s) = ${designs * shirts} prints`
      + (designs * shirts > max ? `, over the limit of ${max}.` : ".");
    $("dlBatch").disabled = !designs || !shirts || designs * shirts > max;
  }

  const garmentName = (hex) => (catalog.garments.find((g) => g.hex === hex) || {}).name || hex.slice(1);

  async function downloadBatch(btn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Rendering every print…";
    showError("");
    try {
      const build = () => {
        const items = [];
        if (hasDesign()) items.push({ image_id: file ? imageId : null, name: $("name").value || "design" });
        for (const b of batch) items.push({ image_id: b.id, name: b.name });
        const garments = [...batchShirts].map((hex) => ({ hex, name: garmentName(hex) }));
        return { items, garments, options: serverOpts(), mockups: $("batchMockups").checked,
          name: `${$("name").value || "ecko"}-batch` };
      };
      const r = await postWithReupload("/api/tone/batch", build);
      if (!r.ok) throw new Error(await detail(r));
      saveBlob(await r.blob(), r, "ecko-batch.zip");
    } catch (e) {
      showError(e.message);
    } finally {
      btn.textContent = old;
      batchHint();
    }
  }

  function saveBlob(blob, r, fallback) {
    const cd = r.headers.get("content-disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : fallback;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function syncUI() {
    for (const k of SLIDERS) $(k).value = opts[k];
    for (const k of CHECKS) $(k).checked = !!opts[k];
    for (const k of SELECTS) $(k).value = opts[k];
    const grain = catalog.styles.find((s) => s.id === opts.style)?.grain;
    $("amRow").hidden = grain;
    $("grainRow").hidden = !grain;
    $("inksBox").hidden = !(opts.mode === "mono" || opts.mode === "duotone");
    $("spotBox").hidden = opts.mode !== "spot";
    $("bgTolRow").hidden = !opts.remove_background;
    buildInks();
    buildTextures();
    buildText();
    setGarment(opts.garment);
    labels();
  }

  function labels() {
    $("lpiOut").textContent = `${fmt(opts.lpi, 0)} LPI`;
    $("grainOut").textContent = `${fmt(opts.grain_mm)} mm`;
    $("angleOut").textContent = `${fmt(opts.angle, 1)}°`;
    $("spotOut").textContent = opts.spot_colors;
    $("minOut").textContent = `${Math.round(opts.min_dot * 100)}%`;
    $("maxOut").textContent = `${Math.round(opts.max_dot * 100)}%`;
    $("gainOut").textContent = `${Math.round(opts.dot_gain * 100)}%`;
    $("misOut").textContent = `${fmt(opts.misregister_mm)} mm`;
    $("chokeOut").textContent = `${fmt(opts.choke_mm)} mm`;
    $("dpiNote").textContent = $("dpi").value;
    document.querySelectorAll("#presets button").forEach((b) => b.classList.toggle("on", b.dataset.id === opts._preset));
  }

  function applyPreset(p) {
    const keep = { remove_background: opts.remove_background, bg_tolerance: opts.bg_tolerance, seed: opts.seed,
      text: opts.text, shirt_fit: opts.shirt_fit, underbase: opts.underbase, choke_mm: opts.choke_mm };
    opts = { ...structuredClone(catalog.defaults), ...keep, ...structuredClone(p.options), _preset: p.id };
    for (const t of Object.values(tex)) t.on = false;
    for (const t of p.options.textures || []) tex[t.type] = { type: t.type, on: true, strength: t.strength, scale: t.scale };
    if (!p.options.garment) opts.garment = $("garment").value || "#ffffff";
    spotInks = null;
    syncUI();
    changed();
  }

  // ---------------------------------------------------------------- render

  function changed() {
    labels();
    save();
    clearTimeout(timer);
    timer = setTimeout(render, 180);
  }

  function serverOpts() {
    const o = payload();
    delete o._preset;
    return o;
  }

  async function render() {
    if (!hasDesign()) {
      $("preview").hidden = $("mockup").hidden = true;
      $("empty").hidden = false;
      $("results").hidden = true;
      return;
    }
    const my = ++seq;
    $("busy").hidden = false;
    showError("");
    try {
      const maxPx = Math.round(Math.min(1600, Math.max(400, $("stage").clientWidth * (window.devicePixelRatio || 1))));
      const r = await postWithReupload("/api/tone/preview",
        () => ({ image_id: file ? imageId : null, options: serverOpts(), max_px: maxPx }));
      if (my !== seq) return;
      if (!r.ok) throw new Error(await detail(r));
      const j = await r.json();
      if (my !== seq) return;
      $("preview").src = j.image;
      $("empty").hidden = true;
      showView(view);
      if (j.palette && JSON.stringify(j.palette) !== JSON.stringify(palette)) {
        palette = j.palette;
        if (!spotInks || spotInks.length !== palette.length) spotInks = null;
      }
      report = j.report;
      showReport();
      if (loupeAt) renderLoupe();
      if (view === "shirt") renderMockup();
    } catch (e) {
      if (my === seq) showError(e.message);
    } finally {
      if (my === seq) $("busy").hidden = true;
    }
  }

  async function renderLoupe() {
    if (!report || !loupeAt) return;
    const my = ++loupeSeq;
    const [W, H] = report.pixels;
    const w = Math.min(480, W), h = Math.min(360, H);
    const x = Math.round(Math.min(Math.max(loupeAt.fx * W - w / 2, 0), W - w));
    const y = Math.round(Math.min(Math.max(loupeAt.fy * H - h / 2, 0), H - h));
    try {
      const r = await postWithReupload("/api/tone/preview",
        () => ({ image_id: file ? imageId : null, options: serverOpts(), region: [x, y, w, h] }));
      if (!r.ok || my !== loupeSeq) return;
      $("loupeImg").src = (await r.json()).image;
      $("loupe").hidden = false;
    } catch { /* the main preview reports errors */ }
  }

  async function renderMockup() {
    if (!hasDesign()) return;
    const my = ++mockSeq;
    try {
      const size = Math.round(Math.min(1600, Math.max(600, $("stage").clientHeight * (window.devicePixelRatio || 1))));
      const r = await postWithReupload("/api/tone/mockup",
        () => ({ image_id: file ? imageId : null, options: serverOpts(), size }));
      if (!r.ok || my !== mockSeq) return;
      const old = $("mockup").src;
      $("mockup").src = URL.createObjectURL(await r.blob());
      if (old.startsWith("blob:")) URL.revokeObjectURL(old);
    } catch { /* the main preview reports errors */ }
  }

  function showView(v) {
    const was = view;
    view = v;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
    $("preview").hidden = v !== "print" || !hasDesign();
    $("mockup").hidden = v !== "shirt" || !hasDesign();
    $("original").hidden = v !== "original" || !file;
    $("stageHint").hidden = v !== "print" || !hasDesign() || !!loupeAt;
    $("stage").style.backgroundColor = v === "shirt" ? "" : opts.garment;  // the mockup has its own backdrop
    if (v === "shirt" && was !== "shirt") renderMockup();
    if (v !== "print") $("loupe").hidden = true;
    else if (loupeAt && $("loupeImg").src) $("loupe").hidden = false;
  }

  function showReport() {
    $("results").hidden = false;
    const r = report;
    const stats = [
      ["Print size", `${r.inches[0]} × ${r.inches[1]} in (${r.cm[0]} × ${r.cm[1]} cm)`],
      ["Pixels", `${r.pixels[0]} × ${r.pixels[1]} @ ${r.dpi} DPI`],
      ["Ink area", `${r.ink_area_pct}%`],
    ];
    if (r.tone_levels) stats.push(["Tone levels", r.tone_levels]);
    if (r.smallest_dot_mm) stats.push(["Smallest dot", `${r.smallest_dot_mm} mm`]);
    if (r.grain_mm) stats.push(["Grain", `${r.grain_mm} mm`]);
    $("stats").innerHTML = stats.map(([k, v]) => `<li>${k}: <b>${v}</b></li>`).join("");
    $("sizeHint").textContent = `${r.inches[0]} × ${r.inches[1]} in, ${r.megapixels} MP`;
    const fit = r.fit || { notes: [] };
    const modeName = { recolor: "recolouring the ink", tones: "matching the picture's tones", off: "off" }[fit.mode];
    const notes = opts.shirt_fit === "off" ? [] : [`Fit to shirt: ${modeName}${opts.shirt_fit === "auto"
      ? (fit.photo_like ? " (looks like a photo)" : " (looks like a logo or text)") : ""}.`, ...fit.notes];
    $("fitNotes").textContent = notes.join(" ");
    $("fitNotes").hidden = !notes.length;
    batchHint();

    const ul = $("warnings");
    ul.innerHTML = "";
    const items = r.warnings.length ? r.warnings
      : [{ level: "ok", text: `Looks printable on ${r.target}. Transparency is pure on/off: no semi-transparent pixels.` }];
    for (const w of items) {
      const li = document.createElement("li");
      li.className = w.level;
      li.textContent = w.text;
      if (w.fix) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "link";
        b.textContent = "Fix it";
        b.addEventListener("click", () => applyFix(w.fix));
        li.appendChild(document.createElement("br"));
        li.appendChild(b);
      }
      ul.appendChild(li);
    }

    const ol = $("inkList");
    ol.innerHTML = "";
    r.inks.forEach((ink, i) => {
      const li = document.createElement("li");
      const editable = opts.mode !== "cmyk" && !ink.underbase;
      li.innerHTML = `${editable ? `<input type="color" value="${ink.hex}" aria-label="${ink.name} colour">`
        : `<span class="inkSwatch" style="background:${ink.hex}"></span>`}
        <span class="tname"><b>${ink.name}</b><small>${ink.underbase ? "films only, under the colours" : `${ink.hex} · ${ink.angle}°`}</small></span>
        <span class="meta">${ink.coverage}% cover</span>`;
      const inp = li.querySelector("input");
      if (inp) inp.addEventListener("input", () => {
        if (opts.mode === "spot") {
          // the ink list skips the underbase and inks the shirt supplies; map back by spot number
          const n = parseInt(ink.name.replace(/\D+/g, ""), 10) - 1;
          spotInks = (spotInks || palette).slice();
          spotInks[n] = inp.value;
        } else {
          opts.inks[i] = inp.value;
          buildInks();
        }
        changed();
      });
      ol.appendChild(li);
    });
  }

  function applyFix(fix) {
    for (const [k, v] of Object.entries(fix)) {
      if (k === "dpi") {
        if (![...$("dpi").options].some((o) => o.value === String(v))) $("dpi").add(new Option(v, v));
        $("dpi").value = String(v);
      } else {
        opts[k] = v;
      }
    }
    syncUI();
    changed();
  }

  async function download(format, btn) {
    if (!hasDesign()) return;
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Rendering full size…";
    showError("");
    try {
      const name = $("name").value || "ecko-tone";
      const r = await postWithReupload("/api/tone/export",
        () => ({ image_id: file ? imageId : null, options: serverOpts(), format, name }));
      if (!r.ok) throw new Error(await detail(r));
      saveBlob(await r.blob(), r, `${name}.${format}`);
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  // ---------------------------------------------------------------- events

  function setFile(f) {
    if (!f) return;
    file = f;
    imageId = null;
    palette = null;
    spotInks = null;
    loupeAt = null;
    $("loupe").hidden = true;
    const url = URL.createObjectURL(f);
    $("thumb").src = url;
    $("thumb").hidden = false;
    $("original").src = url;
    $("dropText").hidden = true;
    $("clearPicture").hidden = false;
    const base = f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
    if (base) $("name").value = base;
    changed();
  }

  function clearPicture() {
    file = null;
    imageId = null;
    loupeAt = null;
    $("loupe").hidden = true;
    $("thumb").hidden = true;
    $("dropText").hidden = false;
    $("clearPicture").hidden = true;
    $("file").value = "";
    changed();
  }

  function bind() {
    $("file").addEventListener("change", (e) => setFile(e.target.files[0]));
    const drop = $("drop");
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));
    $("stage").addEventListener("dragover", (e) => e.preventDefault());
    $("stage").addEventListener("drop", (e) => { e.preventDefault(); setFile(e.dataTransfer.files[0]); });

    for (const k of SLIDERS) $(k).addEventListener("input", () => {
      opts[k] = parseFloat($(k).value);
      if (k === "spot_colors") spotInks = null;
      opts._preset = null;
      changed();
    });
    for (const k of CHECKS) $(k).addEventListener("change", () => {
      opts[k] = $(k).checked;
      opts._preset = null;
      if (k === "remove_background") $("bgTolRow").hidden = !opts[k];
      changed();
    });
    for (const k of SELECTS) $(k).addEventListener("change", () => {
      opts[k] = $(k).value;
      opts._preset = null;
      if (k === "target") {
        const t = catalog.targets.find((x) => x.id === opts.target);
        if (t && (opts.lpi < t.lpi[0] || opts.lpi > t.lpi[1]) && !catalog.styles.find((s) => s.id === opts.style).grain) {
          opts.lpi = Math.round((t.lpi[0] + t.lpi[1]) / 2);
        }
      }
      syncUI();
      changed();
    });
    $("width").addEventListener("input", changed);
    $("dpi").addEventListener("change", changed);
    $("units").addEventListener("change", () => {
      const w = parseFloat($("width").value) || 10;
      $("width").value = fmt($("units").value === "cm" ? w * 2.54 : w / 2.54, 1);
      changed();
    });
    $("garment").addEventListener("input", (e) => setGarment(e.target.value));
    $("resetTone").addEventListener("click", () => {
      for (const k of TONE_KEYS) opts[k] = catalog.defaults[k];
      syncUI();
      changed();
    });
    $("reseed").addEventListener("click", () => {
      opts.seed = Math.floor(Math.random() * 1e6);
      changed();
    });
    $("texFile").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      texFile = f;
      tex.image = { type: "image", on: true, strength: 0.5, scale: 1, image_id: null };
      buildTextures();
      changed();
    });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
    $("preview").addEventListener("click", (e) => {
      const rect = $("preview").getBoundingClientRect();
      loupeAt = { fx: (e.clientX - rect.left) / rect.width, fy: (e.clientY - rect.top) / rect.height };
      $("stageHint").hidden = true;
      renderLoupe();
    });
    $("loupe").addEventListener("click", () => { loupeAt = null; $("loupe").hidden = true; });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { loupeAt = null; $("loupe").hidden = true; }
    });
    $("dlPng").addEventListener("click", (e) => download("png", e.currentTarget));
    $("dlZip").addEventListener("click", (e) => download("zip", e.currentTarget));
    $("clearPicture").addEventListener("click", clearPicture);
    $("addText").addEventListener("click", () => {
      opts.text = opts.text || [];
      opts.text.push({ ...TEXT_DEFAULT, y: file ? -0.75 : 0, color: opts.text.length ? opts.text[0].color : "#000000" });
      buildText();
      changed();
    });
    $("batchFiles").addEventListener("change", (e) => {
      for (const f of e.target.files) {
        batch.push({ file: f, id: null, url: URL.createObjectURL(f),
          name: f.name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "design" });
      }
      e.target.value = "";
      buildBatchList();
    });
    $("dlBatch").addEventListener("click", (e) => downloadBatch(e.currentTarget));
  }

  async function init() {
    catalog = await (await fetch("/api/tone/catalog")).json();
    buildSelect("mode", catalog.modes);
    buildSelect("style", catalog.styles);
    buildSelect("target", catalog.targets);
    buildSelect("shirt_fit", catalog.shirt_fits);
    buildPresets();
    buildGarments();
    opts = structuredClone(catalog.defaults);
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
      if (saved) {
        for (const [k, v] of Object.entries(saved.opts || {})) {
          if (k in catalog.defaults || k === "_preset") opts[k] = v;  // drop keys from older versions
        }
        tex = saved.tex || {};
        $("width").value = saved.width || 10;
        $("units").value = saved.units || "in";
        $("dpi").value = saved.dpi || "300";
      }
    } catch { /* ignore */ }
    if (!localStorage.getItem(STORE_KEY)) {
      const first = catalog.presets[0];
      opts = { ...opts, ...structuredClone(first.options), _preset: first.id };
      for (const t of first.options.textures || []) tex[t.type] = { type: t.type, on: true, strength: t.strength, scale: t.scale };
    }
    bind();
    syncUI();
  }

  init().catch((e) => showError(`Couldn't load: ${e.message}`));
})();
