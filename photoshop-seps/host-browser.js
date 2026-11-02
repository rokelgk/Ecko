/* Browser host: lets the same panel run in a web page for previews and
   testing. Photoshop uses host-photoshop.js instead. */
(function () {
  'use strict';
  if (window.EckoHost) return;
  let artwork = null;

  // On claude.ai the page runs in a sandbox: files are offered through the
  // viewer's "downloads" prompt. Elsewhere (a local file or web server) a
  // normal browser download is used.
  let claudeDownloads = null;
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      window.claude.use('downloads').then((d) => { claudeDownloads = d; }).catch(() => {});
    }
  } catch (e) { /* not on claude.ai */ }
  const CLAUDE_OK = /\.(png|jpg|jpeg|txt|json|csv|zip|pdf|svg)$/i;

  async function download(name, bytes, type) {
    if (claudeDownloads) {
      // Types claude.ai can't hand over (like .tif) go inside a ZIP.
      if (!CLAUDE_OK.test(name)) {
        bytes = window.EckoEngine.zip.makeZip([{ name, data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }]);
        name = name.replace(/\.[^.]+$/, '') + '.zip';
      }
      try {
        await claudeDownloads.save({ filename: name, data: bytes instanceof Blob ? bytes : new Blob([bytes]) });
        return true;
      } catch (e) {
        if (e && e.code === 'declined') return false;
        throw new Error(e && e.message ? e.message : 'Download was not allowed here.');
      }
    }
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return true;
  }

  function toCanvas(rgba, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, w * h * 4), w, h), 0, 0);
    return c;
  }

  const host = {
    name: 'browser',
    storage: {
      get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
      set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    },
    onArtworkChosen: null,
    async getArtwork() { return artwork; },
    showImage(img, rgba, w, h) { img.src = toCanvas(rgba, w, h).toDataURL('image/png'); },
    pickColor(initial) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = initial;
        input.style.position = 'fixed'; input.style.left = '-100px';
        document.body.appendChild(input);
        input.addEventListener('change', () => { resolve(input.value); input.remove(); });
        input.click();
      });
    },
    async foregroundColor() { return null; },
    pickFile(exts) {
      return new Promise((resolve) => {
        const input = document.getElementById('importLibraryInput');
        input.accept = exts.map((e) => '.' + e).join(',');
        input.onchange = async () => {
          const f = input.files[0];
          input.value = '';
          resolve(f ? { name: f.name, data: new Uint8Array(await f.arrayBuffer()) } : null);
        };
        input.click();
      });
    },
    pickImage() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.position = 'fixed'; input.style.left = '-100px';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
          const f = input.files[0];
          input.remove();
          resolve(f ? await readImageFile(f) : null);
        });
        input.click();
      });
    },
    // One file downloads as itself; several go into one ZIP, because
    // browsers (Safari especially) block a burst of separate downloads.
    async saveFiles(files, zipName) {
      if (files.length === 1) return (await download(files[0].name, files[0].data)) ? 'your Downloads folder' : null;
      const name = zipName || 'ecko-seps-films.zip';
      const ok = await download(name, window.EckoEngine.zip.makeZip(files), 'application/zip');
      return ok ? `your Downloads folder (${name})` : null;
    },
    // Browser stand-in for the Photoshop document: every plate as a
    // grayscale TIFF (no canvas, so no browser size limit) plus a preview
    // PNG, all in one ZIP.
    async buildDocument(result, film, opts) {
      const E = window.EckoEngine;
      const files = [];
      for (const s of result.screens) {
        const tif = E.tiff.writeTiff({ data: s.plate, width: result.width, height: result.height, dpi: result.dpi, bits: 8 });
        files.push({ name: `${String(s.order).padStart(2, '0')}-${s.name.replace(/[^a-z0-9]+/gi, '_')}.tif`, data: tif });
      }
      const pw = result.previewWidth || result.width, ph = result.previewHeight || result.height;
      let rgba = result.preview, w = pw, h = ph;
      // Keep the preview inside the browser's canvas size limit.
      const max = 16000000;
      if (w * h > max) {
        const k = Math.sqrt(max / (w * h));
        const small = E.ops.resizeImage({ data: rgba, width: w, height: h, channels: 4 }, Math.floor(w * k), Math.floor(h * k));
        rgba = small.data; w = small.width; h = small.height;
      }
      const blob = await new Promise((r) => toCanvas(rgba, w, h).toBlob((bb) => r(bb), 'image/png'));
      files.push({ name: 'preview.png', data: new Uint8Array(await blob.arrayBuffer()) });
      const base = ((opts && opts.name) || 'ecko-seps').replace(/[^a-z0-9 _-]+/gi, '').trim().replace(/\s+/g, '_') || 'ecko-seps';
      await download(`${base}-plates.zip`, E.zip.makeZip(files), 'application/zip');
    },
  };

  async function readImageFile(file) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { data: d.data, width: bmp.width, height: bmp.height, channels: 4, dpi: 300, fromBrowser: true, name: file.name.replace(/\.[^.]+$/, '') };
  }

  window.EckoHost = host;
  // Scripts run at the end of <body>, so the input already exists.
  const input = document.getElementById('openArt');
  if (input) input.addEventListener('change', async () => {
    if (!input.files[0]) return;
    artwork = await readImageFile(input.files[0]);
    if (host.onArtworkChosen) host.onArtworkChosen();
  });
})();
