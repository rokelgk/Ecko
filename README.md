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
  stitch-path view with jumps and trims, and a sew-out simulation. You can
  change thread colors and the file follows.

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
docker run -p 8000:8000 ecko
```

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
| `ecko/digitizer/report.py` | Quality checks and sew-time estimate |
| `ecko/digitizer/export.py` | Machine file writing |
| `ecko/machines.py` | Machine brands, models, hoops and formats |
| `ecko/fabrics.py` | Fabric presets |
| `ecko/app.py` | FastAPI backend |
| `web/` | Front end (plain HTML/CSS/JS, no build step) |

## API

- `GET /api/catalog` returns the machines, hoops, formats and fabrics.
- `POST /api/digitize` takes multipart `file` plus `options` (JSON: `brand`,
  `model`, `hoop`, `fabric`, `width_mm`, `colors`, `detail`, `density`,
  `underlay`, `remove_background`, `hoop_width_mm`, `hoop_height_mm`). It
  returns a design id, preview stitches and the report.
- `GET /api/designs/{id}/file?format=pes&colors=#hex,...&rotate=false`
  downloads the machine file.

Designs are kept in memory (the last 200). Move them to a database or
object store before running more than one server process.

## Roadmap

1. Thread brand charts (Madeira, Isacord, Robison-Anton).
2. Lettering tool with embroidery fonts.
3. Editing canvas: move or reshape objects, set stitch angles, reorder.
4. Accounts, saved designs, and a paid tier for businesses.
5. An AI stitch planner trained on professionally digitized files.
