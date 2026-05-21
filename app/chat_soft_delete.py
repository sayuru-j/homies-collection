from datetime import datetime, timezone

from app.config import BASE_DIR
from app.storage import chat_path, get_chat, get_group, get_profile, get_users, group_path, save_profile


def _safe_unlink_media(media_path: str | None) -> None:
    if not media_path or not media_path.startswith("data/media/"):
        return
    path = (BASE_DIR / media_path).resolve()
    media_root = (BASE_DIR / "data" / "media").resolve()
    if str(path).startswith(str(media_root)) and path.is_file():
        try:
            path.unlink()
        except OSError:
            pass


async def purge_chat_from_server(chat_id: str, chat: dict | None = None) -> None:
    """Delete chat file, group file (if any), and all message media from disk."""
    if chat is None:
        chat = await get_chat(chat_id)

    seen_media: set[str] = set()
    for msg in chat.get("messages", []):
        mp = msg.get("media_path")
        if mp and mp not in seen_media:
            seen_media.add(mp)
            _safe_unlink_media(mp)
        tp = msg.get("thumb_path")
        if tp and tp not in seen_media:
            seen_media.add(tp)
            _safe_unlink_media(tp)

    if chat_id.startswith("group_"):
        group_id = chat_id.replace("group_", "", 1)
        group = await get_group(group_id)
        if group:
            _safe_unlink_media(group.get("avatar"))
        gp = group_path(group_id)
        if gp.exists():
            try:
                gp.unlink()
            except OSError:
                pass

    cp = chat_path(chat_id)
    if cp.exists():
        try:
            cp.unlink()
        except OSError:
            pass


async def get_chat_member_ids(chat_id: str, chat: dict | None = None) -> list[str]:
    if chat is None:
        chat = await get_chat(chat_id)
    if chat_id.startswith("group_"):
        group_id = chat_id.replace("group_", "", 1)
        group = await get_group(group_id)
        return list(group.get("members", [])) if group else []
    members = chat.get("members", [])
    if members:
        return list(members)
    parts = chat_id.split("_")
    if len(parts) >= 3 and parts[0] == "dm":
        return [p for p in parts[1:] if p]
    return []


def _deleted_map(profile: dict) -> dict[str, str]:
    settings = profile.setdefault("settings", {})
    deleted = settings.setdefault("deleted_chats", {})
    if not isinstance(deleted, dict):
        deleted = {}
        settings["deleted_chats"] = deleted
    return deleted


def _hard_deleted_map(profile: dict) -> dict[str, str]:
    settings = profile.setdefault("settings", {})
    hard = settings.setdefault("hard_deleted_chats", {})
    if not isinstance(hard, dict):
        hard = {}
        settings["hard_deleted_chats"] = hard
    return hard


async def is_chat_deleted(user_id: str, chat_id: str) -> bool:
    profile = await get_profile(user_id)
    return chat_id in _deleted_map(profile)


async def is_chat_hard_deleted(user_id: str, chat_id: str) -> bool:
    profile = await get_profile(user_id)
    return chat_id in _hard_deleted_map(profile)


async def is_chat_hidden(user_id: str, chat_id: str) -> bool:
    return await is_chat_deleted(user_id, chat_id) or await is_chat_hard_deleted(
        user_id, chat_id
    )


async def soft_delete_chat(user_id: str, chat_id: str) -> None:
    profile = await get_profile(user_id)
    deleted = _deleted_map(profile)
    deleted[chat_id] = datetime.now(timezone.utc).isoformat()
    await save_profile(user_id, profile)


async def soft_delete_chat_for_all_members(chat_id: str, chat: dict | None = None) -> None:
    if chat is None:
        chat = await get_chat(chat_id)
    deleted_at = datetime.now(timezone.utc).isoformat()
    for member_id in await get_chat_member_ids(chat_id, chat):
        profile = await get_profile(member_id)
        deleted = _deleted_map(profile)
        deleted[chat_id] = deleted_at
        await save_profile(member_id, profile)


async def restore_chat(user_id: str, chat_id: str) -> bool:
    profile = await get_profile(user_id)
    deleted = _deleted_map(profile)
    if chat_id not in deleted:
        return False
    del deleted[chat_id]
    await save_profile(user_id, profile)
    return True


async def restore_chat_for_all_members(chat_id: str, chat: dict | None = None) -> bool:
    if chat is None:
        chat = await get_chat(chat_id)
    restored_any = False
    for member_id in await get_chat_member_ids(chat_id, chat):
        if await restore_chat(member_id, chat_id):
            restored_any = True
    return restored_any


async def hard_delete_chat_for_all_members(chat_id: str, chat: dict | None = None) -> None:
    if chat is None:
        chat = await get_chat(chat_id)
    member_ids = await get_chat_member_ids(chat_id, chat)
    await purge_chat_from_server(chat_id, chat)
    for member_id in member_ids:
        profile = await get_profile(member_id)
        _deleted_map(profile).pop(chat_id, None)
        _hard_deleted_map(profile).pop(chat_id, None)
        await save_profile(member_id, profile)


async def clear_hard_delete(user_id: str, chat_id: str) -> None:
    """Allow opening a conversation again (e.g. new DM from user list)."""
    profile = await get_profile(user_id)
    hard = _hard_deleted_map(profile)
    if chat_id in hard:
        del hard[chat_id]
        await save_profile(user_id, profile)


async def restore_if_soft_deleted(user_id: str, chat_id: str) -> None:
    chat = await get_chat(chat_id)
    for member_id in await get_chat_member_ids(chat_id, chat):
        if await is_chat_hard_deleted(member_id, chat_id):
            await clear_hard_delete(member_id, chat_id)
        await restore_chat(member_id, chat_id)


async def list_deleted_chat_ids(user_id: str) -> dict[str, str]:
    profile = await get_profile(user_id)
    return dict(_deleted_map(profile))


async def enrich_deleted_chat(user_id: str, chat_id: str, deleted_at: str) -> dict | None:
    chat = await get_chat(chat_id)
    entry = {
        "chat_id": chat_id,
        "type": chat.get("type", "dm"),
        "deleted_at": deleted_at,
        "name": chat.get("name") or "Unknown",
        "avatar": None,
    }

    if chat_id.startswith("group_"):
        group_id = chat_id.replace("group_", "", 1)
        group = await get_group(group_id)
        if not group or user_id not in group.get("members", []):
            return None
        entry["type"] = "group"
        entry["name"] = group.get("name", "Group")
        entry["avatar"] = group.get("avatar")
        entry["group_id"] = group_id
    elif chat_id.startswith("dm_"):
        parts = chat_id.split("_")
        if len(parts) < 3:
            return None
        peer_id = parts[1] if parts[1] != user_id else parts[2]
        users = await get_users()
        peer = next((u for u in users.get("users", []) if u["id"] == peer_id), None)
        if not peer:
            return None
        profile = await get_profile(peer_id)
        entry["type"] = "dm"
        entry["name"] = profile.get("display_name") or peer["name"]
        entry["avatar"] = profile.get("avatar")
        entry["peer_id"] = peer_id
    else:
        return None

    last = chat.get("messages", [])[-1] if chat.get("messages") else None
    entry["last_message"] = last
    return entry


async def list_deleted_chats_enriched(user_id: str) -> list[dict]:
    deleted = await list_deleted_chat_ids(user_id)
    items = []
    for chat_id, deleted_at in deleted.items():
        info = await enrich_deleted_chat(user_id, chat_id, deleted_at)
        if info:
            items.append(info)
    items.sort(key=lambda x: x.get("deleted_at", ""), reverse=True)
    return items
