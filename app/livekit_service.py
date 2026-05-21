"""LiveKit access tokens for SFU group calls."""

from __future__ import annotations

import os

from app.storage import get_profile


def livekit_enabled() -> bool:
    return bool(
        os.getenv("LIVEKIT_URL")
        and os.getenv("LIVEKIT_API_KEY")
        and os.getenv("LIVEKIT_API_SECRET")
    )


def livekit_public_config() -> dict:
    return {
        "enabled": livekit_enabled(),
        "url": os.getenv("LIVEKIT_URL", "").strip() or None,
    }


async def create_room_token(
    *,
    user_id: str,
    user_name: str,
    room_name: str,
    video: bool = False,
) -> str:
    if not livekit_enabled():
        raise RuntimeError("LiveKit is not configured")

    from livekit import api

    api_key = os.getenv("LIVEKIT_API_KEY", "")
    api_secret = os.getenv("LIVEKIT_API_SECRET", "")
    profile = await get_profile(user_id)
    display = profile.get("display_name") or user_name or user_id

    grants = api.VideoGrants(
        room_join=True,
        room=room_name,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    token = (
        api.AccessToken(api_key, api_secret)
        .with_identity(user_id)
        .with_name(display)
        .with_grants(grants)
    )
    return token.to_jwt()

