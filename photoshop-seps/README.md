# Ecko Seps: screen-print color separations for Photoshop

A Photoshop panel (UXP plug-in) that separates artwork for screen printing.
Pick the job type, the shirt color and the number of screens, then press
**Separate**.

- **Seven one-click presets:** Sim Process on dark or light shirts, Index on
  dark or light shirts, Spot Color (vector/logo), CMYK Process, and One Color.
- **2, 4, 6, 8 or 10 screens, or Auto.** The count is the total number of
  screens, underbase and highlight white included, so it equals your press
  heads. Auto finds the fewest screens that still match the art.
- **PMS mapping.** Import your PMS book or ink maker's chart (`.ase`,
  `.aco`, `.csv`, `.gpl`) and the separation maps every screen to its nearest
  library ink using CIEDE2000. The screen is named after the ink. A built-in
  set of 43 common plastisol colors works out of the box.
- **Registration.** Films get registration targets on all four sides and a
  label (screen number, ink, LPI, angle, dot, mesh), and can be mirrored.
- **Bitmap options:** halftone dots (round, ellipse, square, diamond, line),
  stochastic/FM diffusion with a minimum dot size, index square pixels, solid
  threshold, or continuous tone for your own RIP.
- **Frequencies and resolution:** 25–85 lpi, any angle (CMYK uses the
  moiré-safe C15/M75/Y0/K45 set), film output at 300–2400 dpi. Mesh counts
  are recommended for each screen.
- **Dark shirts handled properly:** the underbase is worked out per ink
  (saturated reds and blues get a full base), with choke, density, and a
  highlight white printed last.
- **Preview before you burn screens:** an on-shirt preview using the same
  press model as the separation, a ΔE2000 match score in plain words, and
  single-plate film views.
- **Editable, not a black box:** rename, recolor, lock, reorder, delete or
  add inks, then re-separate with exactly those inks.
- **Output:** a Photoshop document with one named spot channel per ink in
  print order on a garment-colored background, 1-bit TIFF films, and a job
  sheet (print order, inks, coverage, mesh, flash note).

[docs/competitive-research.md](docs/competitive-research.md) lists the
complaints about UltraSeps, T-Seps, Separation Studio and others, and how
each one is handled here.

## Install in Photoshop (2023 / v25 or newer)

1. Install **Adobe UXP Developer Tool** from Creative Cloud.
2. Open Photoshop.
3. In UXP Developer Tool choose **Add Plugin**, select
   `photoshop-seps/manifest.json`, then click **Load**.
4. In Photoshop: **Plugins → Ecko Seps**.

To share it with other machines, use **Package** in UXP Developer Tool. That
makes a `.ccx` file that installs with a double-click.

## Use it

1. Open your art in Photoshop (any mode or bit depth; it is read as RGB).
   Size it to print size at 200–300 ppi first.
2. **What are you printing?** Pick a preset.
3. **Shirt color:** click a swatch, type a hex value, or use the foreground
   color.
4. **Screens:** 2, 4, 6, 8, 10 or Auto.
5. **Separate.** Check the preview and the match score. Click a number to see
   that screen's film.
6. Optional: change inks (click a swatch to see the closest library inks),
   lock the ones you must use, then **Re-separate with these inks**.
7. **Build separation document** for spot channels in Photoshop. Or use
   **Export films (TIFF)** for ready-to-print bitmaps with marks and a job
   sheet.

## Try it without Photoshop

The same panel runs in a browser for previews:

```bash
cd photoshop-seps
python3 -m http.server 8765
# open http://localhost:8765/index.html and choose an image
```

Or from the command line:

```bash
node tools/sep-cli.js art.png out/ --preset dark-sim --screens 8 --films
node tools/sep-cli.js logo.png out/ --preset spot --library my-pms.ase --match --films
```

## Develop

Node 18+ and no dependencies.

```bash
npm test          # checks engine.bundle.js is current, then runs the tests
npm run build     # rebuild engine.bundle.js after editing engine/*.js
```

| Path | What it does |
|---|---|
| `engine/separate.js` | Separation modes, ink planning, underbase, press model, preview, report |
| `engine/palette.js` | Ink selection: k-means in Lab, accent rescue, strong-end inks, edge skipping |
| `engine/halftone.js` | AM/FM/index/threshold bitmaps, registration marks, labels, mesh advice |
| `engine/inks.js` | Built-in inks, `.ase`/`.aco`/`.csv`/`.gpl` import, CIEDE2000 matching |
| `engine/color.js` | sRGB, Lab, Yule-Nielsen space, CIEDE2000, color names |
| `engine/tiff.js` | 1-bit / 8-bit PackBits TIFF writer for films |
| `engine/presets.js` | One-click presets and option lists |
| `engine.bundle.js` | Generated single-file engine loaded by the panel |
| `index.html`, `styles.css`, `ui.js` | The panel (same code in Photoshop and the browser) |
| `host-photoshop.js` | Photoshop glue: read pixels, preview images, spot channels, files |
| `host-browser.js` | Browser glue for the preview page |
| `tools/sep-cli.js` | Command-line separations |

## How the separation works

- **Sim process:** each pixel is solved as an area mix of the garment and at
  most 3 inks, by least squares in Yule-Nielsen space (n = 2). This is done on
  a 33³ lookup table and interpolated, then converted from visible area to
  plate coverage using the print order. The inks are taken as they look
  printed: opaque on underbase, partly see-through on bare fabric.
- **Index:** error diffusion that may only use the garment and the 3 inks
  closest to each pixel's own color. This avoids the classic stray
  off-color dots.
- **Spot:** nearest ink by CIEDE2000, majority filter for specks, optional
  trap, smoothed edges.
- **CMYK:** inverts a transparent-ink model built from the actual process ink
  colors (not the 1−RGB formula), with GCR and a total-ink limit.
- **Finishing:** dot-gain compensation, smallest/largest dot limits that
  round instead of cutting, and removal of lone pixels.

## Known limits

- Photoshop itself was not available while this was built. The engine,
  panel, film export and browser preview are tested. The Photoshop calls in
  `host-photoshop.js` follow Adobe's UXP API but have not yet been run in
  Photoshop: reading pixels (`imaging.getPixels`), writing channels
  (`imaging.putSelection` plus a `spotColorChannel` batchPlay descriptor) and
  the color picker. Test **Build separation document** on a real install
  first.
- Separation runs on Photoshop's main thread. A 12×14 in, 300 ppi file takes
  about 5–10 seconds at full resolution. The interactive preview is a fast
  proof.
- No Pantone data is bundled (it is licensed). Import your own library.
