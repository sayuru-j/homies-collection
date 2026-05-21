from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser
from app.config import BASE_DIR, MESSAGES_PAGE_SIZE
from app.chat_soft_delete import (
    get_chat_member_ids,
    hard_delete_chat_for_all_members,
    is_chat_deleted,
    is_chat_hard_deleted,
    is_chat_hidden,
    list_deleted_chats_enriched,
    restore_chat_for_all_members,
    restore_if_soft_deleted,
    soft_delete_chat_for_all_members,
)
from app.call_log import record_call_in_chat
from app.models import CallLogRequest, SendMessageRequest
from app.presence import manager
from app.storage import (
    dm_chat_id,
    get_chat,
    get_group,
    get_profile,
    get_users,
    list_groups_for_user,
    new_id,
    save_chat,
)

router = APIRouter(prefix="/api/chats", tags=["chats"])


async def _enrich_message(msg: dict) -> dict:
    if msg.get("message_type") == "system":
        return msg
    sender = await get_user_by_id_safe(msg.get("sender_id"))
    if sender:
        profile = await get_profile(sender["id"])
        msg["sender_name"] = profile.get("display_name") or sender["name"]
        msg["sender_avatar"] = profile.get("avatar")
    return msg


async def _append_system_message(chat_id: str, chat: dict, content: str) -> dict:
    msg = {
        "id": new_id(),
        "sender_id": None,
        "content": content,
        "message_type": "system",
        "media_path": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    chat.setdefault("messages", []).append(msg)
    await save_chat(chat_id, chat)
    enriched = await _enrich_message(dict(msg))
    payload = {"type": "message", "chat_id": chat_id, "message": enriched}
    member_ids = await get_chat_member_ids(chat_id, chat)
    await manager.send_to_users(member_ids, payload)
    return enriched


async def get_user_by_id_safe(user_id: str) -> dict | None:
    data = await get_users()
    return next((u for u in data.get("users", []) if u["id"] == user_id), None)


def _try_remove_media_file(media_path: str | None) -> None:
    from app.media_thumbnails import inferred_thumb_path

    if not media_path or not media_path.startswith("data/media/"):
        return
    path = (BASE_DIR / media_path).resolve()
    media_root = (BASE_DIR / "data" / "media").resolve()
    if not str(path).startswith(str(media_root)):
        return
    if path.is_file():
        try:
            path.unlink()
        except OSError:
            pass
    thumb = inferred_thumb_path(media_path)
    if thumb:
        thumb_path = (BASE_DIR / thumb).resolve()
        if str(thumb_path).startswith(str(media_root)) and thumb_path.is_file():
            try:
                thumb_path.unlink()
            except OSError:
                pass


def _try_remove_thumb_file(thumb_path: str | None) -> None:
    if not thumb_path or not thumb_path.startswith("data/media/"):
        return
    path = (BASE_DIR / thumb_path).resolve()
    media_root = (BASE_DIR / "data" / "media").resolve()
    if str(path).startswith(str(media_root)) and path.is_file():
        try:
            path.unlink()
        except OSError:
            pass


@router.get("/deleted")
async def list_deleted(user: dict = CurrentUser):
    items = await list_deleted_chats_enriched(user["id"])
    return {"deleted": items}


@router.get("/list")
async def list_chats(user: dict = CurrentUser):
    data = await get_users()
    chats = []

    for u in data.get("users", []):
        if u["id"] == user["id"]:
            continue
        cid = dm_chat_id(user["id"], u["id"])
        if await is_chat_hidden(user["id"], cid):
            continue
        chat = await get_chat(cid)
        last = chat["messages"][-1] if chat.get("messages") else None
        profile = await get_profile(u["id"])
        chats.append(
            {
                "chat_id": cid,
                "type": "dm",
                "name": profile.get("display_name") or u["name"],
                "peer_id": u["id"],
                "avatar": profile.get("avatar"),
                "online": manager.is_online(u["id"]),
                "last_message": last,
            }
        )

    groups = await list_groups_for_user(user["id"])
    for g in groups:
        cid = f"group_{g['group_id']}"
        if await is_chat_hidden(user["id"], cid):
            continue
        chat = await get_chat(cid)
        last = chat["messages"][-1] if chat.get("messages") else None
        chats.append(
            {
                "chat_id": cid,
                "type": "group",
                "name": g["name"],
                "group_id": g["group_id"],
                "avatar": g.get("avatar"),
                "members": g.get("members", []),
                "last_message": last,
            }
        )

    chats.sort(
        key=lambda c: (c.get("last_message") or {}).get("created_at", ""),
        reverse=True,
    )
    return {"chats": chats}


@router.post("/call-log")
async def log_call(body: CallLogRequest, user: dict = CurrentUser):
    chat = await get_chat(body.chat_id)
    if not await _user_in_chat(user["id"], body.chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")
    msg = await record_call_in_chat(
        body.chat_id,
        user["id"],
        body.duration_sec,
        body.call_mode,
        call_id=body.call_id,
    )
    if not msg:
        return {"ok": True, "duplicate": True}
    return {"ok": True, "message": msg}


@router.delete("/{chat_id}")
async def delete_chat(chat_id: str, user: dict = CurrentUser):
    chat = await get_chat(chat_id)
    if not await _user_in_chat(user["id"], chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")
    profile = await get_profile(user["id"])
    deleter_name = profile.get("display_name") or user["name"]
    system_msg = await _append_system_message(
        chat_id, chat, f"{deleter_name} deleted the history"
    )
    await soft_delete_chat_for_all_members(chat_id, chat)
    return {
        "ok": True,
        "chat_id": chat_id,
        "deleted": True,
        "message": system_msg,
    }


@router.post("/{chat_id}/restore")
async def restore_chat_endpoint(chat_id: str, user: dict = CurrentUser):
    chat = await get_chat(chat_id)
    if not await _user_in_chat(user["id"], chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")
    if await is_chat_hard_deleted(user["id"], chat_id):
        raise HTTPException(
            status_code=410,
            detail="Chat was permanently deleted and cannot be restored.",
        )
    restored = await restore_chat_for_all_members(chat_id, chat)
    if not restored:
        raise HTTPException(status_code=404, detail="Chat was not deleted")
    return {"ok": True, "chat_id": chat_id, "restored": True}


@router.delete("/{chat_id}/permanent")
async def permanent_delete_chat(chat_id: str, user: dict = CurrentUser):
    chat = await get_chat(chat_id)
    if not await _user_in_chat(user["id"], chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")
    if not await is_chat_deleted(user["id"], chat_id):
        raise HTTPException(
            status_code=400,
            detail="Chat must be in Deleted Chats before permanent delete",
        )
    member_ids = await get_chat_member_ids(chat_id, chat)
    await hard_delete_chat_for_all_members(chat_id, chat)

    from app.presence import manager

    payload = {"type": "chat_purged", "chat_id": chat_id}
    await manager.send_to_users(member_ids, payload)

    return {"ok": True, "chat_id": chat_id, "permanent": True}


@router.get("/{chat_id}/messages")
async def get_messages(
    chat_id: str,
    user: dict = CurrentUser,
    limit: int = MESSAGES_PAGE_SIZE,
    before: str | None = None,
):
    if await is_chat_hard_deleted(user["id"], chat_id):
        raise HTTPException(
            status_code=410,
            detail="Chat was permanently deleted.",
        )
    if await is_chat_deleted(user["id"], chat_id):
        raise HTTPException(status_code=410, detail="Chat is deleted. Restore it from settings.")
    chat = await get_chat(chat_id)
    if not await _user_in_chat(user["id"], chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")

    limit = max(1, min(limit, 50))
    all_messages = chat.get("messages", [])

    if before:
        idx = next(
            (i for i, m in enumerate(all_messages) if m.get("id") == before),
            len(all_messages),
        )
        start = max(0, idx - limit)
        batch = all_messages[start:idx]
        has_more = start > 0
    else:
        batch = all_messages[-limit:]
        has_more = len(all_messages) > len(batch)

    enriched = [await _enrich_message(m) for m in batch]
    return {
        "chat_id": chat_id,
        "messages": enriched,
        "has_more": has_more,
        "limit": limit,
    }


async def _user_in_chat(user_id: str, chat_id: str, chat: dict | None = None) -> bool:
    if chat_id.startswith("group_"):
        group_id = chat_id.replace("group_", "", 1)
        group = await get_group(group_id)
        return group is not None and user_id in group.get("members", [])

    if chat is None:
        chat = await get_chat(chat_id)
    members = chat.get("members", [])
    if members:
        return user_id in members
    # dm: parse ids from chat_id dm_a_b
    parts = chat_id.split("_")
    if len(parts) >= 3 and parts[0] == "dm":
        return user_id in parts[1:]
    return False


@router.post("/send")
async def send_message(body: SendMessageRequest, user: dict = CurrentUser):
    await restore_if_soft_deleted(user["id"], body.chat_id)
    chat = await get_chat(body.chat_id)
    if not await _user_in_chat(user["id"], body.chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")

    if body.chat_id.startswith("dm_"):
        parts = body.chat_id.split("_")
        peer_ids = [p for p in parts[1:] if p != user["id"]]
        chat["members"] = sorted([user["id"]] + peer_ids)
        chat["type"] = "dm"
    elif body.chat_id.startswith("group_"):
        group_id = body.chat_id.replace("group_", "", 1)
        group = await get_group(group_id)
        if group:
            chat["members"] = group.get("members", [])
            chat["type"] = "group"
            chat["name"] = group.get("name")

    msg = {
        "id": new_id(),
        "sender_id": user["id"],
        "content": body.content,
        "message_type": body.message_type,
        "media_path": body.media_path,
        "thumb_path": body.thumb_path,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    chat.setdefault("messages", []).append(msg)
    await save_chat(body.chat_id, chat)

    profile = await get_profile(user["id"])
    payload = {
        "type": "message",
        "chat_id": body.chat_id,
        "message": {
            **msg,
            "sender_name": profile.get("display_name") or user["name"],
            "sender_avatar": profile.get("avatar"),
        },
    }

    recipients = [m for m in chat.get("members", []) if m != user["id"]]
    await manager.send_to_users(recipients, payload)
    await manager.send_to_user(user["id"], payload)

    return {"ok": True, "message": payload["message"]}


@router.delete("/{chat_id}/messages/{message_id}")
async def delete_message(
    chat_id: str, message_id: str, user: dict = CurrentUser
):
    if await is_chat_hard_deleted(user["id"], chat_id):
        raise HTTPException(
            status_code=410,
            detail="Chat was permanently deleted.",
        )
    if await is_chat_deleted(user["id"], chat_id):
        raise HTTPException(
            status_code=410,
            detail="Chat is deleted. Restore it from settings.",
        )
    chat = await get_chat(chat_id)
    if not await _user_in_chat(user["id"], chat_id, chat):
        raise HTTPException(status_code=403, detail="Not a member of this chat")

    messages = chat.get("messages", [])
    idx = next(
        (i for i, m in enumerate(messages) if m.get("id") == message_id),
        None,
    )
    if idx is None:
        raise HTTPException(status_code=404, detail="Message not found")

    msg = messages[idx]
    if msg.get("sender_id") != user["id"]:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")

    removed = messages.pop(idx)
    _try_remove_media_file(removed.get("media_path"))
    _try_remove_thumb_file(removed.get("thumb_path"))
    await save_chat(chat_id, chat)

    payload = {
        "type": "message_deleted",
        "chat_id": chat_id,
        "message_id": message_id,
    }
    recipients = [m for m in chat.get("members", []) if m != user["id"]]
    await manager.send_to_users(recipients, payload)
    await manager.send_to_user(user["id"], payload)

    return {"ok": True, "chat_id": chat_id, "message_id": message_id}


@router.get("/dm/{peer_id}")
async def open_dm(peer_id: str, user: dict = CurrentUser):
    peer = await get_user_by_id_safe(peer_id)
    if not peer:
        raise HTTPException(status_code=404, detail="User not found")

    cid = dm_chat_id(user["id"], peer_id)
    await restore_if_soft_deleted(user["id"], cid)
    chat = await get_chat(cid)
    chat["chat_id"] = cid
    chat["type"] = "dm"
    chat["members"] = sorted([user["id"], peer_id])
    await save_chat(cid, chat)

    profile = await get_profile(peer_id)
    return {
        "chat_id": cid,
        "peer": {
            "id": peer_id,
            "name": peer["name"],
            "display_name": profile.get("display_name") or peer["name"],
            "avatar": profile.get("avatar"),
            "online": manager.is_online(peer_id),
        },
    }
