# Start here

Ecko is starting up for you. In a few seconds a new browser tab opens with the app.

**No tab opened?** Click the **Ports** tab at the bottom of this screen, then click the
globe icon next to **Ecko app (8000)**.

- **Embroidery:** the page that opens first.
- **Halftone tool:** click **Halftone tool** at the top of that page.

When you're done, close the tab. The codespace pauses on its own after 30 minutes idle.
To come back, go to https://github.com/codespaces and reopen it.

The app stopped? Click **Terminal → New Terminal** and paste:

    python -m uvicorn ecko.app:app --host 0.0.0.0 --port 8000
