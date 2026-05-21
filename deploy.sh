#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose pull homielog 2>/dev/null || true
docker compose build homielog
docker compose up -d
docker image prune -f
