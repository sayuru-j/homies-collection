#!/usr/bin/env python3
"""Run HomieLog over HTTPS for mic/camera and other secure-context APIs (esp. on phones)."""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CERT_DIR = ROOT / "certs"


def detect_lan_ip() -> str | None:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def ensure_certs(hosts: list[str]) -> tuple[Path, Path, Path]:
    try:
        import trustme
    except ImportError:
        print("Missing trustme. Run: pip install -r requirements.txt")
        sys.exit(1)

    CERT_DIR.mkdir(parents=True, exist_ok=True)
    key_file = CERT_DIR / "server-key.pem"
    cert_file = CERT_DIR / "server.pem"
    ca_file = CERT_DIR / "ca.pem"

    ca = trustme.CA()
    ca.cert_pem.write_to_path(ca_file)
    server = ca.issue_cert(*hosts)
    server.private_key_pem.write_to_path(key_file)
    server.cert_chain_pems[0].write_to_path(cert_file)
    return key_file, cert_file, ca_file


def main() -> None:
    parser = argparse.ArgumentParser(description="Run HomieLog with a local dev HTTPS certificate.")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default: 0.0.0.0)")
    parser.add_argument("--port", type=int, default=7000, help="HTTPS port (default: 7000)")
    parser.add_argument("--reload", action="store_true", help="Enable uvicorn auto-reload")
    args = parser.parse_args()

    hosts = ["localhost", "127.0.0.1"]
    lan = detect_lan_ip()
    if lan:
        hosts.append(lan)
    hosts = list(dict.fromkeys(hosts))

    key_file, cert_file, ca_file = ensure_certs(hosts)

    print("\nHomieLog (HTTPS)")
    print(f"  PC:      https://127.0.0.1:{args.port}")
    if lan:
        print(f"  Phone:   https://{lan}:{args.port}  (same Wi-Fi)")
    print(f"\n  Dev CA (install on phone to avoid warnings): {ca_file}")
    print("  First visit: accept the browser warning, or install ca.pem as a trusted CA.\n")

    cmd = [
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--ssl-keyfile",
        str(key_file),
        "--ssl-certfile",
        str(cert_file),
    ]
    if args.reload:
        cmd.append("--reload")

    subprocess.run(cmd, cwd=ROOT, check=False)


if __name__ == "__main__":
    main()
