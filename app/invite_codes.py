"""Short-lived invite codes for registration."""

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from app.config import INVITE_TTL_SECONDS, INVITES_FILE, PERMANENT_INVITE_FILE
from app.storage import read_json, write_json

logger = logging.getLogger("homies")

INVITE_CODE_LENGTH = 4


def _now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_invite_code(code: str) -> str:
    return "".join(c for c in (code or "") if c.isdigit())


def _generate_code() -> str:
    return f"{secrets.randbelow(10**INVITE_CODE_LENGTH):04d}"


async def _load_invites() -> dict:
    data = await read_json(INVITES_FILE, default={"invites": []})
    if "invites" not in data:
        data["invites"] = []
    return data


async def _save_invites(data: dict) -> None:
    await write_json(INVITES_FILE, data)


def _purge_expired(data: dict) -> None:
    now = _now()
    kept = []
    for inv in data.get("invites", []):
        if inv.get("used_at"):
            kept.append(inv)
            continue
        exp = inv.get("expires_at")
        if not exp:
            continue
        try:
            expires = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        except ValueError:
            continue
        if expires > now:
            kept.append(inv)
    data["invites"] = kept


async def create_invite(created_by: str | None = None) -> dict:
    """Create a new invite code valid for INVITE_TTL_SECONDS."""
    data = await _load_invites()
    _purge_expired(data)

    now = _now()
    expires = now + timedelta(seconds=INVITE_TTL_SECONDS)
    code = _generate_code()
    entry = {
        "code": code,
        "created_by": created_by,
        "created_at": now.isoformat(),
        "expires_at": expires.isoformat(),
        "used_at": None,
        "used_by": None,
    }
    data["invites"].append(entry)
    await _save_invites(data)

    return {
        "code": code,
        "expires_at": entry["expires_at"],
        "expires_in_seconds": INVITE_TTL_SECONDS,
    }


async def get_permanent_invite() -> dict:
    """Admin-configured reusable registration code (optional)."""
    data = await read_json(
        PERMANENT_INVITE_FILE,
        default={"enabled": False, "code": None, "set_at": None},
    )
    return {
        "enabled": bool(data.get("enabled") and data.get("code")),
        "code": data.get("code"),
        "set_at": data.get("set_at"),
    }


async def set_permanent_invite(code: str | None) -> dict:
    """
    Set or clear the permanent invite code.
    Pass None or empty string to disable. Otherwise exactly 4 digits.
    """
    if not code or not str(code).strip():
        await write_json(
            PERMANENT_INVITE_FILE,
            {"enabled": False, "code": None, "set_at": None, "set_by": None},
        )
        return await get_permanent_invite()

    normalized = normalize_invite_code(code)
    if len(normalized) != INVITE_CODE_LENGTH:
        raise ValueError("Permanent invite must be exactly 4 digits")

    payload = {
        "enabled": True,
        "code": normalized,
        "set_at": _now().isoformat(),
        "set_by": "admin",
    }
    await write_json(PERMANENT_INVITE_FILE, payload)
    logger.info("Permanent invite code updated (reusable registration)")
    return await get_permanent_invite()


async def _matches_permanent_invite(normalized: str) -> bool:
    perm = await get_permanent_invite()
    return perm["enabled"] and perm.get("code") == normalized


async def consume_invite(code: str, used_by: str | None = None) -> None:
    """Validate registration code (permanent or one-time). Raises HTTPException if invalid."""
    normalized = normalize_invite_code(code)
    if len(normalized) != INVITE_CODE_LENGTH:
        raise HTTPException(status_code=400, detail="Invalid invite code")

    if await _matches_permanent_invite(normalized):
        logger.info(
            "Registration via permanent invite%s",
            f" (user {used_by})" if used_by else "",
        )
        return

    data = await _load_invites()
    _purge_expired(data)
    now = _now()

    invite = next(
        (i for i in data.get("invites", []) if i.get("code") == normalized and not i.get("used_at")),
        None,
    )
    if not invite:
        raise HTTPException(status_code=400, detail="Invalid or expired invite code")

    try:
        expires = datetime.fromisoformat(invite["expires_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid or expired invite code") from None

    if expires <= now:
        raise HTTPException(status_code=400, detail="Invite code has expired")

    invite["used_at"] = now.isoformat()
    if used_by:
        invite["used_by"] = used_by
    await _save_invites(data)


async def issue_startup_invite() -> str:
    """One bootstrap invite logged when the server starts."""
    inv = await create_invite(created_by=None)
    code = inv["code"]
    logger.info(
        "HomieLog startup invite code: %s (valid %s minutes)",
        code,
        INVITE_TTL_SECONDS // 60,
    )
    print(
        f"\n{'=' * 52}\n"
        f"  HOMIES INVITE CODE (valid 10 min): {code}\n"
        f"{'=' * 52}\n",
        flush=True,
    )
    return code
