"""Composite scoring for photo ranking."""

from __future__ import annotations

from models import (
    DuplicateGroup,
    EventType,
    FaceResult,
    QualityScore,
    RankedPhoto,
    SceneDescription,
)

# Weight configuration
# Retuned 2026-03-30: quality now has better spread (5-component technical
# + sigmoid aesthetic), and face detection fires more reliably (upscale retry
# + lower confidence), so shift weight from family→quality.
WEIGHT_QUALITY = 0.30
WEIGHT_FAMILY = 0.25
WEIGHT_EVENT = 0.25
WEIGHT_UNIQUENESS = 0.20

EVENT_WEIGHTS: dict[EventType, float] = {
    EventType.BIRTHDAY: 90,
    EventType.GRADUATION: 90,
    EventType.TRAVEL: 80,
    EventType.CELEBRATION: 75,
    EventType.OUTDOOR: 60,
    EventType.MEAL: 60,
    EventType.PORTRAIT: 50,
    EventType.DAILY: 30,
    EventType.OTHER: 20,
}


def compute_quality_score(
    aesthetic_raw: float,
    technical_raw: float,
) -> QualityScore:
    """Compute quality score from aesthetic (0-10) and technical (0-50) raw scores.

    aesthetic_raw: LAION score 0-10 → mapped to 0-50 with sigmoid spread
    technical_raw: blur/exposure/noise/resolution/color 0-50
    """
    import math

    # Sigmoid-based mapping to expand differences in the 3-7 range
    # where most LAION scores cluster. Steepness=1.2, center=5.0.
    sigmoid = 1.0 / (1.0 + math.exp(-1.2 * (aesthetic_raw - 5.0)))
    aesthetic_mapped = sigmoid * 50.0

    total = aesthetic_mapped + technical_raw
    return QualityScore(
        photo_id=None,
        aesthetic_score=round(aesthetic_mapped, 2),
        technical_score=round(technical_raw, 2),
        total=round(total, 2),
    )


def compute_family_score(
    faces: list[FaceResult],
    known_person_names: list[str] | None = None,
) -> float:
    """Compute family score 0-100 based on face information."""
    if not faces:
        return 0.0

    score = 0.0

    # face count bonus
    if len(faces) >= 2:
        score += 20.0

    # known person bonus: +25 per known person (max 100 total)
    if known_person_names:
        score += min(100.0, len(known_person_names) * 25.0)

    # expression bonus (placeholder — face engine currently returns "unknown")
    happy_count = sum(1 for f in faces if f.expression == "happy")
    score += happy_count * 10.0

    return min(100.0, score)


def compute_event_score(scene: SceneDescription) -> float:
    """Compute event score 0-100 based on scene classification."""
    base = EVENT_WEIGHTS.get(scene.event_type, 20.0)
    confidence_factor = max(0.3, scene.event_confidence)
    return round(base * confidence_factor, 2)


def compute_uniqueness_score(
    photo_id: str,
    duplicate_groups: list[DuplicateGroup],
) -> float:
    """Compute uniqueness score 0-100.

    Representative photo in a group gets 100.
    Non-representative duplicates get a penalty.
    Photos not in any group get 100.
    """
    for group in duplicate_groups:
        if photo_id in group.photo_ids:
            if photo_id == group.representative_id:
                return 100.0
            else:
                idx = group.photo_ids.index(photo_id)
                penalty = min(30.0, idx * 15.0)
                return max(0.0, 100.0 - penalty)
    return 100.0


def rank_photos(
    photo_scores: list[dict],
    top_n: int | None = None,
) -> list[RankedPhoto]:
    """Aggregate sub-scores and produce ranked results.

    Each dict in photo_scores should contain:
      - photo_id: str
      - quality_score: float (0-100)
      - family_score: float (0-100)
      - event_score: float (0-100)
      - uniqueness_score: float (0-100)
      - scene_description: str
      - event_type: str
      - faces_detected: int
      - known_persons: list[str]
    """
    ranked = []
    for ps in photo_scores:
        total = (
            ps["quality_score"] * WEIGHT_QUALITY
            + ps["family_score"] * WEIGHT_FAMILY
            + ps["event_score"] * WEIGHT_EVENT
            + ps["uniqueness_score"] * WEIGHT_UNIQUENESS
        )
        ranked.append(
            RankedPhoto(
                photo_id=ps["photo_id"],
                total_score=round(total, 2),
                quality_score=round(ps["quality_score"], 2),
                family_score=round(ps["family_score"], 2),
                event_score=round(ps["event_score"], 2),
                uniqueness_score=round(ps["uniqueness_score"], 2),
                scene_description=ps.get("scene_description", ""),
                event_type=ps.get("event_type", "other"),
                faces_detected=ps.get("faces_detected", 0),
                known_persons=ps.get("known_persons", []),
            )
        )

    ranked.sort(key=lambda r: r.total_score, reverse=True)

    if top_n is not None:
        ranked = ranked[:top_n]

    return ranked
