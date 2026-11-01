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

const pluginFiles = ['manifest.json', 'index.html', 'styles.css', 'ui.js', 'engine.bundle.js', 'host-photoshop.js', 'host-browser.js', 'icons', 'README.md'];
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
for (const f of ['engine.bundle.js', 'host-photoshop.js', 'host-browser.js', 'ui.js']) {
  html = html.replace(`<script src="${f}"></script>`, () => `<script>\n${inline(f)}\n</script>`);
}
html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">');
fs.writeFileSync(path.join(dist, 'ecko-seps-try.html'), html);
console.log('wrote dist/ecko-seps-plugin.zip and dist/ecko-seps-try.html');
