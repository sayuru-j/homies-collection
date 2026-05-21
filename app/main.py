import mimetypes
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.config import DATA_DIR, MEDIA_DIR
from app.invite_codes import issue_startup_invite
from app.routers import auth_routes, calls, chats, events, groups, locations, media, users, ws
from app.storage import _ensure_dirs

app = FastAPI(title="HomieLog", version="1.0.0")

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
PUBLIC_DIR = BASE_DIR / "public"


@app.on_event("startup")
async def startup():
    _ensure_dirs()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    await issue_startup_invite()


app.include_router(auth_routes.router)
app.include_router(users.router)
app.include_router(locations.router)
app.include_router(chats.router)
app.include_router(groups.router)
app.include_router(events.router)
app.include_router(events.groups_events_router)
app.include_router(media.router)
app.include_router(calls.router)
app.include_router(ws.router)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
if PUBLIC_DIR.is_dir():
    app.mount("/public", StaticFiles(directory=str(PUBLIC_DIR)), name="public")


def _safe_media_filename(name: str | None, fallback: str) -> str:
    raw = (name or fallback).replace("\n", "").replace("\r", "").strip()
    cleaned = "".join(c for c in raw if c not in ('"', "\\", "/"))
    return (cleaned or fallback)[:200]


@app.get("/media/{user_id}/{media_type}/{filename:path}")
async def serve_media(
    user_id: str,
    media_type: str,
    filename: str,
    download: bool = Query(False),
    name: str | None = Query(None),
):
    path = (MEDIA_DIR / user_id / media_type / filename).resolve()
    media_root = MEDIA_DIR.resolve()
    if not str(path).startswith(str(media_root)) or not path.is_file():
        raise HTTPException(status_code=404)

    content_type, _ = mimetypes.guess_type(filename)
    if download:
        disp_name = _safe_media_filename(name, Path(filename).name)
        return FileResponse(
            path,
            media_type=content_type or "application/octet-stream",
            filename=disp_name,
            content_disposition_type="attachment",
        )
    return FileResponse(path, media_type=content_type)


HOMIELOG_STATIC = STATIC_DIR / "homielog"
STRANGER_DANGER_STATIC = STATIC_DIR / "stranger-danger"


@app.get("/")
async def index():
    return FileResponse(HOMIELOG_STATIC / "index.html")


@app.get("/chat")
async def chat_page():
    return FileResponse(HOMIELOG_STATIC / "chat.html")


@app.get("/stranger-danger")
async def stranger_danger_page():
    return FileResponse(STRANGER_DANGER_STATIC / "index.html")


@app.get("/random-chitchat")
async def random_chitchat_redirect():
    from fastapi.responses import RedirectResponse

    return RedirectResponse(url="/stranger-danger", status_code=301)
