#!/usr/bin/env bash
set -euo pipefail

UUID="${1:-9C2B2620-2F9F-4DD2-A09E-C798CFD95161}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

read -r -d '' PYTHON_SCRIPT <<'PY' || true
import json
import logging
import osxphotos
import sources
import sys

logging.basicConfig(level=logging.INFO)

uuid = sys.argv[1]
photo = next((p for p in osxphotos.PhotosDB().photos() if p.uuid == uuid), None)
resolved = sources._resolve_apple_photo_path(photo, download_missing=True) if photo else None
loaded = sources.load_photos("apple", "", limit=30)
matched = next((p for p in loaded if p["photo_id"] == uuid), None)

print(json.dumps({
    "uuid": uuid,
    "found": photo is not None,
    "resolved_path": resolved or "",
    "matched_in_load": matched is not None,
    "source_photo_path": matched["source_photo_path"] if matched else "",
    "image_b64_present": bool(matched and matched.get("image_b64")),
    "photokit_disabled": getattr(sources, "_APPLE_PHOTOKIT_DISABLED", None),
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
