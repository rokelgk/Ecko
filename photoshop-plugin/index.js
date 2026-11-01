/* Ecko Tone panel for Photoshop (UXP). Halftones the selected layer with the built-in engine
   (tone-engine.js, the same one the stand-alone web page uses) and puts the result on a new
   layer at the same position. No server and no network access. */
const { app, core, imaging } = require("photoshop");
const E = require("./tone-engine.js");

const $ = (id) => document.getElementById(id);
const cat = E.CATALOG.api;
const fill = (id, items, label = (x) => x.name, value = (x) => x.id) => {
  $(id).innerHTML = items.map((x) => `<option value="${value(x)}">${label(x)}</option>`).join("");
};

function status(msg, isErr) {
  $("status").textContent = msg;
  $("status").className = isErr ? "err" : "";
}

// Photoshop's panel engine is picky: set slider values as both property and attribute, and read them
// back as numbers, so the thumb position and the number beside it always agree.
function setSlider(id, v) {
  const el = $(id);
  el.setAttribute("value", String(v));
  el.value = v;
}
const sliderValue = (id) => Number($(id).value);

function setText(id, text) {
  const el = $(id);
  el.textContent = text;
  el.innerHTML = text;   // older panel versions only repaint on innerHTML
}

function labels() {
  setText("lpiOut", String(Math.round(sliderValue("lpi"))));
  setText("angleOut", `${sliderValue("angle")}°`);
  setText("borderOut", `${Math.round(sliderValue("borderMm"))} mm`);
}

function applyPreset() {
  const p = cat.presets.find((x) => x.id === $("preset").value);
  if (!p) return;
  const o = { ...cat.defaults, ...p.options };
  $("style").value = o.style;
  setSlider("lpi", o.lpi);
  setSlider("angle", o.angle);
  $("target").value = o.target;
  if (p.options.garment) $("garment").value = p.options.garment;
  labels();
}

function options(doc, widthPx) {
  const p = cat.presets.find((x) => x.id === $("preset").value);
  const dpi = Math.round(Math.min(1200, Math.max(72, doc.resolution)));
  const o = {
    ...(p ? p.options : {}),
    style: $("style").value, lpi: sliderValue("lpi"), angle: sliderValue("angle"),
    target: $("target").value, garment: $("garment").value, shirt_fit: $("fit").value, dpi,
    border: $("border").value, border_shape: $("borderShape").value, border_mm: sliderValue("borderMm"),
    width_in: Math.max(0.5, widthPx / dpi), text: [],
  };
  // Image textures need a file picker; the web page has them. Procedural textures work here.
  o.textures = (o.textures || []).filter((t) => t.type !== "image");
  return E.parseOptions(o);
}

async function run() {
  const doc = app.activeDocument;
  if (!doc) return status("Open a document first.", true);
  const layer = doc.activeLayers[0];
  if (!layer) return status("Select a layer first.", true);
  status("Halftoning…");
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
      let opaque = true;
      for (let k = 3; k < rgba.length; k += 4) if (rgba[k] !== 255) { opaque = false; break; }

      let o = options(doc, width);
      o.remove_background = o.remove_background && opaque;   // a layer with transparency is already cut out
      const prep = E.prepare(rgba, width, height, o, null);
      o = E.parseOptions({ ...o, width_in: Math.max(0.5, prep.crop[2] / o.dpi) });   // 1:1 with the layer's pixels
      const out = E.renderFull(prep, o);

      const newLayer = await doc.createLayer({ name: `Ecko Tone (${$("preset").selectedOptions[0].text})` });
      const imageData = await imaging.createImageDataFromBuffer(new Uint8Array(out.rgba.buffer), {
        width: out.width, height: out.height, components: 4, chunky: true, colorSpace: "RGB", colorProfile: "sRGB IEC61966-2.1",
      });
      await imaging.putPixels({ documentID: doc.id, layerID: newLayer.id, imageData,
        targetBounds: { left: bounds.left + prep.crop[0], top: bounds.top + prep.crop[1] } });
      imageData.dispose();
      const fit = E.resolveFit(prep, o);
      status(["Done. The result is on a new layer.", ...fit.notes].join(" "));
    }, { commandName: "Ecko Tone halftone" });
  } catch (e) {
    status(e.message || String(e), true);
  }
}

fill("preset", cat.presets);
fill("style", cat.styles);
fill("target", cat.targets);
fill("fit", cat.shirt_fits);
fill("garment", cat.garments, (g) => g.name, (g) => g.hex);
fill("border", cat.borders);
fill("borderShape", cat.border_shapes);
$("borderMm").addEventListener("input", labels);
$("borderMm").addEventListener("change", labels);
$("preset").addEventListener("change", applyPreset);
for (const id of ["lpi", "angle"]) { $(id).addEventListener("input", labels); $(id).addEventListener("change", labels); }
$("run").addEventListener("click", run);
applyPreset();
