"""Photo source loaders for the classification pipeline.

Each loader enumerates images from its source and returns the
pipeline-ready list of {"photo_id": str, "image_b64": str} dicts.
"""

from __future__ import annotations

import base64
import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".tiff", ".bmp"}


def load_photos(
    source: str,
    source_path: str,
    *,
    album: str = "",
    person: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
    max_size: int = 512,
) -> list[dict]:
    """Load photos from the given source as pipeline-ready dicts.

    Returns:
        list of {"photo_id": str, "image_b64": str}
    """
    if source == "local":
        return _load_local(source_path, limit=limit, max_size=max_size)
    if source == "apple":
        return _load_apple(
            album=album or source_path,
            person=person,
            date_from=date_from,
            date_to=date_to,
            limit=limit,
            max_size=max_size,
        )
    if source == "gcs":
        raise NotImplementedError("GCS source not yet implemented in photo-ranker")
    raise ValueError(f"Unsupported source: {source!r}")


# ── Local folder ───────────────────────────────────────


def _load_local(
    directory: str,
    *,
    limit: int = 100,
    max_size: int = 512,
) -> list[dict]:
    """Load images from a local directory."""
    from PIL import Image

    root = Path(directory)
    if not root.is_dir():
        raise FileNotFoundError(f"Directory not found: {directory}")

    results: list[dict] = []

    for path in sorted(root.rglob("*")):
        if path.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if not path.is_file():
            continue

        try:
            b64 = _image_to_b64(Image.open(path), max_size)
            results.append({"photo_id": str(path), "image_b64": b64})
        except Exception:
            logger.warning("Failed to load image: %s", path)
            continue

        if len(results) >= limit:
            break

    logger.info("Loaded %d photos from local: %s", len(results), directory)
    return results


# ── Apple Photos ───────────────────────────────────────


def _load_apple(
    *,
    album: str = "",
    person: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
    max_size: int = 512,
) -> list[dict]:
    """Load images from Apple Photos via osxphotos."""
    try:
        import osxphotos
    except ImportError:
        raise RuntimeError(
            "osxphotos is required for Apple Photos source. "
            "Install with: uv pip install osxphotos"
        )

    from datetime import datetime

    from PIL import Image

    db = osxphotos.PhotosDB()
    photos = db.photos()
    logger.info("Apple Photos DB: %d total photos", len(photos))

    # Apply filters
    if date_from:
        dt_from = datetime.fromisoformat(date_from)
        photos = [p for p in photos if p.date and p.date >= dt_from]
    if date_to:
        dt_to = datetime.fromisoformat(date_to)
        photos = [p for p in photos if p.date and p.date <= dt_to]
    if album:
        album_lower = album.lower()
        photos = [
            p
            for p in photos
            if any(
                album_lower in a.title.lower()
                for a in p.album_info
                if a.title
            )
        ]
    if person:
        person_lower = person.lower()
        photos = [
            p
            for p in photos
            if any(
                person_lower in pn.name.lower()
                for pn in p.person_info
                if pn.name
            )
        ]

    # Sort by date descending (newest first)
    photos.sort(key=lambda p: p.date or datetime.min, reverse=True)
    photos = photos[:limit]

    results: list[dict] = []
    for p in photos:
        if not p.path:
            continue
        try:
            img = Image.open(p.path)
            b64 = _image_to_b64(img, max_size)
            results.append({"photo_id": p.uuid, "image_b64": b64})
        except Exception:
            logger.warning("Failed to load Apple photo: %s (%s)", p.uuid, p.filename)
            continue

    logger.info(
        "Loaded %d photos from Apple Photos (album=%r, person=%r)",
        len(results),
        album,
        person,
    )
    return results


# ── Helpers ────────────────────────────────────────────


def _image_to_b64(img, max_size: int = 512) -> str:
    """Resize and encode a PIL Image as base64 JPEG."""
    img.thumbnail((max_size, max_size))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()
