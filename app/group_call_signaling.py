"""Fan-out group call invites and room lifecycle over WebSocket."""

from app.config import GROUP_CALLS_ENABLED
from app.chat_soft_delete import get_chat_member_ids
from app.presence import manager
from app.storage import get_chat, get_profile

GROUP_CALL_CLIENT_TYPES = frozenset(
    {
        "call_room_invite",
        "call_room_end",
        "call_mesh_invite",
        "call_mesh_join",
        "call_mesh_end",
    }
)


def _online_member_ids(member_ids: list[str], exclude_id: str | None = None) -> list[str]:
    return [
        uid
        for uid in member_ids
        if uid != exclude_id and manager.is_online(uid)
    ]


async def _membership_ok(sender_id: str, chat_id: str) -> list[str] | None:
    if not chat_id or not chat_id.startswith("group_"):
        return None
    chat = await get_chat(chat_id)
    if not chat:
        return None
    member_ids = await get_chat_member_ids(chat_id, chat)
    if sender_id not in member_ids:
        return None
    return member_ids


async def relay_group_call_signal(sender: dict, data: dict) -> None:
    if not GROUP_CALLS_ENABLED:
        return
    chat_id = data.get("chat_id")
    member_ids = await _membership_ok(sender["id"], chat_id)
    if not member_ids:
        return

    msg_type = data.get("type")
    call_id = data.get("call_id")
    base = {
        "call_id": call_id,
        "chat_id": chat_id,
        "from_user_id": sender["id"],
        "room_name": chat_id,
    }

    if msg_type == "call_room_invite":
        profile = await get_profile(sender["id"])
        payload = {
            "type": "call_room_incoming",
            "call_mode": data.get("call_mode") or "voice",
            "from_name": profile.get("display_name") or sender["name"],
            **base,
        }
        targets = _online_member_ids(member_ids, sender["id"])
        if targets:
            await manager.send_to_users(targets, payload)
        return

    if msg_type == "call_room_end":
        payload = {
            "type": "call_room_ended",
            "reason": data.get("reason") or "ended",
            **base,
        }
        await manager.send_to_users(member_ids, payload)
        return

    if msg_type == "call_mesh_invite":
        profile = await get_profile(sender["id"])
        payload = {
            "type": "call_mesh_incoming",
            "call_mode": data.get("call_mode") or "voice",
            "from_name": profile.get("display_name") or sender["name"],
            **base,
        }
        targets = _online_member_ids(member_ids, sender["id"])
        if targets:
            await manager.send_to_users(targets, payload)
        return

    if msg_type == "call_mesh_join":
        profile = await get_profile(sender["id"])
        payload = {
            "type": "call_mesh_peer_joined",
            "peer_id": sender["id"],
            "peer_name": profile.get("display_name") or sender["name"],
            "call_mode": data.get("call_mode") or "voice",
            **base,
        }
        targets = _online_member_ids(member_ids, sender["id"])
        if targets:
            await manager.send_to_users(targets, payload)
        return

    if msg_type == "call_mesh_end":
        payload = {
            "type": "call_mesh_ended",
            "reason": data.get("reason") or "ended",
            **base,
        }
        await manager.send_to_users(member_ids, payload)
