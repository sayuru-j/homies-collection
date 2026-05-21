"""Access checks for viewing another user's profile media."""

from fastapi import HTTPException

from app.auth import get_user_by_id
from app.storage import dm_chat_id, get_chat, get_users, list_groups_for_user


async def users_are_connected(viewer_id: str, owner_id: str) -> bool:
    if viewer_id == owner_id:
        return True

    data = await get_users()
    user_ids = {u["id"] for u in data.get("users", [])}
    if owner_id not in user_ids or viewer_id not in user_ids:
        return False

    for group in await list_groups_for_user(viewer_id):
        if owner_id in group.get("members", []):
            return True

    cid = dm_chat_id(viewer_id, owner_id)
    chat = await get_chat(cid)
    members = chat.get("members") or []
    if members:
        return viewer_id in members and owner_id in members

    return True


async def assert_can_view_avatar(viewer_id: str, owner_id: str) -> None:
    if not await users_are_connected(viewer_id, owner_id):
        raise HTTPException(status_code=403, detail="Cannot view this profile photo")
    owner = await get_user_by_id(owner_id)
    if not owner:
        raise HTTPException(status_code=404, detail="User not found")
