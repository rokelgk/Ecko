/* Ecko Tone stand-alone: answers the page's /api/tone/* requests locally instead of a server.
 *
 * The interface (tone.js) is the same file the server version uses. Here, fetch() calls to
 * /api/tone/... are routed to the in-browser engine, in a Web Worker when the browser allows
 * it (keeps sliders smooth) and on the page otherwise.
 */
(function () {
  "use strict";
  const fonts = JSON.parse(document.getElementById("eckoFonts").textContent);
  const scanEl = document.getElementById("eckoScans");   // the built-in distress scans
  const scans = scanEl ? JSON.parse(scanEl.textContent) : {};
  const realFetch = window.fetch.bind(window);
  let call = null;

  function mainThreadCaller() {
    let ready = window.EckoToneHost.handle("init", { fonts, scans });
    return async (cmd, args) => { await ready; return window.EckoToneHost.handle(cmd, args); };
  }

  function workerCaller() {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        const src = document.getElementById("eckoWorkerSrc").textContent;
        worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
      } catch (e) { reject(e); return; }
      const pending = new Map();
      let next = 1;
      worker.onmessage = (ev) => {
        const p = pending.get(ev.data.id);
        if (!p) return;
        pending.delete(ev.data.id);
        if (ev.data.ok) p.resolve(ev.data.result);
        else p.reject(Object.assign(new Error(ev.data.detail), { status: ev.data.status }));
      };
      worker.onerror = (e) => { reject(e); for (const p of pending.values()) p.reject(new Error("Worker stopped.")); };
      const send = (cmd, args, transfer) => new Promise((res, rej) => {
        const id = next++;
        pending.set(id, { resolve: res, reject: rej });
        worker.postMessage({ id, cmd, args }, transfer || []);
      });
      send("init", { fonts, scans }).then((caps) => (caps.fonts && caps.canDraw ? resolve(send) : reject(new Error("no canvas in worker"))), reject);
      setTimeout(() => reject(new Error("worker timeout")), 8000);
    });
  }

  // Downloads: on a claude.ai page the host shows a save prompt; elsewhere a normal download.
  window.eckoSaveFile = async (blob, filename) => {
    if (!window.claude || typeof window.claude.use !== "function") return false;
    const downloads = await window.claude.use("downloads");
    if (!downloads) return false;
    try {
      await downloads.save({ filename, data: blob });
    } catch (e) {
      if (e && e.code === "declined") return true;   // the viewer said no: nothing more to do
      throw new Error(`Couldn't save the file (${(e && e.message) || e}).`);
    }
    return true;
  };

  const ready = workerCaller().then((send) => { call = send; }, () => { call = mainThreadCaller(); });

  // Only the newest request of each kind matters while sliders move: drop the ones in between.
  const latest = {};
  async function coalesced(kind, cmd, args) {
    const token = (latest[kind] = (latest[kind] || 0) + 1);
    await ready;
    await new Promise((r) => setTimeout(r, 0));
    if (token !== latest[kind]) throw Object.assign(new Error("superseded"), { status: 409 });
    return call(cmd, args);
  }

  /** Decode a picture with the page's own image loader (works for anything the browser can display),
   *  shrinking huge photos so the canvas stays inside every browser's limits (Safari: ~16 MP). */
  async function decodeInPage(file) {
    const unreadable = () => Object.assign(new Error("That file isn't an image we can read. Try PNG or JPG."), { status: 422 });
    let src = null, w = 0, h = 0, url = null;
    try {
      src = await createImageBitmap(file);
      w = src.width; h = src.height;
    } catch (e) {
      url = URL.createObjectURL(file);
      src = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(unreadable());
        im.src = url;
      });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    try {
      if (!w || !h) throw unreadable();
      if (w < 16 || h < 16) throw Object.assign(new Error("The image is too small. Upload at least 200 x 200 pixels."), { status: 422 });
      const s = Math.min(1, 4000 / Math.max(w, h), Math.sqrt(16e6 / (w * h)));
      const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      const ctx = c.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, cw, ch);
      const data = ctx.getImageData(0, 0, cw, ch).data;
      c.width = 1; c.height = 1;   // Safari limits total canvas memory: give it back now
      return { rgba: data.buffer, w: cw, h: ch, origW: w, origH: h };
    } finally {
      if (url) URL.revokeObjectURL(url);
      if (src && src.close) src.close();
    }
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  const fileResponse = (blob, filename) => new Response(blob, {
    headers: { "Content-Type": blob.type || "application/octet-stream",
      ...(filename ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}) },
  });
  const urls = { preview: [], loupe: [] };
  function keepUrl(kind, url) {   // free old preview images
    urls[kind].push(url);
    while (urls[kind].length > 4) URL.revokeObjectURL(urls[kind].shift());
    return url;
  }

  window.fetch = async function (input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    if (!path.startsWith("/api/tone/")) return realFetch(input, init);
    const route = path.slice("/api/tone/".length).split("?")[0];
    try {
      if (route === "catalog") return json(window.EckoToneEngine.CATALOG.api);
      await ready;
      if (route === "masks") {   // colour-region mask: base64 bytes -> the engine
        const b = JSON.parse(init.body), bin = atob(b.data), data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
        return json(await call("uploadMask", { id: b.id, data: data.buffer, w: b.w, h: b.h }, [data.buffer]));
      }
      if (route === "images") {
        const file = init.body.get("file");
        const img = await decodeInPage(file);   // the same way the page shows the thumbnail
        return json(await call("uploadRGBA", img, [img.rgba]));
      }
      const body = init.body ? JSON.parse(init.body) : {};
      if (route === "preview") {
        const kind = body.region ? "loupe" : "preview";
        const r = await coalesced(kind, "preview", body);
        return json({ image: keepUrl(kind, URL.createObjectURL(r.png)), size: r.size, report: r.report, palette: r.palette });
      }
      if (route === "mockup") return fileResponse((await coalesced("mockup", "mockup", body)).blob);
      if (route === "export" || route === "batch") {
        const r = await call(route, body);
        return fileResponse(r.blob, r.filename);
      }
      return json({ detail: "Not found" }, 404);
    } catch (e) {
      return json({ detail: e.message || String(e) }, e.status || 500);
    }
  };
})();
