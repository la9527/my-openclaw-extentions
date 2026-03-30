"""Tests for Apple Photos source (mocked — osxphotos not required)."""

import sys
import types
from unittest.mock import MagicMock, PropertyMock

import pytest


def _make_mock_photo(
    uuid="uuid-1",
    filename="IMG_001.jpg",
    date=None,
    path="/photos/IMG_001.jpg",
    width=4000,
    height=3000,
    albums=None,
    persons=None,
    keywords=None,
    latitude=None,
    longitude=None,
):
    """Create a mock osxphotos photo object."""
    from datetime import datetime as dt

    p = MagicMock()
    p.uuid = uuid
    p.filename = filename
    p.date = date or dt(2025, 6, 15, 10, 0, 0)
    p.path = path
    p.width = width
    p.height = height
    p.latitude = latitude
    p.longitude = longitude
    p.keywords = keywords or []
    p.exif_info = MagicMock()
    p.exif_info.camera_make = "Apple"
    p.exif_info.camera_model = "iPhone 15 Pro"
    p.exif_info.focal_length = 6.86
    p.exif_info.iso = 100

    # Album info
    a_info = []
    for a in (albums or []):
        ai = MagicMock()
        ai.title = a
        a_info.append(ai)
    p.album_info = a_info

    # Person info
    p_info = []
    for name in (persons or []):
        pi = MagicMock()
        pi.name = name
        p_info.append(pi)
    p.person_info = p_info

    return p


@pytest.fixture
def mock_osxphotos():
    """Inject a mock osxphotos module into sys.modules."""
    mock_module = types.ModuleType("osxphotos")
    mock_db = MagicMock()
    mock_module.PhotosDB = MagicMock(return_value=mock_db)

    old = sys.modules.get("osxphotos")
    sys.modules["osxphotos"] = mock_module
    yield mock_db
    if old is None:
        del sys.modules["osxphotos"]
    else:
        sys.modules["osxphotos"] = old


class TestApplePhotosSource:
    def test_list_photos_basic(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(uuid="u1", filename="a.jpg"),
            _make_mock_photo(uuid="u2", filename="b.jpg"),
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        photos = src.list_photos()

        assert len(photos) == 2
        assert photos[0].id == "u1"
        assert photos[1].filename == "b.jpg"

    def test_list_photos_with_album_filter(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(uuid="u1", albums=["Family"]),
            _make_mock_photo(uuid="u2", albums=["Travel"]),
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        photos = src.list_photos(album="family")
        assert len(photos) == 1
        assert photos[0].id == "u1"

    def test_list_photos_with_person_filter(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(uuid="u1", persons=["Alice", "Bob"]),
            _make_mock_photo(uuid="u2", persons=["Charlie"]),
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        photos = src.list_photos(person="alice")
        assert len(photos) == 1
        assert photos[0].id == "u1"

    def test_list_photos_with_limit(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(uuid=f"u{i}") for i in range(10)
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        photos = src.list_photos(limit=3)
        assert len(photos) == 3

    def test_get_metadata(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(
                uuid="u1",
                filename="IMG.jpg",
                albums=["Vacation"],
                persons=["Alice"],
                keywords=["beach"],
                latitude=37.5,
                longitude=127.0,
            )
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        meta = src.get_metadata("u1")
        assert meta is not None
        assert meta.filename == "IMG.jpg"
        assert meta.camera_make == "Apple"
        assert "Alice" in meta.persons
        assert "beach" in meta.keywords
        assert meta.gps is not None
        assert meta.gps["lat"] == 37.5

    def test_get_metadata_not_found(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = []

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        meta = src.get_metadata("nonexistent")
        assert meta is None

    def test_search_photos(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(uuid="u1", filename="beach_sunset.jpg", keywords=["beach"]),
            _make_mock_photo(uuid="u2", filename="mountain.jpg"),
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        results = src.search_photos("beach")
        assert len(results) == 1
        assert results[0].id == "u1"

    def test_source_type(self, mock_osxphotos):
        mock_osxphotos.photos.return_value = [
            _make_mock_photo(uuid="u1"),
        ]

        from sources.apple_photos import ApplePhotosSource

        src = ApplePhotosSource()
        photos = src.list_photos()
        assert photos[0].source == "apple_photos"

    def test_import_error_without_osxphotos(self):
        """Verify RuntimeError when osxphotos is not installed."""
        # Temporarily ensure osxphotos is NOT in sys.modules
        old = sys.modules.pop("osxphotos", None)
        try:
            from sources.apple_photos import ApplePhotosSource

            src = ApplePhotosSource()
            with pytest.raises(RuntimeError, match="osxphotos"):
                src.list_photos()
        finally:
            if old is not None:
                sys.modules["osxphotos"] = old
