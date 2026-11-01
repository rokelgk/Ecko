/* Panel logic. Shared by Photoshop (UXP) and the browser preview; all
   host-specific work goes through window.EckoHost. */
(function () {
  'use strict';
  const E = window.EckoEngine;
  const host = window.EckoHost;
  const $ = (id) => document.getElementById(id);
  const PROOF_MAX = 900;

  const GARMENTS = [
    ['Black', '#111111'], ['White', '#ffffff'], ['Heather Gray', '#9e9e9e'], ['Charcoal', '#3a3a3c'],
    ['Navy', '#1d2a44'], ['Royal', '#1f4fa3'], ['Red', '#b3202a'], ['Maroon', '#5b1f2c'],
    ['Forest', '#1f3d2b'], ['Gold', '#f2b234'], ['Natural', '#efe6d2'], ['Pink', '#f4c2cf'],
  ];

  const MODES_WITH_COUNT = ['simulated', 'index', 'spot'];

  // ---------- state ----------
  const saved = load('settings') || {};
  const state = {
    presetId: saved.presetId || 'dark-sim',
    garment: saved.garment || '#111111',
    screens: saved.screens || 8,
    tune: saved.tune || {},
    film: saved.film || null,
    libraryId: saved.libraryId || 'builtin',
    matchLibrary: !!saved.matchLibrary,
    bake: !!saved.bake,
    libraries: load('libraries') || [],
    art: null, // { image, proof, name }
    result: null,
    inks: null, // editable ink list from the last result
    dirty: false,
    view: 'preview',
    full: null, fullKey: '',
  };
  if (!state.film) state.film = Object.assign({}, preset().film);

  function preset() { return E.presets.getPreset(state.presetId); }
  function mode() { return preset().options.mode; }
  function library() {
    if (state.libraryId === 'builtin') return E.inks.BUILT_IN;
    const lib = state.libraries.find((l) => l.id === state.libraryId);
    return lib ? lib.inks.map((i) => E.inks.makeInk(i.name, i.hex, lib.name)) : E.inks.BUILT_IN;
  }
  function load(k) { try { return JSON.parse(host.storage.get('ecko-seps-' + k) || 'null'); } catch (e) { return null; } }
  function save() {
    host.storage.set('ecko-seps-settings', JSON.stringify({
      presetId: state.presetId, garment: state.garment, screens: state.screens, tune: state.tune, film: state.film,
      libraryId: state.libraryId, matchLibrary: state.matchLibrary, bake: state.bake,
    }));
    host.storage.set('ecko-seps-libraries', JSON.stringify(state.libraries));
  }

  function options(extra) {
    const o = Object.assign({}, preset().options, state.tune, {
      garment: state.garment,
      screens: state.screens,
      library: library(),
      matchLibrary: state.matchLibrary,
    }, extra || {});
    if (state.inks && !(extra && extra.fresh)) o.inks = state.inks;
    delete o.fresh;
    const locked = (state.inks || []).filter((i) => i.locked);
    if (!o.inks && locked.length) o.lockedInks = locked;
    return o;
  }

  // ---------- step 1-3 ----------
  function renderPresets() {
    const box = $('presets');
    box.innerHTML = '';
    for (const p of E.presets.PRESETS) {
      const d = document.createElement('div');
      d.className = 'preset' + (p.id === state.presetId ? ' on' : '');
      d.innerHTML = `<b>${esc(p.label)}</b><span>${esc(p.blurb)}</span>`;
      d.addEventListener('click', () => {
        state.presetId = p.id;
        state.film = Object.assign({}, p.film);
        state.tune = {};
        if (p.options.garment && !userPickedGarment) setGarment(p.options.garment, true);
        if (p.options.screens) state.screens = p.options.screens;
        resetInks();
        renderAll();
      });
      box.appendChild(d);
    }
  }

  let userPickedGarment = !!saved.garment;
  function setGarment(hex, auto) {
    try { hex = E.color.toHex(E.color.parseHex(hex)); } catch (e) { return; }
    state.garment = hex;
    if (!auto) userPickedGarment = true;
    resetInks();
    renderGarment();
    save();
  }

  function renderGarment() {
    const box = $('garments');
    box.innerHTML = '';
    for (const [name, hex] of GARMENTS) {
      const s = document.createElement('div');
      s.className = 'sw' + (hex === state.garment ? ' on' : '');
      s.style.background = hex;
      s.title = name;
      s.addEventListener('click', () => setGarment(hex));
      box.appendChild(s);
    }
    $('garmentChip').style.background = state.garment;
    $('garmentHex').value = state.garment;
  }

  function renderCounts() {
    const box = $('counts');
    box.innerHTML = '';
    const m = mode();
    const has = MODES_WITH_COUNT.includes(m);
    box.style.display = has ? 'flex' : 'none';
    for (const n of E.presets.SCREEN_COUNTS.concat(['auto'])) {
      const d = document.createElement('div');
      d.className = 'seg' + (String(state.screens) === String(n) ? ' on' : '');
      d.textContent = n === 'auto' ? 'Auto' : String(n);
      d.addEventListener('click', () => { state.screens = n; resetInks(); renderCounts(); save(); });
      box.appendChild(d);
    }
    const dark = E.color.rgbToLab(E.color.parseHex(state.garment))[0] < 55;
    let hint = '';
    if (!has) hint = m === 'cmyk' ? `4 process screens${dark ? ' + underbase + highlight white' : ''}.` : '1 screen.';
    else if (state.screens === 'auto') hint = 'Finds the fewest screens that still match your art.';
    else if (dark && m !== 'spot' && state.screens >= 3) hint = `${state.screens} screens total, including the underbase and highlight white. Your press needs ${state.screens} heads.`;
    else hint = `${state.screens} screens total. Your press needs ${state.screens} heads.`;
    $('countHint').textContent = hint;
  }

  // ---------- fine-tune + film controls ----------
  const TUNE = [
    { k: 'overlap', label: 'Ink build-up', modes: ['simulated'], type: 'select', opts: [['stack', 'Full color'], ['side', 'Soft hand (less ink)']] },
    { k: 'underbase', label: 'Underbase', modes: ['simulated', 'index', 'spot', 'cmyk'], type: 'select', opts: [['auto', 'Auto (dark shirts)'], [true, 'Always'], [false, 'Never']] },
    { k: 'underbaseStrength', label: 'Underbase density', modes: ['simulated', 'spot'], type: 'range', min: 0.5, max: 1.3, step: 0.05, fmt: pct },
    { k: 'choke', label: 'Underbase choke', modes: ['simulated', 'spot'], type: 'range', min: 0, max: 4, step: 1, fmt: (v) => `${v} px` },
    { k: 'highlightWhite', label: 'Highlight white', modes: ['simulated', 'index', 'spot'], type: 'select', opts: [['auto', 'Auto'], [true, 'Always'], [false, 'Never']] },
    { k: 'maxInksPerPixel', label: 'Inks per spot', modes: ['simulated', 'index'], type: 'select', opts: [[2, '2 (cleanest)'], [3, '3 (balanced)'], [4, '4 (smoothest)']] },
    { k: 'minDot', label: 'Smallest dot', modes: ['simulated', 'cmyk', 'grayscale'], type: 'range', min: 0, max: 0.15, step: 0.01, fmt: pct },
    { k: 'maxDot', label: 'Largest dot', modes: ['simulated', 'cmyk', 'grayscale'], type: 'range', min: 0.85, max: 1, step: 0.01, fmt: pct },
    { k: 'dotGain', label: 'Dot gain comp.', modes: ['simulated', 'cmyk', 'grayscale'], type: 'range', min: 0, max: 0.3, step: 0.01, fmt: pct },
    { k: 'cleanup', label: 'Speck clean-up', modes: ['spot'], type: 'range', min: 0, max: 3, step: 1, fmt: (v) => (v ? `${v} pass${v > 1 ? 'es' : ''}` : 'off') },
    { k: 'trap', label: 'Trap (spread)', modes: ['spot'], type: 'range', min: 0, max: 3, step: 1, fmt: (v) => `${v} px` },
    { k: 'indexDpi', label: 'Index resolution', modes: ['index'], type: 'select', opts: [[150, '150 ppi'], [180, '180 ppi'], [200, '200 ppi'], [240, '240 ppi'], [300, '300 ppi']] },
    { k: 'gcr', label: 'Black (GCR)', modes: ['cmyk'], type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { k: 'totalInk', label: 'Total ink limit', modes: ['cmyk'], type: 'range', min: 2, max: 4, step: 0.1, fmt: pct },
  ];

  const FILM = [
    { k: 'type', label: 'Bitmap type', type: 'select', opts: [['am', 'Halftone dots (AM)'], ['fm', 'Stochastic / diffusion (FM)'], ['index', 'Index pixels'], ['threshold', 'Solid (threshold)'], ['continuous', 'None – my RIP halftones']] },
    { k: 'lpi', label: 'Frequency (LPI)', when: (f) => f.type === 'am', type: 'select', opts: E.presets.LPI_CHOICES.map((v) => [v, `${v} lpi`]) },
    { k: 'angle', label: 'Angle', when: (f) => f.type === 'am' && mode() !== 'cmyk', type: 'select', opts: E.presets.ANGLE_CHOICES.map((v) => [v, `${v}°`]) },
    { k: 'dot', label: 'Dot shape', when: (f) => f.type === 'am', type: 'select', opts: E.presets.DOT_SHAPES.map((v) => [v, v[0].toUpperCase() + v.slice(1)]) },
    { k: 'fmDot', label: 'FM dot size', when: (f) => f.type === 'fm', type: 'range', min: 2, max: 8, step: 1, fmt: (v) => `${v} px` },
    { k: 'dpi', label: 'Film resolution', when: (f) => f.type !== 'continuous', type: 'select', opts: E.presets.DPI_CHOICES.map((v) => [v, `${v} dpi`]) },
    { k: 'mirror', label: 'Mirror (emulsion)', type: 'check' },
    { k: 'marks', label: 'Registration marks', type: 'check', dflt: true },
    { k: 'label', label: 'Film labels', type: 'check', dflt: true },
  ];

  function pct(v) { return `${Math.round(v * 100)}%`; }

  function valueOf(src, k, dflt) { return src[k] !== undefined ? src[k] : dflt; }

  function fieldEl(def, value, onChange) {
    const row = document.createElement('div');
    row.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = def.label;
    const ctl = document.createElement('div');
    ctl.className = 'ctl';
    row.appendChild(lab); row.appendChild(ctl);
    if (def.type === 'select') {
      const s = document.createElement('select');
      for (const [v, t] of def.opts) {
        const o = document.createElement('option');
        o.value = JSON.stringify(v); o.textContent = t;
        if (JSON.stringify(v) === JSON.stringify(value)) o.selected = true;
        s.appendChild(o);
      }
      s.addEventListener('change', () => onChange(JSON.parse(s.value)));
      ctl.appendChild(s);
    } else if (def.type === 'range') {
      const r = document.createElement('input');
      r.type = 'range'; r.min = def.min; r.max = def.max; r.step = def.step; r.value = value;
      const val = document.createElement('span');
      val.className = 'val'; val.textContent = def.fmt(Number(value));
      r.addEventListener('input', () => { val.textContent = def.fmt(Number(r.value)); });
      r.addEventListener('change', () => onChange(Number(r.value)));
      ctl.appendChild(r); ctl.appendChild(val);
    } else if (def.type === 'check') {
      const c = document.createElement('input');
      c.type = 'checkbox'; c.checked = !!value;
      c.addEventListener('change', () => onChange(c.checked));
      ctl.appendChild(c);
    }
    return row;
  }

  function renderTune() {
    const body = $('tuneBody');
    body.innerHTML = '';
    const base = Object.assign({}, E.DEFAULTS, preset().options);
    const m = mode();
    for (const def of TUNE) {
      if (!def.modes.includes(m)) continue;
      body.appendChild(fieldEl(def, valueOf(state.tune, def.k, base[def.k]), (v) => { state.tune[def.k] = v; resetInks(); save(); }));
    }
    const reset = document.createElement('button');
    reset.className = 'btn small';
    reset.textContent = 'Reset to preset';
    reset.addEventListener('click', () => { state.tune = {}; renderTune(); save(); });
    body.appendChild(reset);
  }

  function renderFilm() {
    const body = $('filmBody');
    body.innerHTML = '';
    const f = state.film;
    for (const def of FILM) {
      if (def.when && !def.when(f)) continue;
      body.appendChild(fieldEl(def, valueOf(f, def.k, def.dflt !== undefined ? def.dflt : ''), (v) => {
        f[def.k] = v; state.full = null; save(); renderFilm(); renderScreens();
      }));
    }
    if (mode() === 'cmyk' && f.type === 'am') {
      const n = document.createElement('div');
      n.className = 'muted small';
      n.textContent = 'CMYK angles: C 15°, M 75°, Y 0°, K 45° (moiré-safe set).';
      body.appendChild(n);
    }
    if (f.type === 'am') {
      const mesh = E.halftone.recommendMesh({ role: 'color' }, f);
      const n = document.createElement('div');
      n.className = 'muted small';
      n.textContent = `At ${f.lpi} lpi use about ${mesh.range} mesh for colors (≈ 4–5× the line count). Same angle on every sim-process screen keeps dots nested and avoids moiré between colors.`;
      body.appendChild(n);
    }
    if (host.name === 'photoshop') {
      body.appendChild(fieldEl({ label: 'Bake into document', type: 'check' }, state.bake, (v) => { state.bake = v; save(); }));
      const n = document.createElement('div');
      n.className = 'muted small';
      n.textContent = 'Off: the document keeps smooth tones and your RIP makes the dots (recommended). On: the document gets these bitmaps at film resolution.';
      body.appendChild(n);
    }
  }

  // ---------- library ----------
  function renderLibrary() {
    const s = $('librarySelect');
    s.innerHTML = '';
    const add = (id, label) => { const o = document.createElement('option'); o.value = id; o.textContent = label; if (id === state.libraryId) o.selected = true; s.appendChild(o); };
    add('builtin', `Built-in plastisol (${E.inks.BUILT_IN.length})`);
    for (const l of state.libraries) add(l.id, `${l.name} (${l.inks.length})`);
    $('matchLibrary').checked = state.matchLibrary;
  }

  async function importLibrary() {
    try {
      const file = await host.pickFile(['ase', 'aco', 'csv', 'gpl', 'txt']);
      if (!file) return;
      const inks = E.inks.parseLibrary(file.name, file.data);
      const id = 'lib-' + Date.now();
      state.libraries.push({ id, name: file.name.replace(/\.[^.]+$/, ''), inks: inks.map((i) => ({ name: i.name, hex: i.hex })) });
      state.libraryId = id;
      state.matchLibrary = true;
      save();
      renderLibrary();
      status(`Imported ${inks.length} inks from ${file.name}.`);
    } catch (e) { status(e.message, true); }
  }

  // ---------- separating ----------
  function status(text, err) {
    const s = $('status');
    s.textContent = text || '';
    s.className = 'status small ' + (err ? 'err' : 'muted');
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  function makeProof(image) {
    const s = Math.min(1, PROOF_MAX / Math.max(image.width, image.height));
    if (s === 1) return image;
    const p = E.ops.resizeImage(image, Math.round(image.width * s), Math.round(image.height * s));
    p.dpi = (image.dpi || 300) * s;
    return p;
  }

  async function loadArt() {
    const art = await host.getArtwork();
    if (!art) return false;
    state.art = { image: art, proof: makeProof(art), name: art.name || 'Artwork' };
    state.full = null;
    const inW = (art.width / (art.dpi || 300)).toFixed(2), inH = (art.height / (art.dpi || 300)).toFixed(2);
    $('docInfo').textContent = `${state.art.name} · ${art.width}×${art.height}px · ${Math.round(art.dpi || 300)} ppi · ${inW}×${inH} in`;
    return true;
  }

  async function runSeparate(fresh) {
    try {
      if (host.name === 'photoshop' || !state.art) {
        status('Reading artwork…');
        await tick();
        if (!(await loadArt())) { status(host.name === 'photoshop' ? 'Open a document in Photoshop first.' : 'Open an image first.', true); return; }
      }
      if (fresh) state.inks = null;
      status('Separating…');
      await tick();
      const t0 = Date.now();
      const o = options(fresh ? { fresh: true } : null);
      if (mode() === 'index') o.indexDpi = 0; // the proof stays at proof resolution
      const r = E.separate(state.art.proof, o);
      state.result = r;
      state.inks = r.screens.map((s) => ({ name: s.name, hex: s.hex, role: s.role, code: s.code, library: s.library, locked: !!s.locked }));
      state.dirty = false;
      state.full = null;
      state.view = 'preview';
      if (state.screens === 'auto' && MODES_WITH_COUNT.includes(mode())) status(`Auto picked ${r.screens.length} screens · ${Date.now() - t0} ms`);
      else status(`Done in ${Date.now() - t0} ms. Preview is a fast proof; output runs at full resolution.`);
      renderResults();
      ['build', 'exportFilms', 'exportSheet'].forEach((id) => { $(id).disabled = false; });
    } catch (e) {
      console.error(e);
      status('Separation failed: ' + e.message, true);
    }
  }

  function resetInks() {
    state.inks = null;
    state.full = null;
  }

  // Full-resolution result for output, using exactly the inks on screen.
  async function fullResult() {
    const key = JSON.stringify({ inks: state.inks, tune: state.tune, garment: state.garment, p: state.presetId });
    if (state.full && state.fullKey === key) return state.full;
    if (host.name === 'photoshop') await loadArt();
    status('Separating at full resolution…');
    await tick();
    const o = options();
    o.inks = state.inks;
    state.full = E.separate(state.art.image, o);
    state.fullKey = key;
    return state.full;
  }

  // ---------- results ----------
  const MATCH_WORDS = {
    Excellent: 'Prints should look like the art.',
    Good: 'Small color differences, mostly in gradients.',
    Fair: 'Noticeable differences. Add a screen or lock the missing color.',
    Poor: 'These inks can\'t reproduce the art. Add screens or change mode.',
  };

  function renderResults() {
    const r = state.result;
    if (!r) return;
    $('results').classList.remove('hidden');
    const b = $('matchBadge');
    b.className = 'badge ' + r.report.match.rating;
    b.textContent = `${r.report.match.rating} match`;
    $('matchText').textContent = `${MATCH_WORDS[r.report.match.rating]} Average color difference ΔE ${r.report.match.avgDeltaE} (under 2 is hard to see).`;
    renderTabs();
    renderView();
    renderScreens();
    const w = $('warnings');
    w.innerHTML = '';
    for (const x of r.report.warnings) {
      const li = document.createElement('li');
      li.className = x.level;
      li.textContent = x.text;
      w.appendChild(li);
    }
    if (r.report.speckPixelsRemoved > 0) {
      const li = document.createElement('li');
      li.className = 'tip';
      li.textContent = `Removed ${r.report.speckPixelsRemoved.toLocaleString()} dots too small to hold on the screen (smallest dot setting).`;
      w.appendChild(li);
    }
  }

  function renderTabs() {
    const box = $('viewTabs');
    box.innerHTML = '';
    const add = (id, text) => {
      const t = document.createElement('span');
      t.className = 'tab' + (state.view === id ? ' on' : '');
      t.textContent = text;
      t.addEventListener('click', () => { state.view = id; renderTabs(); renderView(); });
      box.appendChild(t);
    };
    add('preview', 'On shirt');
    add('art', 'Original');
    state.result.screens.forEach((s, i) => add(i, `${s.order}`));
  }

  function renderView() {
    const r = state.result;
    const w = r.width, h = r.height;
    let rgba;
    if (state.view === 'preview') rgba = r.preview;
    else if (state.view === 'art') {
      const src = state.art.proof;
      rgba = new Uint8ClampedArray(w * h * 4);
      const g = E.color.parseHex(state.garment);
      for (let p = 0; p < w * h; p++) {
        const a = src.channels === 4 ? src.data[p * 4 + 3] / 255 : 1;
        for (let k = 0; k < 3; k++) rgba[p * 4 + k] = src.data[p * src.channels + k] * a + g[k] * (1 - a);
        rgba[p * 4 + 3] = 255;
      }
    } else {
      // Film view: black where the screen prints.
      const pl = r.screens[state.view].plate;
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p++) { const v = 255 - pl[p]; rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; }
    }
    host.showImage($('previewImg'), rgba, w, h);
  }

  function renderScreens() {
    const r = state.result;
    if (!r || !state.inks) return;
    const box = $('screens');
    box.innerHTML = '';
    const summary = E.screenSummary(r, state.film);
    state.inks.forEach((ink, i) => {
      const s = summary[i] || {};
      const row = document.createElement('div');
      row.className = 'scr' + (ink.role === 'underbase' ? ' ub' : '');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = String(i + 1);
      const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = ink.hex; chip.title = 'Change ink';
      chip.addEventListener('click', () => openInkPicker(i, row));
      const name = document.createElement('input'); name.className = 'name'; name.value = ink.name; name.title = 'Ink name (used for the spot channel and film label)';
      name.addEventListener('change', () => { ink.name = name.value.trim() || ink.name; markDirty(false); });
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = s.coverage !== undefined ? `${(s.coverage * 100).toFixed(1)}% · ${s.mesh} mesh` : 'not run yet';
      meta.title = s.meshRange ? `Mesh range ${s.meshRange}` : '';
      row.appendChild(n); row.appendChild(chip); row.appendChild(name); row.appendChild(meta);
      const btn = (txt, title, fn, on) => { const b = document.createElement('button'); b.className = 'btn ic' + (on ? ' on' : ''); b.textContent = txt; b.title = title; b.addEventListener('click', fn); row.appendChild(b); };
      if (ink.role !== 'underbase') btn(ink.locked ? '🔒' : '🔓', 'Lock this ink (kept when you separate again)', () => { ink.locked = !ink.locked; renderScreens(); }, ink.locked);
      btn('↑', 'Print earlier', () => move(i, -1));
      btn('↓', 'Print later', () => move(i, 1));
      btn('✕', 'Remove this screen', () => { state.inks.splice(i, 1); markDirty(true); });
      box.appendChild(row);
    });
    $('reseparate').className = 'btn small' + (state.dirty ? ' primary' : '');
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= state.inks.length) return;
    const t = state.inks[i]; state.inks[i] = state.inks[j]; state.inks[j] = t;
    markDirty(true);
  }

  function markDirty(rerender) {
    state.dirty = true;
    state.full = null;
    if (rerender) renderScreens();
    $('reseparate').className = 'btn small primary';
    status('Inks changed. Press "Re-separate with these inks" to update the preview.');
  }

  // Ink picker: nearest library inks first, then any custom color.
  function openInkPicker(i, row) {
    const old = document.getElementById('inkPicker');
    if (old) { old.parentNode.removeChild(old); if (old.dataset.i === String(i)) return; }
    const ink = state.inks[i];
    const lab = E.color.rgbToLab(E.color.parseHex(ink.hex));
    const lib = library().map((x) => [E.color.deltaE2000(lab, x.lab), x]).sort((a, b) => a[0] - b[0]).slice(0, 10);
    const box = document.createElement('div');
    box.id = 'inkPicker'; box.dataset.i = String(i);
    box.className = 'card';
    box.innerHTML = '<div class="muted small">Closest library inks</div>';
    const list = document.createElement('div'); list.className = 'swatches';
    for (const [d, x] of lib) {
      const s = document.createElement('div');
      s.className = 'sw'; s.style.background = x.hex; s.title = `${x.name} (ΔE ${d.toFixed(1)})`;
      s.addEventListener('click', () => { Object.assign(ink, { name: x.name, hex: x.hex, library: x.library }); box.parentNode.removeChild(box); markDirty(true); });
      list.appendChild(s);
    }
    box.appendChild(list);
    const custom = document.createElement('button');
    custom.className = 'btn small'; custom.textContent = 'Custom color…';
    custom.addEventListener('click', async () => {
      const hex = await host.pickColor(ink.hex);
      if (hex) { ink.hex = hex; box.parentNode.removeChild(box); markDirty(true); }
    });
    box.appendChild(custom);
    row.parentNode.insertBefore(box, row.nextSibling);
  }

  function addInk() {
    if (!state.inks) return;
    const hl = state.inks.findIndex((x) => x.role === 'highlight');
    const ink = { name: 'New Ink', hex: '#808080', role: 'color', locked: true };
    if (hl >= 0) state.inks.splice(hl, 0, ink); else state.inks.push(ink);
    markDirty(true);
  }

  // ---------- output ----------
  async function build() {
    try {
      const r = await fullResult();
      status('Building document…');
      await tick();
      await host.buildDocument(r, Object.assign({}, state.film), { bake: state.bake, name: `${state.art.name} – seps` });
      status(`Built ${r.screens.length} screens at ${r.width}×${r.height}px.`);
    } catch (e) { console.error(e); status('Build failed: ' + e.message, true); }
  }

  async function exportFilms() {
    try {
      const r = await fullResult();
      const files = [];
      for (const s of r.screens) {
        status(`Rendering film ${s.order} of ${r.screens.length}…`);
        await tick();
        const film = E.renderScreenFilm(r, s, state.film);
        files.push({ name: `${String(s.order).padStart(2, '0')}-${s.name.replace(/[^a-z0-9]+/gi, '_')}.tif`, data: E.tiff.writeTiff(film) });
      }
      files.push({ name: 'job-sheet.txt', data: new TextEncoder().encode(jobSheet(r)) });
      const where = await host.saveFiles(files);
      status(where ? `Saved ${files.length - 1} films and a job sheet to ${where}.` : 'Export cancelled.');
    } catch (e) { console.error(e); status('Export failed: ' + e.message, true); }
  }

  async function exportSheet() {
    try {
      const r = await fullResult();
      const where = await host.saveFiles([{ name: 'job-sheet.txt', data: new TextEncoder().encode(jobSheet(r)) }]);
      status(where ? `Saved job sheet to ${where}.` : 'Cancelled.');
    } catch (e) { status(e.message, true); }
  }

  function jobSheet(r) {
    const sum = E.screenSummary(r, state.film);
    const dpi = r.dpi || 300;
    const lines = [
      'ECKO SEPS - JOB SHEET',
      `Art:       ${state.art.name}`,
      `Size:      ${(r.width / dpi).toFixed(2)} x ${(r.height / dpi).toFixed(2)} in (${r.width} x ${r.height} px at ${Math.round(dpi)} ppi)`,
      `Job type:  ${preset().label}`,
      `Garment:   ${state.garment}`,
      `Screens:   ${r.screens.length}`,
      `Match:     ${r.report.match.rating} (average dE ${r.report.match.avgDeltaE}, 95% within ${r.report.match.p95DeltaE})`,
      `Films:     ${filmText(state.film)}`,
      '',
      ' #  Ink                        Hex      Coverage  Mesh (range)   Film',
    ];
    for (const s of sum) {
      lines.push(`${String(s.order).padStart(2)}  ${(s.name + (s.code ? ' ' + s.code : '')).padEnd(26).slice(0, 26)} ${s.hex}  ${(s.coverage * 100).toFixed(1).padStart(6)}%  ${String(s.mesh).padStart(4)} (${s.meshRange})  ${filmText(s.film)}`);
    }
    lines.push('');
    if (r.screens[0] && r.screens[0].role === 'underbase') lines.push('Flash cure after the underbase (screen 1), then print the remaining screens wet-on-wet.');
    for (const w of r.report.warnings) lines.push('Note: ' + w.text);
    return lines.join('\n') + '\n';
  }

  function filmText(f) {
    if (f.type === 'am') return `${f.lpi} lpi, ${f.angle}°, ${f.dot} dot, ${f.dpi} dpi`;
    if (f.type === 'fm') return `FM ${f.fmDot || 3}px dot, ${f.dpi} dpi`;
    if (f.type === 'index') return `index pixels, ${f.dpi} dpi`;
    if (f.type === 'threshold') return `solid, ${f.dpi} dpi`;
    return 'continuous tone (RIP halftones)';
  }

  // ---------- wiring ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function renderAll() {
    renderPresets();
    renderGarment();
    renderCounts();
    renderTune();
    renderFilm();
    renderLibrary();
    if (state.result) renderScreens();
    save();
  }

  document.querySelectorAll('.collapsible .toggle').forEach((t) => t.addEventListener('click', () => t.parentNode.classList.toggle('open')));
  $('garmentHex').addEventListener('change', () => setGarment($('garmentHex').value));
  $('garmentPick').addEventListener('click', async () => { const hex = await host.pickColor(state.garment); if (hex) setGarment(hex); });
  $('garmentFg').addEventListener('click', async () => { const hex = await host.foregroundColor(); if (hex) setGarment(hex); });
  $('separate').addEventListener('click', () => runSeparate(true));
  $('reseparate').addEventListener('click', () => runSeparate(false));
  $('addInk').addEventListener('click', addInk);
  $('librarySelect').addEventListener('change', () => { state.libraryId = $('librarySelect').value; save(); });
  $('matchLibrary').addEventListener('change', () => { state.matchLibrary = $('matchLibrary').checked; resetInks(); save(); });
  $('importLibrary').addEventListener('click', importLibrary);
  $('build').addEventListener('click', build);
  $('exportFilms').addEventListener('click', exportFilms);
  $('exportSheet').addEventListener('click', exportSheet);
  if (host.name !== 'photoshop') {
    document.querySelectorAll('.ps-only').forEach((el) => el.classList.add('hidden'));
    $('browserOnly').classList.remove('hidden');
    $('build').textContent = 'Download plates + preview (PNG)';
    document.querySelectorAll('.ps-text').forEach((el) => { el.textContent = 'In Photoshop this builds a document with one named spot channel per ink.'; });
  }
  host.onArtworkChosen = async () => { await loadArt(); runSeparate(true); };
  window.EckoUI = { state, runSeparate, jobSheet };
  renderAll();
})();
