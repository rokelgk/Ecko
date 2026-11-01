/* Panel logic. Shared by Photoshop (UXP) and the browser preview; all
   host-specific work goes through window.EckoHost.

   Everything is live: after the first Separate, any change (inks, order,
   fine-tune, art prep, film settings) re-runs a fast proof separation and
   redraws the preview. Output runs the same settings at full resolution. */
(function () {
  'use strict';
  const E = window.EckoEngine;
  const host = window.EckoHost;
  const $ = (id) => document.getElementById(id);
  const PROOF_MAX = 700;
  const PROOF_GRID = 17;

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
    prep: Object.assign({}, E.PREP_DEFAULTS, saved.prep || {}),
    libraryId: saved.libraryId || 'builtin',
    matchLibrary: !!saved.matchLibrary,
    bake: !!saved.bake,
    libraries: load('libraries') || [],
    art: null, // { original, name }
    proof: null, proofKey: '',
    result: null,
    inks: null, // editable ink list: {name, hex, role, code, library, locked, hidden}
    undo: [],
    view: 'preview',
    zoom: { x: 0.5, y: 0.5 },
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
      prep: state.prep, libraryId: state.libraryId, matchLibrary: state.matchLibrary, bake: state.bake,
    }));
    host.storage.set('ecko-seps-libraries', JSON.stringify(state.libraries));
  }
  const visibleInks = () => (state.inks || []).filter((i) => !i.hidden);

  function options(fresh) {
    const o = Object.assign({}, preset().options, state.tune, {
      garment: state.garment, screens: state.screens, library: library(), matchLibrary: state.matchLibrary,
    });
    if (!fresh && state.inks) o.inks = visibleInks();
    else {
      const locked = (state.inks || []).filter((i) => i.locked && !i.hidden && i.role !== 'underbase');
      if (locked.length) o.lockedInks = locked;
    }
    return o;
  }

  // ---------- live re-separation ----------
  let timer = null, pending = null;
  function schedule(kind, note) {
    if (!state.art) { save(); return; }
    // A fresh run (new inks) wins over an ink-keeping run.
    pending = { fresh: (pending && pending.fresh) || kind === 'fresh', note: note || (pending && pending.note) };
    $('busy').classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => { const p = pending; pending = null; runProof(p.fresh, p.note); }, 120);
    save();
  }

  function proofImage() {
    const key = JSON.stringify(state.prep);
    if (state.proof && state.proofKey === key) return state.proof;
    const info = E.artInfo(state.art.original, state.prep);
    const scale = Math.min(1, PROOF_MAX / Math.max(info.outWidth, info.outHeight));
    state.proof = E.prepareArt(state.art.original, state.prep, scale);
    state.proofKey = key;
    return state.proof;
  }

  async function runProof(fresh, note) {
    try {
      const prev = state.result ? state.result.report.match : null;
      $('busy').classList.remove('hidden');
      await tick();
      const t0 = Date.now();
      const p = proofImage();
      const o = options(fresh);
      o.lutGrid = PROOF_GRID;
      if (mode() === 'index') o.indexDpi = 0;
      const r = E.separate(p.image, o);
      state.result = r;
      if (fresh || !state.inks) {
        state.inks = r.screens.map((s) => ({ name: s.name, hex: s.hex, role: s.role, code: s.code, library: s.library, locked: !!s.locked, hidden: false }));
        state.undo = [];
      }
      state.full = null;
      renderResults();
      showDelta(note, prev, r.report.match);
      const ms = Date.now() - t0;
      if (fresh && state.screens === 'auto' && MODES_WITH_COUNT.includes(mode())) status(`Auto picked ${r.screens.length} screens · ${ms} ms`);
      else status(`Updated in ${ms} ms`);
      ['build', 'exportFilms', 'exportSheet'].forEach((id) => { $(id).disabled = false; });
      $('separate').textContent = 'Start over with new inks';
    } catch (e) {
      console.error(e);
      status('Separation failed: ' + e.message, true);
    } finally {
      $('busy').classList.add('hidden');
    }
  }

  function showDelta(note, prev, now) {
    const box = $('delta');
    if (!note || !prev) { box.classList.add('hidden'); return; }
    const d = now.avgDeltaE - prev.avgDeltaE;
    const verdict = Math.abs(d) < 0.15 ? 'about the same' : d > 0 ? 'worse' : 'better';
    $('deltaText').textContent = `${note}: match ${prev.rating} (ΔE ${prev.avgDeltaE}) → ${now.rating} (ΔE ${now.avgDeltaE}), ${verdict}.`;
    box.className = 'delta' + (verdict === 'worse' ? ' worse' : verdict === 'better' ? ' better' : '');
    $('undo').style.display = state.undo.length ? '' : 'none';
  }

  function editInks(note, fn) {
    if (!state.inks) return;
    state.undo.push(JSON.parse(JSON.stringify(state.inks)));
    if (state.undo.length > 30) state.undo.shift();
    fn();
    renderScreens();
    schedule('inks', note);
  }

  function undo() {
    if (!state.undo.length) return;
    state.inks = state.undo.pop();
    renderScreens();
    schedule('inks', 'Undo');
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
        if (p.options.garment && !userPickedGarment) state.garment = p.options.garment;
        if (p.options.screens) state.screens = p.options.screens;
        renderAll();
        schedule('fresh');
      });
      box.appendChild(d);
    }
  }

  let userPickedGarment = !!saved.garment;
  function setGarment(hex) {
    try { hex = E.color.toHex(E.color.parseHex(hex)); } catch (e) { return; }
    state.garment = hex;
    userPickedGarment = true;
    renderGarment();
    renderCounts();
    schedule('fresh');
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
      d.addEventListener('click', () => { state.screens = n; renderCounts(); schedule('fresh'); });
      box.appendChild(d);
    }
    const dark = E.color.rgbToLab(E.color.parseHex(state.garment))[0] < 55;
    let hint;
    if (!has) hint = m === 'cmyk' ? `4 process screens${dark ? ' + underbase + highlight white' : ''}.` : '1 screen.';
    else if (state.screens === 'auto') hint = 'Finds the fewest screens that still match your art.';
    else if (dark && m !== 'spot' && state.screens >= 3) hint = `${state.screens} screens total, including the underbase and highlight white. Your press needs ${state.screens} heads.`;
    else hint = `${state.screens} screens total. Your press needs ${state.screens} heads.`;
    $('countHint').textContent = hint;
  }

  // ---------- generic controls ----------
  function pct(v) { return `${Math.round(v * 100)}%`; }
  function valueOf(src, k, dflt) { return src[k] !== undefined ? src[k] : dflt; }

  // Sliders update while dragging (debounced), so the preview follows the hand.
  function fieldEl(def, value, onChange) {
    const row = document.createElement('div');
    row.className = 'field';
    const lab = document.createElement('label');
    lab.textContent = def.label;
    if (def.tip) lab.title = def.tip;
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
      r.addEventListener('input', () => { val.textContent = def.fmt(Number(r.value)); onChange(Number(r.value), true); });
      r.addEventListener('change', () => onChange(Number(r.value)));
      ctl.appendChild(r); ctl.appendChild(val);
    } else if (def.type === 'number') {
      const n = document.createElement('input');
      n.type = 'number'; n.min = def.min; n.max = def.max; n.step = def.step; n.value = value; n.style.width = '70px';
      n.addEventListener('change', () => { const v = Number(n.value); if (!isNaN(v)) onChange(v); });
      ctl.appendChild(n);
      if (def.unit) { const u = document.createElement('span'); u.className = 'muted'; u.style.marginLeft = '6px'; u.textContent = def.unit; ctl.appendChild(u); }
    } else if (def.type === 'check') {
      const c = document.createElement('input');
      c.type = 'checkbox'; c.checked = !!value;
      c.addEventListener('change', () => onChange(c.checked));
      ctl.appendChild(c);
    }
    return row;
  }

  // ---------- art size, resolution, sharpness ----------
  const PREP = [
    { k: 'printWidthIn', label: 'Print width', type: 'number', min: 1, max: 40, step: 0.25, unit: 'in', tip: 'Width of the print on the shirt. Sets the resolution.' },
    { k: 'targetPpi', label: 'Resolution', type: 'select', opts: [[200, '200 ppi'], [250, '250 ppi'], [300, '300 ppi (recommended)'], [360, '360 ppi']] },
    { k: 'upscale', label: 'Upscale low-res', type: 'check', tip: 'Enlarge art below the target resolution with a smooth bicubic resample.' },
    { k: 'sharpen', label: 'Sharpen', type: 'range', min: 0, max: 2, step: 0.05, fmt: pct },
    { k: 'sharpenRadius', label: 'Sharpen radius', type: 'range', min: 0.5, max: 3, step: 0.1, fmt: (v) => `${v.toFixed(1)} px` },
    { k: 'denoise', label: 'Noise clean-up', type: 'select', opts: [[0, 'Off'], [1, 'Light (JPEG speckle)'], [2, 'Strong (scans)']] },
  ];

  function renderArt() {
    const body = $('artBody');
    body.innerHTML = '';
    if (state.art && !state.prep.printWidthIn) {
      state.prep.printWidthIn = +(state.art.original.width / (state.art.original.dpi || 300)).toFixed(2);
    }
    for (const def of PREP) {
      body.appendChild(fieldEl(def, valueOf(state.prep, def.k, E.PREP_DEFAULTS[def.k]), (v, dragging) => {
        state.prep[def.k] = v;
        if (!dragging) renderArtInfo();
        schedule('prep');
      }));
    }
    renderArtInfo();
  }

  function renderArtInfo() {
    const el = $('artInfo');
    if (!state.art) { el.textContent = 'Open artwork to see its print resolution.'; return; }
    const a = state.art.original;
    const i = E.artInfo(a, state.prep);
    const lines = [`Art is ${a.width}×${a.height}px. At ${i.widthIn.toFixed(2)}×${i.heightIn.toFixed(2)} in that is ${Math.round(i.sourcePpi)} ppi${i.lowRes ? ' (low for screen printing)' : ''}.`];
    if (i.upscaled) lines.push(`Output: ${i.outWidth}×${i.outHeight}px at ${Math.round(i.outputPpi)} ppi (upscaled ${(i.outputPpi / i.sourcePpi).toFixed(1)}×). Add some sharpening to crisp up edges.`);
    else if (i.lowRes) lines.push('Turn on "Upscale low-res" for smoother edges on film.');
    else lines.push(`Output: ${i.outWidth}×${i.outHeight}px at ${Math.round(i.outputPpi)} ppi.`);
    el.textContent = lines.join(' ');
    el.style.color = i.lowRes && !i.upscaled ? '#f0b429' : '';
  }

  // ---------- fine-tune + film ----------
  const TUNE = [
    { k: 'overlap', label: 'Ink build-up', modes: ['simulated'], type: 'select', opts: [['stack', 'Full color'], ['side', 'Soft hand (less ink)']] },
    { k: 'underbase', label: 'Underbase', modes: ['simulated', 'index', 'spot', 'cmyk'], type: 'select', opts: [['auto', 'Auto (dark shirts)'], [true, 'Always'], [false, 'Never']], fresh: true },
    { k: 'underbaseStrength', label: 'Underbase density', modes: ['simulated', 'spot'], type: 'range', min: 0.5, max: 1.3, step: 0.05, fmt: pct },
    { k: 'choke', label: 'Underbase choke', modes: ['simulated', 'spot'], type: 'range', min: 0, max: 4, step: 1, fmt: (v) => `${v} px` },
    { k: 'highlightWhite', label: 'Highlight white', modes: ['simulated', 'index', 'spot'], type: 'select', opts: [['auto', 'Auto'], [true, 'Always'], [false, 'Never']], fresh: true },
    { k: 'maxInksPerPixel', label: 'Inks per spot', modes: ['simulated', 'index'], type: 'select', opts: [[2, '2 (cleanest)'], [3, '3 (balanced)'], [4, '4 (smoothest)']] },
    { k: 'minDot', label: 'Smallest dot', modes: ['simulated', 'cmyk', 'grayscale'], type: 'range', min: 0, max: 0.15, step: 0.01, fmt: pct },
    { k: 'maxDot', label: 'Largest dot', modes: ['simulated', 'cmyk', 'grayscale'], type: 'range', min: 0.85, max: 1, step: 0.01, fmt: pct },
    { k: 'dotGain', label: 'Dot gain comp.', modes: ['simulated', 'cmyk', 'grayscale'], type: 'range', min: 0, max: 0.3, step: 0.01, fmt: pct },
    { k: 'inkOpacity', label: 'Ink opacity', modes: ['simulated', 'index', 'spot'], type: 'range', min: 0.7, max: 1, step: 0.01, fmt: pct, tip: 'How well your inks cover. Lower for thin or discharge-style inks.' },
    { k: 'cleanup', label: 'Speck clean-up', modes: ['spot'], type: 'range', min: 0, max: 3, step: 1, fmt: (v) => (v ? `${v} pass${v > 1 ? 'es' : ''}` : 'off') },
    { k: 'trap', label: 'Trap (spread)', modes: ['spot'], type: 'range', min: 0, max: 3, step: 1, fmt: (v) => `${v} px` },
    { k: 'smoothEdges', label: 'Smooth edges', modes: ['spot'], type: 'check' },
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

  function renderTune() {
    const body = $('tuneBody');
    body.innerHTML = '';
    const base = Object.assign({}, E.DEFAULTS, preset().options);
    const m = mode();
    for (const def of TUNE) {
      if (!def.modes.includes(m)) continue;
      body.appendChild(fieldEl(def, valueOf(state.tune, def.k, base[def.k]), (v) => {
        state.tune[def.k] = v;
        schedule(def.fresh ? 'fresh' : 'tune');
      }));
    }
    const reset = document.createElement('button');
    reset.className = 'btn small';
    reset.textContent = 'Reset to preset';
    reset.addEventListener('click', () => { state.tune = {}; renderTune(); schedule('tune'); });
    body.appendChild(reset);
  }

  function renderFilm() {
    const body = $('filmBody');
    body.innerHTML = '';
    const f = state.film;
    for (const def of FILM) {
      if (def.when && !def.when(f)) continue;
      body.appendChild(fieldEl(def, valueOf(f, def.k, def.dflt !== undefined ? def.dflt : ''), (v, dragging) => {
        f[def.k] = v;
        state.full = null;
        save();
        if (!dragging) renderFilm();
        renderScreens();
        // Film settings don't change the separation: show the dots.
        if (state.result) { if (state.view === 'preview' || state.view === 'art') state.view = 'dots'; renderTabs(); renderView(); }
      }));
    }
    const note = (t) => { const n = document.createElement('div'); n.className = 'muted small'; n.textContent = t; body.appendChild(n); };
    if (mode() === 'cmyk' && f.type === 'am') note('CMYK angles: C 15°, M 75°, Y 0°, K 45° (moiré-safe set).');
    if (f.type === 'am') {
      const mesh = E.halftone.recommendMesh({ role: 'color' }, f);
      note(`At ${f.lpi} lpi use about ${mesh.range} mesh for colors (≈ 4–5× the line count). Same angle on every sim-process screen keeps dots nested and avoids moiré between colors.`);
    }
    note('Changes here show in the "Dots" view: tap the preview to pick the spot to inspect.');
    if (host.name === 'photoshop') {
      body.appendChild(fieldEl({ label: 'Bake into document', type: 'check' }, state.bake, (v) => { state.bake = v; save(); }));
      note('Off: the document keeps smooth tones and your RIP makes the dots (recommended). On: the document gets these bitmaps at film resolution.');
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
      renderLibrary();
      status(`Imported ${inks.length} inks from ${file.name}.`);
      schedule('fresh');
    } catch (e) { status(e.message, true); }
  }

  // ---------- artwork ----------
  function status(text, err) {
    const s = $('status');
    s.textContent = text || '';
    s.className = 'status small ' + (err ? 'err' : 'muted');
  }
  const tick = () => new Promise((r) => setTimeout(r, 16));

  async function loadArt() {
    const art = await host.getArtwork();
    if (!art) return false;
    const sameSize = state.art && state.art.original.width === art.width && state.art.original.height === art.height;
    state.art = { original: art, name: art.name || 'Artwork' };
    state.proof = null;
    state.full = null;
    if (!sameSize) state.prep.printWidthIn = +(art.width / (art.dpi || 300)).toFixed(2);
    $('docInfo').textContent = `${state.art.name} · ${art.width}×${art.height}px · ${Math.round(art.dpi || 300)} ppi`;
    $('emptyStage').classList.add('hidden');
    renderArt();
    return true;
  }

  async function separateFresh(reload) {
    if (reload || !state.art) {
      status('Reading artwork…');
      await tick();
      if (!(await loadArt())) { status(host.name === 'photoshop' ? 'Open a document in Photoshop first.' : 'Open an image first.', true); return; }
    }
    state.inks = null;
    await runProof(true);
  }

  // Full-resolution result for output, using exactly the inks on screen.
  async function fullResult() {
    const key = JSON.stringify({ inks: visibleInks(), tune: state.tune, prep: state.prep, garment: state.garment, p: state.presetId });
    if (state.full && state.fullKey === key) return state.full;
    status('Preparing art at full resolution…');
    await tick();
    const prepared = E.prepareArt(state.art.original, state.prep);
    status('Separating at full resolution…');
    await tick();
    const o = options(false);
    o.lutGrid = 33;
    state.full = E.separate(prepared.image, o);
    state.fullKey = key;
    return state.full;
  }

  // ---------- preview ----------
  const MATCH_WORDS = {
    Excellent: 'Prints should look like the art.',
    Good: 'Small color differences, mostly in gradients.',
    Fair: 'Noticeable differences. Add a screen or lock the missing color.',
    Poor: 'These inks can\'t reproduce the art. Add screens or change mode.',
  };

  function renderResults() {
    const r = state.result;
    if (!r) return;
    $('screensCard').classList.remove('hidden');
    const b = $('matchBadge');
    b.className = 'badge ' + r.report.match.rating;
    b.textContent = `${r.report.match.rating} match · ΔE ${r.report.match.avgDeltaE}`;
    b.title = MATCH_WORDS[r.report.match.rating] + ' ΔE under 2 is hard to see.';
    renderTabs();
    renderView();
    renderScreens();
    const w = $('warnings');
    w.innerHTML = '';
    const items = r.report.warnings.slice();
    if (r.report.speckPixelsRemoved > 0) items.push({ level: 'tip', text: `Removed ${r.report.speckPixelsRemoved.toLocaleString()} dots too small to hold on the screen.` });
    for (const x of items) {
      const li = document.createElement('li');
      li.className = x.level;
      li.textContent = x.text;
      w.appendChild(li);
    }
  }

  function renderTabs() {
    const box = $('viewTabs');
    box.innerHTML = '';
    if (!state.result) return;
    const add = (id, text, color) => {
      const t = document.createElement('span');
      t.className = 'tab' + (state.view === id ? ' on' : '');
      if (color) { const d = document.createElement('span'); d.className = 'dot'; d.style.background = color; t.appendChild(d); }
      t.appendChild(document.createTextNode(text));
      t.addEventListener('click', () => { state.view = id; renderTabs(); renderView(); });
      box.appendChild(t);
    };
    add('preview', 'On shirt');
    add('art', 'Original');
    add('dots', 'Dots (close-up)');
    if (state.view !== 'preview' && state.view !== 'art' && state.view !== 'dots' && state.view >= state.result.screens.length) state.view = 'preview';
    state.result.screens.forEach((s, i) => add(i, String(s.order), s.hex));
  }

  function renderView() {
    const r = state.result;
    if (!r) return;
    const img = $('previewImg');
    const w = r.width, h = r.height;
    let rgba, ww = w, hh = h, hint;
    img.className = '';
    if (state.view === 'preview') {
      rgba = r.preview;
      hint = 'Simulated print on the shirt. Tap anywhere to see the real halftone dots there.';
    } else if (state.view === 'art') {
      const src = proofImage().image;
      rgba = new Uint8ClampedArray(w * h * 4);
      const g = E.color.parseHex(state.garment);
      for (let p = 0; p < w * h; p++) {
        const a = src.channels === 4 ? src.data[p * 4 + 3] / 255 : 1;
        for (let k = 0; k < 3; k++) rgba[p * 4 + k] = src.data[p * src.channels + k] * a + g[k] * (1 - a);
        rgba[p * 4 + 3] = 255;
      }
      hint = 'Your art after resolution, sharpen and clean-up, on the shirt color.';
    } else if (state.view === 'dots') {
      const d = E.dotPreview(r, state.film, state.zoom.x, state.zoom.y, 320);
      rgba = d.rgba; ww = d.width; hh = d.height;
      img.className = 'pixel';
      const f = state.film;
      const inches = (320 / (f.dpi || 720)).toFixed(2);
      hint = `Close-up, ${inches} in wide at ${f.dpi || 720} dpi with your film settings. Tap to go back.`;
    } else {
      const s = r.screens[state.view];
      rgba = new Uint8ClampedArray(w * h * 4);
      for (let p = 0; p < w * h; p++) { const v = 255 - s.plate[p]; rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; }
      hint = `Screen ${s.order}: ${s.name}. Black prints. ${(s.coverage * 100).toFixed(1)}% coverage.`;
    }
    host.showImage(img, rgba, ww, hh);
    $('viewHint').textContent = hint;
  }

  // ---------- screens list ----------
  function renderScreens() {
    const r = state.result;
    if (!r || !state.inks) return;
    const box = $('screens');
    box.innerHTML = '';
    const summary = E.screenSummary(r, state.film);
    let vi = 0;
    state.inks.forEach((ink, i) => {
      const s = ink.hidden ? null : summary[vi++];
      const row = document.createElement('div');
      row.className = 'scr' + (ink.role === 'underbase' ? ' ub' : '') + (ink.hidden ? ' off' : '');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = ink.hidden ? '–' : String(vi);
      const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = ink.hex; chip.title = 'Change ink color';
      chip.addEventListener('click', () => openInkPicker(i, row));
      const name = document.createElement('input'); name.className = 'name'; name.value = ink.name; name.title = 'Ink name (used for the spot channel and film label)';
      name.addEventListener('change', () => { ink.name = name.value.trim() || ink.name; renderTabs(); });
      const meta = document.createElement('span'); meta.className = 'meta';
      meta.textContent = ink.hidden ? 'hidden' : s ? `${(s.coverage * 100).toFixed(1)}% · ${s.mesh} mesh` : '';
      if (s) meta.title = `Mesh range ${s.meshRange}`;
      row.appendChild(n); row.appendChild(chip); row.appendChild(name); row.appendChild(meta);
      const btn = (txt, title, fn, on) => { const b = document.createElement('button'); b.className = 'btn ic' + (on ? ' on' : ''); b.textContent = txt; b.title = title; b.addEventListener('click', fn); row.appendChild(b); };
      btn(ink.hidden ? '◌' : '👁', ink.hidden ? 'Show this screen again' : 'Hide this screen (see the print without it)',
        () => editInks(`${ink.hidden ? 'Showed' : 'Hid'} ${ink.name}`, () => { ink.hidden = !ink.hidden; }), ink.hidden);
      if (ink.role !== 'underbase') btn(ink.locked ? '🔒' : '🔓', 'Lock this ink (kept when you start over with new inks)', () => { ink.locked = !ink.locked; renderScreens(); }, ink.locked);
      btn('↑', 'Print earlier', () => move(i, -1));
      btn('↓', 'Print later', () => move(i, 1));
      btn('✕', 'Remove this screen', () => editInks(`Removed ${ink.name}`, () => { state.inks.splice(i, 1); }));
      box.appendChild(row);
    });
  }

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= state.inks.length) return;
    const name = state.inks[i].name;
    editInks(`Moved ${name} ${d < 0 ? 'earlier' : 'later'}`, () => {
      const t = state.inks[i]; state.inks[i] = state.inks[j]; state.inks[j] = t;
    });
  }

  // Ink picker: nearest library inks first, then any custom color.
  function openInkPicker(i, row) {
    const old = document.getElementById('inkPicker');
    if (old) { old.parentNode.removeChild(old); if (old.dataset.i === String(i)) return; }
    const ink = state.inks[i];
    const lab = E.color.rgbToLab(E.color.parseHex(ink.hex));
    const lib = library().map((x) => [E.color.deltaE2000(lab, x.lab), x]).sort((a, b) => a[0] - b[0]).slice(0, 12);
    const box = document.createElement('div');
    box.id = 'inkPicker'; box.dataset.i = String(i);
    box.className = 'card';
    box.innerHTML = '<div class="muted small">Closest library inks (tap to swap)</div>';
    const list = document.createElement('div'); list.className = 'swatches';
    for (const [d, x] of lib) {
      const s = document.createElement('div');
      s.className = 'sw'; s.style.background = x.hex; s.title = `${x.name} (ΔE ${d.toFixed(1)})`;
      s.addEventListener('click', () => { box.parentNode.removeChild(box); editInks(`Swapped ${ink.name} for ${x.name}`, () => Object.assign(ink, { name: x.name, hex: x.hex, library: x.library })); });
      list.appendChild(s);
    }
    box.appendChild(list);
    const row2 = document.createElement('div'); row2.className = 'row';
    const hex = document.createElement('input'); hex.className = 'hex'; hex.value = ink.hex;
    hex.addEventListener('change', () => {
      try { const v = E.color.toHex(E.color.parseHex(hex.value)); box.parentNode.removeChild(box); editInks(`Changed ${ink.name} color`, () => { ink.hex = v; }); } catch (e) { hex.value = ink.hex; }
    });
    const custom = document.createElement('button');
    custom.className = 'btn small'; custom.textContent = 'Custom color…';
    custom.addEventListener('click', async () => {
      const v = await host.pickColor(ink.hex);
      if (v) { box.parentNode.removeChild(box); editInks(`Changed ${ink.name} color`, () => { ink.hex = v; }); }
    });
    row2.appendChild(hex); row2.appendChild(custom);
    box.appendChild(row2);
    row.parentNode.insertBefore(box, row.nextSibling);
  }

  function addInk() {
    if (!state.inks) return;
    editInks('Added a screen', () => {
      const hl = state.inks.findIndex((x) => x.role === 'highlight');
      const ink = { name: 'New Ink', hex: '#808080', role: 'color', locked: true, hidden: false };
      if (hl >= 0) state.inks.splice(hl, 0, ink); else state.inks.push(ink);
    });
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

  // ---------- layout + wiring ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function layout() {
    $('app').classList.toggle('narrow', window.innerWidth < 760);
  }

  function renderAll() {
    renderPresets();
    renderGarment();
    renderCounts();
    renderArt();
    renderTune();
    renderFilm();
    renderLibrary();
    if (state.result) renderScreens();
    save();
  }

  $('previewImg').addEventListener('click', (ev) => {
    if (!state.result) return;
    if (state.view === 'dots') { state.view = 'preview'; renderTabs(); renderView(); return; }
    // The picture is letterboxed inside the element (object-fit: contain).
    const rect = $('previewImg').getBoundingClientRect();
    const iw = state.result.width, ih = state.result.height;
    const k = Math.min(rect.width / iw, rect.height / ih);
    const dx = (rect.width - iw * k) / 2, dy = (rect.height - ih * k) / 2;
    const fx = (ev.clientX - rect.left - dx) / (iw * k), fy = (ev.clientY - rect.top - dy) / (ih * k);
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return;
    state.zoom = { x: fx, y: fy };
    state.view = 'dots';
    renderTabs();
    renderView();
  });
  document.querySelectorAll('.collapsible .toggle').forEach((t) => t.addEventListener('click', () => t.parentNode.classList.toggle('open')));
  $('garmentHex').addEventListener('change', () => setGarment($('garmentHex').value));
  $('garmentPick').addEventListener('click', async () => { const hex = await host.pickColor(state.garment); if (hex) setGarment(hex); });
  $('garmentFg').addEventListener('click', async () => { const hex = await host.foregroundColor(); if (hex) setGarment(hex); });
  $('separate').addEventListener('click', () => separateFresh(host.name === 'photoshop' && !state.result));
  $('reload').addEventListener('click', () => separateFresh(true));
  $('addInk').addEventListener('click', addInk);
  $('undo').addEventListener('click', undo);
  $('librarySelect').addEventListener('change', () => { state.libraryId = $('librarySelect').value; schedule('fresh'); });
  $('matchLibrary').addEventListener('change', () => { state.matchLibrary = $('matchLibrary').checked; schedule('fresh'); });
  $('importLibrary').addEventListener('click', importLibrary);
  $('build').addEventListener('click', build);
  $('exportFilms').addEventListener('click', exportFilms);
  $('exportSheet').addEventListener('click', exportSheet);
  window.addEventListener('resize', layout);

  if (host.name === 'photoshop') {
    $('openArtLabel').classList.add('hidden');
    $('emptyHint').textContent = 'Open your art in Photoshop, pick the job, shirt color and screens, then press Separate.';
    $('reload').classList.remove('hidden');
  } else {
    document.querySelectorAll('.ps-only').forEach((el) => el.classList.add('hidden'));
    $('build').textContent = 'Download plates + preview (PNG)';
    document.querySelectorAll('.ps-text').forEach((el) => { el.textContent = 'In Photoshop this builds a document with one named spot channel per ink.'; });
  }
  host.onArtworkChosen = async () => { await loadArt(); separateFresh(false); };
  window.EckoUI = { state, separateFresh, jobSheet };
  layout();
  renderAll();
})();
