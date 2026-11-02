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
  // Photoshop's document list is array-like; don't rely on Array methods.
  const findDoc = (id) => {
    const docs = app.documents;
    for (let i = 0; i < docs.length; i++) if (docs[i].id === id) return docs[i];
    return null;
  };
  // batchPlay reports failures as an error result, not an exception: turn
  // them into exceptions so fallbacks and error messages work.
  const bp = async (desc) => {
    const res = await action.batchPlay([desc], {});
    const r = res && res[0];
    if (r && r._obj === 'error') throw new Error(r.message || `${desc._obj} failed`);
    return r;
  };
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
      // Never read our own live-preview document as artwork: fall back to
      // the document the art came from.
      let doc = app.activeDocument;
      if (doc && (doc.id === this._liveId || doc.id === this._proofId)) doc = findDoc(this._artId);
      if (!doc) return null;
      this._artId = doc.id;
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

    // Live view on the Photoshop canvas: a document named "Ecko Seps - Live"
    // that is redrawn after every change (whatever view the panel shows).
    // ---------- live Proof Window ----------
    // A document at the art's print size (proof resolution) holding the
    // separation itself: a garment-colored layer plus one spot channel per
    // screen, rebuilt after every change, so Photoshop shows exactly what
    // will print. A top "view" layer shows the panel's other views
    // (original, compare, dots). Opened in its own window beside the art.
    async showProof(job) {
      const log = (m) => this._log(m);
      return modal('Update Proof Window', async () => {
        const { w, h } = job;
        let doc = this._liveId ? findDoc(this._liveId) : null;
        if (doc && (Math.round(doc.width) !== w || Math.round(doc.height) !== h)) { await doc.closeWithoutSaving(); doc = null; }
        let created = false;
        if (!doc) {
          doc = await app.documents.add({ width: w, height: h, resolution: Math.max(1, Math.round(job.dpi || 72)), mode: 'RGBColorMode', fill: 'white', name: 'Proof Window' });
          this._liveId = doc.id;
          this._chan = [];
          this._garmentKey = '';
          await bp({ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: 'Garment' } });
          this._garmentLayer = doc.activeLayers[0].id;
          await bp({ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: 'Ecko Seps view' } });
          this._viewLayer = doc.activeLayers[0].id;
          created = true;
          log('Proof Window created');
        }
        // Channel commands act on the active document: switch to the Proof
        // Window for the update, then give focus back to what you were on.
        const prev = app.activeDocument;
        const prevId = prev ? prev.id : null;
        if (!prev || prev.id !== doc.id) { try { app.activeDocument = doc; } catch (e) { /* fine */ } }
        const putRGB = async (layerID, rgb) => {
          const id = await imaging.createImageDataFromBuffer(rgb, { width: w, height: h, components: 3, chunky: true, colorProfile: 'sRGB IEC61966-2.1', colorSpace: 'RGB' });
          try { await imaging.putPixels({ documentID: doc.id, layerID, imageData: id, replace: true, targetBounds: { left: 0, top: 0 } }); } finally { id.dispose(); }
        };
        // Garment layer (only when the shirt color changes).
        if (this._garmentKey !== job.garment) {
          const [r, g, b] = E.color.parseHex(job.garment);
          const rgb = new Uint8Array(w * h * 3);
          for (let p = 0; p < w * h; p++) { rgb[p * 3] = r; rgb[p * 3 + 1] = g; rgb[p * 3 + 2] = b; }
          await putRGB(this._garmentLayer, rgb);
          this._garmentKey = job.garment;
        }
        // Spot channels: remove last update's, then one per screen in order.
        for (const name of this._chan || []) { try { await bp({ _obj: 'delete', _target: [{ _ref: 'channel', _name: name }] }); } catch (e) { /* already gone */ } }
        this._chan = [];
        const used = new Map();
        for (const s of job.screens) {
          const n = (used.get(s.name) || 0) + 1; used.set(s.name, n);
          const name = n > 1 ? `${s.name} (${n})` : s.name;
          const id = await imaging.createImageDataFromBuffer(s.plate, { width: w, height: h, components: 1, chunky: true, colorProfile: 'Gray Gamma 2.2', colorSpace: 'Grayscale' });
          try { await imaging.putSelection({ documentID: doc.id, imageData: id }); } finally { id.dispose(); }
          const solidity = s.role === 'underbase' ? 85 : s.role === 'process' ? 0 : 95;
          await bp({ _obj: 'make', new: { _obj: 'spotColorChannel', name, color: rgbDesc(s.hex), opacity: solidity } });
          this._chan.push(name);
        }
        try { await bp({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }); } catch (e) { /* nothing selected */ }
        // Which view: all channels, one screen, or a picture on the view layer.
        if (job.viewRgba) {
          const rgb = new Uint8Array(w * h * 3);
          for (let p = 0; p < w * h; p++) { rgb[p * 3] = job.viewRgba[p * 4]; rgb[p * 3 + 1] = job.viewRgba[p * 4 + 1]; rgb[p * 3 + 2] = job.viewRgba[p * 4 + 2]; }
          await putRGB(this._viewLayer, rgb);
          await bp({ _obj: 'show', null: [{ _ref: 'layer', _id: this._viewLayer }] });
          for (const name of this._chan) await bp({ _obj: 'hide', null: [{ _ref: 'channel', _name: name }] });
        } else {
          try { await bp({ _obj: 'hide', null: [{ _ref: 'layer', _id: this._viewLayer }] }); } catch (e) { /* fine */ }
          if (job.only != null) {
            for (let i = 0; i < this._chan.length; i++) if (i !== job.only) { try { await bp({ _obj: 'hide', null: [{ _ref: 'channel', _name: this._chan[i] }] }); } catch (e) { /* fine */ } }
          }
        }
        if (created) await this.arrangeProof(job.arrange || 'windows');
        else if (prevId && prevId !== doc.id) { const back = findDoc(prevId); if (back) { try { app.activeDocument = back; } catch (e) { /* fine */ } } }
        log(`Proof Window updated (${job.screens.length} spot channels)`);
      });
    },

    // Put the art and the Proof Window side by side.
    //  windows: each in its own floating window, tiled across the screen
    //  split:   2-up split inside Photoshop's tab area
    //  tabs:    leave them as tabs
    async arrangeProof(mode) {
      if (mode === 'tabs') return;
      const proof = this._liveId ? findDoc(this._liveId) : null;
      const art = this._artId ? findDoc(this._artId) : null;
      const menu = async (item) => { await bp({ _obj: 'select', _target: [{ _ref: 'menuItemClass', _enum: 'menuItemType', _value: item }] }); this._log(`Arrange: ${item} ok`); };
      const tryAll = async (items) => {
        for (const item of items) { try { await menu(item); return true; } catch (e) { this._log(`Arrange: ${item} failed (${e.message})`); } }
        return false;
      };
      if (mode === 'windows') {
        for (const d of [art, proof]) {
          if (!d) continue;
          try { app.activeDocument = d; } catch (e) { /* fine */ }
          await tryAll(['floatInWindow', 'floatWindow']);
        }
        await tryAll(['tileVertically', 'tile']);
      } else {
        if (proof) { try { app.activeDocument = proof; } catch (e) { /* fine */ } }
        await tryAll(['twoUpVertical', 'tile2UpVertical', 'tileVertically']);
      }
      if (proof) { try { app.activeDocument = proof; } catch (e) { /* fine */ } }
    },

    _log(m) {
      this.logLines = (this.logLines || []).concat([`${new Date().toLocaleTimeString()}  ${m}`]).slice(-30);
      if (this.onLog) this.onLog(this.logLines);
    },

    // Kept for compatibility: older callers.
    async showLive(rgba, w, h, dpi) { return this.showProof({ w, h, dpi, garment: '#111111', screens: [], viewRgba: rgba }); },

    closeLive() {
      const docs = [this._liveId, this._proofId].map((id) => (id ? findDoc(id) : null)).filter(Boolean);
      this._liveId = null; this._proofId = null;
      if (docs.length) return modal('Close Ecko Seps preview', async () => { for (const d of docs) await d.closeWithoutSaving(); });
      return null;
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
