"""2-stage classification pipeline.

Stage 1 (Filter): lightweight checks (~180ms/photo)
  - technical quality (blur/exposure)
  - duplicate detection
  - face detection count

Stage 2 (VLM): heavy inference (~5s/photo)
  - scene description via VLM
  - event classification
  - final ranking
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from engines.aesthetic import score_technical_quality
from engines.dedup import DedupEngine
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


class Pipeline:
    """2-stage photo classification pipeline."""

    def __init__(self, config: PipelineConfig | None = None) -> None:
        self.config = config or PipelineConfig()
        self._dedup = DedupEngine()
        self._face = FaceEngine()

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
        """Lightweight checks: technical quality + face count."""
        cand = PhotoCandidate(photo_id=photo_id, image_b64=image_b64)

        # Technical quality
        cand.technical_score = score_technical_quality(image_b64)

        # Face detection
        faces = self._face.detect_faces(image_b64)
        cand.face_count = len(faces)
        cand.family_score = compute_family_score(faces)

        # Quality score (aesthetic defaults to 5.0 in stage1)
        qs = compute_quality_score(5.0, cand.technical_score)
        cand.quality_score = qs.total

        return cand

    async def _stage2(self, cand: PhotoCandidate) -> None:
        """Heavy VLM inference: scene description + event classification."""
        try:
            from engines.vlm import VLMEngine

            vlm = VLMEngine()
            scene = vlm.describe_scene(cand.image_b64)
            cand.scene_description = scene.scene
            cand.event_type = scene.event_type.value
            cand.event_score = compute_event_score(scene)

            # Re-score quality with real aesthetic if available
            try:
                from engines.aesthetic import AestheticEngine

                ae = AestheticEngine()
                aesthetic_raw = ae.score(cand.image_b64)
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
                h = self._dedup.compute_hash(c.image_b64)
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
                )
            )

        ranked.sort(key=lambda r: r.total_score, reverse=True)
        return ranked
