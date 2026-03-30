"""2-stage classification pipeline.

Stage 1 (Filter): lightweight checks (~180ms/photo)
  - EXIF metadata extraction + orientation correction
  - technical quality (blur/exposure)
  - duplicate detection
  - face detection + known person matching

Stage 2 (VLM): heavy inference (~5s/photo)
  - scene description via VLM
  - event classification (with EXIF GPS correction)
  - final ranking
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

import db as db_module
from engines.aesthetic import score_technical_quality
from engines.dedup import DedupEngine
from engines.exif import ExifEngine
from engines.face import FaceEngine
from jobs import Job, JobProgress
from models import DuplicateGroup, EventType, QualityScore, RankedPhoto
from scoring import (
    WEIGHT_EVENT,
    WEIGHT_FAMILY,
    WEIGHT_QUALITY,
    WEIGHT_UNIQUENESS,
    compute_event_score,
    compute_family_score,
    compute_quality_score,
    compute_uniqueness_score,
)

logger = logging.getLogger(__name__)


@dataclass
class PhotoCandidate:
    """Intermediate representation between stages."""

    photo_id: str
    image_b64: str
    technical_score: float = 0.0
    face_count: int = 0
    is_duplicate: bool = False
    quality_score: float = 0.0
    family_score: float = 0.0
    event_score: float = 0.0
    uniqueness_score: float = 0.0
    scene_description: str = ""
    event_type: str = EventType.OTHER.value
    known_persons: list[str] = field(default_factory=list)
    passed_stage1: bool = True
    has_gps: bool = False
    latitude: float | None = None
    longitude: float | None = None
    faces: list = field(default_factory=list)  # FaceResult list from stage1


@dataclass
class PipelineConfig:
    """Tunable thresholds for the 2-stage pipeline."""

    # Stage 1: minimum technical score (0-50) to pass to Stage 2
    min_technical_score: float = 10.0
    # Stage 1: skip confirmed duplicates in Stage 2
    skip_duplicates: bool = True
    # Duplicate detection Hamming threshold
    dedup_threshold: int = 8
    # Stage 2: top-N to run VLM on (0 = all that pass Stage 1)
    vlm_top_n: int = 0
    # VLM model path (empty = use default)
    vlm_model_path: str = ""


class Pipeline:
    """2-stage photo classification pipeline."""

    def __init__(
        self,
        config: PipelineConfig | None = None,
        db: "db_module.JobDB | None" = None,
    ) -> None:
        self.config = config or PipelineConfig()
        self._dedup = DedupEngine()
        self._face = FaceEngine()
        self._exif = ExifEngine()
        self._db = db  # Optional DB for face embedding caching
        self._vlm = None  # Lazy-initialized VLMEngine (reused across stage2 calls)
        self._aesthetic = None  # Lazy-initialized AestheticEngine
        # Known face embeddings: name -> list of embeddings
        self._known_faces: dict[str, list[list[float]]] = {}

    def register_known_face(self, name: str, embedding: list[float]) -> None:
        """Register a known person's face embedding for family scoring."""
        if name not in self._known_faces:
            self._known_faces[name] = []
        self._known_faces[name].append(embedding)

    def _identify_known_persons(
        self, face_embeddings: list[list[float] | None],
    ) -> list[str]:
        """Match detected face embeddings against registered known faces."""
        if not self._known_faces or not face_embeddings:
            return []

        import numpy as np

        matched_names: list[str] = []
        for emb in face_embeddings:
            if emb is None:
                continue
            emb_arr = np.array(emb)
            best_name = None
            best_sim = 0.0

            for name, known_embs in self._known_faces.items():
                for known_emb in known_embs:
                    known_arr = np.array(known_emb)
                    # Cosine similarity
                    dot = np.dot(emb_arr, known_arr)
                    norm = np.linalg.norm(emb_arr) * np.linalg.norm(known_arr)
                    if norm > 0:
                        sim = dot / norm
                        if sim > best_sim:
                            best_sim = sim
                            best_name = name

            # Threshold: cosine > 0.4 for same person
            if best_name and best_sim > 0.4:
                if best_name not in matched_names:
                    matched_names.append(best_name)

        return matched_names

    async def run(
        self,
        photos: list[dict],
        job: Job | None = None,
    ) -> list[RankedPhoto]:
        """Run full 2-stage pipeline.

        Args:
            photos: list of {"photo_id": str, "image_b64": str}
            job: optional Job for progress tracking

        Returns:
            Ranked list of photos.
        """
        if job:
            job.progress = JobProgress(total=len(photos), stage="filter")

        # ── Stage 1: Filter ──
        candidates = []
        for i, p in enumerate(photos):
            cand = await self._stage1(p["photo_id"], p["image_b64"])
            candidates.append(cand)
            if job:
                job.progress.completed = i + 1
                job.progress.current_file = p["photo_id"]

        # Duplicate detection across all
        dup_groups = self._detect_duplicates(candidates)

        # Mark duplicates
        dup_photo_ids = set()
        for g in dup_groups:
            for pid in g.photo_ids:
                if pid != g.representative_id:
                    dup_photo_ids.add(pid)

        for c in candidates:
            if c.photo_id in dup_photo_ids:
                c.is_duplicate = True
                c.passed_stage1 = False
            if c.technical_score < self.config.min_technical_score:
                c.passed_stage1 = False

        # Compute uniqueness for all
        for c in candidates:
            c.uniqueness_score = compute_uniqueness_score(c.photo_id, dup_groups)

        # ── Stage 2: VLM (only for candidates that passed) ──
        stage2_candidates = [c for c in candidates if c.passed_stage1]
        if self.config.vlm_top_n > 0:
            stage2_candidates = sorted(
                stage2_candidates,
                key=lambda c: c.technical_score,
                reverse=True,
            )[: self.config.vlm_top_n]

        if job:
            job.progress.stage = "vlm"
            job.progress.completed = 0
            job.progress.total = len(stage2_candidates)

        for i, cand in enumerate(stage2_candidates):
            await self._stage2(cand)
            if job:
                job.progress.completed = i + 1
                job.progress.current_file = cand.photo_id

        # ── Rank results ──
        ranked = self._rank(candidates, dup_groups)

        if job:
            job.result_summary = {
                "total_input": len(photos),
                "passed_stage1": len(stage2_candidates),
                "duplicates_found": len(dup_photo_ids),
                "ranked_count": len(ranked),
            }

        return ranked

    async def _stage1(self, photo_id: str, image_b64: str) -> PhotoCandidate:
        """Lightweight checks: EXIF, orientation, technical quality, face count.

        Runs EXIF/technical/face tasks concurrently for speed.
        """
        cand = PhotoCandidate(photo_id=photo_id, image_b64=image_b64)

        # EXIF extraction + orientation correction
        exif_data = self._exif.extract(image_b64)
        cand.has_gps = exif_data.has_gps
        cand.latitude = exif_data.latitude
        cand.longitude = exif_data.longitude
        if exif_data.orientation != 1:
            corrected = self._exif.correct_orientation(image_b64)
            cand.image_b64 = corrected

        # Run technical quality and face detection concurrently
        loop = asyncio.get_event_loop()

        async def _technical() -> float:
            return await loop.run_in_executor(
                None, score_technical_quality, cand.image_b64
            )

        async def _face_detect() -> tuple:
            faces = await loop.run_in_executor(
                None, self._face.detect_faces, cand.image_b64
            )
            return faces

        tech_score, faces = await asyncio.gather(_technical(), _face_detect())

        cand.technical_score = tech_score
        cand.face_count = len(faces)
        cand.faces = list(faces)

        # Cache face embeddings in DB for later registration
        if self._db and faces:
            for i, f in enumerate(faces):
                if f.embedding:
                    self._db.save_face_embedding(
                        photo_id, i, f.embedding,
                        gender=f.gender, age=f.age, expression=f.expression,
                    )

        # Known person matching
        embeddings = [f.embedding for f in faces]
        cand.known_persons = self._identify_known_persons(embeddings)
        cand.family_score = compute_family_score(faces, cand.known_persons or None)

        # Quality score (aesthetic defaults to 5.0 in stage1)
        qs = compute_quality_score(5.0, cand.technical_score)
        cand.quality_score = qs.total

        return cand

    async def _stage2(self, cand: PhotoCandidate) -> None:
        """Heavy VLM inference: scene description + event classification."""
        try:
            from engines.vlm import VLMEngine

            if self._vlm is None:
                model_path = self.config.vlm_model_path or None
                self._vlm = VLMEngine(model_path) if model_path else VLMEngine()
            scene = self._vlm.describe_scene(cand.image_b64)
            cand.scene_description = scene.scene
            cand.event_type = scene.event_type.value
            cand.event_score = compute_event_score(scene)

            # A-1: GPS travel correction — if VLM says outdoor but EXIF has GPS,
            # boost toward travel (tourists usually have GPS-tagged photos)
            if (
                cand.has_gps
                and scene.event_type == EventType.OUTDOOR
                and scene.event_confidence < 0.8
            ):
                cand.event_type = EventType.TRAVEL.value
                scene.event_type = EventType.TRAVEL
                scene.event_confidence = max(scene.event_confidence, 0.5)
                cand.event_score = compute_event_score(scene)
                logger.info(
                    "GPS correction: %s outdoor→travel (GPS present, conf=%.2f)",
                    cand.photo_id,
                    scene.event_confidence,
                )

            # A-1b: GPS travel correction for daily/portrait with low confidence
            # — tourist selfies or casual shots at travel destinations
            if (
                cand.has_gps
                and scene.event_type in (EventType.DAILY, EventType.PORTRAIT)
                and scene.event_confidence < 0.6
            ):
                cand.event_type = EventType.TRAVEL.value
                scene.event_type = EventType.TRAVEL
                scene.event_confidence = max(scene.event_confidence, 0.4)
                cand.event_score = compute_event_score(scene)
                logger.info(
                    "GPS correction: %s %s→travel (GPS present, low conf=%.2f)",
                    cand.photo_id,
                    scene.event_type.value,
                    scene.event_confidence,
                )

            # B-2: Apply VLM expressions to detected faces for scoring
            if scene.expressions and cand.faces:
                # Map expressions to faces: handle count mismatch
                expr_list = [e.lower() for e in scene.expressions]
                for i, face in enumerate(cand.faces):
                    if i < len(expr_list):
                        face.expression = expr_list[i]
                    elif expr_list:
                        # More faces than expressions: apply majority expression
                        face.expression = max(set(expr_list), key=expr_list.count)
                # Recompute family score with expression data
                cand.family_score = compute_family_score(
                    cand.faces, cand.known_persons or None
                )
            elif scene.expressions and not cand.faces and scene.people_count > 0:
                # VLM saw people but face engine didn't — still use expression info
                # as a small family_score boost if positive expressions present
                positive = {"happy", "smiling", "laughing", "joyful", "excited"}
                pos_count = sum(
                    1 for e in scene.expressions if e.lower() in positive
                )
                if pos_count > 0:
                    cand.family_score = min(100.0, cand.family_score + pos_count * 5.0)

            # Re-score quality with real aesthetic if available
            try:
                from engines.aesthetic import AestheticEngine

                if self._aesthetic is None:
                    self._aesthetic = AestheticEngine()
                aesthetic_raw = self._aesthetic.score(cand.image_b64)
                qs = compute_quality_score(aesthetic_raw, cand.technical_score)
                cand.quality_score = qs.total
            except RuntimeError:
                pass

        except RuntimeError as e:
            logger.warning("VLM not available for %s: %s", cand.photo_id, e)

    def _detect_duplicates(
        self, candidates: list[PhotoCandidate]
    ) -> list[DuplicateGroup]:
        """Run dedup across all candidates by computing hashes first."""
        photo_hashes: dict[str, str] = {}
        for c in candidates:
            try:
                h = self._dedup.compute_default_hash(c.image_b64)
                photo_hashes[c.photo_id] = h
            except Exception as e:
                logger.warning("Hash failed for %s: %s", c.photo_id, e)
        return self._dedup.find_duplicates(
            photo_hashes, threshold=self.config.dedup_threshold
        )

    def _rank(
        self,
        candidates: list[PhotoCandidate],
        dup_groups: list[DuplicateGroup],
    ) -> list[RankedPhoto]:
        """Aggregate scores and rank."""
        ranked = []
        for c in candidates:
            total = (
                c.quality_score * WEIGHT_QUALITY
                + c.family_score * WEIGHT_FAMILY
                + c.event_score * WEIGHT_EVENT
                + c.uniqueness_score * WEIGHT_UNIQUENESS
            )
            ranked.append(
                RankedPhoto(
                    photo_id=c.photo_id,
                    total_score=round(total, 2),
                    quality_score=round(c.quality_score, 2),
                    family_score=round(c.family_score, 2),
                    event_score=round(c.event_score, 2),
                    uniqueness_score=round(c.uniqueness_score, 2),
                    scene_description=c.scene_description,
                    event_type=c.event_type,
                    faces_detected=c.face_count,
                    known_persons=c.known_persons,
                    has_gps=c.has_gps,
                )
            )

        ranked.sort(key=lambda r: r.total_score, reverse=True)
        return ranked
