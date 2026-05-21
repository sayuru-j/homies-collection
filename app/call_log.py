"""Persist completed calls as system messages in chat history."""

from datetime import datetime, timezone

from app.chat_soft_delete import get_chat_member_ids
from app.presence import manager
from app.storage import get_chat, new_id, save_chat


def format_call_log_message(duration_sec: int, call_mode: str) -> str:
    kind = "video" if call_mode == "video" else "voice"
    if duration_sec < 60:
        word = "second" if duration_sec == 1 else "seconds"
        return f"{duration_sec} {word} {kind} call —"
    minutes, seconds = divmod(duration_sec, 60)
    if minutes < 60:
        return f"{minutes}:{seconds:02d} {kind} call —"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02d}:{seconds:02d} {kind} call —"


async def record_call_in_chat(
    chat_id: str,
    user_id: str,
    duration_sec: int,
    call_mode: str = "voice",
    call_id: str | None = None,
) -> dict | None:
    if not chat_id or duration_sec < 1:
        return None

    chat = await get_chat(chat_id)
    members = await get_chat_member_ids(chat_id, chat)
    if user_id not in members:
        return None

    if call_id:
        for existing in reversed(chat.get("messages", [])[-40:]):
            if existing.get("message_type") == "system" and existing.get("call_id") == call_id:
                return None

    if not chat.get("members"):
        chat["members"] = members
        if chat_id.startswith("dm_"):
            chat["type"] = "dm"

    msg = {
        "id": new_id(),
        "sender_id": None,
        "content": format_call_log_message(duration_sec, call_mode),
        "message_type": "system",
        "media_path": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if call_id:
        msg["call_id"] = call_id
    chat.setdefault("messages", []).append(msg)
    await save_chat(chat_id, chat)

    payload = {"type": "message", "chat_id": chat_id, "message": msg}
    await manager.send_to_users(members, payload)
    return msg
