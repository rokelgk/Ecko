# Ecko: one-click embroidery digitizing

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
  rounded). Use them on their own or with a picture, and drag to place.
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

See [docs/competitive-research.md](docs/competitive-research.md) for the
complaints about existing software and how each one is handled here.

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
.venv/bin/python -m pytest
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
3. Curved and arched text for caps and badges.
4. Photo-stitch styles for photographs.
