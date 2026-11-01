#!/usr/bin/env node
// Layout check: opens the try-it page at small and large screen sizes, opens
// every section, and verifies every button/control can be scrolled into full
// view and nothing runs off the right edge. Needs Playwright + Chromium.
// Run: node tools/package.js && node tools/check-layout.js
const { chromium } = require('playwright');
const SIZES = [
  ['MacBook Air 13" browser', 1440, 780], ['older MacBook 1280x700', 1280, 700], ['small laptop 1024x600', 1024, 600],
  ['short window 900x480', 900, 480], ['tablet portrait 768x1024', 768, 1024], ['narrow panel 340x700', 340, 700],
  ['phone 390x664', 390, 664], ['tiny 320x480', 320, 480],
];
let failures = 0;
(async () => {
  const b = await chromium.launch();
  for (const [label, w, h] of SIZES) {
    const page = await b.newPage({ viewport: { width: w, height: h } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('file://' + require('path').resolve(__dirname, '../dist/ecko-seps-hosted.html'));
    await page.evaluate(() => localStorage.clear()); await page.reload();
    await page.setInputFiles('#openArt', require('path').resolve(__dirname, '../test/fixtures/four-color.png'));
    await page.waitForSelector('#screensCard:not(.hidden)', { timeout: 30000 });
    await page.waitForTimeout(500);
    // open every collapsible and one ink panel (the longest UI state)
    await page.$$eval('.collapsible', (els) => els.forEach((e) => e.classList.add('open')));
    await page.click('.scr .gear');
    await page.waitForTimeout(300);
    const res = await page.evaluate(() => {
      const out = { hidden: [], hOverflow: [] };
      const vw = window.innerWidth, vh = window.innerHeight;
      for (const pane of [document.getElementById('optionsPane'), document.getElementById('previewPane'), document.documentElement]) {
        if (pane.scrollWidth > pane.clientWidth + 1) out.hOverflow.push(`${pane.id || 'page'} ${pane.scrollWidth}>${pane.clientWidth}`);
      }
      const ctrls = [...document.querySelectorAll('#optionsPane button, #optionsPane select, #optionsPane input, #previewPane button, .pv-tools .btn')]
        .filter((el) => el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.hidden'));
      for (const el of ctrls) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const r = el.getBoundingClientRect();
        const pane = el.closest('#optionsPane, #previewPane');
        const pr = pane.getBoundingClientRect();
        const ok = r.width > 0 && r.left >= Math.max(0, pr.left) - 1 && r.right <= Math.min(vw, pr.right) + 1 && r.top >= Math.max(0, pr.top) - 1 && r.bottom <= Math.min(vh, pr.bottom) + 1;
        if (!ok) out.hidden.push(`${el.tagName}#${el.id || ''}.${(el.textContent || el.title || el.name || '').trim().slice(0, 20)} [${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)}] pane[${Math.round(pr.left)},${Math.round(pr.top)},${Math.round(pr.right)},${Math.round(pr.bottom)}]`);
      }
      out.count = ctrls.length;
      const op = document.getElementById('optionsPane');
      out.scrolls = op.scrollHeight > op.clientHeight;
      out.scrollbar = op.offsetWidth - op.clientWidth;
      out.narrow = document.getElementById('app').className;
      return out;
    });
    console.log(`${label.padEnd(28)} controls ${res.count}  unreachable ${res.hidden.length}  overflow ${res.hOverflow.length}  [${res.narrow}]`);
    if (res.hidden.length || res.hOverflow.length) failures++;
    for (const x of res.hidden.slice(0, 6)) console.log('    !', x);
    for (const x of res.hOverflow) console.log('    > overflow', x);
    if (errors.length) console.log('    errors', errors);
    await page.screenshot({ path: require('path').join(require('os').tmpdir(), `ecko-size-${w}x${h}.png`) });
    await page.close();
  }
  await b.close();
  if (failures) { console.error(`${failures} size(s) had unreachable controls or overflow`); process.exit(1); }
})();
