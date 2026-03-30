"""SQLite persistence for job state and photo results."""

from __future__ import annotations

import json
import logging
import sqlite3
from pathlib import Path

from jobs import Job, JobProgress, JobStatus

logger = logging.getLogger(__name__)

DEFAULT_DB_PATH = Path.home() / ".photo-ranker" / "jobs.db"


class JobDB:
    """Lightweight SQLite store for job state and results."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._path = Path(db_path) if db_path else DEFAULT_DB_PATH
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn: sqlite3.Connection | None = None
        self._init_db()

    def _init_db(self) -> None:
        self._conn = sqlite3.connect(str(self._path))
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")

        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                source_path TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at REAL NOT NULL,
                started_at REAL,
                finished_at REAL,
                progress_json TEXT DEFAULT '{}',
                result_json TEXT,
                error_message TEXT
            );

            CREATE TABLE IF NOT EXISTS photo_results (
                job_id TEXT NOT NULL,
                photo_id TEXT NOT NULL,
                total_score REAL NOT NULL,
                quality_score REAL,
                family_score REAL,
                event_score REAL,
                uniqueness_score REAL,
                scene_description TEXT,
                event_type TEXT,
                faces_detected INTEGER DEFAULT 0,
                known_persons_json TEXT DEFAULT '[]',
                PRIMARY KEY (job_id, photo_id),
                FOREIGN KEY (job_id) REFERENCES jobs(id)
            );

            CREATE INDEX IF NOT EXISTS idx_photo_results_job
                ON photo_results(job_id);
            CREATE INDEX IF NOT EXISTS idx_jobs_status
                ON jobs(status);

            CREATE TABLE IF NOT EXISTS known_faces (
                name TEXT NOT NULL,
                face_idx INTEGER NOT NULL DEFAULT 0,
                embedding BLOB NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (name, face_idx)
            );

            CREATE TABLE IF NOT EXISTS face_embeddings (
                photo_id TEXT NOT NULL,
                face_idx INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                gender TEXT DEFAULT '',
                age INTEGER DEFAULT 0,
                expression TEXT DEFAULT 'unknown',
                PRIMARY KEY (photo_id, face_idx)
            );
            """
        )
        self._conn.commit()

    def save_job(self, job: Job) -> None:
        """Insert or replace a job record."""
        self._conn.execute(
            """
            INSERT OR REPLACE INTO jobs
                (id, source, source_path, status, created_at,
                 started_at, finished_at, progress_json,
                 result_json, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job.id,
                job.source,
                job.source_path,
                job.status.value,
                job.created_at,
                job.started_at,
                job.finished_at,
                json.dumps(job.progress.to_dict()),
                json.dumps(job.result_summary) if job.result_summary else None,
                job.error_message,
            ),
        )
        self._conn.commit()

    def load_job(self, job_id: str) -> Job | None:
        """Load a job from DB."""
        row = self._conn.execute(
            "SELECT * FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if not row:
            return None
        return self._row_to_job(row)

    def list_jobs(self, status: str | None = None) -> list[Job]:
        """List jobs, optionally filtered by status."""
        if status:
            rows = self._conn.execute(
                "SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC",
                (status,),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC"
            ).fetchall()
        return [self._row_to_job(r) for r in rows]

    def save_photo_results(
        self, job_id: str, results: list[dict]
    ) -> None:
        """Save ranked photo results for a job."""
        for r in results:
            self._conn.execute(
                """
                INSERT OR REPLACE INTO photo_results
                    (job_id, photo_id, total_score, quality_score,
                     family_score, event_score, uniqueness_score,
                     scene_description, event_type, faces_detected,
                     known_persons_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    job_id,
                    r.get("photo_id", ""),
                    r.get("total_score", 0),
                    r.get("quality_score", 0),
                    r.get("family_score", 0),
                    r.get("event_score", 0),
                    r.get("uniqueness_score", 0),
                    r.get("scene_description", ""),
                    r.get("event_type", ""),
                    r.get("faces_detected", 0),
                    json.dumps(r.get("known_persons", [])),
                ),
            )
        self._conn.commit()

    def load_photo_results(self, job_id: str) -> list[dict]:
        """Load ranked results for a job."""
        rows = self._conn.execute(
            """SELECT * FROM photo_results
               WHERE job_id = ?
               ORDER BY total_score DESC""",
            (job_id,),
        ).fetchall()
        return [
            {
                "photo_id": r["photo_id"],
                "total_score": r["total_score"],
                "quality_score": r["quality_score"],
                "family_score": r["family_score"],
                "event_score": r["event_score"],
                "uniqueness_score": r["uniqueness_score"],
                "scene_description": r["scene_description"],
                "event_type": r["event_type"],
                "faces_detected": r["faces_detected"],
                "known_persons": json.loads(r["known_persons_json"]),
            }
            for r in rows
        ]

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ── Known Faces ──

    def save_known_face(self, name: str, embedding: list[float]) -> int:
        """Register a known person's face embedding. Returns face_idx."""
        import struct
        import time

        blob = struct.pack(f"{len(embedding)}f", *embedding)

        # Find next face_idx for this name
        row = self._conn.execute(
            "SELECT COALESCE(MAX(face_idx), -1) + 1 FROM known_faces WHERE name = ?",
            (name,),
        ).fetchone()
        face_idx = row[0]

        self._conn.execute(
            "INSERT OR REPLACE INTO known_faces (name, face_idx, embedding, created_at) "
            "VALUES (?, ?, ?, ?)",
            (name, face_idx, blob, time.time()),
        )
        self._conn.commit()
        return face_idx

    def load_known_faces(self) -> dict[str, list[list[float]]]:
        """Load all known faces as {name: [embedding, ...]}."""
        import struct

        rows = self._conn.execute(
            "SELECT name, embedding FROM known_faces ORDER BY name, face_idx"
        ).fetchall()

        result: dict[str, list[list[float]]] = {}
        for row in rows:
            name = row["name"]
            blob = row["embedding"]
            n_floats = len(blob) // 4
            embedding = list(struct.unpack(f"{n_floats}f", blob))
            if name not in result:
                result[name] = []
            result[name].append(embedding)
        return result

    def delete_known_face(self, name: str) -> int:
        """Delete all embeddings for a known person. Returns deleted count."""
        cursor = self._conn.execute(
            "DELETE FROM known_faces WHERE name = ?", (name,)
        )
        self._conn.commit()
        return cursor.rowcount

    def list_known_faces(self) -> list[dict]:
        """List registered known faces with count per person."""
        rows = self._conn.execute(
            "SELECT name, COUNT(*) as count FROM known_faces GROUP BY name ORDER BY name"
        ).fetchall()
        return [{"name": r["name"], "embedding_count": r["count"]} for r in rows]

    # ── Face Embedding Cache ──

    def save_face_embedding(
        self,
        photo_id: str,
        face_idx: int,
        embedding: list[float],
        gender: str = "",
        age: int = 0,
        expression: str = "unknown",
    ) -> None:
        """Cache a face embedding for a photo."""
        import struct

        blob = struct.pack(f"{len(embedding)}f", *embedding)
        self._conn.execute(
            "INSERT OR REPLACE INTO face_embeddings "
            "(photo_id, face_idx, embedding, gender, age, expression) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (photo_id, face_idx, blob, gender, age, expression),
        )
        self._conn.commit()

    def load_face_embeddings(self, photo_id: str) -> list[dict]:
        """Load cached face embeddings for a photo."""
        import struct

        rows = self._conn.execute(
            "SELECT * FROM face_embeddings WHERE photo_id = ? ORDER BY face_idx",
            (photo_id,),
        ).fetchall()

        results = []
        for row in rows:
            blob = row["embedding"]
            n_floats = len(blob) // 4
            embedding = list(struct.unpack(f"{n_floats}f", blob))
            results.append({
                "face_idx": row["face_idx"],
                "embedding": embedding,
                "gender": row["gender"],
                "age": row["age"],
                "expression": row["expression"],
            })
        return results

    @staticmethod
    def _row_to_job(row) -> Job:
        progress_data = json.loads(row["progress_json"] or "{}")
        return Job(
            id=row["id"],
            source=row["source"],
            source_path=row["source_path"],
            status=JobStatus(row["status"]),
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            progress=JobProgress(
                total=progress_data.get("total", 0),
                completed=progress_data.get("completed", 0),
                stage=progress_data.get("stage", ""),
                current_file=progress_data.get("current_file", ""),
                errors=progress_data.get("errors", []),
            ),
            result_summary=(
                json.loads(row["result_json"])
                if row["result_json"]
                else None
            ),
            error_message=row["error_message"],
        )
