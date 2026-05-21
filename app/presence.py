from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        # user_id -> set of websockets (multiple tabs)
        self.active: dict[str, set[WebSocket]] = {}
        self.ws_to_user: dict[WebSocket, str] = {}

    def is_online(self, user_id: str) -> bool:
        return user_id in self.active and len(self.active[user_id]) > 0

    def online_user_ids(self) -> list[str]:
        return [uid for uid, conns in self.active.items() if conns]

    async def connect(self, user_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active.setdefault(user_id, set()).add(websocket)
        self.ws_to_user[websocket] = user_id
        await self.broadcast_presence()

    def disconnect(self, websocket: WebSocket) -> str | None:
        user_id = self.ws_to_user.pop(websocket, None)
        if user_id and user_id in self.active:
            self.active[user_id].discard(websocket)
            if not self.active[user_id]:
                del self.active[user_id]
        return user_id

    async def broadcast_presence(self) -> None:
        online = self.online_user_ids()
        msg = {"type": "presence", "online": online}
        await self.broadcast_all(msg)

    async def send_to_user(self, user_id: str, message: dict) -> None:
        for ws in list(self.active.get(user_id, [])):
            try:
                await ws.send_json(message)
            except Exception:
                pass

    async def send_to_users(self, user_ids: list[str], message: dict) -> None:
        for uid in user_ids:
            await self.send_to_user(uid, message)

    async def broadcast_all(self, message: dict) -> None:
        for user_id in list(self.active.keys()):
            await self.send_to_user(user_id, message)

    async def disconnect_user(self, user_id: str, reason: str = "admin_disconnect") -> int:
        """Close all WebSocket connections for a user."""
        closed = 0
        for ws in list(self.active.get(user_id, [])):
            try:
                await ws.close(code=4000, reason=reason[:120])
                closed += 1
            except Exception:
                pass
            self.ws_to_user.pop(ws, None)
        if user_id in self.active:
            del self.active[user_id]
        if closed:
            await self.broadcast_presence()
        return closed


manager = ConnectionManager()
