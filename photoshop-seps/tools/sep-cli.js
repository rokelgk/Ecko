#!/usr/bin/env node
'use strict';
// Run a separation from the command line.
//   node tools/sep-cli.js art.png out/ --preset dark-sim --screens 8 --garment #111111 [--films] [--library inks.ase --match]
const fs = require('fs');
const path = require('path');
const engine = require('../engine');
const { readPng, writePng } = require('./png');

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k.startsWith('--')) { const n = argv[i + 1]; if (n === undefined || n.startsWith('--')) a[k.slice(2)] = true; else { a[k.slice(2)] = n; i++; } }
    else a._.push(k);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const [input, outDir] = args._;
  if (!input || !outDir) { console.error('usage: sep-cli.js <art.png> <outdir> [--preset id] [--screens n|auto] [--garment #hex] [--films] [--library file] [--match]'); process.exit(2); }
  const preset = engine.presets.getPreset(args.preset || 'dark-sim');
  const options = Object.assign({}, preset.options);
  if (args.screens) options.screens = args.screens === 'auto' ? 'auto' : Number(args.screens);
  if (args.garment) options.garment = args.garment;
  if (args.library) { options.library = engine.inks.parseLibrary(path.basename(args.library), fs.readFileSync(args.library)); }
  else options.library = engine.inks.BUILT_IN;
  if (args.match) options.matchLibrary = true;
  const film = Object.assign({}, preset.film);
  if (args.lpi) film.lpi = Number(args.lpi);
  if (args.angle) film.angle = Number(args.angle);
  if (args.dot) film.dot = args.dot;
  if (args.dpi) film.dpi = Number(args.dpi);
  const img = readPng(fs.readFileSync(input));
  const t0 = Date.now();
  const r = engine.separate(img, options);
  const ms = Date.now() - t0;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'preview.png'), writePng({ data: r.preview, width: r.width, height: r.height, channels: 4 }));
  r.screens.forEach((s) => {
    const inv = new Uint8Array(s.plate.length);
    for (let i = 0; i < inv.length; i++) inv[i] = 255 - s.plate[i];
    const base = `${String(s.order).padStart(2, '0')}-${s.name.replace(/[^a-z0-9]+/gi, '_')}`;
    fs.writeFileSync(path.join(outDir, `${base}.png`), writePng({ data: inv, width: r.width, height: r.height, channels: 1 }));
    if (args.films) fs.writeFileSync(path.join(outDir, `${base}.tif`), engine.tiff.writeTiff(engine.renderScreenFilm(r, s, film)));
  });
  const summary = engine.screenSummary(r, film).map((s) => ({ ...s, coverage: +(s.coverage * 100).toFixed(1) }));
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ ms, report: r.report, screens: summary }, null, 2));
  console.log(`${r.screens.length} screens in ${ms} ms · match ${r.report.match.rating} (avg ΔE ${r.report.match.avgDeltaE}, 95% ${r.report.match.p95DeltaE})`);
  for (const s of summary) console.log(`  ${s.order}. ${s.name.padEnd(22)} ${s.hex}  ${String(s.coverage).padStart(5)}%  mesh ${s.mesh}`);
  for (const w of r.report.warnings) console.log(`  [${w.level}] ${w.text}`);
}

main();
