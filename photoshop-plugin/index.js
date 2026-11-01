/* Ecko Tone panel for Photoshop (UXP). Sends the selected layer's pixels to an Ecko server
   and places the halftoned result on a new layer at the same position. */
const { app, core, imaging } = require("photoshop");

const $ = (id) => document.getElementById(id);
let catalog = null;

function status(msg, isErr) {
  $("status").textContent = msg;
  $("status").className = isErr ? "err" : "";
}

function labels() {
  $("lpiOut").textContent = $("lpi").value;
  $("angleOut").textContent = `${$("angle").value}°`;
}

async function loadCatalog() {
  try {
    const r = await fetch(`${$("server").value.replace(/\/$/, "")}/api/tone/catalog`);
    catalog = await r.json();
    $("preset").innerHTML = catalog.presets.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    $("style").innerHTML = catalog.styles.map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
    $("target").innerHTML = catalog.targets.map((t) => `<option value="${t.id}">${t.name}</option>`).join("");
    applyPreset();
    status("");
  } catch (e) {
    status(`Can't reach the Ecko server: ${e.message}`, true);
  }
}

function applyPreset() {
  const p = catalog.presets.find((x) => x.id === $("preset").value);
  if (!p) return;
  const o = { ...catalog.defaults, ...p.options };
  $("style").value = o.style;
  $("lpi").value = o.lpi;
  $("angle").value = o.angle;
  $("target").value = o.target;
  labels();
}

function options(doc) {
  const p = catalog.presets.find((x) => x.id === $("preset").value);
  return {
    ...(p ? p.options : {}),
    style: $("style").value,
    lpi: parseFloat($("lpi").value),
    angle: parseFloat($("angle").value),
    target: $("target").value,
    dpi: Math.round(Math.min(1200, Math.max(72, doc.resolution))),
  };
}

async function run() {
  const doc = app.activeDocument;
  if (!doc) return status("Open a document first.", true);
  const layer = doc.activeLayers[0];
  if (!layer) return status("Select a layer first.", true);
  status("Reading layer…");
  try {
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

      status("Halftoning…");
      const q = new URLSearchParams({ width, height, options: JSON.stringify(options(doc)) });
      const r = await fetch(`${$("server").value.replace(/\/$/, "")}/api/tone/raw?${q}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: rgba.buffer,
      });
      if (!r.ok) {
        let msg = `Server error ${r.status}`;
        try { msg = (await r.json()).detail || msg; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      const out = new Uint8Array(await r.arrayBuffer());

      const newLayer = await doc.createLayer({ name: `Ecko Tone (${$("preset").selectedOptions[0].text})` });
      const imageData = await imaging.createImageDataFromBuffer(out, {
        width, height, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
      });
      await imaging.putPixels({ documentID: doc.id, layerID: newLayer.id, imageData,
        targetBounds: { left: bounds.left, top: bounds.top } });
      imageData.dispose();
    }, { commandName: "Ecko Tone halftone" });
    status("Done. The result is on a new layer.");
  } catch (e) {
    status(e.message || String(e), true);
  }
}

$("preset").addEventListener("change", applyPreset);
$("lpi").addEventListener("input", labels);
$("angle").addEventListener("input", labels);
$("server").addEventListener("change", loadCatalog);
$("run").addEventListener("click", run);
labels();
loadCatalog();
