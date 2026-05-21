"""Group call join tokens (LiveKit SFU)."""

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser
from app.config import GROUP_CALLS_ENABLED, MAX_MESH_GROUP_MEMBERS
from app.livekit_service import create_room_token, livekit_enabled, livekit_public_config
from app.models import GroupCallTokenRequest
from app.storage import get_chat, get_group

router = APIRouter(prefix="/api/calls", tags=["calls"])


async def _user_in_group_chat(user_id: str, chat_id: str, chat: dict) -> bool:
    if not chat_id.startswith("group_"):
        return False
    group_id = chat_id.replace("group_", "", 1)
    group = await get_group(group_id)
    return group is not None and user_id in group.get("members", [])


@router.get("/config")
async def calls_config(_user: dict = CurrentUser):
    return {
        "group_calls_enabled": GROUP_CALLS_ENABLED,
        "mesh_group_max": MAX_MESH_GROUP_MEMBERS,
        "livekit": livekit_public_config(),
    }


@router.post("/group/token")
async def group_call_token(body: GroupCallTokenRequest, user: dict = CurrentUser):
    if not GROUP_CALLS_ENABLED:
        raise HTTPException(status_code=503, detail="Group calls are temporarily disabled")
    if not livekit_enabled():
        raise HTTPException(
            status_code=503,
            detail="Group calls are not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
        )

    chat_id = body.chat_id.strip()
    if not chat_id.startswith("group_"):
        raise HTTPException(status_code=400, detail="Group calls require a group chat")

    chat = await get_chat(chat_id)
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    if not await _user_in_group_chat(user["id"], chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this group")

    room_name = chat_id
    try:
        token = await create_room_token(
            user_id=user["id"],
            user_name=user["name"],
            room_name=room_name,
            video=body.call_mode == "video",
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not create join token: {exc}") from exc

    return {
        "token": token,
        "room_name": room_name,
        "url": livekit_public_config()["url"],
        "call_mode": body.call_mode,
    }
