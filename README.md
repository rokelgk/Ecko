# Ecko: one-click embroidery digitizing

## Try it

**Halftone tool, nothing to install:** download
[`dist/ecko-tone.html`](dist/ecko-tone.html) and double-click it. It's the whole halftone tool
in one file: it runs in your browser, works offline, and your pictures never leave your
computer. Everything works, including fit to shirt, curved text, mockups, batch ZIPs, and PNG
and separation downloads. Use a current Chrome, Edge, Firefox or Safari.

**Photoshop:** the panel in [`photoshop-plugin/`](photoshop-plugin/README.md) also runs on its
own inside Photoshop, with no server needed.

**The full app (with embroidery):** install [Python](https://www.python.org/downloads/), then
double-click **`start-windows.bat`** (Windows) or **`start-mac.command`** (Mac). Or open it in
the cloud with [GitHub Codespaces](https://codespaces.new/rokelgk/ecko?quickstart=1).

Upload a picture, pick your machine and fabric, click **Digitize**, and
download a file your machine can sew.

- **Any machine.** Brother, Baby Lock, Janome/Elna, Bernina, Husqvarna
  Viking, Pfaff, Singer, Ricoma, Tajima, Barudan, Melco, SWF, Happy. Writes
  PES, DST, JEF, EXP, VP3, XXX, U01 and PEC. Hoop sizes are listed per model,
  and custom hoops work too.
- **Fabric-aware.** Density, underlay, pull compensation and satin width
  change for woven, T-shirt, polo, fleece, towel, caps, canvas and leather.
- **Real stitch types.** Tatami fill for large areas, satin for narrow
  shapes and lettering, running or bean stitch for fine lines. Every shape
  gets underlay, and every run gets lock stitches.
- **Checks before you sew.** The report covers hoop fit (with one-click
  resize or rotate), stitch-density hotspots, details too small to sew,
  stitch count, trims and sew time.
- **Preview.** A realistic thread render on your garment color, a
  stitch-path view with jumps and trims, and a sew-out simulation.
- **Lettering.** Type names, team text or numbers in six bundled
  embroidery-friendly fonts (block, sans, slab serif, script, varsity,
  rounded). Curve a line into an arch or a smile for caps and badges. Use them on their own or with a picture, and drag to place.
  Text below a font's safe size gets a warning and a one-click fix.
- **Editing.** Click any shape to switch it between fill, satin and running
  stitch, set its stitch angle and density, or stop it being stitched. Move
  colors earlier or later in the sewing order.
- **Real thread numbers.** Brother, Janome and Husqvarna Viking charts are
  built in and matched to your machine. Import any other brand's chart
  (Madeira, Isacord, etc.) from a CSV or GIMP `.gpl` file. Giving two colors
  the same thread merges them, so there's no color change between them.
- **Saved designs.** Designs are saved automatically and listed under "My
  designs" in your browser. Every design has a link you can reopen or share.

## Ecko Tone: halftones for printed shirts

Open `/tone.html` (or click **Halftone tool**). Drop a photo or design, pick a look, and
download a print-ready file.

- **10 screens:** round, classic, ellipse, square, diamond, line, cross, stochastic grain,
  Xerox and mezzotint. Set real LPI, angle, DPI and print size.
- **Colour:** one ink, duotone, CMYK, or 2–8 spot-colour separations with editable inks.
- **Textures:** worn, cracked, grunge, paper, scratches and toner, each with strength and
  size, reseedable for new variations. You can also use your own texture image.
- **DTF-safe output:** transparency is strictly on/off, with real DPI in the PNG. Knock out
  the garment colour so the shirt shows through.
- **Press control:** minimum and maximum dot, dot-gain compensation, rough dot edges, and
  misregistration for a riso look.
- **Print check:** tone levels, smallest dot compared with what DTF, DTG or screen print can
  hold, and LPI range, each with a one-click fix.
- **1:1 loupe:** click the preview to see the exact print pixels.
- **Screen print:** a ZIP of 1-bit films with registration marks.
- **Fit to shirt:** pick the shirt colour and the print adapts to it.
  - **Recolor** (logos and text): ink that would vanish on the shirt switches to cream or black.
  - **Match the picture** (photos): ink coverage is solved for the shirt colour, so highlights
    print in light ink and shadows let the shirt show through.
  - Spot inks that match the shirt are dropped, since the shirt supplies that colour.
  - On dark shirts, screen-print films get a choked white underbase.
  - **Automatic** chooses Recolor or Match the picture for you.
- **Threshold layers** (AutoThresh-style): split a picture into 2–8 solid tones with automatic
  cut points, smoothing, and knockout or overlap. Tones can also blend through any pattern.
- **Dithers** (DitherTone-style): Floyd–Steinberg, Atkinson, Jarvis, Stucki, Burkes, Sierra,
  ordered Bayer and wave lines. Plus **index colour** (one ink per pixel) with built-in palettes.
- **Curved text:** arched or smile text in six fonts, with or without a picture.
- **On-shirt mockup:** see the print to scale on a T-shirt of the chosen colour.
- **Batch:** many designs × up to 12 shirt colours in one ZIP. Every colour gets its own
  adapted print, plus an optional JPEG mockup for product listings.
- **Photoshop panel** (experimental): see [photoshop-plugin/](photoshop-plugin/README.md).

See [docs/tone-research.md](docs/tone-research.md) for how it compares with Photoshop
halftone templates like GryzTone.

See [docs/competitive-research.md](docs/competitive-research.md) for the
complaints about existing software and how each one is handled here.

## Also in this repo: Ecko Seps (screen printing)

[`photoshop-seps/`](photoshop-seps/README.md) is a Photoshop plug-in for
screen-print color separations: sim process, index, spot, CMYK and one-color,
with 2–10 screens or Auto, PMS library mapping, halftone/FM/index film
output with registration marks, and an on-shirt preview with a match score.
See its [research notes](photoshop-seps/docs/competitive-research.md).

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn ecko.app:app --reload
# open http://localhost:8000
```

Or with Docker:

```bash
docker build -t ecko .
docker run -p 8000:8000 -v ecko-data:/data ecko
```

Saved designs go in SQLite at `$ECKO_DATA_DIR/ecko.sqlite3` (default
`./data`).

## Test

```bash
.venv/bin/python -m pytest          # also runs the JS engine tests when Node is installed
python tools/build_standalone.py    # after changing Tone: rebuild dist/ecko-tone.html
```

## How it works

```
picture ─► colors (k-means in Lab, anti-alias clean-up, background removal)
        ─► regions per color (contours → polygons in mm)
        ─► stitch type per region (width along the skeleton)
        ─► stitches (underlay + tatami / satin / bean, pull compensation)
        ─► sequencing (fills first, details on top, nearest-next, trims)
        ─► machine file (pyembroidery) + quality report
```

| Path | What it does |
|---|---|
| `ecko/digitizer/preprocess.py` | Image → clean thread-color map at the requested physical size |
| `ecko/digitizer/regions.py` | Color map → polygons, width measurement, stitch-type choice |
| `ecko/digitizer/stitches.py` | Fill, satin, running/bean and underlay generators |
| `ecko/digitizer/pipeline.py` | Orchestration, color order, sequencing, lock stitches |
| `ecko/digitizer/text.py` | Lettering: fonts and text rendering |
| `ecko/digitizer/report.py` | Quality checks and sew-time estimate |
| `ecko/digitizer/export.py` | Machine file writing |
| `ecko/machines.py` | Machine brands, models, hoops and formats |
| `ecko/fabrics.py` | Fabric presets |
| `ecko/threadcharts.py` | Thread brand charts and nearest-thread matching |
| `ecko/store.py` | Saved designs (SQLite) |
| `ecko/fonts/` | Bundled fonts (SIL Open Font License / Apache 2.0; licence files included) |
| `ecko/tone/engine.py` | Halftone engine: screens, colour separation, tone and press control, print check |
| `ecko/tone/noise.py` | Procedural patterns in global print coordinates (textures, blue noise) |
| `ecko/tone/api.py`, `export.py`, `presets.py` | Tone API, PNG/ZIP export, starting looks |
| `ecko/tone/mockup.py` | Flat T-shirt mockups, drawn to scale |
| `ecko/arctext.py` | Text set along an arc (shared by embroidery and Tone) |
| `web/standalone/` | No-server Tone: JS engine port (`engine.src.js`), browser host, fetch shim |
| `tools/build_standalone.py` | Builds `dist/ecko-tone.html` and the Photoshop panel's engine |
| `ecko/app.py` | FastAPI backend |
| `web/` | Front end (plain HTML/CSS/JS, no build step) |

## API

| Method | Path | What it does |
|---|---|---|
| GET | `/api/catalog` | Machines, hoops, formats, fabrics, fonts, thread charts |
| POST | `/api/designs` | Multipart: optional `file`, `options` (JSON), `name`. Creates and saves a design |
| GET | `/api/designs/{id}` | Design state: preview stitches, objects, report, threads |
| PATCH | `/api/designs/{id}` | JSON `{options?, edits?, name?}`. Re-plans instantly; re-analyzes the picture only when size, colors, detail or background change |
| DELETE | `/api/designs/{id}` | Deletes a design |
| GET | `/api/designs?ids=a,b` | Summaries for the ids a browser has saved |
| GET | `/api/designs/{id}/file?format=pes&rotate=false` | Machine file download |
| GET | `/api/designs/{id}/image` | The original picture |
| GET | `/api/tone/catalog` | Screens, colour modes, textures, print targets, presets, defaults |
| POST | `/api/tone/images` | Multipart `file`; returns an image id (kept in memory, so re-upload on 410) |
| POST | `/api/tone/preview` | JSON `{image_id, options, max_px?, region?}`: preview (or 1:1 crop) plus print check |
| POST | `/api/tone/export` | JSON `{image_id, options, format: png\|zip, name}`: full-size print file |
| POST | `/api/tone/mockup` | JSON `{image_id, options, size?}`: JPEG of the print on a shirt |
| POST | `/api/tone/batch` | JSON `{items: [{image_id, name}], garments: [{hex, name}], options, mockups}`: ZIP |
| POST | `/api/tone/raw?width=&height=&options=` | Raw RGBA body in, RGBA out (for the Photoshop panel) |

`image_id` may be `null` when `options.text` has text: text-only designs work too.

`options` fields: `brand`, `model`, `hoop`, `hoop_width_mm`,
`hoop_height_mm`, `fabric`, `width_mm`, `colors`, `detail`, `density`,
`underlay`, `remove_background`, `thread_chart`, and `text` (a list of
`{text, font, height_mm, color, x_mm, y_mm}`).

`edits` fields: `objects` (`{"<id>": {kind, angle, density, hidden}}`),
`color_order` (palette indices) and `threads`
(`{"<palette index>": {hex, name, code, brand}}`).

There are no user accounts yet. A design's random 128-bit id works like an
unlisted link: anyone who has it can open it.

## Roadmap

1. Accounts and a paid tier for businesses. This needs decisions first: a
   sign-in provider, pricing, and where to host.
2. An AI stitch planner trained on professionally digitized files. This
   needs a licensed set of artwork paired with pro files.
3. Photo-stitch styles for photographs.
