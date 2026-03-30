"""Tests for scoring module."""

from models import DuplicateGroup, EventType, FaceResult, SceneDescription
from scoring import (
    WEIGHT_EVENT,
    WEIGHT_FAMILY,
    WEIGHT_QUALITY,
    WEIGHT_UNIQUENESS,
    compute_event_score,
    compute_family_score,
    compute_quality_score,
    compute_uniqueness_score,
    rank_photos,
)


class TestComputeQualityScore:
    def test_perfect_scores(self):
        qs = compute_quality_score(aesthetic_raw=10.0, technical_raw=50.0)
        assert qs.total == 100.0
        assert qs.aesthetic_score == 50.0
        assert qs.technical_score == 50.0

    def test_zero_scores(self):
        qs = compute_quality_score(aesthetic_raw=0.0, technical_raw=0.0)
        assert qs.total == 0.0

    def test_midrange(self):
        qs = compute_quality_score(aesthetic_raw=5.0, technical_raw=25.0)
        assert qs.total == 50.0

    def test_photo_id_is_none(self):
        qs = compute_quality_score(0, 0)
        assert qs.photo_id is None


class TestComputeFamilyScore:
    def test_no_faces(self):
        assert compute_family_score([]) == 0.0

    def test_single_face(self):
        faces = [FaceResult(bbox=(0, 0, 0, 0))]
        score = compute_family_score(faces)
        assert score == 0.0  # 1 face, no known, no group bonus

    def test_two_faces_with_known(self):
        faces = [
            FaceResult(bbox=(0, 0, 0, 0)),
            FaceResult(bbox=(0, 0, 0, 0)),
        ]
        score = compute_family_score(faces, ["Alice", "Bob"])
        # 20 (2+ faces) + 50 (2 known * 25) = 70
        assert score == 70.0

    def test_cap_at_100(self):
        faces = [FaceResult(bbox=(0, 0, 0, 0))] * 5
        score = compute_family_score(faces, ["A", "B", "C", "D", "E"])
        assert score == 100.0

    def test_happy_expression_bonus(self):
        faces = [FaceResult(bbox=(0, 0, 0, 0), expression="happy")]
        score = compute_family_score(faces)
        assert score == 10.0


class TestComputeEventScore:
    def test_birthday_high_confidence(self):
        scene = SceneDescription(
            scene="",
            people_count=0,
            is_family_photo=False,
            expressions=[],
            event_type=EventType.BIRTHDAY,
            event_confidence=1.0,
            quality_notes="",
            meaningful_score=5,
        )
        assert compute_event_score(scene) == 90.0

    def test_daily_low_confidence(self):
        scene = SceneDescription(
            scene="",
            people_count=0,
            is_family_photo=False,
            expressions=[],
            event_type=EventType.DAILY,
            event_confidence=0.3,
            quality_notes="",
            meaningful_score=5,
        )
        assert compute_event_score(scene) == 9.0  # 30 * 0.3

    def test_minimum_confidence_floor(self):
        scene = SceneDescription(
            scene="",
            people_count=0,
            is_family_photo=False,
            expressions=[],
            event_type=EventType.TRAVEL,
            event_confidence=0.0,
            quality_notes="",
            meaningful_score=5,
        )
        # confidence floored to 0.3
        assert compute_event_score(scene) == 24.0  # 80 * 0.3


class TestComputeUniquenessScore:
    def test_not_in_any_group(self):
        assert compute_uniqueness_score("p1", []) == 100.0

    def test_representative_gets_100(self):
        groups = [
            DuplicateGroup(
                group_id="g1",
                photo_ids=["p1", "p2"],
                representative_id="p1",
            )
        ]
        assert compute_uniqueness_score("p1", groups) == 100.0

    def test_duplicate_gets_penalty(self):
        groups = [
            DuplicateGroup(
                group_id="g1",
                photo_ids=["p1", "p2", "p3"],
                representative_id="p1",
            )
        ]
        assert compute_uniqueness_score("p2", groups) == 85.0  # 100 - 15
        assert compute_uniqueness_score("p3", groups) == 70.0  # 100 - 30


class TestRankPhotos:
    def _make_score(self, pid: str, **overrides) -> dict:
        defaults = {
            "photo_id": pid,
            "quality_score": 50.0,
            "family_score": 50.0,
            "event_score": 50.0,
            "uniqueness_score": 100.0,
            "scene_description": "",
            "event_type": "daily",
            "faces_detected": 0,
            "known_persons": [],
        }
        defaults.update(overrides)
        return defaults

    def test_ranking_order(self):
        scores = [
            self._make_score("low", quality_score=10.0),
            self._make_score("high", quality_score=90.0),
            self._make_score("mid", quality_score=50.0),
        ]
        ranked = rank_photos(scores)
        assert ranked[0].photo_id == "high"
        assert ranked[-1].photo_id == "low"

    def test_top_n(self):
        scores = [self._make_score(f"p{i}") for i in range(20)]
        ranked = rank_photos(scores, top_n=5)
        assert len(ranked) == 5

    def test_weight_sum(self):
        total = WEIGHT_QUALITY + WEIGHT_FAMILY + WEIGHT_EVENT + WEIGHT_UNIQUENESS
        assert total == 1.0

    def test_total_score_calculation(self):
        scores = [
            self._make_score(
                "p1",
                quality_score=100.0,
                family_score=100.0,
                event_score=100.0,
                uniqueness_score=100.0,
            )
        ]
        ranked = rank_photos(scores)
        assert ranked[0].total_score == 100.0

    def test_zero_scores(self):
        scores = [
            self._make_score(
                "p1",
                quality_score=0.0,
                family_score=0.0,
                event_score=0.0,
                uniqueness_score=0.0,
            )
        ]
        ranked = rank_photos(scores)
        assert ranked[0].total_score == 0.0
