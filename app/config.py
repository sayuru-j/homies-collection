import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
AUTH_DIR = DATA_DIR / "auth"
PROFILES_DIR = DATA_DIR / "profiles"
CHATS_DIR = DATA_DIR / "chats"
GROUPS_DIR = DATA_DIR / "groups"
EVENTS_DIR = DATA_DIR / "events"
MEDIA_DIR = DATA_DIR / "media"
CHUNKS_DIR = DATA_DIR / "uploads" / "chunks"

USERS_FILE = AUTH_DIR / "users.json"
SESSIONS_FILE = AUTH_DIR / "sessions.json"
INVITES_FILE = AUTH_DIR / "invite_codes.json"
ADMIN_SESSIONS_FILE = AUTH_DIR / "admin_sessions.json"

# Override on the VM: ADMIN_PASSWORD in .env or environment
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "@dminThamaiJuto")
ADMIN_SESSION_MAX_AGE = 60 * 60 * 8  # 8 hours

INVITE_TTL_SECONDS = 600  # 10 minutes

CHUNK_SIZE = 256 * 1024  # 256 KB recommended chunk size
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50 MB
MESSAGES_PAGE_SIZE = 10

DEFAULT_MEDIA_COMPRESSION_PERCENT = 90
MIN_MEDIA_COMPRESSION_PERCENT = 0
MAX_MEDIA_COMPRESSION_PERCENT = 100

# Group calls: mesh WebRTC (same as 1:1) up to this many members; larger groups need LiveKit SFU.
MAX_MESH_GROUP_MEMBERS = 6

# Temporary kill switch — set True to re-enable group voice/video calls.
GROUP_CALLS_ENABLED = False
