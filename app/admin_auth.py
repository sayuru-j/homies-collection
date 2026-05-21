"""Admin dashboard authentication (separate from user sessions)."""

import secrets
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, Response

from app.config import (
    ADMIN_PASSWORD,
    ADMIN_SESSION_MAX_AGE,
    ADMIN_SESSIONS_FILE,
)
from app.storage import read_json, write_json

ADMIN_COOKIE = "admin_session"


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def _load_admin_sessions() -> dict:
    return await read_json(ADMIN_SESSIONS_FILE, default={"sessions": {}})


async def _save_admin_sessions(data: dict) -> None:
    await write_json(ADMIN_SESSIONS_FILE, data)


def verify_admin_password(password: str) -> bool:
    return secrets.compare_digest(password or "", ADMIN_PASSWORD)


async def create_admin_session() -> str:
    token = secrets.token_urlsafe(32)
    data = await _load_admin_sessions()
    data.setdefault("sessions", {})[token] = {"created_at": _now().isoformat()}
    await _save_admin_sessions(data)
    return token


async def revoke_admin_session(token: str) -> None:
    data = await _load_admin_sessions()
    sessions = data.get("sessions", {})
    if token in sessions:
        del sessions[token]
        await _save_admin_sessions(data)


async def is_valid_admin_token(token: str | None) -> bool:
    if not token:
        return False
    data = await _load_admin_sessions()
    return token in data.get("sessions", {})


def _token_from_request(request: Request) -> str | None:
    return request.cookies.get(ADMIN_COOKIE) or request.headers.get("X-Admin-Token")


async def get_current_admin(request: Request) -> dict:
    token = _token_from_request(request)
    if not await is_valid_admin_token(token):
        raise HTTPException(status_code=401, detail="Admin authentication required")
    return {"token": token}


CurrentAdmin = Depends(get_current_admin)


def set_admin_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=ADMIN_COOKIE,
        value=token,
        httponly=True,
        samesite="lax",
        max_age=ADMIN_SESSION_MAX_AGE,
    )


def clear_admin_cookie(response: Response) -> None:
    response.delete_cookie(ADMIN_COOKIE)
