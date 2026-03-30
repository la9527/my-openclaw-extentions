"""Apple Photos source using osxphotos library."""

from __future__ import annotations

import base64
import io
import logging
from datetime import datetime

from models import Photo, PhotoMetadata

logger = logging.getLogger(__name__)


class ApplePhotosSource:
    """Access Apple Photos / iCloud library via osxphotos."""

    def __init__(self) -> None:
        self._db = None

    def _ensure_loaded(self):
        if self._db is not None:
            return
        try:
            import osxphotos

            self._db = osxphotos.PhotosDB()
            logger.info(
                "Apple Photos DB loaded: %d photos", len(self._db.photos())
            )
        except ImportError:
            raise RuntimeError(
                "osxphotos is not installed. "
                "Install with: uv pip install 'photo-source[apple]'"
            )

    def list_photos(
        self,
        date_from: str | None = None,
        date_to: str | None = None,
        album: str | None = None,
        person: str | None = None,
        limit: int = 100,
    ) -> list[Photo]:
        """List photos matching filters."""
        self._ensure_loaded()
        import osxphotos

        photos = self._db.photos()

        # Filter by date
        if date_from:
            dt_from = datetime.fromisoformat(date_from)
            photos = [p for p in photos if p.date and p.date >= dt_from]
        if date_to:
            dt_to = datetime.fromisoformat(date_to)
            photos = [p for p in photos if p.date and p.date <= dt_to]

        # Filter by album
        if album:
            album_lower = album.lower()
            photos = [
                p
                for p in photos
                if any(album_lower in a.title.lower() for a in p.album_info if a.title)
            ]

        # Filter by person
        if person:
            person_lower = person.lower()
            photos = [
                p
                for p in photos
                if any(person_lower in pn.name.lower() for pn in p.person_info if pn.name)
            ]

        # Limit
        photos = photos[:limit]

        return [self._to_photo(p) for p in photos]

    def get_metadata(self, photo_id: str) -> PhotoMetadata | None:
        """Get detailed metadata for a photo by UUID."""
        self._ensure_loaded()
        matches = [p for p in self._db.photos() if p.uuid == photo_id]
        if not matches:
            return None

        p = matches[0]
        exif = p.exif_info or {}

        return PhotoMetadata(
            photo_id=p.uuid,
            filename=p.filename or "",
            date_taken=p.date.isoformat() if p.date else "",
            camera_make=getattr(exif, "camera_make", "") or "",
            camera_model=getattr(exif, "camera_model", "") or "",
            focal_length=getattr(exif, "focal_length", 0.0) or 0.0,
            iso=getattr(exif, "iso", 0) or 0,
            gps=(
                {"lat": p.latitude, "lon": p.longitude}
                if p.latitude is not None
                else None
            ),
            albums=[a.title for a in p.album_info if a.title],
            persons=[pn.name for pn in p.person_info if pn.name],
            keywords=list(p.keywords) if p.keywords else [],
        )

    def get_thumbnail(
        self, photo_id: str, max_size: int = 512
    ) -> str | None:
        """Get resized thumbnail as base64."""
        self._ensure_loaded()
        from PIL import Image

        matches = [p for p in self._db.photos() if p.uuid == photo_id]
        if not matches:
            return None

        p = matches[0]
        path = p.path
        if not path:
            return None

        image = Image.open(path)
        image.thumbnail((max_size, max_size))
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode()

    def search_photos(self, query: str, limit: int = 50) -> list[Photo]:
        """Search photos by keyword matching on filename, albums, persons, keywords."""
        self._ensure_loaded()
        query_lower = query.lower()
        results = []

        for p in self._db.photos():
            text_parts = [
                p.filename or "",
                *(a.title for a in p.album_info if a.title),
                *(pn.name for pn in p.person_info if pn.name),
                *(p.keywords or []),
            ]
            combined = " ".join(text_parts).lower()
            if query_lower in combined:
                results.append(self._to_photo(p))
                if len(results) >= limit:
                    break

        return results

    @staticmethod
    def _to_photo(p) -> Photo:
        return Photo(
            id=p.uuid,
            filename=p.filename or "",
            date_taken=p.date.isoformat() if p.date else "",
            source="apple_photos",
            path=p.path or "",
            width=p.width or 0,
            height=p.height or 0,
            albums=[a.title for a in p.album_info if a.title],
            persons=[pn.name for pn in p.person_info if pn.name],
            gps=(
                {"lat": p.latitude, "lon": p.longitude}
                if p.latitude is not None
                else None
            ),
        )
