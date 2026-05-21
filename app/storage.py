import json
import uuid
from pathlib import Path
from typing import Any

import aiofiles

from app.config import (
    AUTH_DIR,
    CHATS_DIR,
    CHUNKS_DIR,
    DATA_DIR,
    DEFAULT_MEDIA_COMPRESSION_PERCENT,
    EVENTS_DIR,
    GROUPS_DIR,
    MEDIA_DIR,
    PROFILES_DIR,
    SESSIONS_FILE,
    USERS_FILE,
)


def _ensure_dirs() -> None:
    for d in (
        DATA_DIR,
        AUTH_DIR,
        PROFILES_DIR,
        CHATS_DIR,
        GROUPS_DIR,
        EVENTS_DIR,
        MEDIA_DIR,
        CHUNKS_DIR,
    ):
        d.mkdir(parents=True, exist_ok=True)


async def read_json(path: Path, default: Any = None) -> Any:
    _ensure_dirs()
    if not path.exists():
        return default if default is not None else {}
    async with aiofiles.open(path, "r", encoding="utf-8") as f:
        content = await f.read()
        if not content.strip():
            return default if default is not None else {}
        return json.loads(content)


async def write_json(path: Path, data: Any) -> None:
    _ensure_dirs()
    path.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(path, "w", encoding="utf-8") as f:
        await f.write(json.dumps(data, indent=2, ensure_ascii=False))


def new_id() -> str:
    return str(uuid.uuid4())


# --- Auth ---

async def get_users() -> dict:
    return await read_json(USERS_FILE, default={"users": []})


async def save_users(data: dict) -> None:
    await write_json(USERS_FILE, data)


async def get_sessions() -> dict:
    return await read_json(SESSIONS_FILE, default={"sessions": {}})


async def save_sessions(data: dict) -> None:
    await write_json(SESSIONS_FILE, data)


# --- Profiles ---

def profile_path(user_id: str) -> Path:
    return PROFILES_DIR / f"{user_id}.json"


async def get_profile(user_id: str) -> dict:
    default = {
        "user_id": user_id,
        "display_name": "",
        "avatar": None,
        "settings": {"media_compression_percent": DEFAULT_MEDIA_COMPRESSION_PERCENT},
    }
    data = await read_json(profile_path(user_id), default=default)
    data.setdefault("user_id", user_id)
    return data


async def save_profile(user_id: str, profile: dict) -> None:
    await write_json(profile_path(user_id), profile)


# --- Chats ---

def chat_path(chat_id: str) -> Path:
    return CHATS_DIR / f"{chat_id}.json"


async def get_chat(chat_id: str) -> dict:
    default = {"chat_id": chat_id, "type": "dm", "members": [], "messages": []}
    data = await read_json(chat_path(chat_id), default=default)
    data.setdefault("chat_id", chat_id)
    return data


async def save_chat(chat_id: str, chat: dict) -> None:
    await write_json(chat_path(chat_id), chat)


def dm_chat_id(user_a: str, user_b: str) -> str:
    a, b = sorted([user_a, user_b])
    return f"dm_{a}_{b}"


# --- Groups ---

def group_path(group_id: str) -> Path:
    return GROUPS_DIR / f"{group_id}.json"


async def get_group(group_id: str) -> dict | None:
    path = group_path(group_id)
    if not path.exists():
        return None
    return await read_json(path)


async def save_group(group: dict) -> None:
    await write_json(group_path(group["group_id"]), group)


async def list_groups_for_user(user_id: str) -> list[dict]:
    _ensure_dirs()
    groups = []
    for path in GROUPS_DIR.glob("*.json"):
        g = await read_json(path)
        if user_id in g.get("members", []):
            groups.append(g)
    return groups


# --- Events ---

def event_path(event_id: str) -> Path:
    return EVENTS_DIR / f"{event_id}.json"


async def get_event(event_id: str) -> dict | None:
    path = event_path(event_id)
    if not path.exists():
        return None
    return await read_json(path)


async def save_event(event: dict) -> None:
    await write_json(event_path(event["event_id"]), event)


async def delete_event_file(event_id: str) -> None:
    path = event_path(event_id)
    if path.exists():
        path.unlink()


async def list_all_events() -> list[dict]:
    _ensure_dirs()
    events = []
    for path in EVENTS_DIR.glob("*.json"):
        events.append(await read_json(path))
    return events


async def list_events_for_user(user_id: str) -> list[dict]:
    member_group_ids = {g["group_id"] for g in await list_groups_for_user(user_id)}
    events = []
    for ev in await list_all_events():
        if ev.get("group_id") in member_group_ids:
            events.append(ev)
    return events
