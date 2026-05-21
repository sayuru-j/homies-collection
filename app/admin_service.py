"""Server administration: users, chats, media, maintenance."""

import shutil
from datetime import datetime, timezone
from pathlib import Path

from app.chat_soft_delete import _safe_unlink_media, purge_chat_from_server
from app.config import (
    AUTH_DIR,
    BASE_DIR,
    CHATS_DIR,
    CHUNKS_DIR,
    DATA_DIR,
    EVENTS_DIR,
    GROUPS_DIR,
    INVITES_FILE,
    MEDIA_DIR,
    PROFILES_DIR,
    SESSIONS_FILE,
)
from app.invite_codes import create_invite
from app.presence import manager
from app.storage import (
    chat_path,
    get_chat,
    get_profile,
    get_sessions,
    get_users,
    profile_path,
    read_json,
    save_chat,
    save_group,
    save_profile,
    save_sessions,
    save_users,
    write_json,
)


def _dir_size(path: Path) -> int:
    if not path.exists():
        return 0
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    return total


def _format_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} TB"


async def get_server_stats() -> dict:
    users = await get_users()
    sessions = await get_sessions()

    chat_count = len(list(CHATS_DIR.glob("*.json"))) if CHATS_DIR.exists() else 0
    group_count = len(list(GROUPS_DIR.glob("*.json"))) if GROUPS_DIR.exists() else 0
    event_count = len(list(EVENTS_DIR.glob("*.json"))) if EVENTS_DIR.exists() else 0
    profile_count = len(list(PROFILES_DIR.glob("*.json"))) if PROFILES_DIR.exists() else 0

    invites = await read_json(INVITES_FILE, default={"invites": []})
    active_invites = sum(
        1 for i in invites.get("invites", []) if not i.get("used_at")
    )

    chunk_count = 0
    if CHUNKS_DIR.exists():
        chunk_count = sum(1 for p in CHUNKS_DIR.rglob("*") if p.is_file())

    data_bytes = _dir_size(DATA_DIR)
    media_bytes = _dir_size(MEDIA_DIR)

    return {
        "users": len(users.get("users", [])),
        "sessions": len(sessions.get("sessions", {})),
        "online": len(manager.online_user_ids()),
        "chats": chat_count,
        "groups": group_count,
        "events": event_count,
        "profiles": profile_count,
        "active_invites": active_invites,
        "chunk_files": chunk_count,
        "data_size": data_bytes,
        "data_size_human": _format_bytes(data_bytes),
        "media_size": media_bytes,
        "media_size_human": _format_bytes(media_bytes),
    }


async def list_users_admin() -> list[dict]:
    users_data = await get_users()
    sessions = (await get_sessions()).get("sessions", {})
    online = set(manager.online_user_ids())

    session_counts: dict[str, int] = {}
    for sess in sessions.values():
        uid = sess.get("user_id")
        if uid:
            session_counts[uid] = session_counts.get(uid, 0) + 1

    out = []
    for u in users_data.get("users", []):
        uid = u["id"]
        profile = await get_profile(uid)
        media_dir = MEDIA_DIR / uid
        out.append(
            {
                "id": uid,
                "name": u.get("name"),
                "created_at": u.get("created_at"),
                "display_name": profile.get("display_name"),
                "avatar": profile.get("avatar"),
                "online": uid in online,
                "session_count": session_counts.get(uid, 0),
                "media_bytes": _dir_size(media_dir),
                "media_size_human": _format_bytes(_dir_size(media_dir)),
            }
        )
    out.sort(key=lambda x: x.get("name", "").lower())
    return out


def _remove_user_media_tree(user_id: str) -> None:
    media_user = MEDIA_DIR / user_id
    if media_user.exists():
        shutil.rmtree(media_user, ignore_errors=True)


async def _remove_user_from_sessions(user_id: str) -> int:
    data = await get_sessions()
    sessions = data.get("sessions", {})
    to_del = [tok for tok, s in sessions.items() if s.get("user_id") == user_id]
    for tok in to_del:
        del sessions[tok]
    await save_sessions(data)
    return len(to_del)


async def _purge_dms_for_user(user_id: str) -> list[str]:
    purged = []
    if not CHATS_DIR.exists():
        return purged
    for path in CHATS_DIR.glob("dm_*.json"):
        chat_id = path.stem
        parts = chat_id.split("_")
        if len(parts) >= 3 and user_id in parts[1:]:
            chat = await get_chat(chat_id)
            await purge_chat_from_server(chat_id, chat)
            purged.append(chat_id)
    return purged


async def _handle_groups_for_user(user_id: str) -> list[str]:
    """Remove user from groups; purge group if empty."""
    affected = []
    if not GROUPS_DIR.exists():
        return affected
    for path in GROUPS_DIR.glob("*.json"):
        group = await read_json(path)
        members = group.get("members", [])
        if user_id not in members:
            continue
        group_id = group.get("group_id", path.stem)
        chat_id = f"group_{group_id}"
        members = [m for m in members if m != user_id]
        if not members:
            chat = await get_chat(chat_id)
            await purge_chat_from_server(chat_id, chat)
            for ev_path in EVENTS_DIR.glob("*.json") if EVENTS_DIR.exists() else []:
                ev = await read_json(ev_path)
                if ev.get("group_id") == group_id:
                    for post in ev.get("posts") or []:
                        _safe_unlink_media(post.get("media_path"))
                        _safe_unlink_media(post.get("thumb_path"))
                    try:
                        ev_path.unlink()
                    except OSError:
                        pass
            affected.append(chat_id)
        else:
            group["members"] = members
            await save_group(group)
            chat = await get_chat(chat_id)
            chat["members"] = members
            await save_chat(chat_id, chat)
            affected.append(chat_id)
    return affected


async def delete_user_completely(user_id: str) -> dict:
    users_data = await get_users()
    user = next((u for u in users_data.get("users", []) if u["id"] == user_id), None)
    if not user:
        raise ValueError("User not found")

    dms = await _purge_dms_for_user(user_id)
    groups = await _handle_groups_for_user(user_id)
    sessions_removed = await _remove_user_from_sessions(user_id)

    users_data["users"] = [u for u in users_data["users"] if u["id"] != user_id]
    await save_users(users_data)

    pp = profile_path(user_id)
    if pp.exists():
        profile = await get_profile(user_id)
        _safe_unlink_media(profile.get("avatar"))
        try:
            pp.unlink()
        except OSError:
            pass

    _remove_user_media_tree(user_id)

    invites = await read_json(INVITES_FILE, default={"invites": []})
    for inv in invites.get("invites", []):
        if inv.get("used_by") == user_id:
            inv["used_by"] = None
    await write_json(INVITES_FILE, invites)

    return {
        "ok": True,
        "user_id": user_id,
        "name": user.get("name"),
        "dms_purged": dms,
        "groups_affected": groups,
        "sessions_removed": sessions_removed,
    }


async def list_chats_admin() -> list[dict]:
    if not CHATS_DIR.exists():
        return []
    items = []
    for path in sorted(CHATS_DIR.glob("*.json")):
        chat = await read_json(path)
        chat_id = chat.get("chat_id", path.stem)
        messages = chat.get("messages", [])
        last = messages[-1] if messages else None
        items.append(
            {
                "chat_id": chat_id,
                "type": chat.get("type", "dm"),
                "name": chat.get("name"),
                "members": chat.get("members", []),
                "message_count": len(messages),
                "last_at": last.get("created_at") if last else None,
            }
        )
    items.sort(key=lambda x: x.get("last_at") or "", reverse=True)
    return items


async def delete_chat_admin(chat_id: str) -> dict:
    chat = await get_chat(chat_id)
    if not chat_path(chat_id).exists() and not chat.get("messages"):
        raise ValueError("Chat not found")
    await purge_chat_from_server(chat_id, chat)
    return {"ok": True, "chat_id": chat_id}


async def list_media_admin(user_id: str | None = None) -> list[dict]:
    if not MEDIA_DIR.exists():
        return []
    items = []
    roots = [MEDIA_DIR / user_id] if user_id else sorted(MEDIA_DIR.iterdir())
    for user_dir in roots:
        if not user_dir.is_dir():
            continue
        uid = user_dir.name
        for path in user_dir.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(BASE_DIR).as_posix()
            items.append(
                {
                    "path": rel,
                    "user_id": uid,
                    "media_type": path.parent.name if path.parent != user_dir else "",
                    "filename": path.name,
                    "size": path.stat().st_size,
                    "size_human": _format_bytes(path.stat().st_size),
                    "url": "/" + rel.replace("data/media/", "media/", 1)
                    if rel.startswith("data/media/")
                    else None,
                }
            )
    items.sort(key=lambda x: (x["user_id"], x["path"]))
    return items


def _validate_media_path(media_path: str) -> Path:
    if not media_path or not media_path.startswith("data/media/"):
        raise ValueError("Invalid media path")
    path = (BASE_DIR / media_path).resolve()
    root = MEDIA_DIR.resolve()
    if not str(path).startswith(str(root)) or not path.is_file():
        raise ValueError("Media file not found")
    return path


async def delete_media_admin(media_path: str) -> dict:
    path = _validate_media_path(media_path)
    path.unlink()
    return {"ok": True, "path": media_path}


async def delete_user_media_all(user_id: str) -> dict:
    media_user = MEDIA_DIR / user_id
    count = sum(1 for p in media_user.rglob("*") if p.is_file()) if media_user.exists() else 0
    _remove_user_media_tree(user_id)
    try:
        profile = await get_profile(user_id)
        profile["avatar"] = None
        await save_profile(user_id, profile)
    except Exception:
        pass
    return {"ok": True, "user_id": user_id, "files_removed": count}


async def clear_all_invites() -> dict:
    await write_json(INVITES_FILE, {"invites": []})
    return {"ok": True}


async def clear_upload_chunks() -> dict:
    removed = 0
    if CHUNKS_DIR.exists():
        for p in CHUNKS_DIR.rglob("*"):
            if p.is_file():
                try:
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
        for p in sorted(CHUNKS_DIR.rglob("*"), reverse=True):
            if p.is_dir():
                try:
                    p.rmdir()
                except OSError:
                    pass
    return {"ok": True, "files_removed": removed}


async def clear_all_user_sessions() -> dict:
    await write_json(SESSIONS_FILE, {"sessions": {}})
    return {"ok": True}


async def list_events_admin() -> list[dict]:
    if not EVENTS_DIR.exists():
        return []
    items = []
    for path in EVENTS_DIR.glob("*.json"):
        ev = await read_json(path)
        items.append(
            {
                "event_id": ev.get("event_id", path.stem),
                "group_id": ev.get("group_id"),
                "title": ev.get("title"),
                "created_by": ev.get("created_by"),
                "starts_at": ev.get("starts_at"),
                "post_count": len(ev.get("posts") or []),
            }
        )
    return items


async def delete_event_admin(event_id: str) -> dict:
    from app.routers.events import _purge_event_posts_media

    path = EVENTS_DIR / f"{event_id}.json"
    if not path.exists():
        raise ValueError("Event not found")
    ev = await read_json(path)
    _purge_event_posts_media(ev)
    path.unlink()
    return {"ok": True, "event_id": event_id}


async def create_bootstrap_invite() -> dict:
    return await create_invite(created_by=None)
