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
  // Preview detail (longest side of the live proof, in pixels).
  const DETAIL = { fast: 700, sharp: 1200, max: 2000 };
  const proofMax = () => DETAIL[(load('ui') || {}).detail] || DETAIL.fast;
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
    reg: Object.assign({}, E.REG_DEFAULTS, saved.reg || {}),
    regInDoc: saved.regInDoc !== false,
    openInk: -1,
    clean: { active: false, target: '', tool: 'brush', size: 0.015, limit: 0.25 },
    artPick: [],
    artColors: null, artColorsKey: '',
    texture: Object.assign({ type: 'none', density: 0.3, scale: 0.3, softness: 0.25, strength: 1, seed: 1, invert: false, apply: 'all', fit: 'tile' }, saved.texture || {}),
    textureImage: null,
    dragging: false,
    picking: false,
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
      prep: state.prep, reg: state.reg, texture: state.texture, regInDoc: state.regInDoc, libraryId: state.libraryId, matchLibrary: state.matchLibrary, bake: state.bake,
    }));
    host.storage.set('ecko-seps-libraries', JSON.stringify(state.libraries));
  }
  const visibleInks = () => (state.inks || []).filter((i) => !i.hidden);
  // Inks that have their own screen in the result (not hidden, not merged).
  const hasScreen = (i) => !i.hidden && !(i.mergeInto && (state.inks || []).some((t) => t !== i && !t.hidden && !t.mergeInto && t.name === i.mergeInto));

  function options(fresh) {
    const o = Object.assign({}, preset().options, state.tune, {
      garment: state.garment, screens: state.screens, library: library(), matchLibrary: state.matchLibrary,
    });
    if (state.texture && state.texture.type !== 'none') {
      o.texture = Object.assign({}, state.texture);
      if (o.texture.type === 'custom') o.texture.image = state.textureImage;
    }
    if (!fresh && state.inks) o.inks = visibleInks();
    else if (state.onlyColors) {
      // "Separate with only these": exactly the chosen art colors (+ underbase).
      o.lockedInks = state.onlyColors;
      const dark = E.color.rgbToLab(E.color.parseHex(state.garment))[0] < 55;
      const ub = o.underbase === 'auto' ? dark : !!o.underbase;
      o.screens = state.onlyColors.length + (ub && state.onlyColors.length >= 2 ? 1 : 0);
      o.highlightWhite = false;
      o.refine = false;
      state.onlyColors = null;
    } else {
      const locked = (state.inks || []).filter((i) => i.locked && !i.hidden && !i.mergeInto && i.role !== 'underbase');
      if (locked.length) o.lockedInks = locked;
    }
    return o;
  }

  // ---------- live re-separation ----------
  let timer = null, pending = null;
  function schedule(kind, note) {
    if (!state.art) { save(); return; }
    // A fresh run (new inks) wins over an ink-keeping run.
    // Changes to the art itself (background, knockout, levels, size) make the
    // old and new match scores incomparable, so they get no better/worse verdict.
    const artChanged = kind === 'prep' || /background|knock|levels|high-res|texture|clean|patch/i.test(note || '');
    pending = { fresh: (pending && pending.fresh) || kind === 'fresh', note: note || (pending && pending.note), artChanged: (pending && pending.artChanged) || artChanged };
    $('busy').classList.remove('hidden');
    clearTimeout(timer);
    timer = setTimeout(() => { const p = pending; pending = null; runProof(p.fresh, p.note, p.artChanged); }, 120);
    save();
  }

  function prepOpts() {
    // Knockout needs to know the shirt color.
    return Object.assign({}, state.prep, { garment: state.garment });
  }

  function proofImage() {
    const key = JSON.stringify(prepOpts()) + proofMax();
    if (state.proof && state.proofKey === key) return state.proof;
    const info = E.artInfo(state.art.original, state.prep);
    const scale = Math.min(1, proofMax() / Math.max(info.outWidth, info.outHeight));
    state.proof = E.prepareArt(state.art.original, prepOpts(), scale);
    state.proofKey = key;
    return state.proof;
  }

  async function runProof(fresh, note, artChanged) {
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
        state.inks = [];
        for (const s of r.screens) {
          state.inks.push({ name: s.name, hex: s.hex, role: s.role, code: s.code, library: s.library, locked: !!s.locked, hidden: false });
          for (const m of s.merged || []) state.inks.push({ name: m.name, hex: m.hex, role: m.role, locked: false, hidden: false, mergeInto: s.name });
        }
        state.undo = [];
      }
      state.full = null;
      renderResults();
      if (state.prep.removeBg) renderBg();
      showDelta(note, note && state.dragBase ? state.dragBase : prev, r.report.match, artChanged);
      if (note) state.dragBase = null;
      const ms = Date.now() - t0;
      if (fresh && state.screens === 'auto' && MODES_WITH_COUNT.includes(mode())) status(`Auto picked ${r.screens.length} screens · ${ms} ms`);
      else status(`Updated in ${ms} ms`);
      ['build', 'exportFilms', 'exportSheet'].forEach((id) => { $(id).disabled = false; });
      if (fresh) openSection('screensCard', true);
      $('separate').textContent = 'Start over with new inks';
    } catch (e) {
      console.error(e);
      status('Separation failed: ' + e.message, true);
    } finally {
      $('busy').classList.add('hidden');
    }
  }

  function r0(m) { return `Match now ${m.rating} (ΔE ${m.avgDeltaE}).`; }

  function showDelta(note, prev, now, artChanged) {
    const box = $('delta');
    if (!note || !prev) { box.classList.add('hidden'); return; }
    if (artChanged) {
      $('deltaText').textContent = `${note}. ${r0(now)}`;
      box.className = 'delta';
      $('undo').style.display = state.undo.length ? '' : 'none';
      return;
    }
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
      r.addEventListener('input', () => { state.dragging = true; val.textContent = def.fmt(Number(r.value)); onChange(Number(r.value), true); });
      r.addEventListener('change', () => { state.dragging = false; onChange(Number(r.value)); });
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

  // Automatic resolution fix: art under 300 ppi at its print size gets
  // upscaled (bicubic) with light sharpening; the banner says what happened.
  function autoFixResolution() {
    const i = E.artInfo(state.art.original, Object.assign({}, state.prep, { upscale: false }));
    if (i.sourcePpi < 295) {
      state.prep.upscale = true;
      state.prep.targetPpi = 300;
      if (!state.prep.sharpen) state.prep.sharpen = i.sourcePpi < 150 ? 0.7 : 0.45;
      if (i.sourcePpi < 120 && !state.prep.denoise) state.prep.denoise = 1;
      state.autoFixed = Math.round(i.sourcePpi);
    } else state.autoFixed = 0;
  }

  function renderBanner() {
    const b = $('dpiBanner');
    if (!state.art) { b.classList.add('hidden'); return; }
    const raw = E.artInfo(state.art.original, Object.assign({}, state.prep, { upscale: false }));
    const i = E.artInfo(state.art.original, state.prep);
    b.innerHTML = '';
    const text = document.createElement('span');
    const btn = document.createElement('button');
    btn.className = 'btn small';
    if (raw.sourcePpi >= 295) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    if (i.upscaled) {
      b.className = 'banner ok';
      text.textContent = `✓ High-res: ${Math.round(raw.sourcePpi)} ppi art is rendered at ${Math.round(i.outputPpi)} ppi (${i.outWidth}×${i.outHeight}px) with sharpening${state.prep.denoise ? ' and noise clean-up' : ''}.`;
      btn.textContent = 'Undo';
      btn.addEventListener('click', () => { state.prep.upscale = false; state.prep.sharpen = 0; state.prep.denoise = 0; renderArt(); schedule('prep', 'Turned off high-res'); });
    } else {
      b.className = 'banner warn';
      text.textContent = `! Art is only ${Math.round(raw.sourcePpi)} ppi at ${raw.widthIn.toFixed(1)} in wide. Screen printing needs 300 ppi for clean edges and dots.`;
      btn.textContent = 'Make high-res (300 ppi)';
      btn.addEventListener('click', () => { autoFixResolution(); renderArt(); schedule('prep', 'Made art high-res'); });
    }
    b.appendChild(text); b.appendChild(btn);
  }

  // Background removal and shirt knockout.
  function renderBg() {
    const box = $('bgBody');
    if (!box) return;
    box.innerHTML = '';
    const tg = $('bgToggles');
    tg.innerHTML = '';
    const pill = (on, label, fn) => { const t = document.createElement('span'); t.className = 'tog' + (on ? ' on' : ''); t.textContent = (on ? '✓ ' : '') + label; t.addEventListener('click', fn); tg.appendChild(t); };
    pill(state.prep.removeBg, 'Remove background', () => { state.prep.removeBg = !state.prep.removeBg; renderBg(); schedule('fresh', state.prep.removeBg ? 'Removed background' : 'Background back'); });
    pill(state.prep.knockout, 'Knock out shirt color', () => { state.prep.knockout = !state.prep.knockout; renderBg(); schedule('fresh', state.prep.knockout ? 'Shirt color knocked out' : 'Knockout off'); });
    if (state.prep.removeBg) {
      const info = state.proof && state.proof.info && state.proof.info.background;
      const row = document.createElement('div'); row.className = 'row';
      const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = state.prep.bgColor || info || '#888';
      const lab = document.createElement('span'); lab.className = 'muted small';
      lab.textContent = state.prep.bgColor ? `Background color ${state.prep.bgColor} (picked)` : `Background found: ${info || '…'}`;
      const pick = document.createElement('button'); pick.className = 'btn small'; pick.textContent = state.picking === 'bg' ? 'Tap the background…' : 'Pick it on the art';
      pick.addEventListener('click', () => { state.picking = 'bg'; $('app').classList.add('picking'); state.view = 'art'; renderTabs(); renderView(); status('Tap the background in the picture.'); renderBg(); });
      row.appendChild(chip); row.appendChild(lab); row.appendChild(pick);
      if (state.prep.bgColor) { const auto = document.createElement('button'); auto.className = 'btn small'; auto.textContent = 'Auto'; auto.addEventListener('click', () => { state.prep.bgColor = null; renderBg(); schedule('fresh'); }); row.appendChild(auto); }
      box.appendChild(row);
      box.appendChild(fieldEl({ label: 'Tolerance', type: 'range', min: 2, max: 40, step: 1, fmt: (v) => String(v), tip: 'How different from the background color a pixel can be and still be removed.' }, state.prep.bgTolerance, (v) => { state.prep.bgTolerance = v; schedule('prep'); }));
      box.appendChild(fieldEl({ label: 'Only from edges', type: 'check', tip: 'On: removes only background touching the picture edges (keeps the same color inside the design). Off: removes that color everywhere.' }, state.prep.bgEdgesOnly, (v) => { state.prep.bgEdgesOnly = v; schedule('prep'); }));
      box.appendChild(fieldEl({ label: 'Soft edge', type: 'range', min: 0, max: 3, step: 1, fmt: (v) => `${v} px` }, state.prep.feather, (v) => { state.prep.feather = v; schedule('prep'); }));
    }
    if (state.prep.knockout) {
      box.appendChild(fieldEl({ label: 'Knockout amount', type: 'range', min: 2, max: 40, step: 1, fmt: (v) => String(v), tip: 'Art colors this close to the shirt color print nothing: the shirt shows through.' }, state.prep.knockoutTolerance, (v) => { state.prep.knockoutTolerance = v; schedule('prep'); }));
    }
    const hint = document.createElement('div'); hint.className = 'muted small';
    hint.textContent = 'Removed areas print nothing, so the shirt shows. Knockout lets the shirt be any art color that matches it (for example black in the art on a black shirt), which saves ink and keeps the print soft.';
    box.appendChild(hint);
  }

  function renderArtLevels() {
    const box = $('artLevels');
    box.innerHTML = '';
    const lv = Object.assign({ black: 0, white: 255, gamma: 1 }, state.prep.levels || {});
    const set = (k) => (v) => { state.prep.levels = Object.assign({}, lv, state.prep.levels || {}, { [k]: v }); schedule('prep'); };
    box.appendChild(fieldEl({ label: 'Black point', type: 'range', min: 0, max: 128, step: 1, fmt: (v) => String(v) }, lv.black, set('black')));
    box.appendChild(fieldEl({ label: 'Midtones', type: 'range', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2) }, lv.gamma, set('gamma')));
    box.appendChild(fieldEl({ label: 'White point', type: 'range', min: 128, max: 255, step: 1, fmt: (v) => String(v) }, lv.white, set('white')));
    box.appendChild(fieldEl({ label: 'Saturation', type: 'range', min: 0, max: 2, step: 0.05, fmt: pct }, state.prep.saturation == null ? 1 : state.prep.saturation, (v) => { state.prep.saturation = v; schedule('prep'); }));
    const reset = document.createElement('button'); reset.className = 'btn small'; reset.textContent = 'Reset levels';
    reset.addEventListener('click', () => { state.prep.levels = null; state.prep.saturation = 1; renderArtLevels(); schedule('prep', 'Reset art levels'); });
    box.appendChild(reset);
  }

  const REG_TOGGLES = [['marks', 'Registration marks'], ['crops', 'Crop marks'], ['center', 'Center marks'], ['names', 'Ink names'], ['details', 'LPI / mesh on label']];
  function renderReg() {
    const box = $('regToggles');
    box.innerHTML = '';
    for (const [k, label] of REG_TOGGLES) {
      const t = document.createElement('span');
      t.className = 'tog' + (state.reg[k] ? ' on' : '');
      t.textContent = (state.reg[k] ? '✓ ' : '+ ') + label;
      t.addEventListener('click', () => { state.reg[k] = !state.reg[k]; save(); renderReg(); afterRegChange(); });
      box.appendChild(t);
    }
    const body = $('regBody');
    body.innerHTML = '';
    body.appendChild(fieldEl({ label: 'Mark thickness', type: 'select', opts: [['fine', 'Fine (0.5 pt)'], ['normal', 'Normal (1 pt)'], ['bold', 'Bold (2 pt)'], ['extra', 'Extra bold (3 pt)']] }, state.reg.weight || 'bold', (v) => { state.reg.weight = v; save(); afterRegChange(); }));
    body.appendChild(fieldEl({ label: 'Margin', type: 'select', opts: [[0.25, '0.25 in'], [0.5, '0.5 in'], [0.75, '0.75 in'], [1, '1 in']] }, state.reg.marginIn, (v) => { state.reg.marginIn = v; save(); afterRegChange(); }));
    if (host.name === 'photoshop') body.appendChild(fieldEl({ label: 'Add to document', type: 'check' }, state.regInDoc, (v) => { state.regInDoc = v; save(); }));
  }

  function afterRegChange() {
    state.full = null;
    renderSteps();
    if (state.result) {
      if (typeof state.view !== 'number') state.view = state.result.screens.length > 1 ? 1 : 0;
      renderTabs(); renderView();
    }
  }

  function pickBgAt(fx, fy) {
    state.picking = false;
    $('app').classList.remove('picking');
    const src = state.art.original;
    const x = Math.min(src.width - 1, Math.floor(fx * src.width)), y = Math.min(src.height - 1, Math.floor(fy * src.height));
    const i = (y * src.width + x) * src.channels;
    state.prep.bgColor = E.color.toHex([src.data[i], src.data[i + 1], src.data[i + 2]]);
    state.prep.removeBg = true;
    renderBg();
    schedule('fresh', `Background set to ${state.prep.bgColor}`);
  }

  function pickSpotAt(fx, fy) {
    const forMixer = state.picking === 'mixer';
    state.picking = false;
    $('app').classList.remove('picking');
    layout();
    const src = proofImage().image;
    const x = Math.min(src.width - 1, Math.floor(fx * src.width)), y = Math.min(src.height - 1, Math.floor(fy * src.height));
    const acc = [0, 0, 0];
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(src.width - 1, Math.max(0, x + dx)), yy = Math.min(src.height - 1, Math.max(0, y + dy));
      const i = (yy * src.width + xx) * src.channels;
      if (src.channels === 4 && src.data[i + 3] < 128) continue;
      acc[0] += src.data[i]; acc[1] += src.data[i + 1]; acc[2] += src.data[i + 2]; n++;
    }
    if (!n) { status('That spot is transparent. Tap on the art.', true); return; }
    let hex = E.color.toHex(acc.map((v) => v / n));
    if (forMixer) { setMixerHex(hex); openAddColor(); status(`Picked ${hex}. Adjust it if you like, then press "Add this color".`); return; }
    const lab = E.color.rgbToLab(E.color.parseHex(hex));
    let name = E.color.colorName(lab);
    if (state.matchLibrary) { const m = E.inks.nearestInk(lab, library()); if (m) { name = m.ink.name; hex = m.ink.hex; } }
    editInks(`Added spot ${name}`, () => {
      const hl = state.inks.findIndex((q) => q.role === 'highlight');
      const ink = { name, hex, role: 'color', locked: true, hidden: false };
      if (hl >= 0) state.inks.splice(hl, 0, ink); else state.inks.push(ink);
    });
  }

  // ---------- drop-down sections (accordion) ----------
  // Every options card is a drop-down with a one-line summary on its header.
  // Opening one closes the others, so the panel stays short and tidy.
  function setupSections() {
    const cards = Array.prototype.slice.call(document.querySelectorAll('#optionsPane > section.card'));
    for (const card of cards) {
      const h = card.querySelector('h2');
      if (!h) continue;
      if (!card.classList.contains('collapsible')) {
        card.classList.add('collapsible');
        const body = document.createElement('div');
        body.className = 'body';
        while (h.nextSibling) body.appendChild(h.nextSibling);
        card.appendChild(body);
      }
      h.classList.add('toggle');
      if (!h.querySelector('.sum')) { const sm = document.createElement('span'); sm.className = 'sum'; h.appendChild(sm); }
      h.addEventListener('click', () => openSection(card.id, !card.classList.contains('open')));
    }
    const ui0 = load('ui') || {};
    cards.forEach((c) => c.classList.remove('open'));
    openSection(ui0.section || 'artCard', true, true);
  }

  function openSection(id, open, quiet) {
    const cards = document.querySelectorAll('#optionsPane > section.card');
    for (const c of cards) if (c.id !== id) c.classList.remove('open');
    const el = $(id);
    if (!el) return;
    el.classList.toggle('open', open !== false);
    if (!quiet) { ui.section = open !== false ? id : ''; saveUi(); }
  }

  function setSummary(id, text) {
    const el = $(id);
    const sm = el && el.querySelector('h2 .sum');
    if (sm) sm.textContent = text || '';
  }

  // ---------- workflow checklist ----------
  const CARD = { art: 'artCard', job: 'presetCard', shirt: 'garmentCard', screens: 'countCard', sep: 'separate', colors: 'screensCard', tex: 'textureCard', ub: 'tuneCard', film: 'filmCard', reg: 'regCard', out: 'outputCard' };
  function renderSteps() {
    const box = $('steps');
    if (!box) return;
    const r = state.result;
    const steps = [];
    if (!state.art) steps.push(['art', 'todo', 'Art check', 'Open your artwork']);
    else {
      const raw = E.artInfo(state.art.original, Object.assign({}, state.prep, { upscale: false }));
      const i = E.artInfo(state.art.original, state.prep);
      if (raw.sourcePpi >= 295) steps.push(['art', 'ok', 'Art check', `${Math.round(raw.sourcePpi)} ppi at ${i.widthIn.toFixed(1)} in`]);
      else if (i.upscaled) steps.push(['art', 'ok', 'Art check', `${Math.round(raw.sourcePpi)} → ${Math.round(i.outputPpi)} ppi (fixed)`]);
      else steps.push(['art', 'warn', 'Art check', `Only ${Math.round(raw.sourcePpi)} ppi: make it high-res`]);
    }
    steps.push(['job', 'ok', 'Job type', preset().label]);
    const g = GARMENTS.find((x) => x[1] === state.garment);
    steps.push(['shirt', 'ok', 'Shirt color', g ? g[0] : state.garment]);
    steps.push(['screens', 'ok', 'Screens', MODES_WITH_COUNT.includes(mode()) ? (state.screens === 'auto' ? 'Auto' : `${state.screens}`) : 'set by mode']);
    if (!r) steps.push(['sep', state.art ? 'todo' : '', 'Separate', 'Press Separate']);
    else steps.push(['sep', r.report.match.rating === 'Poor' || r.report.match.rating === 'Fair' ? 'warn' : 'ok', 'Separate', `${r.screens.length} screens · ${r.report.match.rating} (ΔE ${r.report.match.avgDeltaE})`]);
    if (r) {
      const adjusted = (state.inks || []).filter((x) => x.adjust || x.film).length;
      const hidden = (state.inks || []).filter((x) => x.hidden).length;
      const merged = (state.inks || []).filter((x) => x.mergeInto && !x.hidden).length;
      steps.push(['colors', 'ok', 'Colors & order', `${adjusted ? `${adjusted} adjusted` : 'optional tweaks'}${merged ? ` · ${merged} merged` : ''}${hidden ? ` · ${hidden} hidden` : ''}`]);
      steps.push(['tex', 'ok', 'Texture & distress', state.texture.type === 'none' ? 'none (optional)' : `${state.texture.type} · ${Math.round(state.texture.density * 100)}%`]);
      const ub = r.screens.find((x) => x.role === 'underbase');
      const choke = state.tune.choke != null ? state.tune.choke : (preset().options.choke != null ? preset().options.choke : E.DEFAULTS.choke);
      steps.push(['ub', 'ok', 'Underbase & fine-tune', ub ? `underbase ${(ub.coverage * 100).toFixed(0)}% · choke ${choke}px` : 'no underbase needed']);
    } else {
      steps.push(['colors', '', 'Colors & order', 'after separating']);
      steps.push(['tex', '', 'Texture & distress', 'optional']);
      steps.push(['ub', '', 'Underbase & fine-tune', 'after separating']);
    }
    const f = state.film;
    steps.push(['film', 'ok', 'Halftones & films', f.type === 'am' ? `${f.lpi} lpi · ${f.angle != null ? f.angle + '°' : 'CMYK angles'} · ${f.dot} · ${f.dpi} dpi` : f.type === 'continuous' ? 'RIP halftones' : `${f.type} · ${f.dpi} dpi`]);
    const on = REG_TOGGLES.filter(([k]) => state.reg[k]).map(([, l]) => l.split(' ')[0].toLowerCase());
    steps.push(['reg', on.length ? 'ok' : 'warn', 'Registration', on.length ? on.join(', ') : 'no marks: films are hard to line up']);
    steps.push(['out', r ? 'todo' : '', 'Output', r ? (host.name === 'photoshop' ? 'Build document or export films' : 'Ready (Photoshop plug-in exports)') : 'after separating']);
    for (const [key, , , sub] of steps) if (CARD[key] && CARD[key] !== 'separate') setSummary(CARD[key], sub);
    const done = steps.filter((x) => x[1] === 'ok').length;
    setSummary('workflow', `${done} of ${steps.length} done`);
    setSummary('libraryCard', state.libraryId === 'builtin' ? 'built-in inks' : 'your library');
    box.innerHTML = '';
    steps.forEach(([key, st, title, sub], idx) => {
      const d = document.createElement('div');
      d.className = 'stp ' + st;
      d.innerHTML = `<span class="ico">${st === 'ok' ? '✓' : st === 'warn' ? '!' : idx + 1}</span><span class="t"><b>${idx + 1}. ${esc(title)}</b></span><span class="s">${esc(sub)}</span>`;
      d.addEventListener('click', () => {
        const el = $(CARD[key]);
        if (!el) return;
        if (el.classList.contains('collapsible')) openSection(el.id, true);
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 900);
      });
      box.appendChild(d);
    });
  }

  function renderArtInfo() {
    renderBanner();
    renderSteps();
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
    { k: 'underbaseStyle', label: 'Underbase style', modes: ['simulated', 'spot'], type: 'select', opts: [['tonal', 'Tonal (follows the art’s light)'], ['inks', 'Solid under every color']], tip: 'Tonal keeps the shading of the art in the underbase, like a fuller highlight white. Solid puts full white under anything that needs it.' },
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
    if (!sameSize) {
      // Photoshop knows the document's print size. A browser image has no
      // reliable size, so assume a standard 11 in front print.
      state.prep.printWidthIn = art.fromBrowser ? +Math.max(1, Math.min(11, art.width / 300 > 11 ? art.width / 300 : 11)).toFixed(2) : +(art.width / (art.dpi || 300)).toFixed(2);
      state.prep.levels = null; state.prep.saturation = 1; state.prep.sharpen = 0; state.prep.denoise = 0; state.prep.bgColor = null;
      autoFixResolution();
    }
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
    const prepared = E.prepareArt(state.art.original, prepOpts());
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
    add('compare', '⇆ Compare');
    add('dots', 'Dots (close-up)');
    if (typeof state.view === 'number' && state.view >= state.result.screens.length) state.view = 'preview';
    state.result.screens.forEach((s, i) => add(i, String(s.order), s.hex));
  }

  // The uploaded art, untouched, scaled to the preview size on the shirt.
  let origCache = { key: '', rgba: null };
  function originalOnShirt(w, h) {
    const key = `${w}x${h}:${state.garment}:${state.art && state.art.original.width}`;
    if (origCache.key === key) return origCache.rgba;
    const src = E.ops.resizeImage(state.art.original, w, h);
    const g = E.color.parseHex(state.garment);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      const a = src.channels === 4 ? src.data[p * 4 + 3] / 255 : 1;
      for (let k = 0; k < 3; k++) out[p * 4 + k] = src.data[p * src.channels + k] * a + g[k] * (1 - a);
      out[p * 4 + 3] = 255;
    }
    origCache = { key, rgba: out };
    return out;
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
      hint = 'Simulated print on the shirt. Scroll or use − / + to zoom; tap (at Fit) to see the real halftone dots there.';
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
    } else if (state.view === 'compare') {
      // Original upload (before any fixes) next to the print preview, side
      // by side when the window is wide, stacked when it's tall.
      const orig = originalOnShirt(w, h);
      const st = $('stage').getBoundingClientRect();
      const across = st.height > 0 ? (st.width / st.height) >= (w / h) : true;
      const gap = Math.max(6, Math.round(Math.max(w, h) * 0.02));
      ww = across ? w * 2 + gap : w; hh = across ? h : h * 2 + gap;
      rgba = new Uint8ClampedArray(ww * hh * 4);
      for (let p = 0; p < ww * hh; p++) { rgba[p * 4] = 30; rgba[p * 4 + 1] = 26; rgba[p * 4 + 2] = 22; rgba[p * 4 + 3] = 255; }
      const blit = (src, ox, oy) => { for (let y = 0; y < h; y++) rgba.set(src.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * ww + ox) * 4); };
      blit(orig, 0, 0);
      blit(r.preview, across ? w + gap : 0, across ? 0 : h + gap);
      hint = across ? 'Left: your original artwork as uploaded · Right: the print preview with every fix and setting.' : 'Top: your original artwork as uploaded · Bottom: the print preview with every fix and setting.';
    } else if (state.view === 'dots') {
      const d = E.dotPreview(r, state.film, state.zoom.x, state.zoom.y, 320);
      rgba = d.rgba; ww = d.width; hh = d.height;
      img.className = 'pixel';
      const f = state.film;
      const inches = (320 / (f.dpi || 720)).toFixed(2);
      hint = `Close-up, ${inches} in wide at ${f.dpi || 720} dpi with your film settings. Tap to go back.`;
    } else {
      // While cleaning up, show the bare screen so taps map straight onto it.
      const reg = state.clean.active ? r : E.applyRegistration(r, state.film, state.reg);
      const s = reg.screens[state.view];
      ww = reg.width; hh = reg.height;
      rgba = new Uint8ClampedArray(ww * hh * 4);
      for (let p = 0; p < ww * hh; p++) { const v = 255 - s.plate[p]; rgba[p * 4] = v; rgba[p * 4 + 1] = v; rgba[p * 4 + 2] = v; rgba[p * 4 + 3] = 255; }
      hint = `Screen ${s.order}: ${s.name}. Black prints. ${(s.coverage * 100).toFixed(1)}% coverage.`;
    }
    host.showImage(img, rgba, ww, hh);
    $('viewHint').textContent = proofMode() ? `${hint.split('. Tap')[0].replace(/ Tap .*$/, '')} · Showing in the Proof Window next to your art.` : hint;
    pushLive(rgba, ww, hh);
  }

  // Live Proof Window in Photoshop: after every change the separation is
  // rebuilt there as spot channels (throttled: newest state wins, so dragging
  // keeps updating without piling up work).
  let liveTimer = null, liveBusy = false, liveDirty = false, liveView = null;
  function pushLive(rgba, w, h) {
    if (host.name !== 'photoshop' || !host.showProof || ui.liveOff || !state.result) return;
    liveView = { rgba, w, h };
    liveDirty = true;
    if (!liveBusy && !liveTimer) liveTimer = setTimeout(flushLive, 150);
  }
  function fitInto(rgba, sw, sh, w, h) {
    // Letterbox a picture into the proof size on a dark background.
    const k = Math.min(w / sw, h / sh);
    const tw = Math.max(1, Math.round(sw * k)), th = Math.max(1, Math.round(sh * k));
    const small = E.ops.resizeImage({ data: rgba, width: sw, height: sh, channels: 4 }, tw, th);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let p = 0; p < w * h; p++) { out[p * 4] = 30; out[p * 4 + 1] = 26; out[p * 4 + 2] = 22; out[p * 4 + 3] = 255; }
    const ox = Math.floor((w - tw) / 2), oy = Math.floor((h - th) / 2);
    for (let y = 0; y < th; y++) out.set(small.data.subarray(y * tw * 4, (y + 1) * tw * 4), ((y + oy) * w + ox) * 4);
    return out;
  }
  async function flushLive() {
    liveTimer = null;
    if (liveBusy || !liveDirty || !state.result) return;
    liveDirty = false;
    liveBusy = true;
    const r = state.result;
    const job = {
      w: r.width, h: r.height, dpi: r.dpi, garment: state.garment, arrange: ui.proofAs || 'windows',
      screens: r.screens.map((x) => ({ name: x.name, hex: x.hex, role: x.role, plate: x.plate })),
    };
    if (typeof state.view === 'number') job.only = state.view;
    else if (state.view !== 'preview' && liveView) {
      job.viewRgba = liveView.w === r.width && liveView.h === r.height ? liveView.rgba : fitInto(liveView.rgba, liveView.w, liveView.h, r.width, r.height);
    }
    const t0 = Date.now();
    try {
      await host.showProof(job);
      proofNote(`Proof Window updated ${new Date().toLocaleTimeString()} · ${job.screens.length} spot channels · ${Date.now() - t0} ms`);
    } catch (e) {
      proofNote(`Proof Window could not update: ${e.message}`, true);
    } finally {
      liveBusy = false;
      if (liveDirty && !liveTimer) liveTimer = setTimeout(flushLive, 150);
    }
  }
  function proofNote(text, err) {
    const el = $('proofStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'small ' + (err ? 'err' : 'muted');
  }

  // ---------- screens list ----------
  function renderScreens() {
    const r = state.result;
    if (!r || !state.inks) return;
    renderSteps();
    if (state.dragging && state.openInk >= 0) { updateInkPanelLive(); return; }
    const box = $('screens');
    box.innerHTML = '';
    const summary = E.screenSummary(r, state.film);
    let vi = 0;
    state.inks.forEach((ink, i) => {
      const own = hasScreen(ink);
      // A merged color is part of its target screen now: no row of its own.
      if (!own && !ink.hidden) return;
      const s = own ? summary[vi++] : null;
      const row = document.createElement('div');
      row.className = 'scr' + (ink.role === 'underbase' ? ' ub' : '') + (ink.hidden ? ' off' : '') + (!own && !ink.hidden ? ' merged' : '');
      const n = document.createElement('span'); n.className = 'n'; n.textContent = ink.hidden ? '–' : own ? String(vi) : '↳';
      const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = ink.hex; chip.title = 'Change ink color';
      chip.addEventListener('click', () => openInkPicker(i, row));
      const name = document.createElement('input'); name.className = 'name'; name.value = ink.name; name.title = 'Ink name (used for the spot channel and film label)';
      name.addEventListener('change', () => {
        const old = ink.name;
        ink.name = name.value.trim() || ink.name;
        for (const x of state.inks) if (x.mergeInto === old) x.mergeInto = ink.name; // keep merges attached
        renderTabs(); renderMergeControls();
      });
      const meta = document.createElement('span'); meta.className = 'meta';
      const mergedIn = (state.inks || []).filter((x) => x !== ink && x.mergeInto === ink.name && !x.hidden);
      meta.textContent = (mergedIn.length ? `⊕${mergedIn.length} merged · ` : '') + (ink.hidden ? 'hidden' : s ? `${(s.coverage * 100).toFixed(1)}% · ${s.mesh} mesh` : '') + (ink.erase && ink.erase.length ? ` · 🧹${ink.erase.length}` : '');
      if (s) meta.title = `Mesh range ${s.meshRange}`;
      row.appendChild(n); row.appendChild(chip); row.appendChild(name); row.appendChild(meta);
      const btn = (txt, title, fn, on) => { const b = document.createElement('button'); b.className = 'btn ic' + (on ? ' on' : ''); b.textContent = txt; b.title = title; b.addEventListener('click', fn); row.appendChild(b); };
      btn(ink.hidden ? '◌' : '👁', ink.hidden ? 'Show this screen again' : 'Hide this screen (see the print without it)',
        () => editInks(`${ink.hidden ? 'Showed' : 'Hid'} ${ink.name}`, () => { ink.hidden = !ink.hidden; }), ink.hidden);
      btn('⚙', 'Amount, levels and advanced settings for this color', () => { state.openInk = state.openInk === i ? -1 : i; renderScreens(); }, state.openInk === i);
      row.lastChild.classList.add('gear');
      if (ink.role !== 'underbase') btn(ink.locked ? '🔒' : '🔓', 'Lock this ink (kept when you start over with new inks)', () => { ink.locked = !ink.locked; renderScreens(); }, ink.locked);
      btn('↑', 'Print earlier', () => move(i, -1));
      btn('↓', 'Print later', () => move(i, 1));
      btn('✕', 'Remove this screen', () => editInks(`Removed ${ink.name}`, () => { state.inks.splice(i, 1); if (state.openInk === i) state.openInk = -1; }));
      box.appendChild(row);
      if (state.openInk === i) box.appendChild(inkPanel(ink, s));
    });
    renderMergeControls();
    renderArtColors();
    renderAddColor();
  }

  // ---------- merge screens ----------
  function renderMergeControls() {
    const from = $('mergeFrom'), to = $('mergeTo');
    if (!from || !state.inks) return;
    const standalone = state.inks.filter((x) => hasScreen(x));
    const fill = (sel, list, keep) => {
      const prev = sel.value;
      sel.innerHTML = '';
      for (const x of list) { const o = document.createElement('option'); o.value = x.name; o.textContent = x.name; sel.appendChild(o); }
      if (list.some((x) => x.name === prev)) sel.value = prev; else if (keep && list.length) sel.value = keep;
    };
    const hw = standalone.find((x) => x.role === 'highlight');
    const ub = standalone.find((x) => x.role === 'underbase');
    fill(from, standalone, hw ? hw.name : (standalone[standalone.length - 1] || {}).name);
    fill(to, standalone, ub ? ub.name : (standalone[0] || {}).name);
  }

  function mergeSelected() {
    const a = $('mergeFrom').value, b = $('mergeTo').value;
    if (!a || !b || a === b) { status('Pick two different screens to merge.', true); return; }
    editInks(`Merged ${a} into ${b}`, () => {
      const src = state.inks.find((x) => x.name === a);
      src.mergeInto = b;
      // Anything already merged into the source moves to the new target.
      for (const x of state.inks) if (x.mergeInto === a) x.mergeInto = b;
    });
  }

  // ---------- colors in the art ----------
  function renderArtColors() {
    const box = $('artColors');
    if (!box || !state.art) return;
    const p = proofImage();
    const key = state.proofKey + state.garment;
    if (state.artColorsKey !== key) {
      const g = E.color.rgbToLab(E.color.parseHex(state.garment));
      // Distinct colors only: shades closer than ΔE 12 fold into one swatch.
      const raw = E.palette.pickColorsDiverse(p.image, 16, [g], { skipEdges: true, seed: 7 }).sort((a, b) => b.share - a.share);
      const kept = [];
      for (const c of raw) {
        const twin = kept.find((k) => E.color.deltaE2000(k.lab, c.lab) < 12);
        if (twin) twin.share += c.share; else kept.push({ lab: c.lab, share: c.share });
      }
      state.artColors = kept.slice(0, 12).map((c) => ({ hex: E.color.toHex(E.color.labToRgb(c.lab)), lab: c.lab, share: c.share }));
      state.artColorsKey = key;
      state.artPick = [];
    }
    box.innerHTML = '';
    for (const c of state.artColors) {
      const d = document.createElement('div');
      const on = state.artPick.includes(c.hex);
      d.className = 'asw' + (on ? ' on' : '');
      d.style.background = c.hex;
      d.title = `${E.color.colorName(c.lab)} ${c.hex} · ${(c.share * 100).toFixed(1)}% of the art`;
      d.textContent = c.share >= 0.01 ? `${Math.round(c.share * 100)}%` : '';
      d.addEventListener('click', () => {
        state.artPick = on ? state.artPick.filter((h) => h !== c.hex) : state.artPick.concat([c.hex]);
        renderArtColors();
      });
      box.appendChild(d);
    }
    $('useArtColors').disabled = state.artPick.length < 1;
    $('addArtColors').disabled = state.artPick.length < 1;
    $('useArtColors').textContent = state.artPick.length ? `Separate with only these (${state.artPick.length})` : 'Separate with only these';
  }

  function inkFromHex(hex) {
    const lab = E.color.rgbToLab(E.color.parseHex(hex));
    if (state.matchLibrary) { const m = E.inks.nearestInk(lab, library()); if (m) return { name: m.ink.name, hex: m.ink.hex, role: 'color', locked: true, hidden: false, library: m.ink.library }; }
    return { name: E.color.colorName(lab), hex, role: 'color', locked: true, hidden: false };
  }

  // ---------- per-color panel: amount, levels, advanced ----------
  let liveHist = null;
  function updateInkPanelLive() {
    // While a slider is held, only refresh the histogram, not the controls.
    if (!liveHist || !state.result) return;
    const vis = visibleInks();
    const ink = state.inks[state.openInk];
    const idx = vis.indexOf(ink);
    const scr = state.result.screens[idx];
    if (scr) drawHist(liveHist, scr.histogram);
  }

  function drawHist(el, bins) {
    el.innerHTML = '';
    const max = Math.max(1, ...(bins || [0]));
    for (const b of bins || []) { const d = document.createElement('div'); d.style.height = `${Math.max(1, Math.round((b / max) * 40))}px`; el.appendChild(d); }
  }

  function setAdjust(ink, fn, note, dragging) {
    // Remember the match before a drag starts, so the note compares the
    // final setting with where you started.
    if (!state.dragBase && state.result) state.dragBase = state.result.report.match;
    if (!dragging && !state._adjUndo) {
      state.undo.push(JSON.parse(JSON.stringify(state.inks)));
      if (state.undo.length > 30) state.undo.shift();
    }
    state._adjUndo = !!dragging;
    ink.adjust = ink.adjust || {};
    fn(ink.adjust);
    schedule('inks', dragging ? null : note);
  }

  function inkPanel(ink, s) {
    const box = document.createElement('div');
    box.className = 'inkpanel';
    const adj = ink.adjust || {};
    const lv = Object.assign({ inBlack: 0, inWhite: 1, gamma: 1, outBlack: 0, outWhite: 1 }, adj.levels || {});
    const h = (t) => { const e = document.createElement('h4'); e.textContent = t; box.appendChild(e); };
    const note = `Adjusted ${ink.name}`;
    const mergedIn = (state.inks || []).filter((x) => x !== ink && x.mergeInto === ink.name && !x.hidden);
    if (mergedIn.length) {
      h('Merged into this screen');
      for (const m of mergedIn) {
        const r = document.createElement('div'); r.className = 'row';
        const chip = document.createElement('span'); chip.className = 'chip'; chip.style.background = m.hex;
        const t = document.createElement('span'); t.textContent = `${m.name} prints on this screen`;
        const u = document.createElement('button'); u.className = 'btn small'; u.textContent = 'Unmerge';
        u.addEventListener('click', () => editInks(`Unmerged ${m.name}`, () => { delete m.mergeInto; }));
        r.appendChild(chip); r.appendChild(t); r.appendChild(u);
        box.appendChild(r);
      }
    }
    h('How much of this color');
    box.appendChild(fieldEl({ label: 'Amount', type: 'range', min: 0, max: 2, step: 0.05, fmt: pct, tip: 'Scales this screen: under 100% prints less of the color, over 100% more.' },
      adj.amount == null ? 1 : adj.amount, (v, d) => setAdjust(ink, (a) => { a.amount = v; }, note, d)));
    h('Levels (this screen)');
    const hist = document.createElement('div');
    hist.className = 'hist';
    drawHist(hist, s && s.histogram);
    liveHist = hist;
    box.appendChild(hist);
    const lvSet = (k) => (v, d) => setAdjust(ink, (a) => { a.levels = Object.assign({}, lv, a.levels || {}, { [k]: v }); }, note, d);
    box.appendChild(fieldEl({ label: 'Input shadows', type: 'range', min: 0, max: 0.9, step: 0.01, fmt: pct, tip: 'Tones lighter than this drop out of the screen.' }, lv.inBlack, lvSet('inBlack')));
    box.appendChild(fieldEl({ label: 'Midtones', type: 'range', min: 0.3, max: 3, step: 0.05, fmt: (v) => v.toFixed(2), tip: 'Above 1 makes the screen heavier in the midtones, below 1 lighter.' }, lv.gamma, lvSet('gamma')));
    box.appendChild(fieldEl({ label: 'Input highlights', type: 'range', min: 0.1, max: 1, step: 0.01, fmt: pct, tip: 'Tones at or above this print solid.' }, lv.inWhite, lvSet('inWhite')));
    box.appendChild(fieldEl({ label: 'Output min', type: 'range', min: 0, max: 0.5, step: 0.01, fmt: pct, tip: 'Lightest dot this screen will print where it has ink.' }, lv.outBlack, lvSet('outBlack')));
    box.appendChild(fieldEl({ label: 'Output max', type: 'range', min: 0.5, max: 1, step: 0.01, fmt: pct, tip: 'Heaviest dot this screen will print.' }, lv.outWhite, lvSet('outWhite')));
    h('Advanced');
    box.appendChild(fieldEl({ label: 'Choke / spread', type: 'range', min: -4, max: 4, step: 1, fmt: (v) => (v < 0 ? `choke ${-v} px` : v > 0 ? `spread ${v} px` : 'none') },
      adj.spread || 0, (v, d) => setAdjust(ink, (a) => { a.spread = v; }, note, d)));
    const filmSet = (k) => (v) => { ink.film = Object.assign({}, ink.film || {}); if (v === 'default') delete ink.film[k]; else ink.film[k] = v; state.full = null; schedule('inks', `Changed ${ink.name} film`); };
    const f = ink.film || {};
    box.appendChild(fieldEl({ label: 'Print as', type: 'select', opts: [['default', 'Same as other screens'], ['am', 'Halftone dots'], ['threshold', 'Solid (no halftone)'], ['fm', 'Stochastic (FM)']] }, f.type || 'default', filmSet('type')));
    box.appendChild(fieldEl({ label: 'Screen angle', type: 'select', opts: [['default', 'Same as other screens']].concat([0, 7.5, 15, 22.5, 25, 37.5, 45, 52.5, 67.5, 75, 82.5].map((a) => [a, `${a}°`])) }, f.angle != null ? f.angle : 'default', filmSet('angle')));
    box.appendChild(fieldEl({ label: 'Frequency', type: 'select', opts: [['default', 'Same as other screens']].concat(E.presets.LPI_CHOICES.map((v) => [v, `${v} lpi`])) }, f.lpi != null ? f.lpi : 'default', filmSet('lpi')));
    const row = document.createElement('div'); row.className = 'row';
    const reset = document.createElement('button'); reset.className = 'btn small'; reset.textContent = 'Reset this color';
    reset.addEventListener('click', () => editInks(`Reset ${ink.name}`, () => { delete ink.adjust; delete ink.film; }));
    const cl = document.createElement('button'); cl.className = 'btn small'; cl.textContent = '🧹 Clean up an area';
    cl.title = 'Brush or click to remove this color from just one spot';
    cl.addEventListener('click', () => openClean(ink.name));
    row.appendChild(cl);
    const view = document.createElement('button'); view.className = 'btn small'; view.textContent = 'Show this screen';
    view.addEventListener('click', () => { const idx = visibleInks().indexOf(ink); if (idx >= 0) { state.view = idx; renderTabs(); renderView(); } });
    row.appendChild(view); row.appendChild(reset);
    box.appendChild(row);
    return box;
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

  // ---------- add a color: quick spots, blacks, mixer, pick from image ----------
  const QUICK = [['Red', '#d22630'], ['Orange', '#ff6a13'], ['Yellow', '#ffd100'], ['Gold', '#ffb81c'], ['Green', '#00843d'], ['Lime', '#78be20'],
    ['Blue', '#0057b8'], ['Navy', '#13294b'], ['Purple', '#6d2077'], ['Pink', '#e31c79'], ['Brown', '#6b4226'], ['Skin Tone', '#e2a988'],
    ['Tan', '#c5a882'], ['Gray', '#8a8d8f'], ['White', '#ffffff']];
  const BLACKS = [['Solid Black', 'black-solid', 'Only the true black areas, printed solid.'],
    ['Black Set', 'black-set', 'The shadows as halftones (a key black).'],
    ['Detailed Black', 'black-detail', 'Dark lines and edge detail, for definition.']];
  const mixer = { h: 0, s: 80, v: 85 };

  function hsvToHex(h, sv, v) {
    const S = sv / 100, V = v / 100, c = V * S, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = V - c;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return E.color.toHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
  }
  function setMixerHex(hex) {
    const [r, g, b] = E.color.parseHex(hex).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    mixer.h = Math.round((h + 360) % 360); mixer.s = Math.round(max ? (d / max) * 100 : 0); mixer.v = Math.round(max * 100);
  }

  function haveColor(hex, special) {
    if (special) return (state.inks || []).some((x) => x.special === special && !x.hidden);
    const lab = E.color.rgbToLab(E.color.parseHex(hex));
    return (state.inks || []).some((x) => !x.hidden && !x.special && E.color.deltaE2000(lab, E.color.rgbToLab(E.color.parseHex(x.hex))) < 12);
  }

  function addColor(name, hex, special) {
    if (!state.inks) { status('Separate first, then add colors.', true); return; }
    if (!special && state.matchLibrary) {
      const m = E.inks.nearestInk(E.color.rgbToLab(E.color.parseHex(hex)), library());
      if (m) { name = m.ink.name; hex = m.ink.hex; }
    }
    editInks(`Added ${name}`, () => {
      const ink = { name, hex, role: 'color', locked: true, hidden: false };
      if (special) { ink.special = special; state.inks.push(ink); return; } // blacks print last, on top
      const hl = state.inks.findIndex((q) => q.role === 'highlight');
      if (hl >= 0) state.inks.splice(hl, 0, ink); else state.inks.push(ink);
    });
    renderAddColor();
  }

  function openAddColor() { $('addColorPop').classList.remove('hidden'); renderAddColor(); }
  function renderAddColor() {
    const box = $('addColorPop');
    if (!box || box.classList.contains('hidden')) return;
    box.innerHTML = '';
    const head = document.createElement('div'); head.className = 'row';
    head.innerHTML = '<b>Add a color</b>';
    const close = document.createElement('button'); close.className = 'btn small'; close.textContent = 'Close';
    close.style.marginLeft = 'auto';
    close.addEventListener('click', () => box.classList.add('hidden'));
    head.appendChild(close);
    box.appendChild(head);
    const sub = (t) => { const e = document.createElement('h4'); e.className = 'subhead'; e.textContent = t; box.appendChild(e); };

    sub('Quick spot colors (✓ = already in your screens)');
    const q = document.createElement('div'); q.className = 'quick';
    for (const [name, hex] of QUICK) {
      const b = document.createElement('button');
      const has = haveColor(hex);
      b.className = 'btn small qc' + (has ? ' have' : '');
      b.innerHTML = `<span class="chip" style="background:${hex}"></span>${has ? '✓ ' : ''}${esc(name)}`;
      b.title = has ? `${name} is already covered; add another anyway` : `Add ${name} (${hex})`;
      b.addEventListener('click', () => addColor(name, hex));
      q.appendChild(b);
    }
    box.appendChild(q);

    sub('Black screens');
    for (const [name, special, tip] of BLACKS) {
      const r = document.createElement('div'); r.className = 'row';
      const b = document.createElement('button');
      const has = haveColor('#111111', special);
      b.className = 'btn small qc' + (has ? ' have' : '');
      b.innerHTML = `<span class="chip" style="background:#111"></span>${has ? '✓ ' : ''}${esc(name)}`;
      b.disabled = has;
      b.addEventListener('click', () => addColor(name, '#111111', special));
      const t = document.createElement('span'); t.className = 'muted small'; t.textContent = tip;
      r.appendChild(b); r.appendChild(t);
      box.appendChild(r);
    }

    sub('Mix your own, or pick it from the image');
    const sw = document.createElement('div'); sw.className = 'row';
    const big = document.createElement('span'); big.className = 'mixsw';
    const hexIn = document.createElement('input'); hexIn.className = 'hex';
    sw.appendChild(big); sw.appendChild(hexIn);
    box.appendChild(sw);
    const paint = () => {
      const hex = hsvToHex(mixer.h, mixer.s, mixer.v);
      big.style.background = hex; hexIn.value = hex;
      sat.style.background = `linear-gradient(90deg, ${hsvToHex(mixer.h, 0, mixer.v)}, ${hsvToHex(mixer.h, 100, mixer.v)})`;
      bri.style.background = `linear-gradient(90deg, #000, ${hsvToHex(mixer.h, mixer.s, 100)})`;
      nameOut.textContent = E.color.colorName(E.color.rgbToLab(E.color.parseHex(hex)));
    };
    const slider = (label, key, max, cls) => {
      const r = document.createElement('div'); r.className = 'field';
      const l = document.createElement('label'); l.textContent = label;
      const c = document.createElement('div'); c.className = 'ctl';
      const inp = document.createElement('input'); inp.type = 'range'; inp.min = 0; inp.max = max; inp.step = 1; inp.value = mixer[key]; inp.className = 'mix ' + cls;
      inp.addEventListener('input', () => { mixer[key] = Number(inp.value); paint(); });
      c.appendChild(inp); r.appendChild(l); r.appendChild(c); box.appendChild(r);
      return inp;
    };
    slider('Hue', 'h', 359, 'hue');
    const sat = slider('Saturation', 's', 100, 'sat');
    const bri = slider('Brightness', 'v', 100, 'bri');
    hexIn.addEventListener('change', () => { try { setMixerHex(E.color.toHex(E.color.parseHex(hexIn.value))); renderAddColor(); } catch (e) { paint(); } });
    const nameOut = document.createElement('span'); nameOut.className = 'muted small';
    sw.appendChild(nameOut);
    const acts = document.createElement('div'); acts.className = 'row';
    const add = document.createElement('button'); add.className = 'btn small primary'; add.textContent = '+ Add this color';
    add.addEventListener('click', () => { const hex = hsvToHex(mixer.h, mixer.s, mixer.v); addColor(E.color.colorName(E.color.rgbToLab(E.color.parseHex(hex))), hex); });
    const pick = document.createElement('button'); pick.className = 'btn small'; pick.textContent = '🎯 Pick from the image';
    pick.title = 'Tap a color in the picture; it lands here so you can adjust it before adding';
    pick.addEventListener('click', () => {
      state.picking = 'mixer';
      $('app').classList.add('picking');
      layout();
      state.view = 'art'; renderTabs(); renderView();
      status('Tap the color you want in the picture.');
    });
    acts.appendChild(add); acts.appendChild(pick);
    if (host.name === 'photoshop') {
      const psPick = document.createElement('button'); psPick.className = 'btn small'; psPick.textContent = 'Photoshop color picker';
      psPick.addEventListener('click', async () => { const hex = await host.pickColor(hsvToHex(mixer.h, mixer.s, mixer.v)); if (hex) { setMixerHex(hex); renderAddColor(); } });
      const fg = document.createElement('button'); fg.className = 'btn small'; fg.textContent = 'Use foreground color';
      fg.addEventListener('click', async () => { const hex = await host.foregroundColor(); if (hex) { setMixerHex(hex); renderAddColor(); } });
      acts.appendChild(psPick); acts.appendChild(fg);
    }
    box.appendChild(acts);
    paint();
  }

  function addInk() {
    if (!state.inks) { status('Separate first, then add colors.', true); return; }
    const box = $('addColorPop');
    if (box.classList.contains('hidden')) openAddColor(); else box.classList.add('hidden');
  }

  // ---------- output ----------
  async function build() {
    try {
      const r = await fullResult();
      status('Building document…');
      await tick();
      await host.buildDocument(state.regInDoc ? E.applyRegistration(r, state.film, state.reg) : r, Object.assign({}, state.film), { bake: state.bake, name: `${state.art.name} – seps` });
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
        const film = E.renderScreenFilm(r, s, state.film, state.reg);
        files.push({ name: `${String(s.order).padStart(2, '0')}-${s.name.replace(/[^a-z0-9]+/gi, '_')}.tif`, data: E.tiff.writeTiff(film) });
      }
      files.push({ name: 'job-sheet.txt', data: new TextEncoder().encode(jobSheet(r)) });
      const where = await host.saveFiles(files, `${(state.art.name || 'ecko-seps').replace(/[^a-z0-9 _-]+/gi, '').trim().replace(/\s+/g, '_') || 'ecko-seps'}-films.zip`);
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

  // ---------- layout for any screen size ----------
  const ui = load('ui') || {};
  function saveUi() { host.storage.set('ecko-seps-ui', JSON.stringify(ui)); }
  // Size of the area the app lives in: the panel/window, or the pop-out
  // window when open. Photoshop's panel engine ignores viewport units, so
  // every pane gets exact pixel sizes from here; that is what lets each side
  // scroll with a visible scrollbar in Photoshop as well as browsers.
  function hostSize() {
    const dlg = host.popOutWindow && host.popOutWindow();
    if (dlg && dlg.clientWidth > 0) return { w: dlg.clientWidth, h: dlg.clientHeight };
    const de = document.documentElement;
    return { w: window.innerWidth || de.clientWidth || document.body.clientWidth, h: window.innerHeight || de.clientHeight || document.body.clientHeight };
  }

  let lastSize = '';
  // Proof-window mode (Photoshop, live view on): the panel has no picture,
  // just the view tabs and notes on top and the options below; the picture
  // is the Proof Window document next to the art. The picture comes back
  // while the clean-up brush or the eyedropper is in use.
  const proofMode = () => host.name === 'photoshop' && !ui.liveOff && !(state.clean && state.clean.active) && !state.picking;

  // Natural height of the top strip in proof mode: its visible children.
  function stripHeight(h) {
    const pv = $('previewPane');
    let sum = 14;
    for (const c of pv.children) {
      if (c.offsetParent === null || c.classList.contains('stage')) continue;
      const cs = getComputedStyle(c);
      sum += c.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    }
    return Math.round(Math.max(60, Math.min(h * 0.45, sum)));
  }

  function layout() {
    const app = $('app');
    const { w, h } = hostSize();
    const pm = proofMode();
    app.classList.toggle('proof-mode', pm);
    lastSize = `${w}x${h}x${pm}`;
    if (pm) {
      const pv = $('previewPane'), op = $('optionsPane');
      app.classList.add('narrow');
      app.style.width = `${w}px`; app.style.height = `${h}px`;
      pv.style.width = `${w}px`;
      const pvH = stripHeight(h);
      pv.style.height = `${pvH}px`;
      op.style.width = `${w}px`; op.style.height = `${Math.max(100, h - pvH)}px`;
      lastSize += `x${pvH}`;
      document.body.classList.toggle('ui-compact', ui.size === 'compact' || (!ui.size && h < 700));
      document.body.classList.toggle('ui-large', ui.size === 'large');
      document.body.classList.toggle('theme-aztec', ui.theme !== 'plain');
      document.body.classList.toggle('ps-host', true);
      app.classList.toggle('slim', w < 400);
      return;
    }
    const narrow = w < 760;
    app.classList.toggle('narrow', narrow);
    app.classList.toggle('short', h < 620);
    app.classList.toggle('tiny', w < 360 || (w >= 760 && w < 900));
    app.classList.toggle('pv-hidden', !!ui.previewHidden);
    const pv = $('previewPane'), op = $('optionsPane'), sp = $('splitter');
    app.style.width = `${w}px`;
    app.style.height = `${h}px`;
    if (narrow) {
      const spH = 9;
      let pvH = ui.previewHidden ? Math.min(90, h * 0.3) : (ui.pvH ? Math.max(120, Math.min(ui.pvH, h - 180)) : Math.round(h < 620 ? h * 0.38 : h * 0.45));
      if (state.clean && state.clean.active && !ui.previewHidden) pvH = Math.max(pvH, Math.round(h * 0.64));
      pvH = Math.round(Math.min(pvH, h - 120));
      pv.style.width = `${w}px`; pv.style.height = `${pvH}px`;
      sp.style.width = `${w}px`; sp.style.height = `${spH}px`;
      op.style.width = `${w}px`; op.style.height = `${Math.max(100, h - pvH - spH)}px`;
    } else {
      const spW = 7;
      let optW = ui.optW ? Math.max(260, Math.min(ui.optW, w * 0.75, w - 240)) : Math.min(420, Math.max(330, Math.round(w * 0.36)));
      if (ui.previewHidden) optW = w - 210 - spW;
      optW = Math.round(optW);
      pv.style.width = `${w - optW - spW}px`; pv.style.height = `${h}px`;
      sp.style.width = `${spW}px`; sp.style.height = `${h}px`;
      op.style.width = `${optW}px`; op.style.height = `${h}px`;
    }
    document.body.classList.toggle('ui-compact', ui.size === 'compact' || (!ui.size && h < 700));
    document.body.classList.toggle('ui-large', ui.size === 'large');
    document.body.classList.toggle('theme-aztec', ui.theme !== 'plain');
    document.body.classList.toggle('ps-host', host.name === 'photoshop');
    app.classList.toggle('slim', (parseFloat(op.style.width) || w) < 400);
    $('togglePreview').textContent = ui.previewHidden ? 'Show preview' : 'Hide preview';
  }

  // Photoshop panels don't always send resize events: check the size often.
  setInterval(() => {
    const { w, h } = hostSize();
    const pm = proofMode();
    let key = `${w}x${h}x${pm}`;
    if (pm) key += `x${stripHeight(h)}`;
    if (key !== lastSize) { layout(); if (state.view === 'compare') renderView(); }
  }, 400);

  function setupSplitter() {
    const sp = $('splitter');
    let dragging = false;
    const move = (x, y) => {
      if (!dragging) return;
      if ($('app').classList.contains('narrow')) ui.pvH = Math.round(y);
      else ui.optW = Math.round(window.innerWidth - x);
      layout();
    };
    const end = () => { if (dragging) { dragging = false; sp.classList.remove('drag'); saveUi(); } };
    const start = (e) => { dragging = true; sp.classList.add('drag'); if (e.preventDefault) e.preventDefault(); };
    sp.addEventListener('pointerdown', start);
    sp.addEventListener('mousedown', start);
    window.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    window.addEventListener('pointerup', end);
    window.addEventListener('mouseup', end);
    sp.addEventListener('dblclick', () => { delete ui.optW; delete ui.pvH; saveUi(); layout(); });
  }

  $('uiSmaller').addEventListener('click', () => { ui.size = ui.size === 'large' ? 'normal' : 'compact'; saveUi(); layout(); });
  $('uiBigger').addEventListener('click', () => { ui.size = ui.size === 'compact' || !ui.size ? 'normal' : 'large'; saveUi(); layout(); });
  $('themeBtn').addEventListener('click', () => { ui.theme = ui.theme === 'plain' ? 'aztec' : 'plain'; saveUi(); layout(); });
  if ($('popOut')) $('popOut').addEventListener('click', async () => {
    if (!host.popOut) return;
    try {
      $('popOut').textContent = '⤡ Back to panel';
      const closed = host.popOut($('app'), () => { layout(); renderView(); });
      if (closed && closed.then) { await closed; }
    } catch (e) { status('Could not open the full window: ' + e.message, true); }
    $('popOut').textContent = '⤢ Full window';
    layout(); renderView();
  });
  if ($('liveBtn')) {
    const paintLive = () => { $('liveBtn').textContent = ui.liveOff ? '🪟 Proof window: off' : '🪟 Proof window: on'; $('liveBtn').classList.toggle('primary', !ui.liveOff); };
    paintLive();
    $('liveBtn').addEventListener('click', async () => {
      ui.liveOff = !ui.liveOff; saveUi(); paintLive(); layout();
      if (ui.liveOff) { try { await host.closeLive(); } catch (e) { /* already closed */ } } else if (state.result) renderView();
    });
  }
  if ($('detailSel')) {
    $('detailSel').value = ui.detail || 'fast';
    $('detailSel').addEventListener('change', () => { ui.detail = $('detailSel').value; saveUi(); state.proof = null; schedule('tune', null); });
  }
  $('moreBtn').addEventListener('click', () => { $('moreTools').classList.toggle('hidden'); layout(); });
  if ($('proofAs')) {
    $('proofAs').value = ui.proofAs || 'windows';
    $('proofAs').addEventListener('change', async () => {
      ui.proofAs = $('proofAs').value; saveUi();
      // Reopen the proof the new way.
      try { await host.closeLive(); } catch (e) { /* not open */ }
      if (state.result) renderView();
    });
  }
  if ($('logBtn')) {
    $('logBtn').addEventListener('click', () => $('psLog').classList.toggle('hidden'));
    host.onLog = (lines) => { $('psLog').textContent = lines.join('\n'); };
  }
  if ($('arrangeBtn')) $('arrangeBtn').addEventListener('click', async () => {
    try { await host.arrangeProof(ui.proofAs || 'windows'); proofNote('Arranged the windows.'); } catch (e) { proofNote('Could not arrange: ' + e.message, true); }
  });
  $('togglePreview').addEventListener('click', () => { ui.previewHidden = !ui.previewHidden; saveUi(); layout(); });
  if ($('toTop')) $('toTop').addEventListener('click', () => { $('optionsPane').scrollTop = 0; });
  setupSplitter();

  // ---------- texture & distress ----------
  function renderTexture() {
    const body = $('textureBody');
    if (!body) return;
    body.innerHTML = '';
    const t = state.texture;
    const set = (k, fresh) => (v) => { t[k] = v; if (k === 'type') renderTexture(); schedule('tune', k === 'type' ? `Texture: ${v}` : null); };
    body.appendChild(fieldEl({ label: 'Texture', type: 'select', opts: E.texture.TEXTURES }, t.type, set('type')));
    if (t.type === 'custom') {
      const row = document.createElement('div'); row.className = 'row';
      const b = document.createElement('button'); b.className = 'btn small'; b.textContent = state.textureImage ? 'Change texture image…' : 'Load texture image…';
      b.addEventListener('click', loadTextureImage);
      const info = document.createElement('span'); info.className = 'muted small';
      info.textContent = state.textureImage ? `${state.textureImage.name} (${state.textureImage.width}×${state.textureImage.height})` : 'White in the texture = knocked out (Invert flips it).';
      row.appendChild(b); row.appendChild(info);
      body.appendChild(row);
      body.appendChild(fieldEl({ label: 'Fit', type: 'select', opts: [['tile', 'Tile'], ['stretch', 'Stretch over the design']] }, t.fit, set('fit')));
    }
    if (t.type !== 'none') {
      body.appendChild(fieldEl({ label: 'Amount', type: 'range', min: 0, max: 0.9, step: 0.01, fmt: pct, tip: 'Share of the print knocked out.' }, t.density, set('density')));
      if (t.type !== 'custom' || t.fit === 'tile') body.appendChild(fieldEl({ label: 'Size', type: 'range', min: 0.05, max: t.type === 'custom' ? 12 : 2, step: 0.05, fmt: (v) => `${v.toFixed(2)} in` }, t.scale, set('scale')));
      body.appendChild(fieldEl({ label: 'Edge softness', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct }, t.softness, set('softness')));
      body.appendChild(fieldEl({ label: 'Strength', type: 'range', min: 0.1, max: 1, step: 0.05, fmt: pct, tip: 'Under 100% leaves some ink in the knocked-out areas.' }, t.strength, set('strength')));
      body.appendChild(fieldEl({ label: 'Apply to', type: 'select', opts: [['all', 'All screens'], ['underbase', 'Underbase only (soft vintage)'], ['colors', 'Top colors only']] }, t.apply, set('apply')));
      body.appendChild(fieldEl({ label: 'Invert', type: 'check' }, t.invert, set('invert')));
      const row = document.createElement('div'); row.className = 'row';
      const sh = document.createElement('button'); sh.className = 'btn small'; sh.textContent = '🎲 New pattern';
      sh.addEventListener('click', () => { t.seed = (t.seed | 0) + 1; schedule('tune', 'New texture pattern'); });
      if (t.type !== 'custom') row.appendChild(sh);
      body.appendChild(row);
    }
    const n = document.createElement('div'); n.className = 'muted small';
    n.textContent = 'Textures knock ink out of the screens so the shirt shows through: a distressed, vintage look that also softens the print. Sizes are real inches, so the preview matches the films.';
    body.appendChild(n);
  }

  async function loadTextureImage() {
    try {
      const img = await host.pickImage();
      if (!img) return;
      // Grayscale, at most 1024 px, kept in memory for this session.
      const s = Math.min(1, 1024 / Math.max(img.width, img.height));
      const small = s < 1 ? E.ops.resizeImage(img, Math.round(img.width * s), Math.round(img.height * s)) : img;
      const g = new Uint8Array(small.width * small.height);
      for (let p = 0; p < g.length; p++) {
        const c = small.channels, a = c === 4 ? small.data[p * 4 + 3] / 255 : 1;
        g[p] = Math.round((0.299 * small.data[p * c] + 0.587 * small.data[p * c + 1] + 0.114 * small.data[p * c + 2]) * a + 255 * (1 - a));
      }
      state.textureImage = { data: g, width: small.width, height: small.height, name: img.name || 'texture' };
      state.texture.type = 'custom';
      renderTexture();
      schedule('tune', 'Loaded your texture');
    } catch (e) { status('Could not load that image: ' + e.message, true); }
  }

  // ---------- zoom and pan in the preview ----------
  let zoom = 1;
  // Scale at which the whole picture fits (outer size, so scrollbars that
  // appear when zoomed don't change it).
  function fitScale() {
    const img = $('previewImg'), r = $('stage').getBoundingClientRect();
    return Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
  }
  function applyZoom(anchor) {
    const img = $('previewImg'), st = $('stage');
    const bar = $('zoomBar');
    if (bar) bar.classList.toggle('hidden', !state.result);
    if (!img.naturalWidth) return;
    if (zoom <= 1.001) {
      zoom = 1;
      img.style.width = ''; img.style.height = '';
      st.classList.remove('zoomed');
    } else {
      const fit = fitScale();
      // Keep the point under the cursor (or the center) in place.
      const fx = anchor ? anchor.fx : (st.scrollLeft + st.clientWidth / 2) / Math.max(1, st.scrollWidth);
      const fy = anchor ? anchor.fy : (st.scrollTop + st.clientHeight / 2) / Math.max(1, st.scrollHeight);
      st.classList.add('zoomed');
      img.style.width = `${Math.round(img.naturalWidth * fit * zoom)}px`;
      img.style.height = `${Math.round(img.naturalHeight * fit * zoom)}px`;
      st.scrollLeft = fx * st.scrollWidth - (anchor ? anchor.ox : st.clientWidth / 2);
      st.scrollTop = fy * st.scrollHeight - (anchor ? anchor.oy : st.clientHeight / 2);
    }
    if ($('zoomLabel')) {
      const fit = img.naturalWidth ? fitScale() : 1;
      $('zoomLabel').textContent = `${Math.round(fit * zoom * 100)}%`;
    }
  }
  function setZoom(z, ev) {
    const st = $('stage');
    let anchor = null;
    if (ev && zoom > 1) {
      const r = st.getBoundingClientRect();
      const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
      anchor = { fx: (st.scrollLeft + ox) / st.scrollWidth, fy: (st.scrollTop + oy) / st.scrollHeight, ox, oy };
    }
    zoom = Math.max(1, Math.min(24, z));
    applyZoom(anchor);
  }
  $('previewImg').addEventListener('load', () => applyZoom());
  $('zoomIn').addEventListener('click', () => setZoom(zoom * 1.5));
  $('zoomOut').addEventListener('click', () => setZoom(zoom / 1.5));
  $('zoomFit').addEventListener('click', () => setZoom(1));
  $('zoom100').addEventListener('click', () => {
    const img = $('previewImg'), st = $('stage');
    void st;
    if (img.naturalWidth) setZoom(1 / fitScale());
  });
  $('stage').addEventListener('wheel', (ev) => {
    if (!state.result) return;
    ev.preventDefault();
    setZoom(zoom * (ev.deltaY < 0 ? 1.2 : 1 / 1.2), ev);
  }, { passive: false });
  // Drag to move around when zoomed (not while brushing or picking).
  let pan = null, panMoved = false;
  $('stage').addEventListener('pointerdown', (ev) => {
    if (zoom <= 1 || state.clean.active || state.picking) return;
    const st = $('stage');
    pan = { x: ev.clientX, y: ev.clientY, l: st.scrollLeft, t: st.scrollTop };
    panMoved = false;
  });
  window.addEventListener('pointermove', (ev) => {
    if (!pan) return;
    const st = $('stage');
    if (Math.abs(ev.clientX - pan.x) + Math.abs(ev.clientY - pan.y) > 3) panMoved = true;
    st.scrollLeft = pan.l - (ev.clientX - pan.x);
    st.scrollTop = pan.t - (ev.clientY - pan.y);
  });
  window.addEventListener('pointerup', () => { pan = null; });

  // ---------- clean-up: remove stray color from one area ----------
  const ALL = '*';
  function cleanTargets() { return (state.inks || []).filter((x) => hasScreen(x)); }
  function screenIndexOf(name) { return state.result ? state.result.screens.findIndex((x) => x.name === name) : -1; }

  function openClean(target) {
    if (!state.result) { status('Separate first, then clean up.', true); return; }
    const c = state.clean;
    c.active = true;
    const targets = cleanTargets();
    c.target = target || c.target || (targets[1] || targets[0] || {}).name || ALL;
    if (c.target !== ALL && !targets.some((x) => x.name === c.target)) c.target = (targets[0] || {}).name || ALL;
    $('app').classList.add('cleaning');
    $('cleanBar').classList.remove('hidden');
    layout();
    showCleanView();
    renderCleanBar();
  }

  function closeClean() {
    state.clean.active = false;
    $('app').classList.remove('cleaning', 'tool-area');
    $('cleanBar').classList.add('hidden');
    $('brushRing').classList.add('hidden');
    $('strokeLayer').innerHTML = '';
    layout();
    renderTabs(); renderView();
  }

  function showCleanView() {
    const c = state.clean;
    const idx = c.target === ALL ? -1 : screenIndexOf(c.target);
    state.view = idx >= 0 ? idx : 'preview';
    renderTabs(); renderView();
  }

  function renderCleanBar() {
    const c = state.clean;
    const sel = $('cleanTarget');
    sel.innerHTML = '';
    for (const x of cleanTargets()) { const o = document.createElement('option'); o.value = x.name; o.textContent = `Screen: ${x.name}`; sel.appendChild(o); }
    const all = document.createElement('option'); all.value = ALL; all.textContent = 'All screens (make it bare shirt)'; sel.appendChild(all);
    sel.value = c.target;
    $('toolBrush').classList.toggle('on', c.tool === 'brush');
    $('toolArea').classList.toggle('on', c.tool === 'area');
    $('app').classList.toggle('tool-area', c.tool === 'area');
    $('cleanSize').value = c.size;
    $('cleanLimit').value = c.limit;
    $('cleanSize').parentNode.style.display = c.tool === 'brush' ? '' : 'none';
    $('limitWrap').style.display = c.tool === 'area' ? '' : 'none';
    const who = c.target === ALL ? 'every screen' : `the ${c.target} screen`;
    $('cleanHint').textContent = c.tool === 'brush'
      ? `Paint over unwanted pixels to remove ${who} there. The rest of the color is untouched. Black on the screen view = ink.`
      : `Tap a stray speck or blob to remove that connected patch from ${who}. "Reach" limits how far it spreads.`;
    const n = c.target === ALL ? (state.inks || []).reduce((t, x) => t + ((x.erase || []).length ? 1 : 0), 0) : ((state.inks || []).find((x) => x.name === c.target) || {}).erase;
    $('cleanClear').disabled = !(c.target === ALL ? n : n && n.length);
  }

  // Art-relative position of a pointer event on the letterboxed picture.
  function imgPoint(ev) {
    const rect = $('previewImg').getBoundingClientRect();
    const iw = state.result.width, ih = state.result.height;
    const k = Math.min(rect.width / iw, rect.height / ih);
    const dx = (rect.width - iw * k) / 2, dy = (rect.height - ih * k) / 2;
    return { fx: (ev.clientX - rect.left - dx) / (iw * k), fy: (ev.clientY - rect.top - dy) / (ih * k), k, rect };
  }

  function addErase(item, note) {
    const c = state.clean;
    editInks(note, () => {
      const targets = c.target === ALL ? (state.inks || []).filter((x) => !x.hidden) : (state.inks || []).filter((x) => x.name === c.target);
      for (const t of targets) t.erase = (t.erase || []).concat([item]);
    });
    renderCleanBar();
  }

  let stroke = null;
  function stageXY(ev) {
    const st = $('stage'), sr = st.getBoundingClientRect();
    return [ev.clientX - sr.left + st.scrollLeft, ev.clientY - sr.top + st.scrollTop];
  }
  function drawRing(ev) {
    const c = state.clean, ring = $('brushRing');
    if (!c.active || c.tool !== 'brush' || !state.result || typeof state.view !== 'number' && state.view !== 'preview' && state.view !== 'art') { ring.classList.add('hidden'); return; }
    const p = imgPoint(ev);
    const d = Math.max(4, c.size * state.result.width * p.k * 2);
    const [x, y] = stageXY(ev);
    ring.style.width = ring.style.height = `${d}px`;
    ring.style.left = `${x - d / 2}px`; ring.style.top = `${y - d / 2}px`;
    ring.classList.remove('hidden');
  }
  function dot(ev) {
    const c = state.clean;
    const p = imgPoint(ev);
    const d = Math.max(4, c.size * state.result.width * p.k * 2);
    const [x, y] = stageXY(ev);
    const el = document.createElement('div');
    el.style.width = el.style.height = `${d}px`; el.style.left = `${x - d / 2}px`; el.style.top = `${y - d / 2}px`;
    $('strokeLayer').appendChild(el);
  }

  const img = $('previewImg');
  const onDown = (ev) => {
    const c = state.clean;
    if (!c.active || !state.result) return;
    if (state.view === 'dots') { showCleanView(); return; }
    const p = imgPoint(ev);
    if (p.fx < 0 || p.fy < 0 || p.fx > 1 || p.fy > 1) return;
    if (ev.preventDefault) ev.preventDefault();
    if (c.tool === 'area') {
      // One screen: the connected patch of that screen's ink. All screens: the
      // connected patch of that color in the art.
      const item = c.target === ALL
        ? { type: 'region', x: +p.fx.toFixed(5), y: +p.fy.toFixed(5), limit: c.limit, tol: 14 }
        : { type: 'area', x: +p.fx.toFixed(5), y: +p.fy.toFixed(5), limit: c.limit, tol: 0.03 };
      addErase(item, `Removed a patch from ${c.target === ALL ? 'all screens' : c.target}`);
      return;
    }
    stroke = [[+p.fx.toFixed(5), +p.fy.toFixed(5)]];
    dot(ev);
  };
  const onMove = (ev) => {
    if (!state.clean.active) return;
    drawRing(ev);
    if (!stroke) return;
    const p = imgPoint(ev);
    const last = stroke[stroke.length - 1];
    if (Math.hypot(p.fx - last[0], p.fy - last[1]) < state.clean.size * 0.3) return;
    stroke.push([+Math.max(0, Math.min(1, p.fx)).toFixed(5), +Math.max(0, Math.min(1, p.fy)).toFixed(5)]);
    dot(ev);
  };
  const onUp = () => {
    if (!stroke) return;
    const pts = stroke;
    stroke = null;
    addErase({ type: 'brush', r: state.clean.size, pts }, `Cleaned ${state.clean.target === ALL ? 'all screens' : state.clean.target}`);
    setTimeout(() => { $('strokeLayer').innerHTML = ''; }, 400);
  };
  img.addEventListener('pointerdown', onDown);
  img.addEventListener('pointermove', onMove);
  img.addEventListener('pointerleave', () => $('brushRing').classList.add('hidden'));
  window.addEventListener('pointerup', onUp);
  if (!window.PointerEvent) { img.addEventListener('mousedown', onDown); img.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); }
  img.addEventListener('dragstart', (ev) => ev.preventDefault());

  $('cleanOpen').addEventListener('click', () => (state.clean.active ? closeClean() : openClean()));
  $('cleanOpen2').addEventListener('click', () => openClean());
  $('cleanDone').addEventListener('click', closeClean);
  $('cleanTarget').addEventListener('change', () => { state.clean.target = $('cleanTarget').value; showCleanView(); renderCleanBar(); });
  $('toolBrush').addEventListener('click', () => { state.clean.tool = 'brush'; renderCleanBar(); });
  $('toolArea').addEventListener('click', () => { state.clean.tool = 'area'; $('brushRing').classList.add('hidden'); renderCleanBar(); });
  $('cleanSize').addEventListener('input', () => { state.clean.size = Number($('cleanSize').value); });
  $('cleanLimit').addEventListener('input', () => { state.clean.limit = Number($('cleanLimit').value); });
  $('cleanUndo').addEventListener('click', () => { undo(); renderCleanBar(); });
  $('cleanClear').addEventListener('click', () => {
    const c = state.clean;
    editInks(`Cleared clean-ups on ${c.target === ALL ? 'all screens' : c.target}`, () => {
      for (const x of state.inks || []) if (c.target === ALL || x.name === c.target) delete x.erase;
    });
    renderCleanBar();
  });

  function renderAll() {
    renderTexture();
    renderReg();
    renderBg();
    renderArtLevels();
    renderSteps();
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
    if (!state.result || state.clean.active) return;
    if (panMoved) { panMoved = false; return; }
    if (zoom > 1 && !state.picking) return; // zoomed: clicks are for moving around
    if (state.view === 'dots' && !state.picking) { state.view = 'preview'; renderTabs(); renderView(); return; }
    // The picture is letterboxed inside the element (object-fit: contain).
    const rect = $('previewImg').getBoundingClientRect();
    const iw = state.result.width, ih = state.result.height;
    const k = Math.min(rect.width / iw, rect.height / ih);
    const dx = (rect.width - iw * k) / 2, dy = (rect.height - ih * k) / 2;
    const fx = (ev.clientX - rect.left - dx) / (iw * k), fy = (ev.clientY - rect.top - dy) / (ih * k);
    if (fx < 0 || fy < 0 || fx > 1 || fy > 1) return;
    if (state.view === 'compare' && !state.picking) return;
    if (state.picking === 'bg') { pickBgAt(fx, fy); return; }
    if (state.picking) { pickSpotAt(fx, fy); return; }
    if (typeof state.view === 'number') return; // plate views include margins
    state.zoom = { x: fx, y: fy };
    state.view = 'dots';
    renderTabs();
    renderView();
  });
  setupSections();
  $('garmentHex').addEventListener('change', () => setGarment($('garmentHex').value));
  $('garmentPick').addEventListener('click', async () => { const hex = await host.pickColor(state.garment); if (hex) setGarment(hex); });
  $('garmentFg').addEventListener('click', async () => { const hex = await host.foregroundColor(); if (hex) setGarment(hex); });
  $('separate').addEventListener('click', () => separateFresh(host.name === 'photoshop' && !state.result));
  $('reload').addEventListener('click', () => separateFresh(true));
  $('addInk').addEventListener('click', addInk);
  $('mergeBtn').addEventListener('click', mergeSelected);
  $('useArtColors').addEventListener('click', () => {
    if (!state.artPick.length) return;
    state.onlyColors = state.artPick.map(inkFromHex);
    state.inks = null;
    schedule('fresh', `Separated with ${state.artPick.length} chosen colors`);
  });
  $('addArtColors').addEventListener('click', () => {
    const add = state.artPick.map(inkFromHex);
    state.artPick = [];
    editInks(`Added ${add.length} spot color${add.length > 1 ? 's' : ''}`, () => {
      const hl = state.inks.findIndex((q) => q.role === 'highlight');
      if (hl >= 0) state.inks.splice(hl, 0, ...add); else state.inks.push(...add);
    });
  });
  $('pickSpot').addEventListener('click', () => {
    state.picking = !state.picking;
    $('app').classList.toggle('picking', state.picking);
    layout();
    if (state.picking) { if (typeof state.view === 'number' || state.view === 'dots') { state.view = 'art'; renderTabs(); renderView(); } status('Tap the color in the picture to add it as a spot color.'); }
    else status('');
  });
  $('artLevelsBtn').addEventListener('click', () => $('artLevels').classList.toggle('hidden'));
  $('undo').addEventListener('click', undo);
  $('librarySelect').addEventListener('change', () => { state.libraryId = $('librarySelect').value; schedule('fresh'); });
  $('matchLibrary').addEventListener('change', () => { state.matchLibrary = $('matchLibrary').checked; schedule('fresh'); });
  $('importLibrary').addEventListener('click', importLibrary);
  $('build').addEventListener('click', build);
  $('exportFilms').addEventListener('click', exportFilms);
  $('exportSheet').addEventListener('click', exportSheet);
  window.addEventListener('resize', () => { layout(); if (state.view === 'compare') renderView(); });

  if (host.name === 'photoshop') {
    $('openArtLabel').classList.add('hidden');
    $('emptyHint').textContent = 'Open your art in Photoshop, pick the job, shirt color and screens, then press Separate.';
    $('reload').classList.remove('hidden');
  } else {
    document.querySelectorAll('.ps-only').forEach((el) => el.classList.add('hidden'));
    $('build').textContent = 'Download plates + preview (ZIP)';
    document.querySelectorAll('.ps-text').forEach((el) => { el.textContent = 'In Photoshop this builds a document with one named spot channel per ink.'; });
  }
  host.onArtworkChosen = async () => { await loadArt(); separateFresh(false); };
  window.EckoUI = { state, separateFresh, jobSheet };
  layout();
  renderAll();
})();
