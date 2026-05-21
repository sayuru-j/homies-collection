"""Admin dashboard API — server management (password-protected)."""

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.admin_auth import (
    CurrentAdmin,
    clear_admin_cookie,
    create_admin_session,
    revoke_admin_session,
    set_admin_cookie,
    verify_admin_password,
)
from app.admin_service import (
    clear_all_invites,
    clear_all_user_sessions,
    clear_upload_chunks,
    create_bootstrap_invite,
    delete_chat_admin,
    delete_event_admin,
    delete_media_admin,
    delete_user_completely,
    delete_user_media_all,
    get_server_stats,
    list_chats_admin,
    list_events_admin,
    list_media_admin,
    list_users_admin,
)

router = APIRouter(prefix="/api/admin", tags=["admin"])


class AdminLoginRequest(BaseModel):
    password: str = Field(..., min_length=1)


class MediaPathRequest(BaseModel):
    path: str = Field(..., min_length=10)


@router.post("/login")
async def admin_login(body: AdminLoginRequest, response: Response):
    if not verify_admin_password(body.password):
        raise HTTPException(status_code=401, detail="Invalid admin password")
    token = await create_admin_session()
    set_admin_cookie(response, token)
    return {"ok": True, "token": token}


@router.post("/logout")
async def admin_logout(response: Response, admin: dict = CurrentAdmin):
    await revoke_admin_session(admin["token"])
    clear_admin_cookie(response)
    return {"ok": True}


@router.get("/me")
async def admin_me(admin: dict = CurrentAdmin):
    return {"ok": True, "authenticated": True}


@router.get("/stats")
async def admin_stats(admin: dict = CurrentAdmin):
    return await get_server_stats()


@router.get("/users")
async def admin_users(admin: dict = CurrentAdmin):
    return {"users": await list_users_admin()}


@router.delete("/users/{user_id}")
async def admin_delete_user(user_id: str, admin: dict = CurrentAdmin):
    try:
        return await delete_user_completely(user_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.delete("/users/{user_id}/media")
async def admin_delete_user_media(user_id: str, admin: dict = CurrentAdmin):
    try:
        return await delete_user_media_all(user_id)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/chats")
async def admin_chats(admin: dict = CurrentAdmin):
    return {"chats": await list_chats_admin()}


@router.delete("/chats/{chat_id}")
async def admin_delete_chat(chat_id: str, admin: dict = CurrentAdmin):
    try:
        return await delete_chat_admin(chat_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.get("/media")
async def admin_media(user_id: str | None = None, admin: dict = CurrentAdmin):
    return {"media": await list_media_admin(user_id)}


@router.delete("/media")
async def admin_delete_media(body: MediaPathRequest, admin: dict = CurrentAdmin):
    try:
        return await delete_media_admin(body.path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/events")
async def admin_events(admin: dict = CurrentAdmin):
    return {"events": await list_events_admin()}


@router.delete("/events/{event_id}")
async def admin_delete_event(event_id: str, admin: dict = CurrentAdmin):
    try:
        return await delete_event_admin(event_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.post("/maintenance/clear-invites")
async def admin_clear_invites(admin: dict = CurrentAdmin):
    return await clear_all_invites()


@router.post("/maintenance/clear-chunks")
async def admin_clear_chunks(admin: dict = CurrentAdmin):
    return await clear_upload_chunks()


@router.post("/maintenance/clear-sessions")
async def admin_clear_sessions(admin: dict = CurrentAdmin):
    return await clear_all_user_sessions()


@router.post("/maintenance/create-invite")
async def admin_create_invite(admin: dict = CurrentAdmin):
    inv = await create_bootstrap_invite()
    return inv
