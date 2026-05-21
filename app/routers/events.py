"""Group events and RSVP."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException

from app.auth import CurrentUser
from app.models import CreateEventRequest, EventPostRequest, EventRsvpRequest, UpdateEventRequest
from app.presence import manager
from app.routers.chats import _append_system_message, _try_remove_media_file, _try_remove_thumb_file
from app.storage import (
    delete_event_file,
    get_chat,
    get_event,
    get_group,
    get_profile,
    get_users,
    list_events_for_user,
    new_id,
    save_event,
)

router = APIRouter(tags=["events"])
groups_events_router = APIRouter(prefix="/api/groups", tags=["groups"])


def _parse_iso(dt: str | None) -> datetime | None:
    if not dt:
        return None
    try:
        return datetime.fromisoformat(dt.replace("Z", "+00:00"))
    except ValueError:
        return None


def _format_event_time(starts_at: str) -> str:
    dt = _parse_iso(starts_at)
    if not dt:
        return starts_at
    return dt.strftime("%b %d, %Y %H:%M UTC")


async def _require_group_member(group_id: str, user_id: str) -> dict:
    group = await get_group(group_id)
    if not group or user_id not in group.get("members", []):
        raise HTTPException(status_code=404, detail="Group not found")
    return group


async def _require_event_access(event_id: str, user_id: str) -> tuple[dict, dict]:
    event = await get_event(event_id)
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    group = await _require_group_member(event["group_id"], user_id)
    return event, group


def _rsvp_counts(event: dict, member_count: int) -> dict:
    rsvps = event.get("rsvps") or {}
    going = sum(1 for v in rsvps.values() if v == "going")
    not_going = sum(1 for v in rsvps.values() if v == "not_going")
    no_response = max(0, member_count - going - not_going)
    return {"going": going, "not_going": not_going, "no_response": no_response}


async def _broadcast_event(group: dict, event_id: str, msg_type: str) -> None:
    await manager.send_to_users(
        group.get("members", []),
        {"type": msg_type, "event_id": event_id, "group_id": group["group_id"]},
    )


async def _get_user_by_id(user_id: str) -> dict | None:
    data = await get_users()
    return next((u for u in data.get("users", []) if u["id"] == user_id), None)


async def _enrich_event_post(post: dict) -> dict:
    out = dict(post)
    sender = await _get_user_by_id(post.get("sender_id"))
    if sender:
        profile = await get_profile(sender["id"])
        out["sender_name"] = profile.get("display_name") or sender["name"]
        out["sender_avatar"] = profile.get("avatar")
    return out


def _purge_event_posts_media(event: dict) -> None:
    for post in event.get("posts") or []:
        _try_remove_media_file(post.get("media_path"))
        _try_remove_thumb_file(post.get("thumb_path"))


def _event_summary(event: dict, group: dict, user_id: str) -> dict:
    members = group.get("members", [])
    counts = _rsvp_counts(event, len(members))
    return {
        "event_id": event["event_id"],
        "group_id": event["group_id"],
        "group_name": group.get("name", "Group"),
        "title": event.get("title", ""),
        "starts_at": event.get("starts_at"),
        "ends_at": event.get("ends_at"),
        "location": event.get("location", ""),
        "created_by": event.get("created_by"),
        "counts": counts,
        "my_rsvp": (event.get("rsvps") or {}).get(user_id),
    }


async def _event_detail(event: dict, group: dict) -> dict:
    users_data = await get_users()
    user_map = {u["id"]: u for u in users_data.get("users", [])}
    members = []
    rsvps = event.get("rsvps") or {}
    for mid in group.get("members", []):
        u = user_map.get(mid)
        if not u:
            continue
        profile = await get_profile(mid)
        members.append(
            {
                "id": mid,
                "name": u["name"],
                "display_name": profile.get("display_name") or u["name"],
                "avatar": profile.get("avatar"),
                "rsvp": rsvps.get(mid),
            }
        )
    going = [m for m in members if m["rsvp"] == "going"]
    not_going = [m for m in members if m["rsvp"] == "not_going"]
    no_response = [m for m in members if m["rsvp"] not in ("going", "not_going")]
    counts = _rsvp_counts(event, len(group.get("members", [])))
    return {
        "event": event,
        "group": {"group_id": group["group_id"], "name": group.get("name"), "chat_id": f"group_{group['group_id']}"},
        "counts": counts,
        "members": members,
        "going": going,
        "not_going": not_going,
        "no_response": no_response,
    }


@router.get("/api/events")
async def list_events(user: dict = CurrentUser):
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=24)
    summaries = []
    for ev in await list_events_for_user(user["id"]):
        starts = _parse_iso(ev.get("starts_at"))
        if starts and starts < cutoff:
            continue
        group = await get_group(ev["group_id"])
        if not group:
            continue
        summaries.append(_event_summary(ev, group, user["id"]))
    summaries.sort(key=lambda x: x.get("starts_at") or "")
    return {"events": summaries}


def _can_manage_event(event: dict, group: dict, user_id: str) -> bool:
    return user_id == event.get("created_by") or user_id == group.get("owner_id")


@router.get("/api/events/{event_id}")
async def get_event_detail(event_id: str, user: dict = CurrentUser):
    event, group = await _require_event_access(event_id, user["id"])
    detail = await _event_detail(event, group)
    detail["can_delete"] = _can_manage_event(event, group, user["id"])
    return detail


@router.patch("/api/events/{event_id}")
async def update_event(event_id: str, body: UpdateEventRequest, user: dict = CurrentUser):
    event, group = await _require_event_access(event_id, user["id"])
    if not _can_manage_event(event, group, user["id"]):
        raise HTTPException(status_code=403, detail="Not allowed to edit this event")

    if body.title is not None:
        event["title"] = body.title.strip()
    if body.description is not None:
        event["description"] = body.description.strip()
    if body.location is not None:
        event["location"] = body.location.strip()
    if body.starts_at is not None:
        event["starts_at"] = body.starts_at
    if body.ends_at is not None:
        event["ends_at"] = body.ends_at or None

    start = _parse_iso(event.get("starts_at"))
    end = _parse_iso(event.get("ends_at"))
    if start and end and end <= start:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    await save_event(event)
    await _broadcast_event(group, event_id, "event_updated")
    return await _event_detail(event, group)


@router.get("/api/events/{event_id}/posts")
async def list_event_posts(event_id: str, user: dict = CurrentUser):
    event, _group = await _require_event_access(event_id, user["id"])
    posts = sorted(
        event.get("posts") or [],
        key=lambda p: p.get("created_at") or "",
    )
    enriched = [await _enrich_event_post(p) for p in posts]
    return {"posts": enriched}


@router.post("/api/events/{event_id}/posts")
async def create_event_post(
    event_id: str, body: EventPostRequest, user: dict = CurrentUser
):
    event, group = await _require_event_access(event_id, user["id"])

    if body.message_type == "text" and not (body.content or "").strip():
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    if body.message_type in ("image", "video", "voice", "file") and not body.media_path:
        raise HTTPException(status_code=400, detail="media_path required for media posts")

    post = {
        "id": new_id(),
        "sender_id": user["id"],
        "content": (body.content or "").strip(),
        "message_type": body.message_type,
        "media_path": body.media_path,
        "thumb_path": body.thumb_path,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    event.setdefault("posts", []).append(post)
    await save_event(event)

    enriched = await _enrich_event_post(post)
    payload = {
        "type": "event_post",
        "event_id": event_id,
        "group_id": group["group_id"],
        "post": enriched,
    }
    await manager.send_to_users(group.get("members", []), payload)
    return {"ok": True, "post": enriched}


@router.delete("/api/events/{event_id}/posts/{post_id}")
async def delete_event_post(
    event_id: str, post_id: str, user: dict = CurrentUser
):
    event, group = await _require_event_access(event_id, user["id"])
    posts = event.get("posts") or []
    idx = next((i for i, p in enumerate(posts) if p.get("id") == post_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail="Post not found")

    removed = posts.pop(idx)
    if removed.get("sender_id") != user["id"] and not _can_manage_event(event, group, user["id"]):
        posts.insert(idx, removed)
        raise HTTPException(status_code=403, detail="Not allowed to delete this post")

    _try_remove_media_file(removed.get("media_path"))
    _try_remove_thumb_file(removed.get("thumb_path"))
    event["posts"] = posts
    await save_event(event)

    payload = {
        "type": "event_post_deleted",
        "event_id": event_id,
        "post_id": post_id,
    }
    await manager.send_to_users(group.get("members", []), payload)
    return {"ok": True, "post_id": post_id}


@router.delete("/api/events/{event_id}")
async def delete_event(event_id: str, user: dict = CurrentUser):
    event, group = await _require_event_access(event_id, user["id"])
    if not _can_manage_event(event, group, user["id"]):
        raise HTTPException(status_code=403, detail="Not allowed to delete this event")

    _purge_event_posts_media(event)
    await delete_event_file(event_id)
    await _broadcast_event(group, event_id, "event_deleted")
    return {"ok": True, "event_id": event_id}


@router.put("/api/events/{event_id}/rsvp")
async def set_rsvp(event_id: str, body: EventRsvpRequest, user: dict = CurrentUser):
    event, group = await _require_event_access(event_id, user["id"])
    event.setdefault("rsvps", {})[user["id"]] = body.status
    await save_event(event)
    await _broadcast_event(group, event_id, "event_updated")
    return await _event_detail(event, group)


@groups_events_router.post("/{group_id}/events")
async def create_group_event(
    group_id: str, body: CreateEventRequest, user: dict = CurrentUser
):
    group = await _require_group_member(group_id, user["id"])

    start = _parse_iso(body.starts_at)
    if not start:
        raise HTTPException(status_code=400, detail="Invalid starts_at")
    end = _parse_iso(body.ends_at) if body.ends_at else None
    if end and end <= start:
        raise HTTPException(status_code=400, detail="End time must be after start time")

    event_id = new_id()
    event = {
        "event_id": event_id,
        "group_id": group_id,
        "title": body.title.strip(),
        "description": (body.description or "").strip(),
        "location": (body.location or "").strip(),
        "starts_at": body.starts_at,
        "ends_at": body.ends_at,
        "created_by": user["id"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "rsvps": {user["id"]: "going"},
        "posts": [],
    }
    await save_event(event)

    chat_id = f"group_{group_id}"
    chat = await get_chat(chat_id)
    time_label = _format_event_time(body.starts_at)
    await _append_system_message(
        chat_id,
        chat,
        f"Event: {event['title']} — {time_label}",
    )

    await _broadcast_event(group, event_id, "event_updated")
    detail = await _event_detail(event, group)
    detail["chat_id"] = chat_id
    return detail
