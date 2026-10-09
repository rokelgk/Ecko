"use strict";

const $ = (id) => document.getElementById(id);
const MM_PER_IN = 25.4;
const THREAD_MM = 0.38;

const state = {
  catalog: null,
  file: null,
  image: null,
  result: null,
  colors: [],          // current thread colors (hex) per block
  view: "real",
  garment: "#f4f1ea",
  progress: 1,         // 0..1 of stitches shown
  zoom: 1, panX: 0, panY: 0,
  highlight: -1,
  playing: false,
};

// ------------------------------------------------------------ preferences

const PREF_KEY = "ecko.prefs.v1";
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch { return {}; }
}
function savePrefs() {
  const p = {
    brand: $("brand").value, model: $("model").value, hoop: $("hoop").value,
    hoopW: $("hoopW").value, hoopH: $("hoopH").value,
    fabric: $("fabric").value, units: $("units").value,
  };
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
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
function updateFormatHint() {
  const b = currentBrand();
  const fmts = state.catalog.machines.formats;
  const main = fmts[b.formats[0]];
  $("formatHint").textContent = `Files will be saved as .${b.formats[0].toUpperCase()} (${main.description}). ` +
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
  const prefs = loadPrefs();

  $("brand").replaceChildren(...state.catalog.machines.brands.map((b) => option(b.id, b.name)));
  if (prefs.brand && state.catalog.machines.brands.some((b) => b.id === prefs.brand)) $("brand").value = prefs.brand;
  fillModels(prefs.model);
  fillHoops(prefs.hoop);
  if (prefs.hoopW) $("hoopW").value = prefs.hoopW;
  if (prefs.hoopH) $("hoopH").value = prefs.hoopH;
  $("fabric").replaceChildren(...state.catalog.fabrics.map((f) => option(f.id, f.name)));
  if (prefs.fabric) $("fabric").value = prefs.fabric;
  if (prefs.units) { $("units").value = prefs.units; if (prefs.units === "mm") $("width").value = 100; }
  updateFormatHint();
  updateFabricTip();

  $("brand").addEventListener("change", () => { fillModels(); fillHoops(); updateFormatHint(); savePrefs(); render(); });
  $("model").addEventListener("change", () => { fillHoops(); savePrefs(); render(); });
  $("hoop").addEventListener("change", () => { $("customHoop").hidden = $("hoop").value !== "custom"; savePrefs(); render(); });
  $("hoopW").addEventListener("change", () => { savePrefs(); render(); });
  $("hoopH").addEventListener("change", () => { savePrefs(); render(); });
  $("fabric").addEventListener("change", () => {
    updateFabricTip();
    // Caps go on a cap frame: switch to it when the machine has one.
    if ($("fabric").value === "cap" && currentModel().hoops.some((h) => h.id === "cap")) {
      $("hoop").value = "cap"; $("customHoop").hidden = true; render();
    }
    savePrefs();
  });
  $("units").addEventListener("change", onUnits);
  $("fitHoop").addEventListener("click", fitToHoop);
  $("go").addEventListener("click", runDigitize);
  $("download").addEventListener("click", () => download(currentBrand().formats[0]));
  $("altFormat").addEventListener("change", (e) => { if (e.target.value) download(e.target.value); e.target.value = ""; });
  $("rotate").addEventListener("change", render);
  setupUpload();
  setupCanvas();
}

// ------------------------------------------------------------ size helpers

function widthMm() {
  const v = parseFloat($("width").value);
  if (!(v > 0)) return null;
  return $("units").value === "in" ? v * MM_PER_IN : v;
}
function setWidthMm(mm) {
  $("width").value = $("units").value === "in" ? (mm / MM_PER_IN).toFixed(2) : mm.toFixed(0);
}
function onUnits() {
  const v = parseFloat($("width").value) || 0;
  $("width").value = $("units").value === "in" ? (v / MM_PER_IN).toFixed(2) : (v * MM_PER_IN).toFixed(0);
  savePrefs();
  if (state.result) renderResults();
}
function fmtLen(mm) {
  return $("units").value === "in" ? `${(mm / MM_PER_IN).toFixed(2)}"` : `${mm.toFixed(0)} mm`;
}
function fitToHoop() {
  const hoop = currentHoop();
  const margin = 0.95;
  if (state.result) {
    const p = state.result.preview;
    const s = Math.min(hoop.width_mm / p.width_mm, hoop.height_mm / p.height_mm) * margin;
    setWidthMm(p.width_mm * s);
    runDigitize();
  } else if (state.image) {
    const ar = state.image.naturalHeight / state.image.naturalWidth;
    setWidthMm(Math.min(hoop.width_mm, hoop.height_mm / ar) * margin);
  } else {
    setWidthMm(hoop.width_mm * margin);
  }
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
}

function setFile(file) {
  if (!file.type.startsWith("image/")) { showError("Please choose an image file (PNG, JPG or WebP)."); return; }
  state.file = file;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { state.image = img; if (state.view === "original") render(); };
  img.src = url;
  $("thumb").src = url; $("thumb").hidden = false; $("dropText").hidden = true;
  $("go").disabled = false;
  showError("");
}

function showError(msg) {
  $("error").textContent = msg;
  $("error").hidden = !msg;
}

// ------------------------------------------------------------ digitize

function options() {
  const hoop = $("hoop").value;
  const o = {
    brand: $("brand").value,
    model: $("model").value,
    hoop: hoop === "custom" ? null : hoop,
    fabric: $("fabric").value,
    width_mm: widthMm(),
    detail: +$("detail").value,
    density: +$("density").value,
    remove_background: $("removeBg").checked,
  };
  if (hoop === "custom") { o.hoop_width_mm = +$("hoopW").value; o.hoop_height_mm = +$("hoopH").value; }
  if ($("colors").value) o.colors = +$("colors").value;
  if ($("underlay").value) o.underlay = $("underlay").value;
  return o;
}

async function runDigitize() {
  if (!state.file) return;
  showError("");
  $("busy").hidden = false; $("empty").hidden = true; $("go").disabled = true;
  const fd = new FormData();
  fd.append("file", state.file);
  fd.append("options", JSON.stringify(options()));
  try {
    const res = await fetch("api/digitize", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Something went wrong (${res.status}).`);
    state.result = data;
    state.colors = data.preview.blocks.map((b) => b.color);
    state.progress = 1; state.zoom = 1; state.panX = 0; state.panY = 0;
    $("progress").value = 1000;
    if (state.view === "original") setView("real");
    renderResults();
    render();
  } catch (err) {
    showError(err.message);
  } finally {
    $("busy").hidden = true; $("go").disabled = false;
  }
}

// ------------------------------------------------------------ results panel

function renderResults() {
  const r = state.result;
  if (!r) return;
  $("results").hidden = false; $("sim").hidden = false;
  const s = r.report.stats;

  const score = r.report.score;
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

  const items = r.report.warnings.map((w) => {
    const li = document.createElement("li");
    li.className = w.level;
    li.textContent = w.message;
    if (w.code === "hoop_too_small" && w.suggested_width_mm) {
      const b = document.createElement("button");
      b.className = "link"; b.type = "button";
      b.textContent = `Resize to ${fmtLen(w.suggested_width_mm)} and redo`;
      b.onclick = () => { setWidthMm(w.suggested_width_mm); runDigitize(); };
      li.append(document.createElement("br"), b);
    }
    if (w.code === "hoop_rotate") {
      const b = document.createElement("button");
      b.className = "link"; b.type = "button";
      b.textContent = "Rotate it in the file";
      b.onclick = () => { $("rotate").checked = true; render(); };
      li.append(document.createElement("br"), b);
    }
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "ok"; li.textContent = "No problems found.";
    items.push(li);
  }
  for (const t of r.report.tips) {
    const li = document.createElement("li");
    li.textContent = "Tip: " + t;
    items.push(li);
  }
  $("warnings").replaceChildren(...items);

  $("threads").replaceChildren(...r.preview.blocks.map((b, i) => {
    const li = document.createElement("li");
    const pick = document.createElement("input");
    pick.type = "color"; pick.value = state.colors[i];
    pick.setAttribute("aria-label", `Thread ${i + 1} color`);
    pick.addEventListener("input", () => { state.colors[i] = pick.value; render(); });
    const name = document.createElement("span");
    name.textContent = b.name;
    const kinds = Object.entries(b.kinds).map(([k, n]) => `${n} ${k}`).join(", ");
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${b.stitches.toLocaleString()} st · ${kinds}`;
    li.append(pick, name, meta);
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
  if (!state.result) return;
  const base = (state.file?.name || "design").replace(/\.[^.]+$/, "");
  const q = new URLSearchParams({
    format: fmt,
    colors: state.colors.join(","),
    rotate: $("rotate").checked ? "true" : "false",
    name: base,
  });
  const a = document.createElement("a");
  a.href = `api/designs/${state.result.id}/file?${q}`;
  a.download = `${base}.${fmt}`;
  document.body.append(a); a.click(); a.remove();
}

// ------------------------------------------------------------ canvas

let canvas, ctx;

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

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    state.panX += e.clientX - drag.x; state.panY += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    render();
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("dblclick", () => { state.zoom = 1; state.panX = 0; state.panY = 0; render(); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left - rect.width / 2 - state.panX;
    const my = e.clientY - rect.top - rect.height / 2 - state.panY;
    const f = Math.exp(-e.deltaY * 0.0015);
    const nz = Math.min(40, Math.max(0.5, state.zoom * f));
    const k = nz / state.zoom;
    state.panX -= mx * (k - 1); state.panY -= my * (k - 1);
    state.zoom = nz;
    render();
  }, { passive: false });

  $("progress").addEventListener("input", (e) => { state.progress = e.target.value / 1000; stopPlay(); render(); });
  $("play").addEventListener("click", () => (state.playing ? stopPlay() : startPlay()));
}

function setView(v) {
  state.view = v;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  render();
}

function startPlay() {
  if (!state.result) return;
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

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
  else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
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
  const r = state.result;
  $("empty").hidden = !!r;
  if (!r) return;

  const p = r.preview;
  const hoop = currentHoop() || p.hoop;
  const rot = $("rotate").checked;
  const dw = rot ? p.height_mm : p.width_mm, dh = rot ? p.width_mm : p.height_mm;
  const viewW = Math.max(dw, hoop.width_mm) + 10, viewH = Math.max(dh, hoop.height_mm) + 10;
  const scale = Math.min(w / viewW, h / viewH) * state.zoom;
  ctx.translate(w / 2 + state.panX, h / 2 + state.panY);
  ctx.scale(scale, scale);
  if (rot) ctx.rotate(Math.PI / 2);

  // Hoop outline (drawn unrotated)
  ctx.save();
  if (rot) ctx.rotate(-Math.PI / 2);
  const fits = dw <= hoop.width_mm && dh <= hoop.height_mm;
  ctx.setLineDash([4 / scale * 2, 4 / scale * 2]);
  ctx.lineWidth = 1.5 / scale;
  ctx.strokeStyle = fits ? "rgba(120,120,120,.8)" : "rgba(200,30,30,.9)";
  ctx.beginPath();
  ctx.roundRect(-hoop.width_mm / 2, -hoop.height_mm / 2, hoop.width_mm, hoop.height_mm, 6);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  const total = p.blocks.reduce((a, b) => a + b.stitches, 0);
  let budget = Math.round(total * state.progress);
  let shown = 0;
  const real = state.view === "real";
  const t = Math.max(THREAD_MM, 0.7 / scale);
  ctx.lineCap = "round"; ctx.lineJoin = "round";

  let needle = null;
  p.blocks.forEach((b, bi) => {
    if (budget <= 0) return;
    const color = state.colors[bi] || b.color;
    const dim = state.highlight >= 0 && state.highlight !== bi;
    ctx.globalAlpha = dim ? 0.15 : 1;
    const passes = real
      ? [[t * 1.35, "rgba(0,0,0,0.28)", 0], [t, color, 0], [t * 0.35, shade(color, 0.45), -t * 0.18]]
      : [[0.8 / scale, color, 0]];
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
      // Show jumps/trims as dashed lines
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
  if (needle && state.progress < 1) {
    ctx.fillStyle = "#e11d48";
    ctx.beginPath(); ctx.arc(needle[0], needle[1], 4 / scale, 0, Math.PI * 2); ctx.fill();
  }
  $("progressLabel").textContent = `${shown.toLocaleString()} / ${total.toLocaleString()} stitches`;
}

init().catch((e) => showError("Couldn't load machine list: " + e.message));
