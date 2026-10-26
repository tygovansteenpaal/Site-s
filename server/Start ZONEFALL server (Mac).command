#!/bin/bash
# Double-click on a Mac: creates a private Python environment the first time, then starts the ZONEFALL server.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is not installed. Get it from https://www.python.org/downloads/ and run this again."
  read -r -p "Press Enter to close." _; exit 1
fi
if [ ! -d .venv ]; then
  echo "First start: installing the server (one time)..."
  python3 -m venv .venv && ./.venv/bin/pip install --quiet --upgrade pip && ./.venv/bin/pip install --quiet -r requirements.txt || { read -r -p "Install failed. Press Enter to close." _; exit 1; }
fi
./.venv/bin/python zonefall_server.py "$@"
