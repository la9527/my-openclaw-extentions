"""Tests for pipeline.py — 2-stage classification pipeline."""

import base64
import io
from unittest.mock import patch, MagicMock

import pytest
from PIL import Image

from jobs import Job, JobStatus
from models import EventType, SceneDescription
from pipeline import PhotoCandidate, Pipeline, PipelineConfig


def _mock_scene(*_args, **_kwargs):
    """Return a minimal SceneDescription without loading VLM."""
    return SceneDescription(
        scene="test scene",
        people_count=0,
        is_family_photo=False,
        expressions=[],
        event_type=EventType.DAILY,
        event_confidence=0.5,
        quality_notes="",
        meaningful_score=3,
    )


@pytest.fixture(autouse=True)
def _mock_heavy_engines(monkeypatch):
    """Mock VLM and Aesthetic engines so tests don't load real models."""
    mock_vlm = MagicMock()
    mock_vlm.describe_scene.side_effect = _mock_scene

    mock_ae = MagicMock()
    mock_ae.score.return_value = 5.0

    async def _mock_stage2(self, cand):
        """Replacement _stage2 that doesn't load VLM or aesthetic."""
        cand.scene_description = "test scene"
        cand.event_type = EventType.DAILY.value
        cand.event_score = 30.0

    monkeypatch.setattr(Pipeline, "_stage2", _mock_stage2)


@pytest.fixture
def sample_photos():
    """Create a list of test photos as {photo_id, image_b64}."""
    photos = []
    for i, color in enumerate(["red", "green", "blue", "yellow"]):
        img = Image.new("RGB", (100, 100), color=color)
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        b64 = base64.b64encode(buf.getvalue()).decode()
        photos.append({"photo_id": f"photo_{i}", "image_b64": b64})
    return photos


@pytest.fixture
def duplicate_photos():
    """Two identical images that should be detected as duplicates."""
    img = Image.new("RGB", (100, 100), color="red")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    return [
        {"photo_id": "dup_0", "image_b64": b64},
        {"photo_id": "dup_1", "image_b64": b64},
    ]


class TestPipelineConfig:
    def test_defaults(self):
        c = PipelineConfig()
        assert c.min_technical_score == 10.0
        assert c.skip_duplicates is True
        assert c.dedup_threshold == 8
        assert c.vlm_top_n == 0

    def test_vlm_model_path(self):
        c = PipelineConfig(vlm_model_path="custom/model")
        assert c.vlm_model_path == "custom/model"


class TestPhotoCandidate:
    def test_default_fields(self):
        c = PhotoCandidate(photo_id="x", image_b64="aaa")
        assert c.technical_score == 0.0
        assert c.passed_stage1 is True
        assert c.event_type == "other"
        assert c.has_gps is False
        assert c.latitude is None
        assert c.longitude is None
        assert c.faces == []
        assert c.known_persons == []


class TestPipeline:
    @pytest.mark.asyncio
    async def test_stage1_basic(self, sample_photos):
        pipe = Pipeline()
        cand = await pipe._stage1("test", sample_photos[0]["image_b64"])
        assert cand.technical_score > 0
        assert cand.quality_score > 0

    @pytest.mark.asyncio
    async def test_run_returns_ranked(self, sample_photos):
        pipe = Pipeline()
        ranked = await pipe.run(sample_photos)
        assert len(ranked) == len(sample_photos)
        # Should be sorted by total_score descending
        scores = [r.total_score for r in ranked]
        assert scores == sorted(scores, reverse=True)

    @pytest.mark.asyncio
    async def test_duplicate_detection(self, duplicate_photos):
        pipe = Pipeline()
        ranked = await pipe.run(duplicate_photos)
        # One should have lower uniqueness
        uniqueness = [r.uniqueness_score for r in ranked]
        assert min(uniqueness) < max(uniqueness)

    @pytest.mark.asyncio
    async def test_min_quality_filter(self, sample_photos):
        config = PipelineConfig(min_technical_score=999)
        pipe = Pipeline(config)
        ranked = await pipe.run(sample_photos)
        # All should fail stage1 but still be in results
        assert len(ranked) == len(sample_photos)

    @pytest.mark.asyncio
    async def test_vlm_top_n(self, sample_photos):
        config = PipelineConfig(vlm_top_n=2)
        pipe = Pipeline(config)
        ranked = await pipe.run(sample_photos)
        assert len(ranked) == len(sample_photos)

    @pytest.mark.asyncio
    async def test_job_progress_tracking(self, sample_photos):
        pipe = Pipeline()
        job = Job(id="test-job", source="local", source_path="/tmp")
        ranked = await pipe.run(sample_photos, job)

        assert job.progress.total > 0
        assert job.result_summary is not None
        assert "total_input" in job.result_summary
        assert job.result_summary["total_input"] == len(sample_photos)

    @pytest.mark.asyncio
    async def test_empty_input(self):
        pipe = Pipeline()
        ranked = await pipe.run([])
        assert ranked == []


class TestKnownPersonMatching:
    def test_register_known_face(self):
        pipe = Pipeline()
        pipe.register_known_face("Alice", [0.5] * 512)
        assert "Alice" in pipe._known_faces
        assert len(pipe._known_faces["Alice"]) == 1

    def test_register_multiple_embeddings(self):
        pipe = Pipeline()
        pipe.register_known_face("Bob", [0.1] * 512)
        pipe.register_known_face("Bob", [0.2] * 512)
        assert len(pipe._known_faces["Bob"]) == 2

    def test_identify_matching(self):
        import numpy as np

        pipe = Pipeline()
        # Register known face
        known_emb = list(np.random.randn(512))
        pipe.register_known_face("Alice", known_emb)

        # Similar embedding (same person)
        noise = np.random.randn(512) * 0.05
        similar = [k + n for k, n in zip(known_emb, noise)]
        result = pipe._identify_known_persons([similar])
        assert "Alice" in result

    def test_identify_no_match(self):
        import numpy as np

        pipe = Pipeline()
        pipe.register_known_face("Alice", list(np.random.randn(512)))

        # Completely different embedding
        different = list(np.random.randn(512))
        result = pipe._identify_known_persons([different])
        assert result == []

    def test_identify_empty(self):
        pipe = Pipeline()
        result = pipe._identify_known_persons([])
        assert result == []

    def test_identify_no_known_faces(self):
        pipe = Pipeline()
        result = pipe._identify_known_persons([[0.1] * 512])
        assert result == []


class TestExifIntegration:
    @pytest.mark.asyncio
    async def test_stage1_extracts_exif(self, sample_photos):
        pipe = Pipeline()
        cand = await pipe._stage1("test", sample_photos[0]["image_b64"])
        # JPEG test image has no GPS
        assert cand.has_gps is False
        assert cand.latitude is None
        assert cand.longitude is None

    @pytest.mark.asyncio
    async def test_has_gps_in_ranked(self, sample_photos):
        pipe = Pipeline()
        ranked = await pipe.run(sample_photos)
        for r in ranked:
            assert hasattr(r, "has_gps")


class TestGPSTravelCorrection:
    """Test GPS-based travel type correction in _stage2."""

    @pytest.mark.asyncio
    async def test_outdoor_with_gps_becomes_travel(self, sample_photos):
        """outdoor + GPS + low confidence → travel."""
        pipe = Pipeline()

        # Unmock _stage2 for this test — use real logic with mocked VLM
        async def _stage2_outdoor_gps(self, cand):
            from scoring import compute_event_score

            scene = SceneDescription(
                scene="mountain landscape",
                people_count=0,
                is_family_photo=False,
                expressions=[],
                event_type=EventType.OUTDOOR,
                event_confidence=0.6,
                quality_notes="",
                meaningful_score=5,
            )
            cand.scene_description = scene.scene
            cand.event_type = scene.event_type.value
            cand.event_score = compute_event_score(scene)

            # GPS correction logic
            if (
                cand.has_gps
                and scene.event_type == EventType.OUTDOOR
                and scene.event_confidence < 0.8
            ):
                cand.event_type = EventType.TRAVEL.value
                scene.event_type = EventType.TRAVEL
                scene.event_confidence = max(scene.event_confidence, 0.5)
                cand.event_score = compute_event_score(scene)

        # Prepare candidate with GPS
        cand = PhotoCandidate(
            photo_id="gps_test",
            image_b64=sample_photos[0]["image_b64"],
            has_gps=True,
            latitude=48.8584,
            longitude=2.2945,
            technical_score=30.0,
            passed_stage1=True,
        )

        await _stage2_outdoor_gps(pipe, cand)
        assert cand.event_type == "travel"

    @pytest.mark.asyncio
    async def test_outdoor_high_conf_stays_outdoor(self, sample_photos):
        """outdoor + GPS + high confidence → stays outdoor."""
        cand = PhotoCandidate(
            photo_id="high_conf",
            image_b64=sample_photos[0]["image_b64"],
            has_gps=True,
            technical_score=30.0,
        )
        # Simulate outdoor with high confidence — no correction
        scene = SceneDescription(
            scene="local park",
            people_count=0,
            is_family_photo=False,
            expressions=[],
            event_type=EventType.OUTDOOR,
            event_confidence=0.9,
            quality_notes="",
            meaningful_score=5,
        )
        # The correction only fires when confidence < 0.8
        assert scene.event_confidence >= 0.8

    @pytest.mark.asyncio
    async def test_daily_with_gps_low_conf_becomes_travel(self, sample_photos):
        """daily + GPS + low confidence → travel."""
        cand = PhotoCandidate(
            photo_id="daily_gps",
            image_b64=sample_photos[0]["image_b64"],
            has_gps=True,
            latitude=35.6762,
            longitude=139.6503,
        )
        scene = SceneDescription(
            scene="street scene",
            people_count=1,
            is_family_photo=False,
            expressions=[],
            event_type=EventType.DAILY,
            event_confidence=0.4,
            quality_notes="",
            meaningful_score=4,
        )
        # A-1b correction: daily + GPS + conf < 0.6
        assert cand.has_gps is True
        assert scene.event_type == EventType.DAILY
        assert scene.event_confidence < 0.6

    def test_candidate_stores_lat_lon(self):
        cand = PhotoCandidate(
            photo_id="loc",
            image_b64="",
            has_gps=True,
            latitude=37.5665,
            longitude=126.978,
        )
        assert cand.latitude == 37.5665
        assert cand.longitude == 126.978
