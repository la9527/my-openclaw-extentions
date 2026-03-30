#!/usr/bin/env python3
"""Batch photo classification CLI.

Usage:
    uv run batch_classify.py --source local --path /photos/2025
    uv run batch_classify.py --source local --path /photos --min-quality 15
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time

from db import JobDB
from jobs import Job, JobQueue, JobStatus
from pipeline import Pipeline, PipelineConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)


def _load_photos_from_local(path: str, limit: int = 0) -> list[dict]:
    """Load photos from local directory as photo_id + image_b64."""
    import base64
    from pathlib import Path

    from PIL import Image
    import io

    IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".tiff"}
    root = Path(path)
    photos = []

    for f in sorted(root.rglob("*")):
        if f.suffix.lower() not in IMAGE_EXTS or not f.is_file():
            continue
        try:
            img = Image.open(f)
            buf = io.BytesIO()
            img.save(buf, format="JPEG")
            b64 = base64.b64encode(buf.getvalue()).decode()
            photos.append({"photo_id": str(f), "image_b64": b64})
        except Exception as e:
            logger.warning("Skip %s: %s", f, e)

        if limit and len(photos) >= limit:
            break

    return photos


async def run_batch(args: argparse.Namespace) -> None:
    config = PipelineConfig(
        min_technical_score=args.min_quality,
        vlm_top_n=args.vlm_top_n,
        dedup_threshold=args.dedup_threshold,
    )
    pipeline = Pipeline(config)
    db = JobDB(args.db_path) if args.db_path else JobDB()

    # Load photos
    logger.info("Loading photos from %s: %s", args.source, args.path)
    if args.source == "local":
        photos = _load_photos_from_local(args.path, args.limit)
    else:
        logger.error("Batch CLI currently supports --source local only")
        sys.exit(1)

    if not photos:
        logger.warning("No photos found")
        return

    logger.info("Loaded %d photos", len(photos))

    # Create and run job
    job = Job(
        id=f"batch-{int(time.time())}",
        source=args.source,
        source_path=args.path,
    )
    db.save_job(job)

    start = time.time()
    ranked = await pipeline.run(photos, job)
    elapsed = time.time() - start

    # Save results
    results = [r.to_dict() for r in ranked]
    db.save_photo_results(job.id, results)
    db.save_job(job)

    # Output
    logger.info(
        "Done in %.1fs — %d photos ranked (job: %s)",
        elapsed,
        len(ranked),
        job.id,
    )

    if args.output:
        with open(args.output, "w") as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
        logger.info("Results written to %s", args.output)
    else:
        # Print top results
        top = ranked[: args.top_n]
        print(f"\n{'='*60}")
        print(f"Top {len(top)} results:")
        print(f"{'='*60}")
        for i, r in enumerate(top, 1):
            print(
                f"  {i}. {r.photo_id}"
                f"  total={r.total_score:.1f}"
                f"  quality={r.quality_score:.1f}"
                f"  family={r.family_score:.1f}"
                f"  event={r.event_score:.1f}"
                f"  unique={r.uniqueness_score:.1f}"
            )

    # Summary
    if job.result_summary:
        print(f"\nSummary: {json.dumps(job.result_summary, indent=2)}")


def main():
    parser = argparse.ArgumentParser(
        description="Batch photo classification"
    )
    parser.add_argument(
        "--source",
        default="local",
        choices=["local"],
        help="Photo source (default: local)",
    )
    parser.add_argument(
        "--path",
        required=True,
        help="Directory path to scan",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max photos to process (0 = all)",
    )
    parser.add_argument(
        "--min-quality",
        type=float,
        default=10.0,
        help="Minimum technical score for Stage 2 (default: 10.0)",
    )
    parser.add_argument(
        "--vlm-top-n",
        type=int,
        default=0,
        help="Only run VLM on top N from Stage 1 (0 = all)",
    )
    parser.add_argument(
        "--dedup-threshold",
        type=int,
        default=8,
        help="Hamming distance threshold for dedup (default: 8)",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=20,
        help="Number of top results to display (default: 20)",
    )
    parser.add_argument(
        "--output",
        "-o",
        help="Output JSON file path",
    )
    parser.add_argument(
        "--db-path",
        help="SQLite DB path (default: ~/.photo-ranker/jobs.db)",
    )

    args = parser.parse_args()
    asyncio.run(run_batch(args))


if __name__ == "__main__":
    main()
