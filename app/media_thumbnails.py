"""Generate small JPEG thumbnails for chat images and videos."""

from __future__ import annotations

import logging
from pathlib import Path

from app.media_compress import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, _ffmpeg_available, _run_ffmpeg

logger = logging.getLogger(__name__)

THUMB_MAX_SIDE = 320
THUMB_JPEG_QUALITY = 78
THUMB_MEDIA_TYPES = frozenset({"image", "video"})


def thumbnail_rel_path(user_id: str, media_type: str, source_filename: str) -> str:
    stem = Path(source_filename).stem
    return f"data/media/{user_id}/{media_type}/thumbs/{stem}.jpg"


def inferred_thumb_path(media_path: str | None) -> str | None:
    if not media_path or not media_path.startswith("data/media/"):
        return None
    parts = media_path.replace("\\", "/").split("/")
    if len(parts) < 5:
        return None
    # data / media / user_id / media_type / filename
    if parts[0] != "data" or parts[1] != "media":
        return None
    user_id, media_type = parts[2], parts[3]
    if media_type not in THUMB_MEDIA_TYPES:
        return None
    filename = "/".join(parts[4:])
    return thumbnail_rel_path(user_id, media_type, filename)


def generate_image_thumbnail(source: Path, dest: Path) -> bool:
    try:
        from PIL import Image
    except ImportError:
        logger.warning("Pillow not installed; skipping image thumbnail")
        return False

    if source.suffix.lower() == ".gif":
        return False

    try:
        img = Image.open(source)
        img.load()
    except Exception as exc:
        logger.warning("Thumbnail: could not open %s: %s", source, exc)
        return False

    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (30, 30, 34))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")

    w, h = img.size
    if max(w, h) > THUMB_MAX_SIDE:
        r = THUMB_MAX_SIDE / max(w, h)
        img = img.resize((max(1, int(w * r)), max(1, int(h * r))), Image.Resampling.LANCZOS)

    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest, format="JPEG", quality=THUMB_JPEG_QUALITY, optimize=True)
    return dest.is_file() and dest.stat().st_size > 0


def thumb_public_url(thumb_path: str) -> str:
    parts = thumb_path.replace("\\", "/").replace("data/media/", "").split("/")
    if len(parts) >= 4 and parts[2] == "thumbs":
        return f"/media/{parts[0]}/{parts[1]}/thumbs/{parts[3]}"
    name = Path(thumb_path).name
    if len(parts) >= 2:
        return f"/media/{parts[0]}/{parts[1]}/thumbs/{name}"
    return ""


def generate_video_thumbnail(source: Path, dest: Path) -> bool:
    if not _ffmpeg_available() or not source.is_file():
        return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    scale = (
        f"scale='min(iw,{THUMB_MAX_SIDE})':'min(ih,{THUMB_MAX_SIDE})':"
        "force_original_aspect_ratio=decrease"
    )

    for seek in ("0", "0.5", "1", "2"):
        if dest.exists():
            try:
                dest.unlink()
            except OSError:
                pass
        ok = _run_ffmpeg(
            [
                "-ss",
                seek,
                "-i",
                str(source),
                "-vframes",
                "1",
                "-vf",
                scale,
                "-q:v",
                "4",
                str(dest),
            ],
            timeout=120,
        )
        if ok and dest.is_file() and dest.stat().st_size > 0:
            return True
    return False


def generate_media_thumbnail(source: Path, user_id: str, media_type: str) -> str | None:
    if media_type not in THUMB_MEDIA_TYPES or not source.is_file():
        return None

    rel = thumbnail_rel_path(user_id, media_type, source.name)
    dest = source.parent / "thumbs" / f"{source.stem}.jpg"

    ok = False
    if media_type == "image" or source.suffix.lower() in IMAGE_EXTENSIONS:
        ok = generate_image_thumbnail(source, dest)
    elif media_type == "video" or source.suffix.lower() in VIDEO_EXTENSIONS:
        ok = generate_video_thumbnail(source, dest)

    return rel.replace("\\", "/") if ok else None


def ensure_video_thumbnail_file(media_path: str) -> str | None:
    """Return thumb_path for a video, generating the JPEG on disk if needed."""
    rel = inferred_thumb_path(media_path)
    if not rel:
        return None

    from app.config import BASE_DIR

    source = (BASE_DIR / media_path).resolve()
    media_root = (BASE_DIR / "data" / "media").resolve()
    if not str(source).startswith(str(media_root)) or not source.is_file():
        return None

    dest = (BASE_DIR / rel).resolve()
    if str(dest).startswith(str(media_root)) and dest.is_file() and dest.stat().st_size > 0:
        return rel.replace("\\", "/")

    parts = media_path.replace("\\", "/").split("/")
    if len(parts) < 5 or parts[3] != "video":
        return None
    user_id = parts[2]
    return generate_media_thumbnail(source, user_id, "video")
