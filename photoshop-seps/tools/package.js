#!/usr/bin/env node
'use strict';
// Makes dist/ecko-seps-plugin.zip (Photoshop plug-in folder) and
// dist/ecko-seps-try.html (the panel as one self-contained web page).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const pluginFiles = ['manifest.json', 'index.html', 'styles.css', 'compat.js', 'ui.js', 'engine.bundle.js', 'host-photoshop.js', 'host-browser.js', 'icons', 'README.md'];
const zip = path.join(dist, 'ecko-seps-plugin.zip');
fs.rmSync(zip, { force: true });
const stage = path.join(dist, 'Ecko Seps');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
for (const f of pluginFiles) fs.cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
execFileSync('zip', ['-qr', zip, 'Ecko Seps'], { cwd: dist });
fs.rmSync(stage, { recursive: true, force: true });

let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inline = (file) => fs.readFileSync(path.join(root, file), 'utf8').replace(/<\/script/gi, '<\\/script');
html = html.replace('<link rel="stylesheet" href="styles.css">', `<style>\n${fs.readFileSync(path.join(root, 'styles.css'), 'utf8')}\n</style>`);
for (const f of ['compat.js', 'engine.bundle.js', 'host-photoshop.js', 'host-browser.js', 'ui.js']) {
  html = html.replace(`<script src="${f}"></script>`, () => `<script>\n${inline(f)}\n</script>`);
}
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">');
fs.writeFileSync(path.join(dist, 'ecko-seps-try.html'), html);

// Hosted (claude.ai) version: the full app. Downloads go through the
// viewer's download prompt there (see host-browser.js).
fs.writeFileSync(path.join(dist, 'ecko-seps-hosted.html'), html);

// Installer package: a .ccx is the plug-in folder's contents zipped with
// manifest.json at the top level. Double-clicking it opens Creative Cloud,
// which installs it into Photoshop.
const ccx = path.join(dist, 'EckoSeps.ccx');
fs.rmSync(ccx, { force: true });
const stage2 = path.join(dist, 'ccx-stage');
fs.rmSync(stage2, { recursive: true, force: true });
fs.mkdirSync(stage2);
for (const f of pluginFiles.filter((x) => x !== 'README.md')) fs.cpSync(path.join(root, f), path.join(stage2, f), { recursive: true });
execFileSync('zip', ['-qr', '-X', ccx, '.'], { cwd: stage2 });
fs.rmSync(stage2, { recursive: true, force: true });
console.log('wrote dist/ecko-seps-plugin.zip, dist/EckoSeps.ccx, dist/ecko-seps-try.html and dist/ecko-seps-hosted.html');
