/* Browser host: lets the same panel run in a web page for previews and
   testing. Photoshop uses host-photoshop.js instead. */
(function () {
  'use strict';
  if (window.EckoHost) return;
  let artwork = null;

  function download(name, bytes, type) {
    const blob = new Blob([bytes], { type: type || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
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
    async saveFiles(files) {
      for (const f of files) download(f.name, f.data);
      return 'your Downloads folder';
    },
    async buildDocument(result) {
      const w = result.width, h = result.height;
      const png = (rgba) => new Promise((r) => toCanvas(rgba, w, h).toBlob((b) => r(b), 'image/png'));
      download('preview.png', await png(result.preview), 'image/png');
      for (const s of result.screens) {
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let p = 0; p < w * h; p++) { const v = 255 - s.plate[p]; rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; }
        download(`${String(s.order).padStart(2, '0')}-${s.name.replace(/[^a-z0-9]+/gi, '_')}.png`, await png(rgba), 'image/png');
      }
    },
  };

  async function readImageFile(file) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { data: d.data, width: bmp.width, height: bmp.height, channels: 4, dpi: 300, name: file.name.replace(/\.[^.]+$/, '') };
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
