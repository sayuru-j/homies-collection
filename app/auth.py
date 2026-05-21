import hashlib
import secrets
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request

from app.storage import get_sessions, get_users, new_id, save_sessions, save_users


def _hash_pin(pin: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{pin}".encode()).hexdigest()


async def register_user(name: str, pin: str, invite_code: str) -> dict:
    from app.invite_codes import consume_invite

    name_key = name.strip().lower()
    data = await get_users()
    users = data.get("users", [])

    if any(u["name_lower"] == name_key for u in users):
        raise HTTPException(status_code=400, detail="Name already taken")

    user_id = new_id()
    await consume_invite(invite_code, used_by=user_id)

    salt = secrets.token_hex(16)
    user = {
        "id": user_id,
        "name": name.strip(),
        "name_lower": name_key,
        "pin_hash": _hash_pin(pin, salt),
        "salt": salt,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    users.append(user)
    data["users"] = users
    await save_users(data)
    return {"id": user["id"], "name": user["name"]}


async def login_user(name: str, pin: str) -> tuple[dict, str]:
    name_key = name.strip().lower()
    data = await get_users()
    user = next((u for u in data.get("users", []) if u["name_lower"] == name_key), None)

    if not user or _hash_pin(pin, user["salt"]) != user["pin_hash"]:
        raise HTTPException(status_code=401, detail="Invalid name or PIN")

    token = secrets.token_urlsafe(32)
    sessions = await get_sessions()
    sessions["sessions"][token] = {
        "user_id": user["id"],
        "name": user["name"],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await save_sessions(sessions)
    return {"id": user["id"], "name": user["name"]}, token


async def get_user_by_id(user_id: str) -> dict | None:
    data = await get_users()
    return next((u for u in data.get("users", []) if u["id"] == user_id), None)


async def change_user_pin(user_id: str, current_pin: str, new_pin: str) -> None:
    data = await get_users()
    users = data.get("users", [])
    user = next((u for u in users if u["id"] == user_id), None)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if _hash_pin(current_pin, user["salt"]) != user["pin_hash"]:
        raise HTTPException(status_code=400, detail="Current PIN is incorrect")

    salt = secrets.token_hex(16)
    user["salt"] = salt
    user["pin_hash"] = _hash_pin(new_pin, salt)
    await save_users(data)


async def get_current_user(request: Request) -> dict:
    token = request.cookies.get("session") or request.headers.get("X-Session-Token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    sessions = await get_sessions()
    session = sessions.get("sessions", {}).get(token)
    if not session:
        raise HTTPException(status_code=401, detail="Invalid session")

    user = await get_user_by_id(session["user_id"])
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return {"id": user["id"], "name": user["name"], "token": token}


CurrentUser = Depends(get_current_user)
