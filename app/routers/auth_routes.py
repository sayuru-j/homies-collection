from fastapi import APIRouter, Response

from app.auth import login_user, register_user
from app.config import DEFAULT_MEDIA_COMPRESSION_PERCENT
from app.models import LoginRequest, RegisterRequest
from app.storage import get_profile, save_profile

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
async def register(body: RegisterRequest, response: Response):
    user = await register_user(body.name, body.pin, body.invite_code)
    await save_profile(
        user["id"],
        {
            "user_id": user["id"],
            "display_name": user["name"],
            "avatar": None,
            "settings": {"media_compression_percent": DEFAULT_MEDIA_COMPRESSION_PERCENT},
        },
    )
    _, token = await login_user(body.name, body.pin)
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
    )
    return {"user": user, "token": token}


@router.post("/login")
async def login(body: LoginRequest, response: Response):
    user, token = await login_user(body.name, body.pin)
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
    )
    return {"user": user, "token": token}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("session")
    return {"ok": True}
