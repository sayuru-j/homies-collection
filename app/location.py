"""In-memory live location sharing while users have Beam on."""

from __future__ import annotations

import time
from typing import Any

from app.presence import manager
from app.storage import get_profile, get_users

# Drop stale positions after this many seconds without an update.
LOCATION_TTL_SEC = 300


class LocationManager:
    def __init__(self) -> None:
        # user_id -> {lat, lng, accuracy?, updated_at, beaming}
        self._live: dict[str, dict[str, Any]] = {}

    def _now(self) -> float:
        return time.time()

    def is_beaming(self, user_id: str) -> bool:
        entry = self._live.get(user_id)
        return bool(entry and entry.get("beaming"))

    def set_beaming(
        self,
        user_id: str,
        *,
        active: bool,
        lat: float | None = None,
        lng: float | None = None,
        accuracy: float | None = None,
    ) -> dict[str, Any] | None:
        if not active:
            self._live.pop(user_id, None)
            return None
        if lat is None or lng is None:
            raise ValueError("lat and lng required when starting beam")
        entry = {
            "lat": lat,
            "lng": lng,
            "accuracy": accuracy,
            "updated_at": self._now(),
            "beaming": True,
        }
        self._live[user_id] = entry
        return dict(entry)

    def update_position(
        self,
        user_id: str,
        *,
        lat: float,
        lng: float,
        accuracy: float | None = None,
    ) -> dict[str, Any] | None:
        entry = self._live.get(user_id)
        if not entry or not entry.get("beaming"):
            return None
        entry["lat"] = lat
        entry["lng"] = lng
        if accuracy is not None:
            entry["accuracy"] = accuracy
        entry["updated_at"] = self._now()
        return dict(entry)

    def clear_user(self, user_id: str) -> bool:
        if user_id in self._live:
            del self._live[user_id]
            return True
        return False

    def _is_fresh(self, entry: dict[str, Any]) -> bool:
        updated = entry.get("updated_at") or 0
        return (self._now() - updated) <= LOCATION_TTL_SEC

    async def _user_public(self, user_id: str) -> dict[str, Any] | None:
        users = await get_users()
        for u in users.get("users", []):
            if u["id"] == user_id:
                profile = await get_profile(user_id)
                return {
                    "id": user_id,
                    "name": u["name"],
                    "display_name": profile.get("display_name") or u["name"],
                    "avatar": profile.get("avatar"),
                }
        return None

    async def _allows_share(self, user_id: str) -> bool:
        profile = await get_profile(user_id)
        settings = profile.get("settings") or {}
        return bool(settings.get("location_share_allowed"))

    async def build_marker(self, user_id: str) -> dict[str, Any] | None:
        entry = self._live.get(user_id)
        if not entry or not entry.get("beaming") or not self._is_fresh(entry):
            return None
        if not await self._allows_share(user_id):
            return None
        pub = await self._user_public(user_id)
        if not pub:
            return None
        return {
            **pub,
            "lat": entry["lat"],
            "lng": entry["lng"],
            "accuracy": entry.get("accuracy"),
            "updated_at": entry["updated_at"],
            "online": manager.is_online(user_id),
        }

    async def list_visible(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for user_id in list(self._live.keys()):
            marker = await self.build_marker(user_id)
            if marker:
                out.append(marker)
        return out

    async def broadcast_update(self, user_id: str) -> None:
        marker = await self.build_marker(user_id)
        if marker:
            await manager.broadcast_all({"type": "location_update", "location": marker})
        else:
            await self.broadcast_stopped(user_id)

    async def broadcast_stopped(self, user_id: str) -> None:
        await manager.broadcast_all({"type": "location_stopped", "user_id": user_id})


location_manager = LocationManager()
