/* Photoshop host (UXP). Reads the active document, shows previews, and
   builds the separation document with one named spot channel per ink, in
   print order. Loaded in the browser too, where it does nothing. */
(function () {
  'use strict';
  let ps, uxp;
  try {
    if (typeof require !== 'function') return;
    ps = require('photoshop');
    uxp = require('uxp');
  } catch (e) {
    return; // not running inside Photoshop
  }
  const E = window.EckoEngine;
  const { app, core, action, imaging } = ps;
  const lfs = uxp.storage.localFileSystem;
  const formats = uxp.storage.formats;

  const modal = (name, fn) => core.executeAsModal(fn, { commandName: name });
  const rgbDesc = (hex) => {
    const [r, g, b] = E.color.parseHex(hex);
    return { _obj: 'RGBColor', red: r, grain: g, blue: b };
  };

  function descToHex(c) {
    if (!c) return null;
    if (c._obj === 'RGBColor') return E.color.toHex([c.red, c.grain !== undefined ? c.grain : c.green, c.blue]);
    if (c._obj === 'HSBColorClass') {
      const h = (c.hue && c.hue._value !== undefined ? c.hue._value : c.hue) / 60;
      const s = c.saturation / 100, v = c.brightness / 100;
      const i = Math.floor(h) % 6, f = h - Math.floor(h);
      const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
      const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
      return E.color.toHex(rgb.map((x) => x * 255));
    }
    return null;
  }

  // Spot channel names must be unique in a document.
  function uniqueNames(screens) {
    const seen = new Map();
    return screens.map((s) => {
      const n = (seen.get(s.name) || 0) + 1;
      seen.set(s.name, n);
      return n > 1 ? `${s.name} (${n})` : s.name;
    });
  }

  const host = {
    name: 'photoshop',
    storage: {
      get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    },
    onArtworkChosen: null,

    async getArtwork() {
      const doc = app.activeDocument;
      if (!doc) return null;
      return modal('Read artwork for separation', async () => {
        const pix = await imaging.getPixels({ documentID: doc.id, componentSize: 8, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1' });
        const id = pix.imageData;
        const data = await id.getData({ chunky: true });
        const out = {
          data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
          width: id.width, height: id.height, channels: id.components,
          dpi: doc.resolution || 300,
          name: String(doc.title || 'Artwork').replace(/\.[^.]+$/, ''),
        };
        id.dispose();
        return out;
      });
    },

    async showImage(img, rgba, w, h) {
      const rgb = new Uint8Array(w * h * 3);
      for (let p = 0; p < w * h; p++) { rgb[p * 3] = rgba[p * 4]; rgb[p * 3 + 1] = rgba[p * 4 + 1]; rgb[p * 3 + 2] = rgba[p * 4 + 2]; }
      const id = await imaging.createImageDataFromBuffer(rgb, { width: w, height: h, components: 3, chunky: true, colorProfile: 'sRGB IEC61966-2.1', colorSpace: 'RGB' });
      const b64 = await imaging.encodeImageData({ imageData: id, base64: true });
      id.dispose();
      img.src = 'data:image/jpeg;base64,' + b64;
    },

    async pickColor(initial) {
      try {
        const res = await modal('Pick ink color', () => action.batchPlay([{ _obj: 'showColorPicker', context: 'Ecko Seps', color: rgbDesc(initial) }], {}));
        return descToHex(res && res[0] && res[0].color);
      } catch (e) { return null; }
    },

    async foregroundColor() {
      try { return '#' + app.foregroundColor.rgb.hexValue; } catch (e) { return null; }
    },

    async pickFile(exts) {
      const f = await lfs.getFileForOpening({ types: exts });
      if (!f) return null;
      const data = await f.read({ format: formats.binary });
      return { name: f.name, data: new Uint8Array(data) };
    },

    // Texture image: open the file in Photoshop, read its pixels, close it.
    async pickImage() {
      const f = await lfs.getFileForOpening({ types: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'psd', 'webp'] });
      if (!f) return null;
      return modal('Load texture', async () => {
        const doc = await app.open(f);
        try {
          const pix = await imaging.getPixels({ documentID: doc.id, componentSize: 8, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1' });
          const id = pix.imageData;
          const data = await id.getData({ chunky: true });
          const out = { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), width: id.width, height: id.height, channels: id.components, name: f.name };
          id.dispose();
          return out;
        } finally {
          await doc.closeWithoutSaving();
        }
      });
    },

    // Opens the whole app in its own large, resizable window (a UXP dialog)
    // and moves it back into the panel when that window closes.
    popOutWindow() {
      return this._dlg && this._dlg.open ? this._dlg : null;
    },
    popOut(appEl, onResize) {
      let dlg = document.getElementById('eckoDialog');
      if (!dlg) {
        dlg = document.createElement('dialog');
        dlg.id = 'eckoDialog';
        document.body.appendChild(dlg);
      }
      this._dlg = dlg;
      const home = appEl.parentNode, next = appEl.nextSibling;
      dlg.appendChild(appEl);
      const shown = dlg.uxpShowModal({ title: 'Ecko Seps', resize: 'both', size: { width: 1400, height: 880 } });
      setTimeout(onResize, 50);
      return Promise.resolve(shown).then(() => {
        home.insertBefore(appEl, next);
        this._dlg = null;
      }, (e) => {
        home.insertBefore(appEl, next);
        this._dlg = null;
        throw e;
      });
    },

    async saveFiles(files) {
      const folder = await lfs.getFolder();
      if (!folder) return null;
      for (const f of files) {
        const file = await folder.createFile(f.name, { overwrite: true });
        await file.write(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength), { format: formats.binary });
      }
      return folder.nativePath;
    },

    // New RGB document: garment-colored background plus one spot channel
    // per screen, named after the ink, in print order. Photoshop's spot
    // channel display (solidity) previews the stack on the garment.
    async buildDocument(result, film, opts) {
      let W = result.width, H = result.height, dpi = result.dpi;
      let plates = result.screens.map((s) => s.plate);
      if (opts.bake && film.type !== 'continuous') {
        plates = result.screens.map((s) => {
          const f = E.filmSettingsFor(s, film);
          const bm = E.halftone.renderBitmap(s.plate, result.width, result.height, result.dpi, f);
          W = bm.width; H = bm.height; dpi = bm.dpi;
          return bm.data;
        });
      }
      const names = uniqueNames(result.screens);
      await core.executeAsModal(async (ctx) => {
        const doc = await app.documents.add({ width: W, height: H, resolution: dpi, mode: 'RGBColorMode', fill: 'white', name: opts.name });
        await action.batchPlay([{
          _obj: 'fill', using: { _enum: 'fillContents', _value: 'color' }, color: rgbDesc(result.garment.hex),
          opacity: { _unit: 'percentUnit', _value: 100 }, mode: { _enum: 'blendMode', _value: 'normal' },
        }], {});
        for (let i = 0; i < result.screens.length; i++) {
          const s = result.screens[i];
          ctx.reportProgress({ value: i / result.screens.length, commandName: `Screen ${i + 1} of ${result.screens.length}: ${s.name}` });
          const id = await imaging.createImageDataFromBuffer(plates[i], { width: W, height: H, components: 1, chunky: true, colorProfile: 'Gray Gamma 2.2', colorSpace: 'Grayscale' });
          await imaging.putSelection({ documentID: doc.id, imageData: id });
          id.dispose();
          const solidity = s.role === 'underbase' ? 85 : s.role === 'process' ? 0 : 95;
          await action.batchPlay([{ _obj: 'make', new: { _obj: 'spotColorChannel', name: names[i], color: rgbDesc(s.hex), opacity: solidity } }], {});
        }
        await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], {});
      }, { commandName: 'Build separations' });
    },
  };

  window.EckoHost = host;
})();
