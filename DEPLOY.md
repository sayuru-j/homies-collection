# HomieLog — Production deployment guide

This document is the **full replication runbook** for running HomieLog on a single Linux VM with **Docker** (app + Caddy HTTPS) and **coturn** (TURN) on the host. It matches the live setup on the `relay` Azure VM.

**Repository:** https://github.com/sayuru-j/homies-collection

**Related docs:** feature details and APIs → [DOCUMENTATION.md](./DOCUMENTATION.md)

---

## Table of contents

1. [What you get](#what-you-get)
2. [Current production snapshot](#current-production-snapshot)
3. [Architecture](#architecture)
4. [Prerequisites](#prerequisites)
5. [Azure VM and networking](#azure-vm-and-networking)
6. [DNS](#dns)
7. [VM preparation](#vm-preparation)
8. [Deploy application (Docker + Caddy)](#deploy-application-docker--caddy)
9. [Registration invite codes (Docker logs)](#registration-invite-codes-docker-logs)
10. [Deploy TURN (coturn on host)](#deploy-turn-coturn-on-host)
11. [WebRTC / ICE configuration](#webrtc--ice-configuration)
12. [Updates and redeploy](#updates-and-redeploy)
13. [Backups](#backups)
14. [Smoke test checklist](#smoke-test-checklist)
15. [Troubleshooting](#troubleshooting)
16. [Replicating on a new VM or domain](#replicating-on-a-new-vm-or-domain)
17. [Admin dashboard](#admin-dashboard)
18. [Optional: container registry CI](#optional-container-registry-ci)
19. [Files reference](#files-reference)

---

## What you get

| Component | How it runs | Port(s) |
|-----------|-------------|---------|
| **HomieLog** | Docker service `homielog` | 8000 (internal only) |
| **Caddy** | Docker service `caddy` | 80, 443 (public) |
| **coturn** | systemd on **host** (not Docker) | 3478 UDP/TCP, 49152–65535 UDP |
| **Data** | Bind mount `/opt/appsvc/data` → `/app/data` | — |

- **HTTPS** and **Let’s Encrypt** via Caddy (no `trustme` in production).
- **WebSockets** (`/ws`) proxied by Caddy automatically.
- **No database** — backup = copy `/opt/appsvc/data`.
- **Voice / video calls** use WebRTC + TURN on the same VM public IP.

---

## Current production snapshot

Use this table when comparing docs to what is live today. Change values when you move to a new server.

| Setting | Value |
|---------|--------|
| VM hostname (Azure) | `relay` (example discreet name) |
| Public IPv4 | `52.230.105.30` |
| App URL | https://app.green-valley.homes |
| DNS A record | `app` → `52.230.105.30` (TTL 600) |
| App root on VM | `/opt/appsvc` |
| Persistent data | `/opt/appsvc/data` |
| GitHub repo | `sayuru-j/homies-collection` |
| TURN public host | `52.230.105.30:3478` |
| TURN username | `homies` |
| TURN password | In `static/shared/js/ice-servers.js` and `/etc/turnserver.conf` (rotate together) |
| ICE config file | `static/shared/js/ice-servers.js` |

---

## Architecture

```
Internet
   │
   ├─ 443, 80/tcp ──► Caddy (Docker) ──► homielog:8000 (Docker)
   ├─ 3478 udp/tcp ──► coturn (host)
   └─ 49152–65535 udp ──► coturn relay

/opt/appsvc/          ← git clone, Dockerfile, compose, Caddyfile
/opt/appsvc/data/     ← JSON + media (survives container rebuilds)
```

```mermaid
flowchart TB
  Browser[Browser HTTPS]
  Caddy[Caddy :443]
  App[homielog :8000]
  Data[(/opt/appsvc/data)]
  Turn[coturn host :3478]

  Browser -->|REST + WSS| Caddy
  Caddy --> App
  App --> Data
  Browser -->|WebRTC media| Turn
```

---

## Prerequisites

- Azure (or any) **Ubuntu 22.04/24.04** VM, ~**2 vCPU / 4 GB RAM**, **32–64 GB** disk.
- A **domain** you control (for HTTPS).
- **Inbound ports** on cloud NSG and optionally `ufw` (see below).
- SSH access (`azureuser` or similar).

---

## Azure VM and networking

### VM sizing

- **2 vCPU / 4 GB RAM** — enough for a small friend group + coturn.
- Disk **32–64 GB** — grows with `data/media/`.

### Discreet naming (optional)

If the VM is on a shared/subscription account, use bland names:

| Resource | Example |
|----------|---------|
| VM | `relay`, `dev-log-01` |
| NSG | `nsg-relay-01` |
| Deploy path | `/opt/appsvc` (not `/opt/homies`) |

### NSG inbound rules

Create rules with boring names; **priority** 100, 110, …:

| Priority | Rule name | Port | Protocol | Purpose |
|----------|-----------|------|----------|---------|
| 100 | `Allow-SSH-Admin` | 22 | TCP | SSH — restrict source to **your IP** `/32` if possible |
| 110 | `Allow-HTTP-Web` | 80 | TCP | HTTP → HTTPS redirect + ACME |
| 120 | `Allow-HTTPS-Web` | 443 | TCP | HomieLog via Caddy |
| 130 | `Allow-STUN-TURN-Signaling` | 3478 | UDP | TURN |
| 140 | `Allow-STUN-TURN-Signaling-TCP` | 3478 | TCP | TURN (TCP fallback) |
| 150 | `Allow-Media-Relay-UDP` | 49152-65535 | UDP | TURN relay range |

### Host firewall (`ufw`, if enabled)

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```

---

## DNS

1. Create an **A** record: e.g. `app.yourdomain.com` → VM **public IPv4**.
2. Wait for propagation (`dig +short app.yourdomain.com A`).
3. Put the **exact hostname** in `Caddyfile` (see [Files reference](#files-reference)).

**TURN** does not need a DNS name; browsers use the **public IP** in `ice-servers.js`.

---

## VM preparation

SSH to the VM, then:

```bash
# Docker (official script)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"
# Log out and back in so docker works without sudo

# App directories
sudo mkdir -p /opt/appsvc/data
sudo chown -R 1000:1000 /opt/appsvc
```

Verify Docker:

```bash
docker run --rm hello-world
```

If `rsync` is missing, use `cp` (see deploy section) or `sudo apt-get install -y rsync`.

---

## Deploy application (Docker + Caddy)

### 1. Clone the repository

**Option A — clone directly into `/opt/appsvc`:**

```bash
sudo git clone https://github.com/sayuru-j/homies-collection.git /opt/appsvc
cd /opt/appsvc
sudo rm -rf .git   # optional: avoid accidental git pull as root issues
```

**Option B — clone to `/tmp` and copy (no `rsync`):**

```bash
cd /tmp
git clone https://github.com/sayuru-j/homies-collection.git
sudo cp -a /tmp/homies-collection/. /opt/appsvc/
sudo rm -rf /opt/appsvc/.git
```

**Private repo:**

```bash
git clone https://<TOKEN>@github.com/sayuru-j/homies-collection.git
```

### 2. Seed `data/` (optional)

If the repo or your laptop has existing `data/` (users, chats, media):

```bash
# From clone
sudo cp -a /tmp/homies-collection/data/. /opt/appsvc/data/ 2>/dev/null || true

# Or from your PC (PowerShell)
# scp -r C:\path\to\homies-collection\data\* azureuser@<VM_IP>:/tmp/data-upload/
# On VM:
# sudo cp -a /tmp/data-upload/. /opt/appsvc/data/
sudo chown -R 1000:1000 /opt/appsvc/data
```

**Warning:** Do not start with an **empty** `data/` over existing production data without a backup.

### 3. Configure Caddy hostname

Edit `Caddyfile` if your domain differs:

```caddyfile
app.green-valley.homes {
    reverse_proxy homielog:8000
}
```

Service name `homielog` must match `docker-compose.yml`.

### 4. Build and start

```bash
cd /opt/appsvc
sudo chmod +x deploy.sh
sudo docker compose up -d --build
sudo docker compose ps
```

### 5. Check logs

```bash
sudo docker compose logs caddy --tail 50
sudo docker compose logs homielog --tail 30
```

Open **https://your.domain** — first visit may take ~30–60s while Caddy obtains a Let’s Encrypt certificate.

### 6. `curl` checks

```bash
curl -4 ifconfig.me                    # VM public IP
dig +short app.green-valley.homes A   # must match
curl -sI https://app.green-valley.homes | head -5
```

---

## Registration invite codes (Docker logs)

New users need a **4-digit invite code** to register. On every app start, HomieLog creates one bootstrap code and prints it to **stdout** (Uvicorn’s terminal inside the `homielog` container).

### Where it comes from

| Piece | Location |
|-------|----------|
| Startup hook | `app/main.py` → `issue_startup_invite()` on FastAPI startup |
| Logic | `app/invite_codes.py` |
| Storage | `/opt/appsvc/data/auth/invite_codes.json` (bind mount) |
| TTL | **10 minutes** (`INVITE_TTL_SECONDS = 600` in `app/config.py`) |

On startup you should see a banner like:

```text
====================================================
  HOMIES INVITE CODE (valid 10 min): 1234
====================================================
```

And a log line:

```text
HomieLog startup invite code: 1234 (valid 10 minutes)
```

### View logs on the VM (production)

**Follow live logs (best when restarting):**

```bash
cd /opt/appsvc
sudo docker compose logs -f homielog
```

**Last 100 lines (find a recent startup banner):**

```bash
sudo docker compose logs homielog --tail 100
```

**Filter for invite lines only:**

```bash
sudo docker compose logs homielog 2>&1 | grep -i invite
```

**Generate a fresh startup code** (restart container — creates a **new** code, old unused startup codes may still exist in JSON until they expire):

```bash
cd /opt/appsvc
sudo docker compose restart homielog
sudo docker compose logs homielog --tail 30
```

There is **no interactive TTY** attached in production; you always use `docker compose logs`, not `docker attach`.

### After the first user exists

Logged-in friends do **not** need Docker logs. In the app:

**Settings → Generate invite code** (calls `POST /api/users/invite-code`, returns a new 4-digit code for 10 minutes).

### Read codes from disk (optional)

Unused, non-expired codes are in `invite_codes.json`:

```bash
sudo cat /opt/appsvc/data/auth/invite_codes.json
```

Look for entries with `"used_at": null` and `"expires_at"` still in the future. Install `jq` for easier parsing:

```bash
sudo apt-get install -y jq
sudo jq '.invites[] | select(.used_at == null)' /opt/appsvc/data/auth/invite_codes.json
```

### Security notes

- Anyone with **SSH + Docker access** on the VM can read invite codes from logs or `data/auth/`.
- Codes in logs rotate on restart; treat VM access like admin access.
- Do not share `docker compose logs` output publicly if it contains a fresh code.

---

## Deploy TURN (coturn on host)

Run coturn on the **host**, not inside Docker (simpler UDP relay port range).

### 1. Install

```bash
sudo apt-get update
sudo apt-get install -y coturn
```

### 2. Enable service

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn
```

### 3. Configure `/etc/turnserver.conf`

Get the VM **private** IP (Azure NIC):

```bash
PRIVATE_IP=$(hostname -I | awk '{print $1}')
echo "relay-ip=$PRIVATE_IP"
```

Example config (also in `deploy/turnserver.conf.example`):

```conf
listening-port=3478
fingerprint
lt-cred-mech
user=homies:YOUR_PASSWORD
realm=52.230.105.30
external-ip=52.230.105.30
relay-ip=<PRIVATE_IP>
min-port=49152
max-port=65535
```

**Password must match** `static/shared/js/ice-servers.js` (`TURN_CREDENTIAL`).

Apply and restart:

```bash
sudo systemctl enable coturn
sudo systemctl restart coturn
sudo systemctl status coturn --no-pager
```

### 4. Verify TURN

```bash
turnutils_uclient -v -u homies -w 'YOUR_PASSWORD' 52.230.105.30
```

Expect `success` and `Received relay addr: 52.230.105.30:...`. Trailing `channel bind: error 403` in the test tool is often harmless for real browser calls.

---

## WebRTC / ICE configuration

All call features load **`/static/shared/js/ice-servers.js`** before call scripts:

| Page | HTML |
|------|------|
| HomieLog chat | `static/homielog/chat.html` |
| StrangerDanger | `static/stranger-danger/index.html` |

Call modules use `HOMIES_ICE_SERVERS`:

- `static/homielog/js/voice-call.js` (1:1)
- `static/homielog/js/group-mesh-call.js` (mesh group, ≤6 users)
- `static/stranger-danger/js/app.js`

To change TURN host or password, edit **only** `ice-servers.js`, redeploy Docker, hard-refresh browsers.

**Security:** credentials are visible in JS (acceptable for a private friend group). Prefer rotating password in coturn + `ice-servers.js` together; long-term improvement = short-lived TURN creds from API.

---

## Git on `/opt/appsvc` (one-time fix)

If you first deployed by **copying files** (no `.git`), `git pull` will fail. Use this once to attach the repo **without losing production `data/`**:

```bash
# 1) Backup live data
sudo tar czf /opt/appsvc/backups/data-pre-git-$(date +%F).tar.gz -C /opt/appsvc data

# 2) Move data out of the way (repo may contain a sample data/ folder)
sudo mv /opt/appsvc/data /tmp/appsvc-data-save

# 3) Clone fresh into a temp dir, then move .git + sync tree
cd /tmp
rm -rf homies-collection
git clone https://github.com/sayuru-j/homies-collection.git
sudo cp -a /tmp/homies-collection/.git /opt/appsvc/
cd /opt/appsvc
sudo git checkout -f main
# If checkout fails, try: sudo git branch -M main && sudo git reset --hard origin/main

# 4) Restore production data (never use repo sample data on the VM)
sudo rm -rf /opt/appsvc/data
sudo mv /tmp/appsvc-data-save /opt/appsvc/data
sudo chown -R 1000:1000 /opt/appsvc/data

# 5) Tell git to ignore local data forever
echo 'data/' | sudo tee -a .git/info/exclude

# 6) Deploy
sudo chmod +x deploy.sh
sudo ./deploy.sh
```

Verify:

```bash
cd /opt/appsvc && sudo git status && sudo git remote -v
```

**Alternative (cleanest):** rename old dir, clone anew, copy `data/` back:

```bash
sudo mv /opt/appsvc /opt/appsvc.old
sudo git clone https://github.com/sayuru-j/homies-collection.git /opt/appsvc
sudo cp -a /opt/appsvc.old/data /opt/appsvc/
sudo chown -R 1000:1000 /opt/appsvc/data
cd /opt/appsvc && sudo chmod +x deploy.sh && sudo ./deploy.sh
```

---

## Updates and redeploy

After pushing changes to GitHub:

```bash
cd /opt/appsvc
sudo git pull origin main
sudo ./deploy.sh
```

`deploy.sh` runs `git pull` (if `.git` exists), rebuilds `homielog`, restarts compose, prunes old images.

If Docker shows **CACHED** for `COPY app` / `COPY static` after a pull, force a rebuild:

```bash
sudo docker compose build --no-cache homielog
sudo docker compose up -d
```

**Hard-refresh** clients (Ctrl+Shift+R) after frontend/ICE changes.

### Production cookie hardening (recommended)

Behind HTTPS, set session cookies with `secure=True` in `app/routers/auth_routes.py` (currently `httponly` + `samesite=lax` only). Redeploy after changing.

---

## Backups

There is no database. Backup the data directory:

```bash
sudo mkdir -p /opt/appsvc/backups
sudo tar czf /opt/appsvc/backups/data-$(date +%F).tar.gz -C /opt/appsvc data
```

Restore:

```bash
sudo tar xzf /opt/appsvc/backups/data-YYYY-MM-DD.tar.gz -C /opt/appsvc
sudo chown -R 1000:1000 /opt/appsvc/data
sudo docker compose restart homielog
```

Optional cron (daily 03:00):

```bash
sudo crontab -e
# 0 3 * * * tar czf /opt/appsvc/backups/data-$(date +\%F).tar.gz -C /opt/appsvc data
```

---

## Smoke test checklist

| # | Test | Pass? |
|---|------|-------|
| 1 | https://your.domain loads login | |
| 2 | Register / login | |
| 3 | WebSocket presence (online list) | |
| 4 | Send text + image | |
| 5 | Beam / map location (needs HTTPS) | |
| 6 | 1:1 voice call on Wi‑Fi | |
| 7 | 1:1 voice call on phone LTE | |
| 8 | `ice-servers.js` loads in DevTools → Network | |
| 9 | `turnutils_uclient` success on VM | |

---

## Troubleshooting

| Problem | Likely fix |
|---------|------------|
| Site not loading | `docker compose ps`; NSG 443; DNS A record |
| Certificate error / timeout | Port **80** open (ACME); DNS points to VM; `docker compose logs caddy` |
| 502 Bad Gateway | `docker compose logs homielog`; container crashed — check `data/` permissions (`1000:1000`) |
| Chat works, calls fail on LTE | TURN: NSG 3478 + 49152–65535 UDP; coturn running; password matches `ice-servers.js` |
| Calls fail everywhere | Wrong `TURN_HOST` in `ice-servers.js`; `external-ip` / `relay-ip` wrong in turnserver.conf |
| `turnutils_uclient` fails | coturn not enabled; firewall; wrong `relay-ip` (must be Azure **private** IP) |
| Old TURN IP after migration | Update `ice-servers.js`, rebuild, hard-refresh |
| Empty app after deploy | Restored empty `data/` over production — restore from `backups/` |
| Need register code | `docker compose logs homielog \| grep -i invite` or restart `homielog` and read last 30 lines |
| Invite expired | Restart app for new startup code, or use logged-in **Generate invite code** |

---

## Replicating on a new VM or domain

1. Provision VM + NSG (same ports).
2. Point **new** A record → new public IP.
3. Update **`Caddyfile`** hostname.
4. Update **`static/shared/js/ice-servers.js`**: `TURN_HOST`, and coturn `realm` / `external-ip`.
5. On new VM, set coturn `relay-ip` to that VM’s **private** IP.
6. Clone repo to `/opt/appsvc`, `docker compose up -d --build`.
7. Copy **`/opt/appsvc/data`** from old VM if migrating (tar + scp).
8. Run [smoke test checklist](#smoke-test-checklist).

---

## Admin dashboard

Web UI for full server control (users, chats, media, events, maintenance). **Not linked** from the public HomieLog app — open directly:

**https://app.green-valley.homes/admin** (or your domain + `/admin`)

### Authentication

- Password is checked **only on the server** (`app/config.py` / environment).
- Default: set in code; override on the VM:

```bash
# /opt/appsvc/.env (docker compose env_file) or export before compose up
ADMIN_PASSWORD=your-strong-password
```

Add to `docker-compose.yml` under `homielog`:

```yaml
    env_file: .env
```

- Admin session cookie: `admin_session` (8 hours, HttpOnly).
- Stored in `data/auth/admin_sessions.json` on the persistent volume.

### Capabilities

| Tab | Actions |
|-----|---------|
| **Overview** | **VM disk** (`/` — shows ~30 GB total), app data mount, storage breakdown, uptime |
| **Server** | **Maintenance mode** (503 public app), broadcast, **data backups** |
| **Users** | Kick (disconnect WS + sessions), delete account, clear media |
| **Chats** | Permanently purge conversation + media |
| **Media** | List/delete files; scan & purge orphan media |
| **Events** | Delete group events + post media |
| **Tools** | Clear invites/chunks/sessions; generate temporary invite code |
| **Server → Permanent registration code** | Optional reusable 4-digit code for new signups (`data/auth/permanent_invite.json`) |

**Maintenance mode** takes HomieLog offline for users while `/admin` keeps working. Re-enable with **Bring server online**.

### API (for scripts)

Prefix: `/api/admin` — requires admin cookie or header `X-Admin-Token` after `POST /api/admin/login`.

### Redeploy after update

```bash
cd /opt/appsvc && sudo git pull && sudo docker compose up -d --build
```

---

## Optional: container registry CI

Manual pipeline (no Azure DevOps required):

1. On PC: `docker build -t ghcr.io/<user>/homies:<git-sha> .` && `docker push ...`
2. On VM: set `homielog.image` in `docker-compose.yml` instead of `build: .`
3. SSH: `cd /opt/appsvc && ./deploy.sh`

Optional GitHub Action with `workflow_dispatch` and secrets: `GHCR_TOKEN`, `SSH_PRIVATE_KEY`, `DEPLOY_HOST`.

---

## Files reference

| File | Purpose |
|------|---------|
| `Dockerfile` | Python 3.12 image, Uvicorn on 8000 |
| `docker-compose.yml` | `homielog` + `caddy`, volume `/opt/appsvc/data` |
| `Caddyfile` | HTTPS site block → `homielog:8000` |
| `deploy.sh` | Rebuild and restart on VM |
| `.dockerignore` | Excludes `data/`, `venv/`, `certs/` from image |
| `deploy/turnserver.conf.example` | coturn template for host |
| `static/shared/js/ice-servers.js` | STUN/TURN URLs + credentials |
| `docker-compose.livekit.yml` | Optional LiveKit (group SFU); not used when `GROUP_CALLS_ENABLED = False` |
| `static/admin/` | Admin dashboard UI |
| `app/routers/admin.py` | Admin API |
| `app/admin_service.py` | Delete users, purge chats, media, maintenance |

---

## Quick command summary (copy-paste)

**Full first-time deploy (after NSG + DNS):**

```bash
curl -fsSL https://get.docker.com | sh
sudo mkdir -p /opt/appsvc/data && sudo chown -R 1000:1000 /opt/appsvc
sudo git clone https://github.com/sayuru-j/homies-collection.git /opt/appsvc
cd /opt/appsvc && sudo chmod +x deploy.sh && sudo docker compose up -d --build
# coturn: see "Deploy TURN" section above
```

**Routine update (after `.git` is set up):**

```bash
cd /opt/appsvc && sudo git pull origin main && sudo ./deploy.sh
```

---

*Last updated for production on `relay` — app at https://app.green-valley.homes, TURN at 52.230.105.30.*
