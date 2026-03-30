"""Tests for db.py — SQLite persistence."""

import pytest

from db import JobDB
from jobs import Job, JobProgress, JobStatus


@pytest.fixture
def db(tmp_path):
    """Create a temporary JobDB instance."""
    db_path = tmp_path / "test_jobs.db"
    instance = JobDB(db_path)
    yield instance
    instance.close()


class TestJobDB:
    def test_save_and_load_job(self, db):
        job = Job(id="t1", source="local", source_path="/photos")
        db.save_job(job)

        loaded = db.load_job("t1")
        assert loaded is not None
        assert loaded.id == "t1"
        assert loaded.source == "local"
        assert loaded.status == JobStatus.PENDING

    def test_load_nonexistent(self, db):
        assert db.load_job("fake") is None

    def test_update_job(self, db):
        job = Job(id="t2", source="gcs", source_path="bucket")
        db.save_job(job)

        job.status = JobStatus.COMPLETED
        job.result_summary = {"count": 5}
        db.save_job(job)

        loaded = db.load_job("t2")
        assert loaded.status == JobStatus.COMPLETED
        assert loaded.result_summary == {"count": 5}

    def test_list_jobs(self, db):
        j1 = Job(id="a", source="local", source_path="/a")
        j2 = Job(id="b", source="local", source_path="/b")
        j2.status = JobStatus.COMPLETED
        db.save_job(j1)
        db.save_job(j2)

        all_jobs = db.list_jobs()
        assert len(all_jobs) == 2

        pending = db.list_jobs(status="pending")
        assert len(pending) == 1
        assert pending[0].id == "a"

    def test_save_and_load_photo_results(self, db):
        results = [
            {
                "photo_id": "p1",
                "total_score": 85.0,
                "quality_score": 70.0,
                "family_score": 90.0,
                "event_score": 80.0,
                "uniqueness_score": 100.0,
                "scene_description": "Birthday party",
                "event_type": "birthday",
                "faces_detected": 3,
                "known_persons": ["Alice", "Bob"],
            },
            {
                "photo_id": "p2",
                "total_score": 60.0,
                "quality_score": 55.0,
                "family_score": 40.0,
                "event_score": 70.0,
                "uniqueness_score": 75.0,
                "scene_description": "Outdoor",
                "event_type": "outdoor",
                "faces_detected": 0,
                "known_persons": [],
            },
        ]
        db.save_photo_results("job1", results)

        loaded = db.load_photo_results("job1")
        assert len(loaded) == 2
        assert loaded[0]["total_score"] == 85.0
        assert loaded[0]["known_persons"] == ["Alice", "Bob"]

    def test_load_empty_results(self, db):
        results = db.load_photo_results("nonexistent")
        assert results == []

    def test_progress_persistence(self, db):
        job = Job(
            id="t3",
            source="local",
            source_path="/tmp",
            progress=JobProgress(
                total=100, completed=42, stage="vlm", current_file="x.jpg"
            ),
        )
        db.save_job(job)
        loaded = db.load_job("t3")
        assert loaded.progress.total == 100
        assert loaded.progress.completed == 42
        assert loaded.progress.stage == "vlm"
