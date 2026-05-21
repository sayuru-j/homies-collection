"""StrangerDanger 1:1 video queue and WebRTC signaling (separate from HomieLog calls)."""

from app.auth import get_user_by_id
from app.presence import manager
from app.storage import get_profile, new_id

SD_CLIENT_TYPES = frozenset(
    {
        "sd_join_queue",
        "sd_leave_queue",
        "sd_skip",
        "sd_offer",
        "sd_answer",
        "sd_ice",
    }
)


class StrangerDangerManager:
    def __init__(self) -> None:
        self._queue: list[str] = []
        self._in_queue: set[str] = set()
        self._sessions: dict[str, tuple[str, str]] = {}
        self._user_session: dict[str, str] = {}

    def _queue_position(self, user_id: str) -> int:
        try:
            return self._queue.index(user_id) + 1
        except ValueError:
            return 0

    async def _send(self, user_id: str, payload: dict) -> None:
        await manager.send_to_user(user_id, payload)

    async def _peer_profile_name(self, user_id: str) -> str:
        user = await get_user_by_id(user_id)
        if not user:
            return "Stranger"
        profile = await get_profile(user_id)
        return profile.get("display_name") or user["name"]

    def _remove_from_queue(self, user_id: str) -> None:
        self._in_queue.discard(user_id)
        self._queue = [uid for uid in self._queue if uid != user_id]

    async def _notify_matched(self, session_id: str, user_a: str, user_b: str) -> None:
        name_b_for_a = await self._peer_profile_name(user_b)
        name_a_for_b = await self._peer_profile_name(user_a)
        await self._send(
            user_a,
            {
                "type": "sd_matched",
                "session_id": session_id,
                "peer_id": user_b,
                "peer_name": name_b_for_a,
                "is_initiator": user_a < user_b,
            },
        )
        await self._send(
            user_b,
            {
                "type": "sd_matched",
                "session_id": session_id,
                "peer_id": user_a,
                "peer_name": name_a_for_b,
                "is_initiator": user_b < user_a,
            },
        )

    async def _try_match(self) -> None:
        while len(self._queue) >= 2:
            user_a = self._queue.pop(0)
            while self._queue and self._queue[0] == user_a:
                self._queue.pop(0)
            if not self._queue:
                if user_a in self._in_queue:
                    self._queue.append(user_a)
                break
            user_b = self._queue.pop(0)
            if user_a == user_b:
                continue
            if user_a not in self._in_queue or user_b not in self._in_queue:
                if user_a in self._in_queue:
                    self._queue.insert(0, user_a)
                if user_b in self._in_queue:
                    self._queue.insert(0, user_b)
                continue
            self._in_queue.discard(user_a)
            self._in_queue.discard(user_b)
            session_id = new_id()
            self._sessions[session_id] = (user_a, user_b)
            self._user_session[user_a] = session_id
            self._user_session[user_b] = session_id
            await self._notify_matched(session_id, user_a, user_b)

    async def join_queue(self, user_id: str) -> None:
        if user_id in self._user_session:
            sid = self._user_session[user_id]
            pair = self._sessions.get(sid)
            if pair:
                peer = pair[1] if pair[0] == user_id else pair[0]
                await self._send(
                    user_id,
                    {
                        "type": "sd_matched",
                        "session_id": sid,
                        "peer_id": peer,
                        "peer_name": await self._peer_profile_name(peer),
                        "is_initiator": user_id < peer,
                    },
                )
            return
        if user_id in self._in_queue:
            await self._send(
                user_id,
                {"type": "sd_queued", "position": self._queue_position(user_id)},
            )
            return
        self._in_queue.add(user_id)
        self._queue.append(user_id)
        await self._send(
            user_id,
            {"type": "sd_queued", "position": self._queue_position(user_id)},
        )
        await self._try_match()

    async def leave_queue(self, user_id: str) -> None:
        self._remove_from_queue(user_id)
        await self._end_session_for(user_id, reason="left", notify_self=False)

    async def skip(self, user_id: str) -> None:
        await self._end_session_for(user_id, reason="skipped", notify_self=False)
        await self.join_queue(user_id)

    async def _end_session_for(
        self, user_id: str, reason: str = "ended", notify_self: bool = True
    ) -> None:
        self._remove_from_queue(user_id)
        session_id = self._user_session.pop(user_id, None)
        if not session_id:
            return
        pair = self._sessions.pop(session_id, None)
        if not pair:
            return
        other = pair[1] if pair[0] == user_id else pair[0]
        self._user_session.pop(other, None)
        if notify_self:
            await self._send(user_id, {"type": "sd_ended", "reason": reason})
        await self._send(other, {"type": "sd_ended", "reason": reason})

    def _session_peer(self, user_id: str) -> str | None:
        session_id = self._user_session.get(user_id)
        if not session_id:
            return None
        pair = self._sessions.get(session_id)
        if not pair:
            return None
        return pair[1] if pair[0] == user_id else pair[0]

    async def relay_signal(self, sender: dict, data: dict) -> None:
        msg_type = data.get("type")
        sender_id = sender["id"]

        if msg_type == "sd_join_queue":
            await self.join_queue(sender_id)
            return
        if msg_type == "sd_leave_queue":
            await self.leave_queue(sender_id)
            return
        if msg_type == "sd_skip":
            await self.skip(sender_id)
            return

        peer_id = self._session_peer(sender_id)
        if not peer_id:
            return

        base = {
            "session_id": data.get("session_id") or self._user_session.get(sender_id),
            "from_user_id": sender_id,
        }

        if msg_type == "sd_offer":
            payload = {"type": "sd_offer", **base}
            if data.get("sdp") is not None:
                payload["sdp"] = data["sdp"]
            await self._send(peer_id, payload)
            return

        if msg_type == "sd_answer":
            payload = {"type": "sd_answer", **base}
            if data.get("sdp") is not None:
                payload["sdp"] = data["sdp"]
            await self._send(peer_id, payload)
            return

        if msg_type == "sd_ice":
            payload = {"type": "sd_ice", **base}
            if data.get("candidate") is not None:
                payload["candidate"] = data["candidate"]
            await self._send(peer_id, payload)

    async def on_disconnect(self, user_id: str) -> None:
        await self.leave_queue(user_id)


sd_manager = StrangerDangerManager()


async def relay_sd_signal(sender: dict, data: dict) -> None:
    await sd_manager.relay_signal(sender, data)
