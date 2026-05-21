"""Compress uploaded media using Pillow (images) and ffmpeg (video/audio) when available."""

from __future__ import annotations

import logging
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from app.config import (
    DEFAULT_MEDIA_COMPRESSION_PERCENT,
    MAX_MEDIA_COMPRESSION_PERCENT,
    MIN_MEDIA_COMPRESSION_PERCENT,
)

logger = logging.getLogger(__name__)

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}
AUDIO_EXTENSIONS = {".webm", ".ogg", ".mp3", ".m4a", ".aac", ".wav", ".opus"}

MIN_TARGET_BYTES = 50_000  # floor ~50 KB


def clamp_compression_percent(value: int | float | None) -> int:
    if value is None:
        return DEFAULT_MEDIA_COMPRESSION_PERCENT
    try:
        n = int(round(float(value)))
    except (TypeError, ValueError):
        return DEFAULT_MEDIA_COMPRESSION_PERCENT
    return max(MIN_MEDIA_COMPRESSION_PERCENT, min(MAX_MEDIA_COMPRESSION_PERCENT, n))


def target_size_ratio(percent: int | float | None) -> float:
    """Target output size as a fraction of original. 0% = smallest, 100% = no compression."""
    p = clamp_compression_percent(percent)
    if p >= 100:
        return 1.0
    return 0.08 + (p / 100.0) * 0.92


def target_bytes(original_size: int, percent: int | float | None) -> int:
    ratio = target_size_ratio(percent)
    if ratio >= 1.0:
        return original_size
    return max(MIN_TARGET_BYTES, int(original_size * ratio))


def encode_scale(percent: int | float | None) -> float:
    """Legacy alias: sqrt of target ratio for dimension/bitrate scaling."""
    return math.sqrt(target_size_ratio(percent))


def _ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def _ffprobe_duration_sec(path: Path) -> float:
    if not shutil.which("ffprobe"):
        return 0.0
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if proc.returncode != 0:
            return 0.0
        return max(0.0, float(proc.stdout.strip()))
    except (ValueError, subprocess.SubprocessError, OSError):
        return 0.0


def _run_ffmpeg(args: list[str], timeout: int = 900) -> bool:
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", *args],
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if proc.returncode != 0:
            logger.warning(
                "ffmpeg failed: %s",
                proc.stderr.decode(errors="replace")[-800:],
            )
            return False
        return True
    except (subprocess.SubprocessError, FileNotFoundError, OSError) as exc:
        logger.warning("ffmpeg error: %s", exc)
        return False


def _video_encode_args(path: Path, percent: int, out_path: Path) -> list[str]:
    original = path.stat().st_size
    goal = target_bytes(original, percent)
    ratio = target_size_ratio(percent)
    duration = _ffprobe_duration_sec(path) or 120.0

    total_bps = max(32_000, int((goal * 8) / duration))
    audio_bps = min(48_000, max(8_000, int(total_bps * 0.12)))
    video_bps = max(32_000, total_bps - audio_bps)

    dim_scale = max(0.1, math.sqrt(ratio))
    max_h = max(144, int(720 * dim_scale))
    max_w = max(256, int(1280 * dim_scale))
    crf = min(51, max(28, int(51 - ratio * 40)))

    vf = (
        f"scale='min(iw,{max_w})':'min(ih,{max_h})':"
        "force_original_aspect_ratio=decrease"
    )

    return [
        "-i",
        str(path),
        "-vf",
        vf,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(crf),
        "-b:v",
        str(video_bps),
        "-maxrate",
        str(int(video_bps * 1.15)),
        "-bufsize",
        str(int(video_bps * 2)),
        "-c:a",
        "aac",
        "-b:a",
        f"{audio_bps}",
        "-movflags",
        "+faststart",
        str(out_path),
    ]


def compress_image(path: Path, percent: int) -> bool:
    try:
        from PIL import Image
    except ImportError:
        logger.warning("Pillow not installed; skipping image compression")
        return False

    percent = clamp_compression_percent(percent)
    if percent >= 100:
        return False

    if path.suffix.lower() == ".gif":
        return False

    try:
        img = Image.open(path)
        img.load()
    except Exception as exc:
        logger.warning("Could not open image %s: %s", path, exc)
        return False

    original_size = path.stat().st_size
    goal = target_bytes(original_size, percent)
    ratio = target_size_ratio(percent)

    has_alpha = img.mode in ("RGBA", "LA", "P")
    if has_alpha:
        img = img.convert("RGBA")
    else:
        img = img.convert("RGB")

    dim_scale = max(0.12, math.sqrt(ratio))
    max_side = max(320, int(2048 * dim_scale))
    w, h = img.size
    if max(w, h) > max_side:
        r = max_side / max(w, h)
        img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.Resampling.LANCZOS)

    out_path = path
    if path.suffix.lower() in (".png", ".webp", ".bmp", ".gif") and not has_alpha:
        out_path = path.with_suffix(".jpg")

    quality = max(3, min(85, int(5 + ratio * 90)))
    best_path = out_path

    for attempt in range(6):
        q = max(2, int(quality * (0.72**attempt)))
        if not has_alpha:
            img.save(out_path, format="JPEG", quality=q, optimize=True)
        else:
            img.save(out_path, format="PNG", optimize=True)
        if out_path.stat().st_size <= goal * 1.15:
            best_path = out_path
            break
        best_path = out_path
        if q <= 3:
            break
        w, h = img.size
        if max(w, h) > 240:
            r = 0.75
            img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.Resampling.LANCZOS)

    if best_path != path and path.exists() and best_path.suffix != path.suffix:
        path.unlink()

    return best_path.exists()


def compress_video(path: Path, percent: int) -> bool:
    if not _ffmpeg_available():
        return False
    percent = clamp_compression_percent(percent)
    if percent >= 100:
        return False

    original = path.stat().st_size
    goal = target_bytes(original, percent)

    with tempfile.NamedTemporaryFile(suffix=path.suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)

    current_pct = percent
    for attempt in range(4):
        ok = _run_ffmpeg(_video_encode_args(path, current_pct, tmp_path))
        if not ok or not tmp_path.exists():
            tmp_path.unlink(missing_ok=True)
            return False
        if tmp_path.stat().st_size <= goal * 1.4:
            break
        if attempt >= 3:
            break
        current_pct = clamp_compression_percent(current_pct - 15)
        tmp_path.unlink(missing_ok=True)
        with tempfile.NamedTemporaryFile(suffix=path.suffix, delete=False) as tmp2:
            tmp_path = Path(tmp2.name)

    if tmp_path.stat().st_size > 0:
        tmp_path.replace(path)
        logger.info(
            "Video %s: %s → %s (goal ~%s, %s%%)",
            path.name,
            original,
            path.stat().st_size,
            goal,
            clamp_compression_percent(percent),
        )
        return True
    tmp_path.unlink(missing_ok=True)
    return False


def compress_audio(path: Path, percent: int) -> bool:
    if not _ffmpeg_available():
        return False
    percent = clamp_compression_percent(percent)
    if percent >= 100:
        return False

    original = path.stat().st_size
    goal = target_bytes(original, percent)
    duration = _ffprobe_duration_sec(path) or 60.0
    audio_bps = max(8_000, min(128_000, int((goal * 8) / duration)))

    with tempfile.NamedTemporaryFile(suffix=path.suffix, delete=False) as tmp:
        tmp_path = Path(tmp.name)

    ok = _run_ffmpeg(
        [
            "-i",
            str(path),
            "-c:a",
            "libopus" if path.suffix.lower() == ".webm" else "aac",
            "-b:a",
            f"{audio_bps}",
            str(tmp_path),
        ]
    )
    if ok and tmp_path.exists() and tmp_path.stat().st_size > 0:
        tmp_path.replace(path)
        return True
    tmp_path.unlink(missing_ok=True)
    return False


def compress_media_file(path: Path, media_type: str, percent: int | None) -> bool:
    """Compress file in place. Returns True if compression ran."""
    if not path.is_file():
        return False

    pct = clamp_compression_percent(percent)
    if pct >= 100:
        return False

    ext = path.suffix.lower()

    if media_type in ("image", "avatar") or ext in IMAGE_EXTENSIONS:
        return compress_image(path, pct)

    if media_type == "video" or ext in VIDEO_EXTENSIONS:
        return compress_video(path, pct)

    if media_type == "voice" or ext in AUDIO_EXTENSIONS:
        return compress_audio(path, pct)

    return False
