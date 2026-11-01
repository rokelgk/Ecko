#!/bin/bash
# Double-click to run Ecko on a Mac. First run installs everything (a few minutes).
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null; then
  echo "Python 3 isn't installed. Get it from https://www.python.org/downloads/ and run this again."
  read -r -p "Press Enter to close."; exit 1
fi
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt || { read -r -p "Install failed. Press Enter to close."; exit 1; }
(sleep 3; open "http://localhost:8000/tone.html") &
echo "Ecko is running at http://localhost:8000 . Close this window to stop it."
.venv/bin/uvicorn ecko.app:app --port 8000
