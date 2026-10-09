"use strict";

const $ = (id) => document.getElementById(id);
const MM_PER_IN = 25.4;
const THREAD_MM = 0.38;
const PREF_KEY = "ecko.prefs.v2";
const RECENT_KEY = "ecko.recent.v1";
const CHARTS_KEY = "ecko.charts.v1";

const state = {
  catalog: null,
  file: null,          // picture chosen but not yet sent
  imageChanged: false, // picture added/removed since the design was created
  image: null,         // HTMLImageElement for the "Original" tab
  design: null,        // server state of the current design
  layers: [],          // lettering layers (options.text)
  selected: null,      // selected object id
  view: "real",
  garment: "#f4f1ea",
  progress: 1,
  zoom: 1, panX: 0, panY: 0,
  highlight: -1,
  playing: false,
  drag: null,          // text drag in progress
  customCharts: {},
  pickerBlock: -1,
};

// ------------------------------------------------------------ storage helpers

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode / full */ }
}
function savePrefs() {
  writeJSON(PREF_KEY, {
    brand: $("brand").value, model: $("model").value, hoop: $("hoop").value,
    hoopW: $("hoopW").value, hoopH: $("hoopH").value, chart: $("chart").value,
    fabric: $("fabric").value, units: $("units").value,
  });
}
function rememberDesign(id) {
  const ids = readJSON(RECENT_KEY, []).filter((x) => x !== id);
  ids.unshift(id);
  writeJSON(RECENT_KEY, ids.slice(0, 50));
}
function forgetDesign(id) {
  writeJSON(RECENT_KEY, readJSON(RECENT_KEY, []).filter((x) => x !== id));
}

// ------------------------------------------------------------ color helpers

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}
function lab(hex) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = hexToRgb(hex).map(lin);
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047);
  const y = f(r * 0.2126 + g * 0.7152 + b * 0.0722);
  const z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function colorDist(a, b) {
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
function shade(hex, amt) {
  let [r, g, b] = hexToRgb(hex);
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

// ------------------------------------------------------------ catalog / selects

function option(value, label) {
  const o = document.createElement("option");
  o.value = value; o.textContent = label;
  return o;
}
function currentBrand() {
  return state.catalog.machines.brands.find((b) => b.id === $("brand").value);
}
function currentModel() {
  const b = currentBrand();
  return b.models.find((m) => m.id === $("model").value) || b.models[0];
}
function currentHoop() {
  if ($("hoop").value === "custom") {
    return { name: "Custom hoop", width_mm: +$("hoopW").value, height_mm: +$("hoopH").value };
  }
  return currentModel().hoops.find((h) => h.id === $("hoop").value);
}
function fillModels(pref) {
  const sel = $("model");
  sel.replaceChildren(...currentBrand().models.map((m) => option(m.id, m.name)));
  if (pref && [...sel.options].some((o) => o.value === pref)) sel.value = pref;
}
function fillHoops(pref) {
  const sel = $("hoop");
  const hoops = currentModel().hoops;
  sel.replaceChildren(...hoops.map((h) => option(h.id, h.name)), option("custom", "Custom size…"));
  if (pref && [...sel.options].some((o) => o.value === pref)) sel.value = pref;
  else sel.value = hoops.reduce((a, b) => (a.width_mm * a.height_mm >= b.width_mm * b.height_mm ? a : b)).id;
  $("customHoop").hidden = sel.value !== "custom";
}
function brandChartId() {
  const map = { brother: "brother", "brother-pr": "brother", babylock: "brother", janome: "janome", husqvarna: "husqvarna", pfaff: "husqvarna" };
  return map[$("brand").value] || "generic";
}
function allCharts() {
  const out = {};
  for (const [id, c] of Object.entries(state.catalog.thread_charts)) out["builtin:" + id] = c;
  for (const [id, c] of Object.entries(state.customCharts)) out["custom:" + id] = c;
  return out;
}
function fillCharts(pref) {
  const sel = $("chart");
  const builtinName = state.catalog.thread_charts[brandChartId()].name;
  const opts = [option("", `Match my machine (${builtinName})`)];
  for (const [id, c] of Object.entries(state.catalog.thread_charts)) opts.push(option("builtin:" + id, c.name));
  for (const [id, c] of Object.entries(state.customCharts)) opts.push(option("custom:" + id, `${c.name} (imported)`));
  opts.push(option("import", "Import a thread chart (CSV/GPL)…"));
  sel.replaceChildren(...opts);
  if (pref !== undefined && [...sel.options].some((o) => o.value === pref)) sel.value = pref;
}
function updateFormatHint() {
  const b = currentBrand();
  const main = state.catalog.machines.formats[b.formats[0]];
  $("formatHint").textContent = `Files are saved as .${b.formats[0].toUpperCase()} (${main.description}). ` +
    (b.needles === "multi" ? "Multi-needle machine." : "Single-needle machine.");
}
function updateFabricTip() {
  const f = state.catalog.fabrics.find((x) => x.id === $("fabric").value);
  $("fabricTip").textContent = f ? f.tip : "";
}

async function init() {
  for (let i = 1; i <= 15; i++) $("colors").append(option(String(i), i === 1 ? "1 color" : `${i} colors`));
  const res = await fetch("api/catalog");
  state.catalog = await res.json();
  state.customCharts = readJSON(CHARTS_KEY, {});
  const prefs = readJSON(PREF_KEY, {});

  $("brand").replaceChildren(...state.catalog.machines.brands.map((b) => option(b.id, b.name)));
  if (prefs.brand && state.catalog.machines.brands.some((b) => b.id === prefs.brand)) $("brand").value = prefs.brand;
  fillModels(prefs.model);
  fillHoops(prefs.hoop);
  if (prefs.hoopW) $("hoopW").value = prefs.hoopW;
  if (prefs.hoopH) $("hoopH").value = prefs.hoopH;
  fillCharts(prefs.chart);
  $("fabric").replaceChildren(...state.catalog.fabrics.map((f) => option(f.id, f.name)));
  if (prefs.fabric) $("fabric").value = prefs.fabric;
  if (prefs.units) { $("units").value = prefs.units; if (prefs.units === "mm") $("width").value = 100; }
  $("pickerChart").replaceChildren(...Object.entries(allCharts()).map(([id, c]) => option(id, c.name)));
  updateFormatHint();
  updateFabricTip();
  bindForm();
  setupUpload();
  setupCanvas();
  setupPicker();
  setupEditor();
  setupRecent();
  renderLayers();
  updateGo();

  const m = location.hash.match(/d=([0-9a-f]{32})/);
  if (m) loadDesign(m[1]);
}

function bindForm() {
  const onMachine = () => { updateFormatHint(); savePrefs(); render(); scheduleUpdate(); };
  $("brand").addEventListener("change", () => { fillModels(); fillHoops(); fillCharts($("chart").value); onMachine(); });
  $("model").addEventListener("change", () => { fillHoops(); onMachine(); });
  $("hoop").addEventListener("change", () => { $("customHoop").hidden = $("hoop").value !== "custom"; onMachine(); });
  $("hoopW").addEventListener("change", onMachine);
  $("hoopH").addEventListener("change", onMachine);
  $("chart").addEventListener("change", onChartChange);
  $("chartFile").addEventListener("change", onChartFile);
  $("fabric").addEventListener("change", () => {
    updateFabricTip();
    // Caps go on a cap frame: switch to it when the machine has one.
    if ($("fabric").value === "cap" && currentModel().hoops.some((h) => h.id === "cap")) {
      $("hoop").value = "cap"; $("customHoop").hidden = true;
    }
    savePrefs(); render(); scheduleUpdate();
  });
  $("units").addEventListener("change", onUnits);
  $("width").addEventListener("change", () => scheduleUpdate());
  for (const id of ["colors", "detail", "density", "underlay", "removeBg"]) $(id).addEventListener("change", () => scheduleUpdate());
  $("fitHoop").addEventListener("click", fitToHoop);
  $("go").addEventListener("click", digitize);
  $("addText").addEventListener("click", () => {
    state.layers.push({ text: "Your text", font: "block", height_mm: 15, color: "#000000", x_mm: null, y_mm: null });
    renderLayers(); updateGo(); scheduleUpdate();
  });
  $("download").addEventListener("click", () => download(currentBrand().formats[0]));
  $("altFormat").addEventListener("change", (e) => { if (e.target.value) download(e.target.value); e.target.value = ""; });
  $("rotate").addEventListener("change", render);
  $("designName").addEventListener("change", () => state.design && patch({ name: $("designName").value }));
  $("copyLink").addEventListener("click", copyLink);
  $("newDesign").addEventListener("click", newDesign);
}

// ------------------------------------------------------------ units

function inches() { return $("units").value === "in"; }
function toMm(v) { return inches() ? v * MM_PER_IN : v; }
function fromMm(mm) { return inches() ? +(mm / MM_PER_IN).toFixed(2) : +mm.toFixed(1); }
function fmtLen(mm) { return inches() ? `${(mm / MM_PER_IN).toFixed(2)}"` : `${mm.toFixed(0)} mm`; }
function widthMm() {
  const v = parseFloat($("width").value);
  return v > 0 ? toMm(v) : null;
}
function setWidthMm(mm) { $("width").value = fromMm(mm); }
function onUnits() {
  const v = parseFloat($("width").value) || 0;
  $("width").value = inches() ? (v / MM_PER_IN).toFixed(2) : (v * MM_PER_IN).toFixed(0);
  savePrefs();
  renderLayers();
  if (state.design) renderResults();
}
function fitToHoop() {
  const hoop = currentHoop();
  if (state.design) {
    const p = state.design.preview;
    applyScale(Math.min(hoop.width_mm / p.width_mm, hoop.height_mm / p.height_mm) * 0.95);
  } else if (state.image) {
    const ar = state.image.naturalHeight / state.image.naturalWidth;
    setWidthMm(Math.min(hoop.width_mm, hoop.height_mm / ar) * 0.95);
  } else {
    setWidthMm(hoop.width_mm * 0.95);
  }
}
function applyScale(scale) {
  // Scale picture and lettering together, keeping their layout.
  const w = widthMm();
  if (w && hasPicture()) setWidthMm(w * scale);
  for (const l of state.layers) {
    l.height_mm = Math.max(3, l.height_mm * scale);
    if (l.x_mm != null) { l.x_mm *= scale; l.y_mm *= scale; }
  }
  renderLayers();
  digitize();
}

// ------------------------------------------------------------ lettering layers

function renderLayers() {
  const tpl = $("layerTpl");
  const fonts = state.catalog ? state.catalog.fonts : [];
  $("layers").replaceChildren(...state.layers.map((layer, i) => {
    const el = tpl.content.firstElementChild.cloneNode(true);
    const ta = el.querySelector("textarea");
    ta.value = layer.text;
    ta.addEventListener("input", () => { layer.text = ta.value; scheduleUpdate(); });
    const font = el.querySelector(".font");
    font.replaceChildren(...fonts.map((f) => option(f.id, f.name)));
    font.value = layer.font;
    font.addEventListener("change", () => { layer.font = font.value; scheduleUpdate(); });
    const h = el.querySelector(".height");
    h.value = fromMm(layer.height_mm);
    h.addEventListener("change", () => {
      const v = toMm(parseFloat(h.value) || 0);
      layer.height_mm = Math.min(300, Math.max(3, v));
      h.value = fromMm(layer.height_mm);
      scheduleUpdate();
    });
    el.querySelector(".height").closest("label").firstChild.textContent = `Letter height (${inches() ? "in" : "mm"}) `;
    const c = el.querySelector(".color");
    c.value = layer.color;
    c.addEventListener("change", () => { layer.color = c.value; scheduleUpdate(); });
    el.querySelector(".center").addEventListener("click", () => { layer.x_mm = null; layer.y_mm = null; scheduleUpdate(); });
    el.querySelector(".remove").addEventListener("click", () => {
      state.layers.splice(i, 1); renderLayers(); updateGo(); scheduleUpdate();
    });
    return el;
  }));
}

// ------------------------------------------------------------ upload

function setupUpload() {
  const drop = $("drop");
  $("file").addEventListener("change", (e) => e.target.files[0] && setFile(e.target.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });
  window.addEventListener("paste", (e) => {
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith("image/"));
    if (f) setFile(f);
  });
  $("clearPicture").addEventListener("click", () => {
    state.file = null; state.image = null; state.imageChanged = true;
    showPicture(null);
    updateGo();
  });
}

function showPicture(url) {
  $("thumb").hidden = !url; $("dropText").hidden = !!url; $("clearPicture").hidden = !url;
  if (url) $("thumb").src = url; else $("thumb").removeAttribute("src");
  $("sizeStep").classList.toggle("muted", !url);
}

function setFile(file) {
  if (!file.type.startsWith("image/")) { showError("Please choose an image file (PNG, JPG or WebP)."); return; }
  state.file = file; state.imageChanged = true;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { state.image = img; if (state.view === "original") render(); };
  img.src = url;
  showPicture(url);
  showError("");
  updateGo();
}

// Server-side lettering indices skip empty layers; map them back to ours.
function localLayer(serverIndex) {
  return state.layers.filter((l) => l.text.trim())[serverIndex];
}

function hasPicture() {
  return !!state.file || (!state.imageChanged && !!state.design?.has_image);
}

function updateGo() {
  const ready = hasPicture() || state.layers.some((l) => l.text.trim());
  $("go").disabled = !ready;
  $("go").textContent = state.design && !state.imageChanged ? "Update design" : "Digitize";
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

// ------------------------------------------------------------ talking to the server

function collectOptions() {
  const hoop = $("hoop").value;
  const chart = $("chart").value;
  const o = {
    brand: $("brand").value,
    model: $("model").value,
    hoop: hoop === "custom" ? null : hoop,
    hoop_width_mm: hoop === "custom" ? +$("hoopW").value : null,
    hoop_height_mm: hoop === "custom" ? +$("hoopH").value : null,
    fabric: $("fabric").value,
    width_mm: hasPicture() ? widthMm() : null,
    colors: $("colors").value ? +$("colors").value : null,
    detail: +$("detail").value,
    density: +$("density").value,
    underlay: $("underlay").value || null,
    remove_background: $("removeBg").checked,
    thread_chart: chart.startsWith("builtin:") ? chart.slice(8) : null,
    text: state.layers.filter((l) => l.text.trim()).map((l) => ({ ...l })),
  };
  return o;
}

let updateTimer = null;
function scheduleUpdate() {
  updateGo();
  if (!state.design || state.imageChanged) return;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(() => digitize(), 500);
}

let busyCount = 0;
function busy(on, text) {
  busyCount += on ? 1 : -1;
  $("busy").hidden = busyCount <= 0;
  if (text) $("busyText").textContent = text;
}

async function request(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(typeof d === "string" ? d : `Something went wrong (${res.status}).`);
  }
  return data;
}

let seq = 0;
async function run(promiseFn, text) {
  const my = ++seq;
  showError("");
  busy(true, text);
  try {
    const data = await promiseFn();
    if (my === seq) setDesign(data);   // ignore stale responses
    return data;
  } catch (err) {
    if (my === seq) showError(err.message);
  } finally {
    busy(false);
  }
}

async function digitize() {
  if ($("go").disabled) return;
  clearTimeout(updateTimer);
  if (!state.design || state.imageChanged) {
    const fd = new FormData();
    if (state.file) fd.append("file", state.file);
    fd.append("options", JSON.stringify(collectOptions()));
    fd.append("name", $("designName").value || state.file?.name || (state.layers[0]?.text.split("\n")[0] ?? "Lettering"));
    const data = await run(() => request("api/designs", { method: "POST", body: fd }), "Digitizing…");
    if (data) {
      state.file = null; state.imageChanged = false;
      rememberDesign(data.id);
      history.replaceState(null, "", "#d=" + data.id);
      state.zoom = 1; state.panX = 0; state.panY = 0;
      if (state.view === "original") setView("real");
      await applyCustomChart();
    }
  } else {
    await patch({ options: collectOptions() });
  }
  updateGo();
}

function patch(body, text = "Updating…") {
  const id = state.design.id;
  return run(() => request(`api/designs/${id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), text);
}

function editsCopy() {
  return structuredClone(state.design.edits);
}

function setDesign(data) {
  const prevId = state.design?.id;
  state.design = data;
  if (prevId !== data.id) {
    // Opening a different design: take its lettering. Otherwise keep the
    // local layers, which may hold typing that hasn't been sent yet.
    state.layers = (data.options.text || []).map((l) => ({ ...l }));
    state.selected = null;
    renderLayers();
  }
  if (state.selected != null && !data.preview.objects.some((o) => o.id === state.selected)) state.selected = null;
  state.progress = 1; $("progress").value = 1000;
  $("designName").value = data.name;
  $("autoHint").hidden = false;
  renderResults();
  renderEditor();
  render();
}

// ------------------------------------------------------------ thread charts

function parseChart(text) {
  // Accepts CSV (code,name,#hex or r,g,b) and GIMP .gpl palettes.
  const threads = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") && !/^#[0-9a-f]{6}\b/i.test(line) || /^(GIMP|Name:|Columns:)/i.test(line)) continue;
    let hex = null, rest = line;
    const hm = line.match(/#?\b([0-9a-f]{6})\b/i);
    const gpl = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*(.*)$/);
    const csvRgb = line.match(/(^|[,;\t])\s*(\d{1,3})\s*[,;\t]\s*(\d{1,3})\s*[,;\t]\s*(\d{1,3})\s*([,;\t]|$)/);
    if (gpl) { hex = rgbToHex(+gpl[1], +gpl[2], +gpl[3]); rest = gpl[4]; }
    else if (hm) { hex = "#" + hm[1].toLowerCase(); rest = line.replace(hm[0], ""); }
    else if (csvRgb) { hex = rgbToHex(+csvRgb[2], +csvRgb[3], +csvRgb[4]); rest = line.replace(csvRgb[0], ","); }
    if (!hex) continue;
    const parts = rest.split(/[,;\t]/).map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const code = parts.find((p) => /\d/.test(p) && p.length <= 12) || "";
    const name = parts.find((p) => p !== code) || code || hex;
    threads.push({ hex, name: name.slice(0, 60), code: code.slice(0, 60), brand: "" });
  }
  return threads;
}

async function onChartFile(e) {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) { fillCharts(""); return; }
  const threads = parseChart(await f.text());
  if (threads.length < 3) { showError("We couldn't find thread colors in that file. Use CSV with a hex color per line, or a .gpl palette."); fillCharts(""); return; }
  const name = f.name.replace(/\.[^.]+$/, "").slice(0, 40);
  threads.forEach((t) => { t.brand = name; });
  const id = Date.now().toString(36);
  state.customCharts[id] = { name, threads };
  writeJSON(CHARTS_KEY, state.customCharts);
  fillCharts("custom:" + id);
  $("pickerChart").replaceChildren(...Object.entries(allCharts()).map(([cid, c]) => option(cid, c.name)));
  savePrefs();
  onChartChange();
}

function nearestThread(chart, hex) {
  let best = null, bd = Infinity;
  for (const t of chart.threads) { const d = colorDist(t.hex, hex); if (d < bd) { bd = d; best = t; } }
  return best;
}

async function applyCustomChart() {
  const v = $("chart").value;
  if (!state.design || !v.startsWith("custom:")) return;
  const chart = state.customCharts[v.slice(7)];
  if (!chart) return;
  const edits = editsCopy();
  edits.threads = {};
  state.design.preview.palette.forEach((hex, i) => { edits.threads[i] = nearestThread(chart, hex); });
  await patch({ edits });
}

async function onChartChange() {
  const v = $("chart").value;
  if (v === "import") { $("chartFile").click(); return; }
  savePrefs();
  if (!state.design || state.imageChanged) return;
  if (v.startsWith("custom:")) { await applyCustomChart(); return; }
  const edits = editsCopy();
  edits.threads = {};
  await patch({ options: collectOptions(), edits });
}

// ------------------------------------------------------------ thread picker

function setupPicker() {
  $("pickerClose").addEventListener("click", closePicker);
  $("pickerChart").addEventListener("change", renderPicker);
  $("pickerSearch").addEventListener("input", renderPicker);
  $("pickerCustom").addEventListener("change", () => setBlockThread({ hex: $("pickerCustom").value, name: "Custom", code: "", brand: "" }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
  document.addEventListener("pointerdown", (e) => {
    if (!$("picker").hidden && !$("picker").contains(e.target) && !e.target.closest(".swatchBtn")) closePicker();
  });
}

function openPicker(blockIndex, anchor) {
  state.pickerBlock = blockIndex;
  const v = $("chart").value;
  $("pickerChart").value = v && v !== "import" ? v : "builtin:" + state.design.thread_chart;
  $("pickerSearch").value = "";
  $("pickerCustom").value = state.design.preview.blocks[blockIndex].color;
  const r = anchor.getBoundingClientRect();
  const p = $("picker");
  p.hidden = false;
  const left = Math.min(window.innerWidth - p.offsetWidth - 8, Math.max(8, r.left));
  p.style.left = left + window.scrollX + "px";
  p.style.top = r.bottom + window.scrollY + 6 + "px";
  renderPicker();
}
function closePicker() { $("picker").hidden = true; state.pickerBlock = -1; }

function renderPicker() {
  if (state.pickerBlock < 0) return;
  const chart = allCharts()[$("pickerChart").value];
  if (!chart) return;
  const target = state.design.preview.blocks[state.pickerBlock].color;
  const q = $("pickerSearch").value.trim().toLowerCase();
  const list = chart.threads
    .filter((t) => !q || t.name.toLowerCase().includes(q) || String(t.code).toLowerCase().includes(q))
    .map((t) => ({ t, d: colorDist(t.hex, target) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 120);
  $("pickerGrid").replaceChildren(...list.map(({ t }) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "sw";
    b.style.background = t.hex;
    b.title = `${t.name}${t.code ? " · " + t.code : ""}`;
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", () => setBlockThread(t));
    return b;
  }));
}

function setBlockThread(t) {
  const block = state.design.preview.blocks[state.pickerBlock];
  if (!block) return;
  const edits = editsCopy();
  for (const p of block.palette) edits.threads[p] = { hex: t.hex, name: t.name, code: t.code || "", brand: t.brand || "" };
  closePicker();
  patch({ edits });
}

function moveBlock(i, dir) {
  const blocks = state.design.preview.blocks;
  const j = i + dir;
  if (j < 0 || j >= blocks.length) return;
  const order = blocks.map((b) => b.palette);
  [order[i], order[j]] = [order[j], order[i]];
  const edits = editsCopy();
  edits.color_order = order.flat();
  patch({ edits });
}

// ------------------------------------------------------------ results panel

function renderResults() {
  const d = state.design;
  if (!d) { $("results").hidden = true; $("sim").hidden = true; $("canvasHint").hidden = true; return; }
  $("results").hidden = false; $("sim").hidden = false; $("canvasHint").hidden = false;
  const s = d.report.stats;

  const score = d.report.score;
  $("score").textContent = score;
  $("scoreRing").className = "ring" + (score < 60 ? " err" : score < 90 ? " warn" : "");
  $("scoreTitle").textContent = score >= 90 ? "Ready to sew" : score >= 60 ? "Sewable. Check the notes" : "Needs a fix before sewing";
  const stat = (k, v) => { const li = document.createElement("li"); li.innerHTML = `${k} <b></b>`; li.querySelector("b").textContent = v; return li; };
  $("stats").replaceChildren(
    stat("Size", `${fmtLen(s.width_mm)} × ${fmtLen(s.height_mm)}`),
    stat("Stitches", s.stitches.toLocaleString()),
    stat("Colors", s.colors),
    stat("Trims", s.trims),
    stat("Sew time", `~${s.sew_minutes} min`),
    stat("Hoop", s.fits_hoop ? "Fits ✓" : "Too big"),
  );

  const action = (li, label, fn) => {
    const b = document.createElement("button");
    b.className = "link"; b.type = "button"; b.textContent = label; b.onclick = fn;
    li.append(document.createElement("br"), b);
  };
  const items = d.report.warnings.map((w) => {
    const li = document.createElement("li");
    li.className = w.level;
    li.textContent = w.message;
    if (w.code === "hoop_too_small" && w.scale) action(li, "Shrink it to fit", () => applyScale(w.scale));
    if (w.code === "hoop_rotate") action(li, "Rotate it in the file", () => { $("rotate").checked = true; render(); });
    const layer = w.code === "small_text" ? localLayer(w.layer) : null;
    if (layer) {
      const font = state.catalog.fonts.find((f) => f.id === layer.font);
      action(li, `Make it ${fmtLen(font.min_height_mm)} tall`, () => {
        layer.height_mm = font.min_height_mm; renderLayers(); digitize();
      });
    }
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "ok"; li.textContent = "No problems found.";
    items.push(li);
  }
  for (const t of d.report.tips) {
    const li = document.createElement("li");
    li.textContent = "Tip: " + t;
    items.push(li);
  }
  $("warnings").replaceChildren(...items);

  const blocks = d.preview.blocks;
  $("threads").replaceChildren(...blocks.map((b, i) => {
    const li = document.createElement("li");
    const sw = document.createElement("button");
    sw.type = "button"; sw.className = "swatchBtn";
    sw.style.background = b.color;
    sw.setAttribute("aria-label", `Change thread ${i + 1}`);
    sw.addEventListener("click", () => openPicker(i, sw));
    const name = document.createElement("span");
    name.className = "tname";
    const kinds = Object.entries(b.kinds).map(([k, n]) => `${n} ${k === "run" ? "running" : k}`).join(", ");
    name.innerHTML = "<b></b><small></small>";
    name.querySelector("b").textContent = b.name + (b.code ? ` · ${b.brand ? b.brand + " " : ""}#${b.code}` : "");
    name.querySelector("small").textContent = `${b.stitches.toLocaleString()} stitches · ${kinds}`;
    const up = document.createElement("button");
    up.type = "button"; up.className = "mini"; up.textContent = "↑"; up.disabled = i === 0;
    up.setAttribute("aria-label", "Sew earlier");
    up.addEventListener("click", () => moveBlock(i, -1));
    const down = document.createElement("button");
    down.type = "button"; down.className = "mini"; down.textContent = "↓"; down.disabled = i === blocks.length - 1;
    down.setAttribute("aria-label", "Sew later");
    down.addEventListener("click", () => moveBlock(i, 1));
    li.append(sw, name, up, down);
    li.addEventListener("mouseenter", () => { state.highlight = i; render(); });
    li.addEventListener("mouseleave", () => { state.highlight = -1; render(); });
    return li;
  }));

  const brand = currentBrand();
  const main = brand.formats[0];
  $("download").textContent = `Download for ${brand.name} (.${main.toUpperCase()})`;
  const fmts = state.catalog.machines.formats;
  $("altFormat").replaceChildren(option("", "Other formats…"),
    ...Object.keys(fmts).filter((f) => f !== main).map((f) => option(f, `.${f.toUpperCase()} (${fmts[f].description})`)));
}

function download(fmt) {
  if (!state.design) return;
  const q = new URLSearchParams({ format: fmt, rotate: $("rotate").checked ? "true" : "false" });
  const a = document.createElement("a");
  a.href = `api/designs/${state.design.id}/file?${q}`;
  a.download = "";
  document.body.append(a); a.click(); a.remove();
}

async function copyLink() {
  const url = location.href.split("#")[0] + "#d=" + state.design.id;
  try { await navigator.clipboard.writeText(url); $("copyLink").textContent = "Link copied ✓"; }
  catch { prompt("Copy this link:", url); }
  setTimeout(() => { $("copyLink").textContent = "Copy link to this design"; }, 2000);
}

// ------------------------------------------------------------ object editor

function selectedObject() {
  return state.design?.preview.objects.find((o) => o.id === state.selected) || null;
}

function setupEditor() {
  $("deselect").addEventListener("click", () => { state.selected = null; renderEditor(); render(); });
  document.querySelectorAll("#kindSeg button").forEach((b) => b.addEventListener("click", () => setObjEdit({ kind: b.dataset.kind })));
  $("angle").addEventListener("input", () => { $("angleVal").textContent = `${$("angle").value}°`; });
  $("angle").addEventListener("change", () => { $("angleAuto").checked = false; setObjEdit({ angle: +$("angle").value }); });
  $("angleAuto").addEventListener("change", () => setObjEdit({ angle: $("angleAuto").checked ? null : +$("angle").value }));
  $("objDensity").addEventListener("input", () => { $("objDensityVal").textContent = `${Math.round($("objDensity").value * 100)}%`; });
  $("objDensity").addEventListener("change", () => setObjEdit({ density: +$("objDensity").value === 1 ? null : +$("objDensity").value }));
  $("hideObj").addEventListener("click", () => {
    const o = selectedObject();
    setObjEdit({ hidden: o.hidden ? null : true });
  });
  $("resetObj").addEventListener("click", () => {
    const edits = editsCopy();
    delete edits.objects[state.selected];
    patch({ edits });
  });
}

function setObjEdit(changes) {
  if (state.selected == null) return;
  const edits = editsCopy();
  const cur = { ...(edits.objects[state.selected] || {}) };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null || v === undefined) delete cur[k]; else cur[k] = v;
  }
  if (Object.keys(cur).length) edits.objects[state.selected] = cur; else delete edits.objects[state.selected];
  patch({ edits });
}

const KIND_NAMES = { fill: "Fill", satin: "Satin column", run: "Running stitch" };
const KIND_HINTS = {
  fill: "Rows of stitches. Best for large areas.",
  satin: "Smooth, shiny zig-zag. Best for text, borders and shapes up to about 7 mm wide.",
  run: "A single (or triple) line. Best for fine detail and outlines.",
};

function renderEditor() {
  const o = selectedObject();
  $("editor").hidden = !o;
  if (!o) return;
  const e = state.design.edits.objects[o.id] || {};
  const kind = o.kind || e.kind || o.default_kind;
  const thread = state.design.preview.blocks.find((b) => b.palette.includes(o.color));
  $("editorTitle").textContent = `${o.source === "text" ? "Lettering" : "Shape"}: ${KIND_NAMES[kind]}` +
    (thread ? ` · ${thread.name}` : "") + (o.hidden ? " (not stitched)" : "");
  document.querySelectorAll("#kindSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.kind === kind);
    b.disabled = b.dataset.kind === "satin" && !o.satin_ok;
  });
  $("kindHint").textContent = KIND_HINTS[kind] + (o.satin_ok ? "" : " This shape is too wide for satin.");
  $("angleRow").hidden = kind !== "fill";
  $("angleAuto").checked = e.angle == null;
  $("angle").value = e.angle ?? 45;
  $("angleVal").textContent = e.angle == null ? "(auto)" : `${e.angle}°`;
  $("objDensity").value = e.density ?? 1;
  $("objDensityVal").textContent = `${Math.round((e.density ?? 1) * 100)}%`;
  $("hideObj").textContent = o.hidden ? "Stitch this shape again" : "Don't stitch this shape";
}

// ------------------------------------------------------------ my designs

function setupRecent() {
  $("myDesigns").addEventListener("click", async () => {
    const open = $("recent").hidden;
    $("recent").hidden = !open;
    $("myDesigns").setAttribute("aria-expanded", String(open));
    if (open) await renderRecent();
  });
}

async function renderRecent() {
  const ids = readJSON(RECENT_KEY, []);
  if (!ids.length) {
    const li = document.createElement("li");
    li.className = "hint"; li.textContent = "Designs you digitize show up here.";
    $("recentList").replaceChildren(li);
    return;
  }
  let designs = [];
  try { designs = (await request("api/designs?ids=" + ids.join(","))).designs; } catch (e) { showError(e.message); }
  const found = new Set(designs.map((d) => d.id));
  writeJSON(RECENT_KEY, ids.filter((id) => found.has(id)));
  $("recentList").replaceChildren(...designs.map((d) => {
    const li = document.createElement("li");
    const open = document.createElement("button");
    open.type = "button"; open.className = "recentItem";
    const when = new Date(d.updated * 1000).toLocaleDateString();
    open.innerHTML = "<strong></strong><span></span>";
    open.querySelector("strong").textContent = d.name;
    open.querySelector("span").textContent = d.stitches
      ? `${fmtLen(d.width_mm)} × ${fmtLen(d.height_mm)} · ${d.colors} colors · ${d.machine} · ${when}` : when;
    open.addEventListener("click", () => { $("recent").hidden = true; loadDesign(d.id); });
    const del = document.createElement("button");
    del.type = "button"; del.className = "mini"; del.textContent = "✕";
    del.setAttribute("aria-label", `Delete ${d.name}`);
    del.addEventListener("click", async () => {
      if (!confirm(`Delete "${d.name}"? This can't be undone.`)) return;
      try { await request(`api/designs/${d.id}`, { method: "DELETE" }); } catch (e) { showError(e.message); }
      forgetDesign(d.id);
      if (state.design?.id === d.id) newDesign();
      renderRecent();
    });
    li.append(open, del);
    return li;
  }));
}

async function loadDesign(id) {
  const data = await run(() => request(`api/designs/${id}`), "Opening…");
  if (!data) { forgetDesign(id); return; }
  rememberDesign(id);
  history.replaceState(null, "", "#d=" + id);
  const o = data.options;
  if (state.catalog.machines.brands.some((b) => b.id === o.brand)) $("brand").value = o.brand;
  fillModels(o.model);
  fillHoops(o.hoop_width_mm ? "custom" : o.hoop);
  if (o.hoop_width_mm) { $("hoopW").value = o.hoop_width_mm; $("hoopH").value = o.hoop_height_mm; }
  fillCharts(o.thread_chart ? "builtin:" + o.thread_chart : $("chart").value.startsWith("custom:") ? $("chart").value : "");
  $("fabric").value = o.fabric;
  if (o.width_mm) setWidthMm(o.width_mm);
  $("colors").value = o.colors ?? "";
  $("detail").value = o.detail; $("density").value = o.density;
  $("underlay").value = o.underlay ?? ""; $("removeBg").checked = o.remove_background;
  updateFormatHint(); updateFabricTip();
  state.file = null; state.imageChanged = false; state.image = null;
  state.zoom = 1; state.panX = 0; state.panY = 0;
  renderLayers();
  if (data.has_image) {
    const url = `api/designs/${id}/image`;
    const img = new Image();
    img.onload = () => { state.image = img; };
    img.src = url;
    showPicture(url);
  } else {
    showPicture(null);
  }
  updateGo();
}

function newDesign() {
  state.design = null; state.file = null; state.image = null; state.imageChanged = false;
  state.layers = []; state.selected = null;
  history.replaceState(null, "", location.pathname);
  $("designName").value = "";
  $("autoHint").hidden = true;
  showPicture(null);
  renderLayers(); renderResults(); renderEditor(); updateGo(); render();
}

// ------------------------------------------------------------ canvas

let canvas, ctx, view = null;

function setupCanvas() {
  canvas = $("canvas");
  ctx = canvas.getContext("2d");
  new ResizeObserver(render).observe($("canvasWrap"));

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll(".garment button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".garment button").forEach((x) => x.classList.toggle("on", x === b));
    state.garment = b.dataset.bg;
    $("canvasWrap").style.background = state.garment;
    render();
  }));

  let down = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const pt = toDesign(e);
    const hit = pt && state.view !== "original" ? hitTest(pt) : null;
    down = { x: e.clientX, y: e.clientY, moved: false, hit, start: pt,
             text: hit && hit.source === "text" && !hit.hidden ? hit.layer : null };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!down.moved && Math.hypot(dx, dy) < 4) return;
    down.moved = true;
    if (down.text != null) {
      const pt = toDesign(e);
      state.drag = { layer: down.text, dx: pt[0] - down.start[0], dy: pt[1] - down.start[1] };
    } else {
      state.panX += e.movementX; state.panY += e.movementY;
    }
    render();
  });
  canvas.addEventListener("pointerup", () => {
    if (!down) return;
    if (state.drag) {
      const box = state.design.preview.text_boxes[state.drag.layer];
      const [ox, oy] = state.design.preview.offset;
      const layer = localLayer(state.drag.layer);
      layer.x_mm = box.x_mm + state.drag.dx - ox;
      layer.y_mm = box.y_mm + state.drag.dy - oy;
      state.drag = null;
      digitize();
    } else if (!down.moved && state.design && state.view !== "original") {
      state.selected = down.hit ? down.hit.id : null;
      renderEditor(); render();
      if (down.hit) $("editor").scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    down = null;
  });
  canvas.addEventListener("dblclick", () => { state.zoom = 1; state.panX = 0; state.panY = 0; render(); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2 - state.panX;
    const my = e.clientY - rect.top - rect.height / 2 - state.panY;
    const nz = Math.min(40, Math.max(0.5, state.zoom * Math.exp(-e.deltaY * 0.0015)));
    const k = nz / state.zoom;
    state.panX -= mx * (k - 1); state.panY -= my * (k - 1);
    state.zoom = nz;
    render();
  }, { passive: false });

  $("progress").addEventListener("input", (e) => { state.progress = e.target.value / 1000; stopPlay(); render(); });
  $("play").addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));
}

function toDesign(e) {
  if (!view) return null;
  const rect = canvas.getBoundingClientRect();
  const sx = (e.clientX - rect.left - view.cx) / view.scale;
  const sy = (e.clientY - rect.top - view.cy) / view.scale;
  return view.rot ? [sy, -sx] : [sx, sy];
}

function inRings(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function hitTest([x, y]) {
  const hits = state.design.preview.objects.filter((o) => inRings(o.rings, x, y));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (a.area_mm2 <= b.area_mm2 ? a : b));
}

function setView(v) {
  state.view = v;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  render();
}

function startPlay() {
  if (!state.design) return;
  if (state.progress >= 1) state.progress = 0;
  state.playing = true; $("play").textContent = "❚❚";
  const step = () => {
    if (!state.playing) return;
    state.progress = Math.min(1, state.progress + 0.004);
    $("progress").value = Math.round(state.progress * 1000);
    render();
    if (state.progress >= 1) stopPlay(); else requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function stopPlay() { state.playing = false; $("play").textContent = "▶"; }

function strokeRings(rings, color, width, dash) {
  ctx.setLineDash(dash || []);
  ctx.strokeStyle = color; ctx.lineWidth = width;
  ctx.beginPath();
  for (const r of rings) {
    ctx.moveTo(r[0], r[1]);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1]);
    ctx.closePath();
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

function render() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  if (state.view === "original") {
    view = null;
    $("empty").hidden = !!state.image;
    if (state.image) {
      const im = state.image;
      const s = Math.min((w - 40) / im.naturalWidth, (h - 40) / im.naturalHeight) * state.zoom;
      ctx.drawImage(im, w / 2 + state.panX - im.naturalWidth * s / 2, h / 2 + state.panY - im.naturalHeight * s / 2,
        im.naturalWidth * s, im.naturalHeight * s);
    }
    $("progressLabel").textContent = "";
    return;
  }
  const d = state.design;
  $("empty").hidden = !!d;
  if (!d) { view = null; return; }

  const p = d.preview;
  const hoop = currentHoop() || p.hoop;
  const rot = $("rotate").checked;
  const dw = rot ? p.height_mm : p.width_mm, dh = rot ? p.width_mm : p.height_mm;
  const viewW = Math.max(dw, hoop.width_mm) + 10, viewH = Math.max(dh, hoop.height_mm) + 10;
  const scale = Math.min(w / viewW, h / viewH) * state.zoom;
  view = { cx: w / 2 + state.panX, cy: h / 2 + state.panY, scale, rot };
  ctx.translate(view.cx, view.cy);
  ctx.scale(scale, scale);

  // Hoop outline (never rotated: the hoop stays put, the design turns)
  const fits = dw <= hoop.width_mm && dh <= hoop.height_mm;
  strokeRings([[-hoop.width_mm / 2, -hoop.height_mm / 2, hoop.width_mm / 2, -hoop.height_mm / 2,
    hoop.width_mm / 2, hoop.height_mm / 2, -hoop.width_mm / 2, hoop.height_mm / 2]],
  fits ? "rgba(120,120,120,.8)" : "rgba(200,30,30,.9)", 1.5 / scale, [8 / scale, 8 / scale]);
  if (rot) ctx.rotate(Math.PI / 2);

  const total = p.blocks.reduce((a, b) => a + b.stitches, 0);
  let budget = Math.round(total * state.progress);
  let shown = 0;
  const real = state.view === "real";
  const t = Math.max(THREAD_MM, 0.7 / scale);
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  let needle = null;
  p.blocks.forEach((b, bi) => {
    if (budget <= 0) return;
    const dim = state.highlight >= 0 && state.highlight !== bi;
    ctx.globalAlpha = dim ? 0.15 : 1;
    const passes = real
      ? [[t * 1.35, "rgba(0,0,0,0.28)", 0], [t, b.color, 0], [t * 0.35, shade(b.color, 0.45), -t * 0.18]]
      : [[0.8 / scale, b.color, 0]];
    // Draw in short chunks so later stitches (top) cover earlier ones
    // (underlay), like real thread does.
    const CHUNK = real ? 120 : 1e9;
    let left = budget;
    for (const run of b.runs) {
      if (left <= 0) break;
      const n = Math.min(run.length / 2, left);
      for (let s = 0; s < n - 1; s += CHUNK) {
        const e = Math.min(n - 1, s + CHUNK);
        for (const [lw, style, off] of passes) {
          ctx.lineWidth = lw; ctx.strokeStyle = style;
          ctx.beginPath();
          ctx.moveTo(run[2 * s] + off, run[2 * s + 1] + off);
          for (let i = s + 1; i <= e; i++) ctx.lineTo(run[2 * i] + off, run[2 * i + 1] + off);
          ctx.stroke();
        }
      }
      left -= n;
      if (n > 0) needle = [run[2 * (n - 1)], run[2 * (n - 1) + 1]];
    }
    if (!real) {
      ctx.setLineDash([2 / scale, 3 / scale]);
      ctx.strokeStyle = "rgba(128,128,128,.7)"; ctx.lineWidth = 0.8 / scale;
      ctx.beginPath();
      for (let i = 1; i < b.runs.length; i++) {
        const a = b.runs[i - 1], c = b.runs[i];
        ctx.moveTo(a[a.length - 2], a[a.length - 1]); ctx.lineTo(c[0], c[1]);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    const used = Math.min(budget, b.stitches);
    budget -= used; shown += used;
  });
  ctx.globalAlpha = 1;

  // Shapes switched off, then the selection on top.
  for (const o of p.objects) if (o.hidden) strokeRings(o.rings, "rgba(128,128,128,.9)", 1 / scale, [3 / scale, 3 / scale]);
  const sel = selectedObject();
  if (sel) {
    strokeRings(sel.rings, "rgba(255,255,255,.9)", 3.5 / scale);
    strokeRings(sel.rings, "#c2410c", 2 / scale, [6 / scale, 4 / scale]);
  }
  if (state.drag) {
    const b = p.text_boxes[state.drag.layer];
    const x = b.x_mm + state.drag.dx - b.width_mm / 2, y = b.y_mm + state.drag.dy - b.height_mm / 2;
    strokeRings([[x, y, x + b.width_mm, y, x + b.width_mm, y + b.height_mm, x, y + b.height_mm]], "#c2410c", 2 / scale, [6 / scale, 4 / scale]);
  }
  if (needle && state.progress < 1) {
    ctx.fillStyle = "#e11d48";
    ctx.beginPath(); ctx.arc(needle[0], needle[1], 4 / scale, 0, Math.PI * 2); ctx.fill();
  }
  $("progressLabel").textContent = `${shown.toLocaleString()} / ${total.toLocaleString()} stitches`;
}

init().catch((e) => showError("Couldn't load: " + e.message));
