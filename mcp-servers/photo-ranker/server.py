"""photo-ranker MCP server — scene description, quality scoring, and ranking."""

from __future__ import annotations

import json
import logging

from mcp.server.fastmcp import FastMCP

from engines.aesthetic import AestheticEngine, score_technical_quality
from engines.dedup import DedupEngine
from engines.face import FaceEngine
from engines.vlm import VLMEngine
from scoring import (
    compute_event_score,
    compute_family_score,
    compute_quality_score,
    compute_uniqueness_score,
    rank_photos,
)

logger = logging.getLogger(__name__)

mcp = FastMCP(
    "photo-ranker",
    instructions="Photo ranking and classification MCP server",
)

# Lazy-initialized engines
_vlm: VLMEngine | None = None
_aesthetic: AestheticEngine | None = None
_face: FaceEngine | None = None
_dedup: DedupEngine | None = None


def get_vlm() -> VLMEngine:
    global _vlm
    if _vlm is None:
        _vlm = VLMEngine()
    return _vlm


def get_aesthetic() -> AestheticEngine:
    global _aesthetic
    if _aesthetic is None:
        _aesthetic = AestheticEngine()
    return _aesthetic


def get_face() -> FaceEngine:
    global _face
    if _face is None:
        _face = FaceEngine()
    return _face


def get_dedup() -> DedupEngine:
    global _dedup
    if _dedup is None:
        _dedup = DedupEngine()
    return _dedup


@mcp.tool()
async def score_quality(image_b64: str, photo_id: str = "") -> str:
    """Score the aesthetic and technical quality of a photo.

    Args:
        image_b64: Base64-encoded image data.
        photo_id: Optional photo identifier.

    Returns:
        JSON with aesthetic_score, technical_score, and total (0-100).
    """
    technical = score_technical_quality(image_b64)

    try:
        aesthetic_raw = get_aesthetic().score(image_b64)
    except RuntimeError:
        logger.warning("Aesthetic engine not available, using technical only")
        aesthetic_raw = 5.0  # default midpoint

    qs = compute_quality_score(aesthetic_raw, technical)
    qs.photo_id = photo_id or None
    return json.dumps(qs.to_dict())


@mcp.tool()
async def detect_faces(image_b64: str) -> str:
    """Detect faces in a photo and return locations + embeddings.

    Args:
        image_b64: Base64-encoded image data.

    Returns:
        JSON array of face results with bbox and expression.
    """
    faces = get_face().detect_faces(image_b64)
    return json.dumps([f.to_dict() for f in faces])


@mcp.tool()
async def describe_scene(image_b64: str, prompt: str = "") -> str:
    """Describe the scene in a photo using VLM.

    Args:
        image_b64: Base64-encoded image data.
        prompt: Optional custom prompt for the VLM.

    Returns:
        JSON with scene description, people count, event type, etc.
    """
    scene = get_vlm().describe_scene(image_b64, prompt or None)
    return json.dumps(scene.to_dict())


@mcp.tool()
async def classify_event(image_b64: str) -> str:
    """Classify the event type of a photo.

    Args:
        image_b64: Base64-encoded image data.

    Returns:
        JSON with event_type and confidence.
    """
    event_type, confidence = get_vlm().classify_event(image_b64)
    return json.dumps(
        {"event_type": event_type.value, "confidence": round(confidence, 3)}
    )


@mcp.tool()
async def find_duplicates(
    photo_hashes_json: str, threshold: int = 8
) -> str:
    """Find duplicate/similar photos by perceptual hash.

    Args:
        photo_hashes_json: JSON object mapping photo_id -> perceptual hash hex string.
        threshold: Max Hamming distance to consider duplicates (default 8).

    Returns:
        JSON array of duplicate groups.
    """
    photo_hashes = json.loads(photo_hashes_json)
    groups = get_dedup().find_duplicates(photo_hashes, threshold)
    return json.dumps([g.to_dict() for g in groups])


@mcp.tool()
async def register_face(image_b64: str, name: str) -> str:
    """Register a known person's face for family photo scoring.

    Args:
        image_b64: Base64-encoded image containing the person's face.
        name: Name of the person.

    Returns:
        JSON with registration result.
    """
    faces = get_face().detect_faces(image_b64)
    if not faces:
        return json.dumps({"error": "No face detected in image"})
    if not faces[0].embedding:
        return json.dumps({"error": "Face detected but no embedding available"})

    db = _get_job_db()
    face_idx = db.save_known_face(name, faces[0].embedding)
    return json.dumps({
        "name": name,
        "face_idx": face_idx,
        "embedding_dim": len(faces[0].embedding),
    })


@mcp.tool()
async def list_known_faces() -> str:
    """List all registered known faces.

    Returns:
        JSON array of registered people and their embedding counts.
    """
    db = _get_job_db()
    return json.dumps(db.list_known_faces())


@mcp.tool()
async def rank_best_shots(
    photo_scores_json: str, top_n: int = 10
) -> str:
    """Rank photos by composite score and return the top N.

    Args:
        photo_scores_json: JSON array of objects, each with:
            photo_id, quality_score, family_score, event_score,
            uniqueness_score, scene_description, event_type,
            faces_detected, known_persons.
        top_n: Number of top photos to return (default 10).

    Returns:
        JSON array of ranked photos with total_score.
    """
    photo_scores = json.loads(photo_scores_json)
    ranked = rank_photos(photo_scores, top_n)
    return json.dumps([r.to_dict() for r in ranked])


# ── Job Management Tools ──────────────────────────────

from db import JobDB
from jobs import JobQueue, JobStatus
from pipeline import Pipeline, PipelineConfig

_job_queue: JobQueue | None = None
_job_db: JobDB | None = None
_pipeline: Pipeline | None = None


def _get_job_queue() -> JobQueue:
    global _job_queue
    if _job_queue is None:
        _job_queue = JobQueue(max_concurrent=1)
        _job_queue.set_handler(_run_classify_job)
    return _job_queue


def _get_job_db() -> JobDB:
    global _job_db
    if _job_db is None:
        _job_db = JobDB()
    return _job_db


def _get_pipeline() -> Pipeline:
    global _pipeline
    if _pipeline is None:
        _pipeline = Pipeline()
    return _pipeline


async def _run_classify_job(job) -> dict:
    """Handler called by JobQueue to execute classification."""
    # This is a simplified handler — in production, it would
    # load photos from photo-source MCP and feed them through the pipeline
    pipe = _get_pipeline()
    db = _get_job_db()

    db.save_job(job)

    # The actual photo loading would happen here via source integration
    # For now, the pipeline expects photos to be passed via job metadata
    photos = getattr(job, "_photos", [])
    ranked = await pipe.run(photos, job)

    # Persist results
    results = [r.to_dict() for r in ranked]
    db.save_photo_results(job.id, results)
    db.save_job(job)

    return {
        "ranked_count": len(ranked),
        "top_score": ranked[0].total_score if ranked else 0,
    }


@mcp.tool()
async def start_classify_job(
    source: str,
    source_path: str,
) -> str:
    """Start a background photo classification job.

    Args:
        source: Photo source — "local", "apple", "gcs"
        source_path: Directory path or bucket name

    Returns:
        JSON with job_id and status.
    """
    queue = _get_job_queue()
    job = queue.create_job(source, source_path)

    db = _get_job_db()
    db.save_job(job)

    await queue.submit(job.id)
    return json.dumps({"job_id": job.id, "status": job.status.value})


@mcp.tool()
async def get_job_status(job_id: str) -> str:
    """Get the current status of a classification job.

    Args:
        job_id: The job identifier.

    Returns:
        JSON with job status details.
    """
    db = _get_job_db()
    job = db.load_job(job_id)
    if not job:
        # Check in-memory queue
        queue = _get_job_queue()
        job = queue.get_job(job_id)
    if not job:
        return json.dumps({"error": f"Job {job_id} not found"})
    return json.dumps(job.to_dict())


@mcp.tool()
async def get_job_result(job_id: str, top_n: int = 20) -> str:
    """Get the ranked results of a completed classification job.

    Args:
        job_id: The job identifier.
        top_n: Max results to return.

    Returns:
        JSON array of ranked photo results.
    """
    db = _get_job_db()
    results = db.load_photo_results(job_id)
    return json.dumps(results[:top_n])


@mcp.tool()
async def cancel_job(job_id: str) -> str:
    """Cancel a running or pending classification job.

    Args:
        job_id: The job identifier.

    Returns:
        JSON with cancellation result.
    """
    queue = _get_job_queue()
    success = queue.cancel_job(job_id)
    if success:
        db = _get_job_db()
        job = queue.get_job(job_id)
        if job:
            db.save_job(job)
    return json.dumps({"job_id": job_id, "cancelled": success})


@mcp.tool()
async def list_jobs(status: str = "") -> str:
    """List classification jobs, optionally filtered by status.

    Args:
        status: Filter by status — "pending", "running", "completed", "failed", "cancelled". Empty for all.

    Returns:
        JSON array of job summaries.
    """
    db = _get_job_db()
    jobs = db.list_jobs(status=status or None)
    return json.dumps([j.to_dict() for j in jobs])


if __name__ == "__main__":
    mcp.run()
