/* Ecko Tone stand-alone: answers the page's /api/tone/* requests locally instead of a server.
 *
 * The interface (tone.js) is the same file the server version uses. Here, fetch() calls to
 * /api/tone/... are routed to the in-browser engine, in a Web Worker when the browser allows
 * it (keeps sliders smooth) and on the page otherwise.
 */
(function () {
  "use strict";
  const fonts = JSON.parse(document.getElementById("eckoFonts").textContent);
  const realFetch = window.fetch.bind(window);
  let call = null;

  function mainThreadCaller() {
    let ready = window.EckoToneHost.handle("init", { fonts });
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
      send("init", { fonts }).then((caps) => (caps.fonts && caps.canDraw ? resolve(send) : reject(new Error("no canvas in worker"))), reject);
      setTimeout(() => reject(new Error("worker timeout")), 8000);
    });
  }

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
      if (route === "images") {
        const file = init.body.get("file"), bytes = await file.arrayBuffer();
        return json(await call("upload", { bytes }, [bytes]));
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
