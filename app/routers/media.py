import json
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.auth import CurrentUser
from app.config import CHUNKS_DIR, DEFAULT_MEDIA_COMPRESSION_PERCENT, MAX_FILE_SIZE, MEDIA_DIR
from app.media_compress import clamp_compression_percent, compress_media_file  # avatar only
from app.media_thumbnails import (
    ensure_video_thumbnail_file,
    generate_media_thumbnail,
    thumb_public_url,
)
from app.models import ThumbnailEnsureRequest
from app.storage import get_profile, save_profile

router = APIRouter(prefix="/api/media", tags=["media"])


def _user_media_dir(user_id: str) -> Path:
    d = MEDIA_DIR / user_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def _chunk_dir(upload_id: str) -> Path:
    d = CHUNKS_DIR / upload_id
    d.mkdir(parents=True, exist_ok=True)
    return d


@router.post("/chunk")
async def upload_chunk(
    upload_id: str = Form(...),
    chunk_index: int = Form(...),
    total_chunks: int = Form(...),
    filename: str = Form(...),
    media_type: str = Form("file"),
    file: UploadFile = File(...),
    user: dict = CurrentUser,
):
    if total_chunks < 1 or chunk_index < 0 or chunk_index >= total_chunks:
        raise HTTPException(status_code=400, detail="Invalid chunk parameters")

    chunk_path = _chunk_dir(upload_id) / f"{chunk_index:06d}.part"
    content = await file.read()
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(status_code=400, detail="Chunk too large")

    chunk_path.write_bytes(content)

    meta_path = _chunk_dir(upload_id) / "meta.json"
    meta = {
        "upload_id": upload_id,
        "filename": filename,
        "total_chunks": total_chunks,
        "media_type": media_type,
        "user_id": user["id"],
        "received": [],
    }
    if meta_path.exists():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))

    if chunk_index not in meta["received"]:
        meta["received"].append(chunk_index)
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    complete = len(meta["received"]) >= total_chunks
    result = {"ok": True, "chunk_index": chunk_index, "complete": complete}

    if complete:
        ext = Path(filename).suffix or ".bin"
        safe_name = f"{upload_id}{ext}"
        out_dir = _user_media_dir(user["id"]) / media_type
        out_dir.mkdir(parents=True, exist_ok=True)
        final_path = out_dir / safe_name

        with open(final_path, "wb") as out:
            for i in range(total_chunks):
                part = _chunk_dir(upload_id) / f"{i:06d}.part"
                if not part.exists():
                    raise HTTPException(status_code=400, detail=f"Missing chunk {i}")
                out.write(part.read_bytes())

        # Compression runs in the browser before upload (see static/homielog/js/media-compress.js).

        rel_path = f"data/media/{user['id']}/{media_type}/{safe_name}"

        thumb_path = None
        if media_type in ("image", "video"):
            thumb_path = generate_media_thumbnail(final_path, user["id"], media_type)

        if media_type == "avatar":
            profile = await get_profile(user["id"])
            profile["avatar"] = rel_path.replace("\\", "/")
            await save_profile(user["id"], profile)
            result["avatar"] = profile["avatar"]

        shutil.rmtree(_chunk_dir(upload_id), ignore_errors=True)
        result["media_path"] = rel_path.replace("\\", "/")
        result["url"] = f"/media/{user['id']}/{media_type}/{safe_name}"
        if thumb_path:
            result["thumb_path"] = thumb_path
            result["thumb_url"] = thumb_public_url(thumb_path)

    return result


@router.post("/thumbnail")
async def ensure_thumbnail(body: ThumbnailEnsureRequest, user: dict = CurrentUser):
    """Ensure a video poster JPEG exists; generate server-side without client video download."""
    media_path = body.media_path.replace("\\", "/")
    if not media_path.startswith("data/media/"):
        raise HTTPException(status_code=400, detail="Invalid media path")
    parts = media_path.split("/")
    if len(parts) < 5 or parts[3] != "video":
        raise HTTPException(status_code=400, detail="Only video thumbnails are supported")

    thumb_path = ensure_video_thumbnail_file(media_path)
    if not thumb_path:
        raise HTTPException(
            status_code=503,
            detail="Could not generate video thumbnail (ffmpeg may be unavailable)",
        )

    return {
        "ok": True,
        "thumb_path": thumb_path,
        "thumb_url": thumb_public_url(thumb_path),
    }


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    user: dict = CurrentUser,
):
    content = await file.read()
    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Avatar max 5MB")

    ext = Path(file.filename or "avatar.jpg").suffix or ".jpg"
    out_dir = _user_media_dir(user["id"]) / "avatar"
    out_dir.mkdir(parents=True, exist_ok=True)
    safe_name = f"avatar{ext}"
    final_path = out_dir / safe_name
    final_path.write_bytes(content)

    profile = await get_profile(user["id"])
    compression_pct = clamp_compression_percent(
        (profile.get("settings") or {}).get(
            "media_compression_percent", DEFAULT_MEDIA_COMPRESSION_PERCENT
        )
    )
    compress_media_file(final_path, "avatar", compression_pct)

    rel_path = str(Path("data") / "media" / user["id"] / "avatar" / safe_name).replace(
        "\\", "/"
    )
    profile["avatar"] = rel_path
    await save_profile(user["id"], profile)
    return {"ok": True, "avatar": rel_path, "url": f"/media/{user['id']}/avatar/{safe_name}"}
