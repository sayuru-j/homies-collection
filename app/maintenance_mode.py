"""Server maintenance mode — blocks public app while admin stays available."""

from datetime import datetime, timezone
from pathlib import Path

from app.config import DATA_DIR
from app.storage import read_json, write_json

MAINTENANCE_FILE = DATA_DIR / ".maintenance.json"

DEFAULT_MESSAGE = "HomieLog is temporarily offline for maintenance. Please try again shortly."


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def get_maintenance_state() -> dict:
    data = await read_json(MAINTENANCE_FILE, default={"enabled": False})
    return {
        "enabled": bool(data.get("enabled")),
        "message": data.get("message") or DEFAULT_MESSAGE,
        "enabled_at": data.get("enabled_at"),
        "enabled_by": data.get("enabled_by"),
    }


async def set_maintenance(enabled: bool, message: str | None = None) -> dict:
    if enabled:
        data = {
            "enabled": True,
            "message": (message or DEFAULT_MESSAGE).strip()[:500],
            "enabled_at": _now(),
            "enabled_by": "admin",
        }
    else:
        data = {"enabled": False, "message": None, "enabled_at": None, "enabled_by": None}
    await write_json(MAINTENANCE_FILE, data)
    return await get_maintenance_state()


async def is_maintenance_enabled() -> bool:
    state = await get_maintenance_state()
    return state["enabled"]


def path_allowed_during_maintenance(path: str) -> bool:
    """Routes that stay up while maintenance mode is on."""
    if path.startswith("/api/admin"):
        return True
    if path == "/admin" or path.startswith("/static/admin"):
        return True
    if path == "/api/admin/login":
        return True
    return False
