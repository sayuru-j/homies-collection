"""Process uptime and host metadata for admin dashboard."""

import platform
import sys
import time
from datetime import datetime, timezone

_START_MONO = time.monotonic()
_START_AT = datetime.now(timezone.utc)


def get_uptime_seconds() -> float:
    return time.monotonic() - _START_MONO


def format_uptime(seconds: float) -> str:
    s = int(seconds)
    days, s = divmod(s, 86400)
    hours, s = divmod(s, 3600)
    minutes, s = divmod(s, 60)
    parts = []
    if days:
        parts.append(f"{days}d")
    if hours or days:
        parts.append(f"{hours}h")
    parts.append(f"{minutes}m")
    parts.append(f"{s}s")
    return " ".join(parts)


def get_system_info() -> dict:
    return {
        "started_at": _START_AT.isoformat(),
        "uptime_seconds": round(get_uptime_seconds(), 1),
        "uptime_human": format_uptime(get_uptime_seconds()),
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "hostname": platform.node(),
    }
