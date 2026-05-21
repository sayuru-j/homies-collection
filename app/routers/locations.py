from fastapi import APIRouter, Depends, HTTPException

from app.auth import CurrentUser
from app.location import location_manager
from app.models import BeamToggleRequest, LocationUpdateRequest
from app.storage import get_profile

router = APIRouter(prefix="/api/location", tags=["location"])


@router.get("/live")
async def list_live_locations(user: dict = CurrentUser):
    """Users currently beaming with location sharing allowed."""
    locations = await location_manager.list_visible()
    return {"locations": locations}


@router.put("/position")
async def update_position(body: LocationUpdateRequest, user: dict = CurrentUser):
    profile = await get_profile(user["id"])
    settings = profile.get("settings") or {}
    if not settings.get("location_share_allowed"):
        raise HTTPException(
            status_code=403,
            detail="Enable location sharing in My Account before beaming",
        )
    if not location_manager.is_beaming(user["id"]):
        raise HTTPException(status_code=400, detail="Beam is off")
    entry = location_manager.update_position(
        user["id"],
        lat=body.lat,
        lng=body.lng,
        accuracy=body.accuracy,
    )
    if not entry:
        raise HTTPException(status_code=400, detail="Beam is off")
    await location_manager.broadcast_update(user["id"])
    return {"ok": True, "beaming": True}


@router.post("/beam")
async def toggle_beam(body: BeamToggleRequest, user: dict = CurrentUser):
    profile = await get_profile(user["id"])
    settings = profile.get("settings") or {}
    if body.active:
        if not settings.get("location_share_allowed"):
            raise HTTPException(
                status_code=403,
                detail="Enable location sharing in My Account before beaming",
            )
        if body.lat is None or body.lng is None:
            raise HTTPException(status_code=400, detail="lat and lng required to start beam")
        location_manager.set_beaming(
            user["id"],
            active=True,
            lat=body.lat,
            lng=body.lng,
            accuracy=body.accuracy,
        )
        await location_manager.broadcast_update(user["id"])
        return {"ok": True, "beaming": True}
    location_manager.clear_user(user["id"])
    await location_manager.broadcast_stopped(user["id"])
    return {"ok": True, "beaming": False}
