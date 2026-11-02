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
// Installer download for the online page: the .ccx inside a .zip (claude.ai
// downloads accept .zip but not .ccx), with short instructions.
const inst = path.join(dist, 'EckoSeps-installer.zip');
fs.rmSync(inst, { force: true });
fs.writeFileSync(path.join(dist, 'HOW-TO-INSTALL.txt'), [
  'ECKO SEPS - install in Photoshop 2023 (v25) or newer',
  '',
  'Option A (installer): double-click EckoSeps.ccx. Creative Cloud opens and installs it.',
  '  If it warns the plug-in is not from the Marketplace, choose Install.',
  '  Then restart Photoshop and open Plugins > Ecko Seps.',
  '',
  'Option B (UXP Developer Tool): unzip ecko-seps-plugin.zip, then in UXP Developer Tool',
  '  click Add Plugin, choose manifest.json inside the Ecko Seps folder, then ... > Load.',
  '',
].join('\n'));
execFileSync('zip', ['-qj', inst, ccx, zip, path.join(dist, 'HOW-TO-INSTALL.txt')]);
fs.rmSync(path.join(dist, 'HOW-TO-INSTALL.txt'));

// Hosted page gets a "Get the Photoshop plug-in" card with the installer
// built in, so it can be downloaded with its real name from the page.
const b64 = fs.readFileSync(inst).toString('base64');
const getCard = `
      <section class="card" id="getPluginCard">
        <h2>Get the Photoshop plug-in</h2>
        <div class="muted small">One download with everything: <b>EckoSeps.ccx</b> (double-click to install), the plug-in folder as a zip, and install steps. Needs Photoshop 2023 (v25) or newer.</div>
        <button id="getPlugin" class="btn primary wide">⬇ Download Photoshop plug-in (.zip)</button>
        <div id="getPluginMsg" class="muted small"></div>
      </section>
`;
const getScript = `<script>
(function () {
  var B64 = '${b64}';
  var btn = document.getElementById('getPlugin');
  if (!btn) return;
  btn.addEventListener('click', function () {
    var bin = atob(B64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    var msg = document.getElementById('getPluginMsg');
    var p = window.EckoHost && window.EckoHost.saveFiles ? window.EckoHost.saveFiles([{ name: 'EckoSeps-installer.zip', data: bytes }]) : null;
    Promise.resolve(p).then(function (where) { msg.textContent = where ? 'Saved to ' + where + '. Open the zip, then double-click EckoSeps.ccx.' : 'Download cancelled.'; },
      function (e) { msg.textContent = 'Download failed: ' + (e && e.message ? e.message : e); });
  });
})();
</script>`;
const hosted = html.replace('      <section class="card" id="outputCard">', getCard + '\n      <section class="card" id="outputCard">').replace('</body>', getScript + '\n</body>');
fs.writeFileSync(path.join(dist, 'ecko-seps-hosted.html'), hosted);
fs.writeFileSync(path.join(dist, 'ecko-seps-try.html'), hosted);
console.log('wrote dist/ecko-seps-plugin.zip, dist/EckoSeps.ccx, dist/EckoSeps-installer.zip, dist/ecko-seps-try.html and dist/ecko-seps-hosted.html');
