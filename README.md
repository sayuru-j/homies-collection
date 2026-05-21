# HomieLog

FastAPI chat app with local JSON/file storage in `data/`.

**Full guide (features, HTTPS, calls, TURN, APIs):** see [DOCUMENTATION.md](./DOCUMENTATION.md).

## Setup

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Open http://localhost:8000

### HTTPS (recommended for phones)

Voice, camera, and some APIs need a **secure context** (HTTPS). Use the dev script (creates certs in `certs/`, gitignored):

```bash
pip install -r requirements.txt
python scripts/run_https.py --reload
```

- PC: https://127.0.0.1:7000  
- Phone (same Wi‑Fi): https://YOUR_LAN_IP:7000 — the script prints your IP.

**Trust the cert on your phone (optional):** copy `certs/ca.pem` to the device and install it as a trusted CA (iOS: Settings → General → About → Certificate Trust Settings). Otherwise tap through the browser warning once.

**Windows firewall:** allow inbound TCP on port 7000 when prompted.

## Features

- Register / login with **name** + **6-digit PIN** (`data/auth/`)
- See who's online (WebSocket presence)
- Direct messages and groups (`data/chats/`, `data/groups/`)
- Text, images, videos (chunked upload), voice messages
- Display picture (`data/profiles/`, `data/media/`)
- Soft-delete conversations (per user, stored in profile settings) — restore from **Settings → Deleted Chats**
- Permanent delete from Deleted Chats (not restorable from settings; hidden from your chat list)

## Data layout

```
data/
  auth/users.json
  auth/sessions.json
  profiles/{user_id}.json
  chats/{chat_id}.json
  groups/{group_id}.json
  media/{user_id}/{type}/...
  uploads/chunks/...
```
