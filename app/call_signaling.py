"""Relay WebRTC call signaling between connected users."""

from app.auth import get_user_by_id
from app.chat_soft_delete import get_chat_member_ids
from app.presence import manager
from app.storage import get_chat, get_profile

CALL_CLIENT_TYPES = frozenset(
    {
        "call_invite",
        "call_offer",
        "call_answer",
        "call_ice",
        "call_reject",
        "call_end",
        "call_cancel",
        "call_busy",
        "call_recording_start",
        "call_recording_stop",
    }
)


async def _peers_share_group_chat(sender_id: str, to_user_id: str, chat_id: str | None) -> bool:
    if not chat_id or not chat_id.startswith("group_"):
        return True
    chat = await get_chat(chat_id)
    if not chat:
        return False
    member_ids = await get_chat_member_ids(chat_id, chat)
    return sender_id in member_ids and to_user_id in member_ids


async def relay_call_signal(sender: dict, data: dict) -> None:
    to_user_id = data.get("to_user_id")
    if not to_user_id or to_user_id == sender["id"]:
        return

    if not await _peers_share_group_chat(sender["id"], to_user_id, data.get("chat_id")):
        return

    peer = await get_user_by_id(to_user_id)
    if not peer:
        return

    msg_type = data.get("type")
    call_id = data.get("call_id")
    base = {"call_id": call_id, "from_user_id": sender["id"]}

    if msg_type == "call_invite":
        if not manager.is_online(to_user_id):
            await manager.send_to_user(
                sender["id"],
                {
                    "type": "call_busy",
                    "call_id": call_id,
                    "from_user_id": to_user_id,
                    "chat_id": data.get("chat_id"),
                    "reason": "offline",
                },
            )
            return
        profile = await get_profile(sender["id"])
        payload = {
            "type": "call_incoming",
            "chat_id": data.get("chat_id"),
            "from_name": profile.get("display_name") or sender["name"],
            "call_mode": data.get("call_mode") or "voice",
            **base,
        }
        if data.get("sdp") is not None:
            payload["sdp"] = data["sdp"]
        await manager.send_to_user(to_user_id, payload)
        return

    if msg_type in ("call_offer", "call_answer", "call_ice"):
        profile = await get_profile(sender["id"])
        payload = {
            "type": msg_type,
            **base,
            "from_name": profile.get("display_name") or sender["name"],
        }
        if data.get("chat_id"):
            payload["chat_id"] = data["chat_id"]
        if data.get("call_mode"):
            payload["call_mode"] = data["call_mode"]
        if data.get("sdp") is not None:
            payload["sdp"] = data["sdp"]
        if data.get("candidate") is not None:
            payload["candidate"] = data["candidate"]
        await manager.send_to_user(to_user_id, payload)
        return

    if msg_type in ("call_recording_start", "call_recording_stop"):
        profile = await get_profile(sender["id"])
        payload = {
            "type": msg_type,
            **base,
            "from_name": profile.get("display_name") or sender["name"],
        }
        if data.get("chat_id"):
            payload["chat_id"] = data["chat_id"]
        await manager.send_to_user(to_user_id, payload)
        return

    if msg_type in ("call_reject", "call_end", "call_cancel", "call_busy"):
        payload = {"type": msg_type, **base, "reason": data.get("reason")}
        if data.get("chat_id"):
            payload["chat_id"] = data["chat_id"]
        await manager.send_to_user(to_user_id, payload)
