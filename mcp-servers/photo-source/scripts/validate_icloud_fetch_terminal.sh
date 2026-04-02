#!/usr/bin/env bash
set -euo pipefail

UUID="${1:-9C2B2620-2F9F-4DD2-A09E-C798CFD95161}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

read -r -d '' PYTHON_SCRIPT <<'PY' || true
import json
import logging
import sys

from sources.apple_photos import ApplePhotosSource

logging.basicConfig(level=logging.INFO)

uuid = sys.argv[1]
src = ApplePhotosSource()
thumb = src.get_thumbnail(uuid, max_size=64)
photos = src.list_photos(limit=20)
matched = next((p for p in photos if p.id == uuid), None)

print(json.dumps({
    "uuid": uuid,
    "thumbnail_present": bool(thumb),
    "listed_match": matched is not None,
    "listed_path": matched.path if matched else "",
}, ensure_ascii=False, indent=2))
PY

COMMAND="cd '$ROOT_DIR' && uv run python - <<'PY' '$UUID'
$PYTHON_SCRIPT
PY"

osascript <<OSA
tell application "Terminal"
    activate
    do script "$COMMAND"
end tell
OSA
