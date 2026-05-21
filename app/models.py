import re
from typing import Literal

from pydantic import BaseModel, Field, field_validator

PIN_PATTERN = re.compile(r"^\d{6}$")


class RegisterRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    pin: str = Field(..., min_length=6, max_length=6)
    invite_code: str = Field(..., min_length=4, max_length=4)

    @field_validator("pin")
    @classmethod
    def pin_must_be_six_digits(cls, v: str) -> str:
        if not PIN_PATTERN.match(v):
            raise ValueError("PIN must be exactly 6 digits")
        return v

    @field_validator("invite_code")
    @classmethod
    def invite_code_normalized(cls, v: str) -> str:
        from app.invite_codes import INVITE_CODE_LENGTH, normalize_invite_code

        normalized = normalize_invite_code(v)
        if len(normalized) != INVITE_CODE_LENGTH or not normalized.isdigit():
            raise ValueError("Invite code must be exactly 4 digits")
        return normalized


class LoginRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    pin: str = Field(..., min_length=6, max_length=6)

    @field_validator("pin")
    @classmethod
    def pin_must_be_six_digits(cls, v: str) -> str:
        if not PIN_PATTERN.match(v):
            raise ValueError("PIN must be exactly 6 digits")
        return v


class ProfileUpdate(BaseModel):
    display_name: str | None = None
    media_compression_percent: int | None = Field(default=None, ge=0, le=100)
    location_share_allowed: bool | None = None


class LocationUpdateRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)


class BeamToggleRequest(BaseModel):
    active: bool
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    accuracy: float | None = Field(default=None, ge=0)


class PinResetRequest(BaseModel):
    current_pin: str = Field(..., min_length=6, max_length=6)
    new_pin: str = Field(..., min_length=6, max_length=6)

    @field_validator("current_pin", "new_pin")
    @classmethod
    def pin_must_be_six_digits(cls, v: str) -> str:
        if not PIN_PATTERN.match(v):
            raise ValueError("PIN must be exactly 6 digits")
        return v

    @field_validator("new_pin")
    @classmethod
    def new_pin_differs(cls, v: str, info) -> str:
        current = info.data.get("current_pin")
        if current is not None and v == current:
            raise ValueError("New PIN must be different from current PIN")
        return v


class ThumbnailEnsureRequest(BaseModel):
    media_path: str = Field(..., min_length=10, max_length=500)


class SendMessageRequest(BaseModel):
    chat_id: str
    content: str = ""
    message_type: Literal["text", "image", "video", "voice", "file"] = "text"
    media_path: str | None = None
    thumb_path: str | None = None


class CreateGroupRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    member_ids: list[str] = Field(default_factory=list)


class AddMembersRequest(BaseModel):
    member_ids: list[str]


class CallLogRequest(BaseModel):
    chat_id: str
    duration_sec: int = Field(..., ge=1, le=86400)
    call_mode: Literal["voice", "video"] = "voice"
    call_id: str | None = None


class GroupCallTokenRequest(BaseModel):
    chat_id: str
    call_mode: Literal["voice", "video"] = "voice"


class CreateEventRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    location: str = Field(default="", max_length=200)
    starts_at: str = Field(..., min_length=1)
    ends_at: str | None = None


class UpdateEventRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    location: str | None = Field(default=None, max_length=200)
    starts_at: str | None = None
    ends_at: str | None = None


class EventRsvpRequest(BaseModel):
    status: Literal["going", "not_going"]


class EventPostRequest(BaseModel):
    content: str = ""
    message_type: Literal["text", "image", "video", "voice", "file"] = "text"
    media_path: str | None = None
    thumb_path: str | None = None


class ChunkMeta(BaseModel):
    upload_id: str
    filename: str
    total_chunks: int
    chunk_index: int
    media_type: Literal["image", "video", "voice", "avatar", "file"] = "file"
