"""Apple Photos album writer via photoscript.

Provides two core operations:
1. Organize existing Photos library photos into albums by classification
2. Import external photos into Photos library with album assignment
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


class AlbumWriter:
    """Write-back to Apple Photos: create albums and organize photos."""

    def __init__(self) -> None:
        self._lib = None

    def _ensure_lib(self):
        if self._lib is not None:
            return
        try:
            import photoscript

            self._lib = photoscript.PhotosLibrary()
            logger.info("photoscript PhotosLibrary connected")
        except ImportError:
            raise RuntimeError(
                "photoscript is required for album writing. "
                "Install with: uv pip install osxphotos"
            )

    # ── Album management ───────────────────────────────

    def create_album(self, name: str, folder: str = "") -> dict:
        """Create an album in Photos.

        Args:
            name: Album name to create.
            folder: Optional folder path (e.g. "AI 분류/2026-03").
                    Creates folder hierarchy if it doesn't exist.

        Returns:
            {"album": name, "uuid": str, "folder": folder}
        """
        self._ensure_lib()
        import photoscript

        target_folder = None
        if folder:
            target_folder = self._ensure_folder(folder)

        # Check if album already exists
        existing = self._lib.album(name, top_level=not folder)
        if existing:
            logger.info("Album already exists: %s", name)
            return {
                "album": existing.name,
                "uuid": existing.uuid,
                "folder": folder,
                "created": False,
            }

        album = self._lib.create_album(name, folder=target_folder)
        logger.info("Created album: %s (uuid=%s)", album.name, album.uuid)
        return {
            "album": album.name,
            "uuid": album.uuid,
            "folder": folder,
            "created": True,
        }

    def list_albums(self) -> list[dict]:
        """List all albums in Photos."""
        self._ensure_lib()

        return [
            {"name": a.name, "uuid": a.uuid, "count": len(a.photos())}
            for a in self._lib.albums()
        ]

    def delete_album(self, name: str) -> bool:
        """Delete an album (photos are not deleted)."""
        self._ensure_lib()

        album = self._lib.album(name)
        if not album:
            return False

        self._lib.delete_album(album)
        logger.info("Deleted album: %s", name)
        return True

    # ── Organize existing photos into albums ───────────

    def add_photos_to_album(
        self,
        photo_uuids: list[str],
        album_name: str,
        folder: str = "",
    ) -> dict:
        """Add existing Photos library photos to an album.

        This does NOT duplicate photos — it creates album references.

        Args:
            photo_uuids: List of Photos UUID strings.
            album_name: Target album name (created if missing).
            folder: Optional folder for the album.

        Returns:
            {"album": str, "added": int, "failed": int, "errors": list}
        """
        self._ensure_lib()
        import photoscript

        # Ensure album
        album_info = self.create_album(album_name, folder)
        album = self._lib.album(album_name)

        added = 0
        failed = 0
        errors = []

        # Resolve photos by UUID
        photos_to_add = []
        for uuid in photo_uuids:
            try:
                photo = photoscript.Photo(uuid)
                photos_to_add.append(photo)
            except Exception as e:
                failed += 1
                errors.append(f"{uuid}: {e}")

        if photos_to_add:
            try:
                album.add(photos_to_add)
                added = len(photos_to_add)
            except Exception as e:
                failed += len(photos_to_add)
                errors.append(f"batch add failed: {e}")

        logger.info(
            "Added %d photos to album %r (failed: %d)",
            added,
            album_name,
            failed,
        )

        return {
            "album": album_name,
            "added": added,
            "failed": failed,
            "errors": errors,
        }

    def organize_by_classification(
        self,
        results: list[dict],
        album_prefix: str = "AI 분류",
        folder: str = "",
        min_score: float = 0.0,
    ) -> dict:
        """Organize classified photos into albums by event type.

        Args:
            results: List of RankedPhoto dicts from pipeline.
            album_prefix: Prefix for album names (e.g. "AI 분류").
            folder: Optional folder for albums.
            min_score: Minimum score threshold (skip lower scored photos).

        Returns:
            {"albums_created": list, "photos_organized": int, "skipped": int}
        """
        self._ensure_lib()

        # Group by event_type
        groups: dict[str, list[str]] = {}
        skipped = 0

        for r in results:
            if r.get("total_score", 0) < min_score:
                skipped += 1
                continue

            event = r.get("event_type", "other")
            if event not in groups:
                groups[event] = []
            groups[event].append(r["photo_id"])

        # Create albums and assign photos
        albums_created = []
        total_organized = 0

        for event_type, photo_ids in groups.items():
            album_name = f"{album_prefix} - {event_type}"
            result = self.add_photos_to_album(photo_ids, album_name, folder)
            albums_created.append(album_name)
            total_organized += result["added"]

        logger.info(
            "Organized %d photos into %d albums (skipped %d)",
            total_organized,
            len(albums_created),
            skipped,
        )

        return {
            "albums_created": albums_created,
            "photos_organized": total_organized,
            "skipped": skipped,
        }

    # ── Import external photos ─────────────────────────

    def import_photos(
        self,
        photo_paths: list[str],
        album_name: str = "",
        folder: str = "",
        skip_duplicates: bool = True,
    ) -> dict:
        """Import external photos into Photos library.

        Args:
            photo_paths: List of file paths to import.
            album_name: Target album (created if missing). Empty = no album.
            folder: Optional folder for the album.
            skip_duplicates: Skip duplicate check if False.

        Returns:
            {"imported": int, "album": str, "errors": list}
        """
        self._ensure_lib()

        # Validate paths
        valid_paths = []
        errors = []
        for p in photo_paths:
            path = Path(p)
            if not path.exists():
                errors.append(f"File not found: {p}")
                continue
            if not path.is_file():
                errors.append(f"Not a file: {p}")
                continue
            valid_paths.append(str(path.resolve()))

        if not valid_paths:
            return {"imported": 0, "album": album_name, "errors": errors}

        # Import with optional album
        target_album = None
        if album_name:
            album_info = self.create_album(album_name, folder)
            target_album = self._lib.album(album_name)

        try:
            imported = self._lib.import_photos(
                valid_paths,
                album=target_album,
                skip_duplicate_check=not skip_duplicates,
            )
            count = len(imported) if imported else 0
        except Exception as e:
            errors.append(f"Import failed: {e}")
            count = 0

        logger.info(
            "Imported %d photos (album=%r, errors=%d)",
            count,
            album_name,
            len(errors),
        )

        return {
            "imported": count,
            "album": album_name,
            "errors": errors,
        }

    def import_and_classify(
        self,
        photo_paths: list[str],
        results: list[dict],
        album_prefix: str = "AI 분류",
        folder: str = "",
    ) -> dict:
        """Import external photos and organize by classification results.

        Pairs each path with its classification result by index.

        Args:
            photo_paths: External file paths to import.
            results: Classification results (same order as photo_paths).
            album_prefix: Prefix for classification albums.
            folder: Optional folder for albums.

        Returns:
            {"imported": int, "albums_created": list}
        """
        self._ensure_lib()

        # Group paths by event_type from results
        groups: dict[str, list[str]] = {}
        for path, result in zip(photo_paths, results):
            event = result.get("event_type", "other")
            if event not in groups:
                groups[event] = []
            groups[event].append(path)

        total_imported = 0
        albums_created = []

        for event_type, paths in groups.items():
            album_name = f"{album_prefix} - {event_type}"
            result = self.import_photos(paths, album_name, folder)
            total_imported += result["imported"]
            albums_created.append(album_name)

        return {
            "imported": total_imported,
            "albums_created": albums_created,
        }

    # ── Helpers ────────────────────────────────────────

    def _ensure_folder(self, folder_path: str):
        """Create folder hierarchy and return the leaf folder."""
        parts = [p.strip() for p in folder_path.split("/") if p.strip()]
        if not parts:
            return None

        self._lib.make_folders(parts)
        return self._lib.folder_by_path(parts)
