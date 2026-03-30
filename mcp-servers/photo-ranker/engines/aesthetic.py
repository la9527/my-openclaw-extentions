"""LAION aesthetic predictor engine."""

from __future__ import annotations

import base64
import io
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# LAION improved-aesthetic-predictor v2.5 weights
_WEIGHTS_FILENAME = "sac+logos+ava1-l14-linearMSE.pth"
_WEIGHTS_URL = (
    "https://github.com/christophschuhmann/improved-aesthetic-predictor"
    "/raw/main/sac%2Blogos%2Bava1-l14-linearMSE.pth"
)


def _weights_path() -> Path:
    """Return the local path for cached weights (XDG cache)."""
    cache = Path.home() / ".cache" / "photo-ranker"
    cache.mkdir(parents=True, exist_ok=True)
    return cache / _WEIGHTS_FILENAME


def _download_weights(dest: Path) -> None:
    """Download LAION aesthetic predictor weights if not cached."""
    if dest.exists():
        return
    import urllib.request

    logger.info("Downloading LAION aesthetic weights to %s …", dest)
    urllib.request.urlretrieve(_WEIGHTS_URL, dest)
    logger.info("Download complete")


class AestheticEngine:
    """Scores image aesthetic quality using CLIP + linear predictor."""

    def __init__(self) -> None:
        self._model = None
        self._preprocess = None
        self._clip_model = None
        self._tokenizer = None

    @property
    def is_loaded(self) -> bool:
        return self._clip_model is not None

    def _ensure_loaded(self) -> None:
        if self._clip_model is not None:
            return
        try:
            import open_clip
            import torch
            import torch.nn as nn

            self._clip_model, _, self._preprocess = (
                open_clip.create_model_and_transforms(
                    "ViT-L-14", pretrained="openai"
                )
            )
            self._clip_model.eval()

            # LAION improved-aesthetic-predictor v2.5 MLP
            # Original model wraps Sequential in `self.layers`
            class _AestheticMLP(nn.Module):
                def __init__(self):
                    super().__init__()
                    self.layers = nn.Sequential(
                        nn.Linear(768, 1024),
                        nn.Dropout(0.2),
                        nn.Linear(1024, 128),
                        nn.Dropout(0.2),
                        nn.Linear(128, 64),
                        nn.Dropout(0.1),
                        nn.Linear(64, 16),
                        nn.Linear(16, 1),
                    )

                def forward(self, x):
                    return self.layers(x)

            self._model = _AestheticMLP()

            weights_file = _weights_path()
            _download_weights(weights_file)
            state_dict = torch.load(
                weights_file, map_location="cpu", weights_only=True
            )
            self._model.load_state_dict(state_dict, strict=True)
            self._model.eval()
            logger.info("Aesthetic model loaded with LAION v2.5 weights")
        except ImportError:
            raise RuntimeError(
                "open-clip-torch is not installed. "
                "Install with: uv pip install 'photo-ranker[aesthetic]'"
            )

    def score(self, image_b64: str) -> float:
        """Return aesthetic score 0-10."""
        self._ensure_loaded()
        import torch
        from PIL import Image

        img_bytes = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(img_bytes)).convert("RGB")

        image_tensor = self._preprocess(image).unsqueeze(0)

        with torch.no_grad():
            image_features = self._clip_model.encode_image(image_tensor)
            image_features = image_features / image_features.norm(
                dim=-1, keepdim=True
            )
            raw_score = self._model(image_features.float()).item()

        return max(0.0, min(10.0, raw_score))

    def unload(self) -> None:
        """Release model from memory."""
        self._model = None
        self._clip_model = None
        self._preprocess = None
        logger.info("Aesthetic model unloaded")


def score_technical_quality(image_b64: str) -> float:
    """Estimate technical quality (blur, exposure, noise, resolution, color) 0-50.

    Uses Laplacian variance for blur detection, histogram analysis for
    exposure, median-diff noise estimation, resolution and color diversity.
    """
    from PIL import Image, ImageFilter, ImageStat

    img_bytes = base64.b64decode(image_b64)
    gray = Image.open(io.BytesIO(img_bytes)).convert("L")
    color = Image.open(io.BytesIO(img_bytes)).convert("RGB")

    # 1. Blur detection via Laplacian variance (0-15)
    laplacian = gray.filter(ImageFilter.FIND_EDGES)
    lap_stat = ImageStat.Stat(laplacian)
    lap_var = lap_stat.var[0]
    blur_score = min(15.0, lap_var / 40.0 * 15.0)

    # 2. Exposure: check histogram spread (0-15)
    hist = gray.histogram()
    total_pixels = sum(hist)
    dark_pct = sum(hist[:20]) / total_pixels
    bright_pct = sum(hist[235:]) / total_pixels
    exposure_penalty = (dark_pct + bright_pct) * 15.0
    exposure_score = max(0.0, 15.0 - exposure_penalty)

    # 3. Noise estimation via median filter residual (0-10)
    median = gray.filter(ImageFilter.MedianFilter(size=3))
    import numpy as np

    gray_arr = np.array(gray, dtype=np.float32)
    median_arr = np.array(median, dtype=np.float32)
    noise_std = float(np.std(gray_arr - median_arr))
    # low noise_std = clean image (high score), high noise_std = noisy (low score)
    noise_score = max(0.0, min(10.0, 10.0 - noise_std * 0.8))

    # 4. Resolution score (0-5): higher resolution = more detail
    w, h = color.size
    megapixels = (w * h) / 1_000_000
    # 0.5MP=1, 2MP=3, 5MP+=5
    resolution_score = min(5.0, megapixels * 1.0)

    # 5. Color diversity / saturation (0-5)
    hsv = color.convert("HSV")
    s_channel = hsv.split()[1]  # Saturation channel
    s_stat = ImageStat.Stat(s_channel)
    avg_saturation = s_stat.mean[0]  # 0-255
    s_std = s_stat.stddev[0]
    # High saturation + high diversity = good color
    color_score = min(5.0, (avg_saturation / 128.0) * 2.5 + (s_std / 64.0) * 2.5)

    return round(blur_score + exposure_score + noise_score + resolution_score + color_score, 2)
