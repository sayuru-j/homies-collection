from fastapi import APIRouter, Depends

from app.auth import CurrentUser, change_user_pin
from app.chat_soft_delete import _safe_unlink_media
from app.invite_codes import create_invite
from app.config import DEFAULT_MEDIA_COMPRESSION_PERCENT
from app.media_compress import clamp_compression_percent
from app.models import PinResetRequest, ProfileUpdate
from app.presence import manager
from app.storage import get_profile, get_users, save_profile


def _profile_settings(profile: dict) -> dict:
    settings = profile.get("settings") or {}
    pct = clamp_compression_percent(settings.get("media_compression_percent"))
    settings["media_compression_percent"] = pct
    settings["location_share_allowed"] = bool(settings.get("location_share_allowed"))
    return settings

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/me")
async def me(user: dict = CurrentUser):
    profile = await get_profile(user["id"])
    settings = _profile_settings(profile)
    return {
        "id": user["id"],
        "name": user["name"],
        "display_name": profile.get("display_name") or user["name"],
        "avatar": profile.get("avatar"),
        "settings": settings,
        "media_compression_percent": settings["media_compression_percent"],
        "location_share_allowed": settings["location_share_allowed"],
    }


@router.delete("/me/avatar")
async def remove_avatar(user: dict = CurrentUser):
    profile = await get_profile(user["id"])
    old_path = profile.get("avatar")
    profile["avatar"] = None
    await save_profile(user["id"], profile)
    _safe_unlink_media(old_path)
    await manager.broadcast_presence()
    return {"ok": True, "avatar": None}


@router.patch("/me/pin")
async def reset_pin(body: PinResetRequest, user: dict = CurrentUser):
    """Change login PIN (requires current PIN)."""
    await change_user_pin(user["id"], body.current_pin, body.new_pin)
    return {"ok": True}


@router.patch("/me")
async def update_me(body: ProfileUpdate, user: dict = CurrentUser):
    profile = await get_profile(user["id"])
    if body.display_name is not None:
        profile["display_name"] = body.display_name.strip()
    if body.media_compression_percent is not None:
        profile.setdefault("settings", {})
        profile["settings"]["media_compression_percent"] = clamp_compression_percent(
            body.media_compression_percent
        )
    if body.location_share_allowed is not None:
        profile.setdefault("settings", {})
        profile["settings"]["location_share_allowed"] = body.location_share_allowed
        if not body.location_share_allowed:
            from app.location import location_manager

            if location_manager.clear_user(user["id"]):
                await location_manager.broadcast_stopped(user["id"])
    await save_profile(user["id"], profile)
    settings = _profile_settings(profile)
    return {
        "ok": True,
        "profile": profile,
        "settings": settings,
        "media_compression_percent": settings["media_compression_percent"],
    }


@router.get("/all")
async def list_users(user: dict = CurrentUser):
    data = await get_users()
    result = []
    for u in data.get("users", []):
        if u["id"] == user["id"]:
            continue
        profile = await get_profile(u["id"])
        result.append(
            {
                "id": u["id"],
                "name": u["name"],
                "display_name": profile.get("display_name") or u["name"],
                "avatar": profile.get("avatar"),
                "online": manager.is_online(u["id"]),
            }
        )
    return {"users": result}


@router.post("/invite-code")
async def generate_invite_code(user: dict = CurrentUser):
    """Create a 10-minute invite code for a new friend to register."""
    return await create_invite(created_by=user["id"])


@router.get("/online")
async def online_users(user: dict = CurrentUser):
    data = await get_users()
    online_ids = set(manager.online_user_ids())
    result = []
    for u in data.get("users", []):
        if u["id"] in online_ids and u["id"] != user["id"]:
            profile = await get_profile(u["id"])
            result.append(
                {
                    "id": u["id"],
                    "name": u["name"],
                    "display_name": profile.get("display_name") or u["name"],
                    "avatar": profile.get("avatar"),
                }
            )
    return {"online": result}
