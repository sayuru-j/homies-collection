from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.auth import get_user_by_id
from app.call_signaling import CALL_CLIENT_TYPES, relay_call_signal
from app.group_call_signaling import GROUP_CALL_CLIENT_TYPES, relay_group_call_signal
from app.stranger_danger import SD_CLIENT_TYPES, relay_sd_signal
from app.stranger_danger import sd_manager
from app.storage import get_sessions

router = APIRouter(tags=["websocket"])


async def _user_from_token(token: str) -> dict | None:
    sessions = await get_sessions()
    session = sessions.get("sessions", {}).get(token)
    if not session:
        return None
    user = await get_user_by_id(session["user_id"])
    if not user:
        return None
    return {"id": user["id"], "name": user["name"]}


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    from app.presence import manager

    token = websocket.cookies.get("session") or websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4001)
        return

    user = await _user_from_token(token)
    if not user:
        await websocket.close(code=4001)
        return

    await manager.connect(user["id"], websocket)
    try:
        await websocket.send_json(
            {"type": "connected", "user_id": user["id"], "online": manager.online_user_ids()}
        )
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            if msg_type == "ping":
                await websocket.send_json({"type": "pong"})
            elif msg_type in CALL_CLIENT_TYPES:
                await relay_call_signal(user, data)
            elif msg_type in GROUP_CALL_CLIENT_TYPES:
                await relay_group_call_signal(user, data)
            elif msg_type in SD_CLIENT_TYPES:
                await relay_sd_signal(user, data)
    except WebSocketDisconnect:
        pass
    finally:
        uid = manager.disconnect(websocket)
        if uid:
            from app.location import location_manager

            if location_manager.clear_user(uid):
                await location_manager.broadcast_stopped(uid)
            await sd_manager.on_disconnect(uid)
            await manager.broadcast_presence()
