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
async def register_face_from_job(
    photo_id: str,
    face_idx: int,
    name: str,
) -> str:
    """이전 분류 결과에서 캐시된 얼굴 임베딩을 known person으로 등록합니다.

    Args:
        photo_id: 사진 식별자 (분류 결과에서 확인)
        face_idx: 얼굴 인덱스 (0부터 시작)
        name: 등록할 인물 이름

    Returns:
        JSON with registration result.
    """
    db = _get_job_db()
    cached = db.load_face_embeddings(photo_id)
    if not cached:
        return json.dumps({"error": f"No cached face embeddings for photo {photo_id}"})

    match = [c for c in cached if c["face_idx"] == face_idx]
    if not match:
        return json.dumps({
            "error": f"Face index {face_idx} not found for photo {photo_id}",
            "available_indices": [c["face_idx"] for c in cached],
        })

    embedding = match[0]["embedding"]
    idx = db.save_known_face(name, embedding)
    return json.dumps({
        "name": name,
        "face_idx": idx,
        "embedding_dim": len(embedding),
        "source_photo": photo_id,
        "source_face_idx": face_idx,
    })


@mcp.tool()
async def delete_known_face(name: str) -> str:
    """등록된 known person의 모든 얼굴 임베딩을 삭제합니다.

    Args:
        name: 삭제할 인물 이름

    Returns:
        JSON with deleted count.
    """
    db = _get_job_db()
    deleted = db.delete_known_face(name)
    return json.dumps({"name": name, "deleted_embeddings": deleted})


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
        _pipeline = Pipeline(db=_get_job_db())
    return _pipeline


async def _run_classify_job(job) -> dict:
    """Handler called by JobQueue to execute classification."""
    from sources import load_photos

    pipe = _get_pipeline()
    db = _get_job_db()

    db.save_job(job)

    # Load known faces from DB into pipeline
    known = db.load_known_faces()
    for name, embeddings in known.items():
        for emb in embeddings:
            pipe.register_known_face(name, emb)

    # Load photos from source
    filters = getattr(job, "_filters", {})
    photos = load_photos(
        job.source,
        job.source_path,
        album=filters.get("album", ""),
        person=filters.get("person", ""),
        date_from=filters.get("date_from", ""),
        date_to=filters.get("date_to", ""),
        limit=filters.get("limit", 100),
    )

    if not photos:
        job.error_message = "No photos found from source"
        db.save_job(job)
        return {"ranked_count": 0, "top_score": 0}

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
    album: str = "",
    person: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
) -> str:
    """Start a background photo classification job.

    Args:
        source: Photo source — "local", "apple", "gcs"
        source_path: Directory path (local), album name (apple), or bucket (gcs)
        album: Album name filter (Apple Photos only)
        person: Person name filter (Apple Photos only)
        date_from: Start date filter (ISO format, optional)
        date_to: End date filter (ISO format, optional)
        limit: Maximum number of photos to process

    Returns:
        JSON with job_id and status.
    """
    queue = _get_job_queue()
    job = queue.create_job(source, source_path)
    job._filters = {
        "album": album,
        "person": person,
        "date_from": date_from,
        "date_to": date_to,
        "limit": limit,
    }

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


# ── Album Management Tools ────────────────────────────

from album_writer import AlbumWriter

_album_writer: AlbumWriter | None = None


def _get_album_writer() -> AlbumWriter:
    global _album_writer
    if _album_writer is None:
        _album_writer = AlbumWriter()
    return _album_writer


@mcp.tool()
async def create_album(name: str, folder: str = "") -> str:
    """Apple Photos에 앨범을 생성합니다.

    Args:
        name: 앨범 이름
        folder: 선택적 폴더 경로 (예: "AI 분류/2026-03")

    Returns:
        JSON with album name, uuid, created status.
    """
    writer = _get_album_writer()
    result = writer.create_album(name, folder)
    return json.dumps(result)


@mcp.tool()
async def add_to_album(
    photo_uuids_json: str,
    album_name: str,
    folder: str = "",
) -> str:
    """기존 Photos 라이브러리 사진을 앨범에 추가합니다 (복제 없음).

    Args:
        photo_uuids_json: JSON array of photo UUID strings
        album_name: 대상 앨범 이름 (없으면 자동 생성)
        folder: 선택적 폴더 경로

    Returns:
        JSON with added count and errors.
    """
    writer = _get_album_writer()
    uuids = json.loads(photo_uuids_json)
    result = writer.add_photos_to_album(uuids, album_name, folder)
    return json.dumps(result)


@mcp.tool()
async def organize_results(
    job_id: str,
    album_prefix: str = "AI 분류",
    folder: str = "",
    min_score: float = 0.0,
) -> str:
    """분류 완료된 Job 결과를 이벤트 유형별 앨범으로 자동 정리합니다.

    Args:
        job_id: 완료된 분류 Job ID
        album_prefix: 앨범 이름 접두사 (예: "AI 분류")
        folder: 선택적 폴더 경로
        min_score: 최소 점수 (이하 건너뜀)

    Returns:
        JSON with albums_created, photos_organized, skipped.
    """
    db = _get_job_db()
    results = db.load_photo_results(job_id)
    if not results:
        return json.dumps({"error": f"No results for job {job_id}"})

    writer = _get_album_writer()
    result = writer.organize_by_classification(results, album_prefix, folder, min_score)
    return json.dumps(result)


@mcp.tool()
async def import_photos(
    photo_paths_json: str,
    album_name: str = "",
    folder: str = "",
    skip_duplicates: bool = True,
) -> str:
    """외부 사진을 Apple Photos 라이브러리에 가져옵니다.

    Args:
        photo_paths_json: JSON array of file path strings
        album_name: 선택적 대상 앨범 (없으면 앨범 미지정)
        folder: 선택적 폴더 경로
        skip_duplicates: 중복 검사 여부

    Returns:
        JSON with imported count and errors.
    """
    writer = _get_album_writer()
    paths = json.loads(photo_paths_json)
    result = writer.import_photos(paths, album_name, folder, skip_duplicates)
    return json.dumps(result)


@mcp.tool()
async def import_and_organize(
    photo_paths_json: str,
    results_json: str,
    album_prefix: str = "AI 분류",
    folder: str = "",
) -> str:
    """외부 사진을 가져오면서 분류 결과에 따라 앨범별로 정리합니다.

    Args:
        photo_paths_json: JSON array of file path strings
        results_json: JSON array of classification results (같은 순서)
        album_prefix: 앨범 이름 접두사
        folder: 선택적 폴더 경로

    Returns:
        JSON with imported count and albums_created.
    """
    writer = _get_album_writer()
    paths = json.loads(photo_paths_json)
    results = json.loads(results_json)
    result = writer.import_and_classify(paths, results, album_prefix, folder)
    return json.dumps(result)


@mcp.tool()
async def list_photo_albums() -> str:
    """Apple Photos의 모든 앨범 목록을 반환합니다.

    Returns:
        JSON array of {name, uuid, count}.
    """
    writer = _get_album_writer()
    albums = writer.list_albums()
    return json.dumps(albums)


# ── End-to-End Workflow Tools ──────────────────────────


@mcp.tool()
async def classify_and_organize(
    source: str,
    source_path: str,
    album_prefix: str = "AI 분류",
    folder: str = "",
    min_score: float = 0.0,
    album: str = "",
    person: str = "",
    date_from: str = "",
    date_to: str = "",
    limit: int = 100,
) -> str:
    """사진 소스에서 불러와 분류하고 Apple Photos 앨범으로 정리하는 전체 워크플로우.

    End-to-end: source → classify → organize into albums.

    Args:
        source: 소스 종류 — "local", "apple"
        source_path: 디렉터리 경로 (local) 또는 앨범 이름 (apple)
        album_prefix: 생성할 앨범 이름 접두사
        folder: 앨범을 넣을 폴더 경로 (예: "AI 분류/2026-03")
        min_score: 최소 점수 (이하 건너뜀)
        album: Apple Photos 앨범 필터
        person: Apple Photos 인물 필터
        date_from: 시작 날짜 (ISO)
        date_to: 종료 날짜 (ISO)
        limit: 최대 처리 사진 수

    Returns:
        JSON with job_id, ranked_count, albums_created, photos_organized.
    """
    from sources import load_photos as _load

    # 1. Load photos from source
    photos = _load(
        source,
        source_path,
        album=album,
        person=person,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
    )
    if not photos:
        return json.dumps({"error": "No photos found from source"})

    # 2. Classify via pipeline
    pipe = _get_pipeline()
    db = _get_job_db()

    # Load known faces
    known = db.load_known_faces()
    for name, embeddings in known.items():
        for emb in embeddings:
            pipe.register_known_face(name, emb)

    # Create job for tracking
    queue = _get_job_queue()
    job = queue.create_job(source, source_path)
    db.save_job(job)

    ranked = await pipe.run(photos, job)
    results = [r.to_dict() for r in ranked]
    db.save_photo_results(job.id, results)
    db.save_job(job)

    # 3. Organize into albums
    if source == "apple" and results:
        writer = _get_album_writer()
        album_result = writer.organize_by_classification(
            results, album_prefix, folder, min_score
        )
    else:
        album_result = {"albums_created": [], "photos_organized": 0, "skipped": 0}

    return json.dumps({
        "job_id": job.id,
        "ranked_count": len(ranked),
        "top_score": ranked[0].total_score if ranked else 0,
        **album_result,
    })


if __name__ == "__main__":
    mcp.run()
