# Ecko Seps: screen-print color separations for Photoshop

A Photoshop panel (UXP plug-in) that separates artwork for screen printing.
Pick the job type, the shirt color and the number of screens, then press
**Separate**.

- **Eight one-click presets:** Sim Process on dark or light shirts, Index on
  dark or light shirts, Spot Color (vector/logo), CMYK Process on white or
  **dark shirts (white underbase + highlight white)**, and One Color.
- **Step-by-step workflow:** a 10-step checklist (art check, job, shirt,
  screens, separate, colors, underbase, halftones, registration, output) shows
  what's done, what needs a look, and jumps to each step.
- **Per-color controls (⚙):** an Amount slider, Levels with a histogram
  (input shadows, midtones, highlights, output min/max), choke/spread, and
  print-as / angle / LPI overrides for each screen.
- **Add spot colors by clicking** on the art (🎯), matched to your library if
  you like.
- **Pre-registration:** one-tap registration marks, crop marks, center
  marks, ink names and LPI/mesh labels on plates, films and the document.
- **Tonal underbase:** the underbase follows the art's own light and color
  (like a fuller highlight white), keeping the shading instead of going
  solid under every ink. "Solid under every color" is still an option.
- **Compare (⇆):** the original artwork as uploaded next to the print
  preview, side by side (stacked on tall screens).
- **Clean-up tool (🧹):** remove unwanted color from just one area, not the
  whole color. Pick a screen (or all screens), then **Brush** over stray
  pixels or tap them with **Magic area** to remove that connected patch
  ("Reach" limits how far it spreads). Clean-ups are stored in art
  coordinates, so they carry to the full-size output, and the underbase
  follows. Undo or clear any time; each screen shows its 🧹 count.
- **Add a color (+):** quick spot colors (red, orange, yellow, gold, green,
  lime, blue, navy, purple, pink, brown, skin tone, tan, gray, white; ✓ marks
  ones you already have), black screens (**Solid Black**, **Black Set** for
  shadows, **Detailed Black** for lines and edge detail; they print on top
  and get their own plates, even on a black shirt), and a mixer with hue /
  saturation / brightness sliders, hex entry, **Pick from the image**, and
  in Photoshop the Photoshop color picker and foreground color.
- **Merge screens:** fold any screen into another (for example Highlight
  White into the Underbase): the merged color disappears as a screen and
  film and prints on the target (shown as "⊕ merged"; unmerge from the
  target's ⚙ panel).
  At 5 screens or fewer the highlight white is merged into the underbase
  automatically, so low counts spend screens on real colors.
- **Colors in your art:** a strip of the art's distinct colors with their
  coverage. Tap to choose, then "Separate with only these" or "Add as spot
  colors"; or pick any color on the art.
- **Smarter ink choice:** two pickers (area-weighted, and one that protects
  small but distinct colors like a yellow among blues) are both refined and
  the better print wins.
- **Texture & distress:** grunge, worn vintage, cracked, scratches, speckle
  and fine-grain knockouts, or your own texture image; amount, size,
  softness, strength, invert, new pattern, and apply to all screens, the
  underbase only or the top colors only.
- **Proof Window (🪟, Photoshop):** like ActionSeps, the panel has no picture;
  a "Proof Window" document at the art's print size opens tiled next to your
  artwork and redraws after every change, showing whichever view tab you
  pick. The panel picture comes back while the clean-up brush or eyedropper
  is in use, or when the Proof window is switched off.
  **Detail** (Fast / Sharp / Max) sets how sharp the live proof is.
- **Aztec carved theme:** stepped-fret bands, sun-stone glyph, carved card
  corners and step-pyramid dividers in obsidian, gold, terracotta and jade
  (pure CSS + inline SVG). The ◈ Theme button switches to the plain look.
- **Works on small screens:** every pane scrolls with an always-visible
  scrollbar, so nothing is cut off on a MacBook Air, older 13" laptops,
  phones or a short Photoshop panel. Drag the divider to resize the
  preview/options (double-click resets), hide the preview to give options
  all the room, and switch to a compact or large interface (A− / A+).
  `node tools/check-layout.js` checks every control is reachable at 8
  screen sizes from 1440×780 down to 320×480.
- **Background & shirt:** one-tap background removal (auto-detected or
  picked on the art, with tolerance, edge-only and soft-edge controls; edges
  are cleaned so no halo is left) and shirt-color knockout so the shirt
  shows wherever the art matches it.
- **Automatic high-res:** art under 300 ppi at its print size is upscaled
  and sharpened automatically, with one-tap undo. Art Levels and saturation
  are also available.
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
- **Live editing:** after the first Separate, every change redraws the
  preview in a fraction of a second. That covers removing, hiding (👁),
  recoloring, reordering or adding a screen, every fine-tune slider, and art
  prep. Each ink edit shows how the match changed ("Good ΔE 3.7 → Good ΔE
  3.9, worse") with Undo.
- **Art size, resolution and sharpness:** set the print width to see the
  real ppi. Low-res art is upscaled (bicubic) to 200–360 ppi, with sharpen
  (amount + radius) and noise clean-up for JPEG speckle or scans.
- **Split layout:** a large preview on one side and all options on the other.
  On a phone the preview stays pinned on top. Tap the preview for a
  real-dot close-up at film resolution with your LPI, angle and dot shape.
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

Or skip the developer tool: `node tools/package.js` also writes
`dist/EckoSeps.ccx`. Double-click it and Creative Cloud installs it into
Photoshop (it may warn that the plug-in isn't from the Marketplace).

If anything fails inside Photoshop, the panel shows the error message at the
bottom (from `compat.js`), so a screenshot tells us exactly what broke.

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
| `engine/texture.js` | Distress textures (procedural or your image) as knockouts |
| `engine/prepare.js` | Print size, upscaling, sharpening and noise clean-up |
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
