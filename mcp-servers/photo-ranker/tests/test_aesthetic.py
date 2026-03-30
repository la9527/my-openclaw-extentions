"""Tests for aesthetic engine (technical quality scoring only — CLIP needs open_clip)."""

from engines.aesthetic import score_technical_quality


class TestScoreTechnicalQuality:
    def test_returns_float(self, sample_photo_b64):
        score = score_technical_quality(sample_photo_b64)
        assert isinstance(score, float)

    def test_range_0_to_50(self, sample_photo_b64):
        score = score_technical_quality(sample_photo_b64)
        assert 0.0 <= score <= 50.0

    def test_red_pixel(self, red_pixel_b64):
        score = score_technical_quality(red_pixel_b64)
        assert isinstance(score, float)
        assert 0.0 <= score <= 50.0


class TestAestheticEngineInit:
    def test_not_loaded_by_default(self):
        from engines.aesthetic import AestheticEngine

        engine = AestheticEngine()
        assert not engine.is_loaded

    def test_unload(self):
        from engines.aesthetic import AestheticEngine

        engine = AestheticEngine()
        engine._clip_model = "fake"
        engine.unload()
        assert not engine.is_loaded
