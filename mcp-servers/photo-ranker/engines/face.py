"""Face detection engine with mediapipe (primary) and face-recognition (fallback)."""

from __future__ import annotations

import base64
import io
import logging
import os
import urllib.request
from pathlib import Path

import numpy as np

from models import FaceResult

logger = logging.getLogger(__name__)

_MP_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "face_detector/blaze_face_short_range/float16/1/"
    "blaze_face_short_range.tflite"
)


def _mediapipe_model_path() -> Path:
    """Return the local path for the cached BlazeFace model."""
    cache = Path.home() / ".cache" / "photo-ranker"
    cache.mkdir(parents=True, exist_ok=True)
    return cache / "blaze_face_short_range.tflite"


class FaceEngine:
    """Detects faces using mediapipe (preferred) or face-recognition."""

    def __init__(self) -> None:
        self._backend: str | None = None  # "mediapipe" | "face_recognition" | ""
        self._mp_detector = None

    def _check_available(self) -> None:
        if self._backend is not None:
            return

        # Try mediapipe first (no dlib dependency)
        try:
            import mediapipe as mp
            from mediapipe.tasks.python import BaseOptions, vision

            model_path = _mediapipe_model_path()
            if not model_path.exists():
                logger.info("Downloading BlazeFace model…")
                urllib.request.urlretrieve(_MP_MODEL_URL, model_path)

            opts = vision.FaceDetectorOptions(
                base_options=BaseOptions(model_asset_path=str(model_path)),
                min_detection_confidence=0.5,
            )
            self._mp_detector = vision.FaceDetector.create_from_options(opts)
            self._backend = "mediapipe"
            logger.info("Face detection backend: mediapipe")
            return
        except (ImportError, Exception) as exc:
            logger.debug("mediapipe not available: %s", exc)

        # Fall back to face-recognition (requires dlib)
        try:
            import face_recognition  # noqa: F401

            self._backend = "face_recognition"
            logger.info("Face detection backend: face-recognition")
            return
        except ImportError:
            pass

        self._backend = ""  # empty string = nothing available
        logger.warning(
            "No face detection backend available. "
            "Install mediapipe or face-recognition."
        )

    @property
    def is_available(self) -> bool:
        self._check_available()
        return bool(self._backend)

    def detect_faces(self, image_b64: str) -> list[FaceResult]:
        """Detect faces and return locations + embeddings."""
        self._check_available()
        if not self._backend:
            return []

        if self._backend == "mediapipe":
            return self._detect_mediapipe(image_b64)
        return self._detect_face_recognition(image_b64)

    def _detect_mediapipe(self, image_b64: str) -> list[FaceResult]:
        """Detect faces via mediapipe FaceDetector (Tasks API)."""
        import mediapipe as mp
        from PIL import Image

        try:
            img_bytes = base64.b64decode(image_b64)
            image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        except Exception:
            logger.warning("Failed to decode image for face detection")
            return []
        img_array = np.array(image)

        mp_image = mp.Image(
            image_format=mp.ImageFormat.SRGB, data=img_array
        )
        mp_result = self._mp_detector.detect(mp_image)

        if not mp_result.detections:
            return []

        results: list[FaceResult] = []
        for det in mp_result.detections:
            bb = det.bounding_box
            # Convert to (top, right, bottom, left) format
            top = bb.origin_y
            left = bb.origin_x
            bottom = bb.origin_y + bb.height
            right = bb.origin_x + bb.width
            results.append(
                FaceResult(
                    bbox=(top, right, bottom, left),
                    embedding=None,
                    expression="unknown",
                )
            )
        return results

    def _detect_face_recognition(self, image_b64: str) -> list[FaceResult]:
        """Detect faces via face-recognition (dlib)."""
        import face_recognition
        from PIL import Image

        img_bytes = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        img_array = np.array(image)

        locations = face_recognition.face_locations(img_array, model="hog")
        encodings = face_recognition.face_encodings(img_array, locations)

        results: list[FaceResult] = []
        for loc, enc in zip(locations, encodings):
            results.append(
                FaceResult(
                    bbox=loc,
                    embedding=enc.tolist(),
                    expression="unknown",
                )
            )
        return results

    def compare_faces(
        self,
        known_embeddings: list[list[float]],
        face_embedding: list[float],
        tolerance: float = 0.6,
    ) -> list[bool]:
        """Compare a face embedding against known faces."""
        if not self.is_available:
            return []
        if self._backend == "mediapipe":
            # mediapipe FaceDetection doesn't produce embeddings
            return []
        import face_recognition

        known = [np.array(e) for e in known_embeddings]
        unknown = np.array(face_embedding)
        return face_recognition.compare_faces(known, unknown, tolerance=tolerance)
