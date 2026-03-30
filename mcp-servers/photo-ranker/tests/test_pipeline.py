"""Tests for pipeline.py — 2-stage classification pipeline."""

import base64
import io

import pytest
from PIL import Image

from jobs import Job, JobStatus
from pipeline import PhotoCandidate, Pipeline, PipelineConfig


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

    @pytest.mark.asyncio
    async def test_has_gps_in_ranked(self, sample_photos):
        pipe = Pipeline()
        ranked = await pipe.run(sample_photos)
        for r in ranked:
            assert hasattr(r, "has_gps")
