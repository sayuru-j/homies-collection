from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser
from app.models import AddMembersRequest, CreateGroupRequest
from app.storage import get_chat, get_group, get_profile, new_id, save_chat, save_group

router = APIRouter(prefix="/api/groups", tags=["groups"])


@router.post("/create")
async def create_group(body: CreateGroupRequest, user: dict = CurrentUser):
    members = list({user["id"], *body.member_ids})
    group_id = new_id()
    group = {
        "group_id": group_id,
        "name": body.name.strip(),
        "owner_id": user["id"],
        "members": members,
        "avatar": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await save_group(group)

    chat_id = f"group_{group_id}"
    chat = {
        "chat_id": chat_id,
        "type": "group",
        "name": group["name"],
        "members": members,
        "messages": [
            {
                "id": new_id(),
                "sender_id": user["id"],
                "content": f"Group \"{group['name']}\" created",
                "message_type": "system",
                "media_path": None,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    }
    await save_chat(chat_id, chat)

    return {"group": group, "chat_id": chat_id}


@router.get("/{group_id}")
async def get_group_info(group_id: str, user: dict = CurrentUser):
    group = await get_group(group_id)
    if not group or user["id"] not in group.get("members", []):
        raise HTTPException(status_code=404, detail="Group not found")

    member_details = []
    from app.storage import get_users

    users_data = await get_users()
    user_map = {u["id"]: u for u in users_data.get("users", [])}
    for mid in group.get("members", []):
        u = user_map.get(mid)
        if u:
            profile = await get_profile(mid)
            member_details.append(
                {
                    "id": mid,
                    "name": u["name"],
                    "display_name": profile.get("display_name") or u["name"],
                    "avatar": profile.get("avatar"),
                }
            )

    return {"group": group, "members": member_details, "chat_id": f"group_{group_id}"}


@router.post("/{group_id}/members")
async def add_members(group_id: str, body: AddMembersRequest, user: dict = CurrentUser):
    group = await get_group(group_id)
    if not group or user["id"] not in group.get("members", []):
        raise HTTPException(status_code=404, detail="Group not found")

    for mid in body.member_ids:
        if mid not in group["members"]:
            group["members"].append(mid)

    await save_group(group)

    chat_id = f"group_{group_id}"
    chat = await get_chat(chat_id)
    chat["members"] = group["members"]
    await save_chat(chat_id, chat)

    return {"group": group, "chat_id": chat_id}
