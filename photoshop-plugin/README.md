# Ecko Tone panel for Photoshop

A UXP panel that halftones the selected layer with the Ecko Tone engine and puts the
result on a new layer at the same position. It uses your document's resolution as the DPI,
so the pattern is the same as an Ecko Tone export at that size.

**Status: experimental.** It hasn't been run inside Photoshop yet. The server endpoint it
calls (`POST /api/tone/raw`) is covered by the test suite.

## Install (development)

1. Start Ecko: `.venv/bin/uvicorn ecko.app:app` (default `http://localhost:8000`).
2. Install Adobe's **UXP Developer Tool** from Creative Cloud.
3. In UXP Developer Tool: *Add Plugin* → choose `photoshop-plugin/manifest.json` → *Load*.
4. In Photoshop: *Plugins → Ecko Tone*. Select a layer, pick a look, click
   **Halftone selected layer**.

Needs Photoshop 2023 (v24) or later and an RGB document. For textures, inks, spot
separations and print checks, use the full web app at `/tone.html`.
