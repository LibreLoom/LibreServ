#!/usr/bin/env python3
"""Comprehensive Luna Connect mock server and CLI manager.

Mocks all Luna Connect companion endpoints for local development and testing:
- Device status & pairing (/api/v1/status)
- Domain management (/api/v1/domain, /api/v1/domain/available)
- Cloud backup storage & restore (/api/v1/backup/objects/*, /api/v1/backup/status)
- Device token generation & Crockford validation
- Error & mode simulation (bound, unbound, challenge, 401, backup_locked, storage_full, bound_spawn)

Usage:
  # Start the mock server (default port 18765):
  python3 luna/scripts/mock-connect.py
  # Or via wrapper / make:
  bash luna/scripts/mock-connect.sh
  make -C luna mock-connect

  # CLI control (communicates with running server or updates local state):
  python3 luna/scripts/mock-connect.py status
  python3 luna/scripts/mock-connect.py mode set <bound|unbound|challenge|401|backup_locked|storage_full>
  python3 luna/scripts/mock-connect.py domain set <subdomain> [custom_domain]
  python3 luna/scripts/mock-connect.py backup unlock
  python3 luna/scripts/mock-connect.py backup lock
  python3 luna/scripts/mock-connect.py backup stats
  python3 luna/scripts/mock-connect.py backup clean
  python3 luna/scripts/mock-connect.py mint-token [--write]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import signal
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = Path(os.environ.get("LUNA_DATA_DIR", ROOT / "dev"))
DEFAULT_HOST = os.environ.get("MOCK_CONNECT_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("MOCK_CONNECT_PORT", "18765"))
DEFAULT_STORAGE_DIR = Path(os.environ.get("LUNA_MOCK_STORAGE_DIR", DATA_DIR / "mock-cloud-storage"))
DEFAULT_STATE_FILE = DATA_DIR / "mock-connect-state.json"
PID_FILE = DATA_DIR / "mock-connect.pid"
DEFAULT_DEVICE_TOKEN_FILE = DATA_DIR / "device-token"

# Crockford base32 alphabet without I, L, O, U (matches Luna Connect & lunad).
CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

CF_HTML = """<!DOCTYPE html>
<html lang="en-US">
<head><title>Just a moment...</title></head>
<body>
  <div class="cf-browser-verification">
    <h1>Just a moment...</h1>
    <script src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page"></script>
  </div>
</body>
</html>
"""

# Price per terabyte monthly (decimal 1TB = 1,000,000,000,000 bytes).
PRICE_PER_TB_MONTHLY = 8.00


def normalize_token(raw: str) -> str:
    """Normalize token: strip spaces/dashes, uppercase, map I/L->1, O->0."""
    out = []
    for c in raw.strip():
        if c in "- _":
            continue
        c = c.upper()
        if c in ("I", "L"):
            c = "1"
        elif c == "O":
            c = "0"
        out.append(c)
    return "".join(out)


def is_valid_crockford(norm: str) -> bool:
    """True if 16..=32 chars and all in Crockford alphabet."""
    if not (16 <= len(norm) <= 32):
        return False
    return all(c in CROCKFORD_ALPHABET for c in norm)


def group_token(norm: str) -> str:
    """Group token in 4-character chunks separated by dashes."""
    return "-".join(norm[i : i + 4] for i in range(0, len(norm), 4))


def setup_prefix(norm_or_grouped: str) -> str:
    """First 8 normalized characters (first two groups)."""
    norm = normalize_token(norm_or_grouped)
    return norm[:8] if len(norm) >= 8 else norm


def mint_device_token(num_groups: int = 5) -> str:
    """Generate a random Crockford device token grouped in 4-char blocks (default 20 chars)."""
    total_chars = num_groups * 4
    raw = "".join(secrets.choice(CROCKFORD_ALPHABET) for _ in range(total_chars))
    return group_token(raw)


def format_bytes(size: int | float) -> str:
    """Format bytes to human readable string."""
    power = 1000.0
    n = float(size)
    labels = ["B", "KB", "MB", "GB", "TB", "PB"]
    for label in labels:
        if abs(n) < power:
            return f"{n:.1f} {label}" if label != "B" else f"{int(n)} B"
        n /= power
    return f"{n:.1f} EB"


class MockState:
    """Thread-safe persistent state for the Luna Connect mock."""

    def __init__(self, state_file: Path, storage_dir: Path):
        self.state_file = state_file
        self.storage_dir = storage_dir
        self._lock = threading.RLock()

        # Defaults
        self.mode: str = os.environ.get("MOCK_MODE", "bound").strip().lower()
        self.subdomain: str = "repro"
        self.domain: str = "luna.servers.libreloom.org"
        self.hostname: str = f"{self.subdomain}.{self.domain}"
        self.tunnel_token: str = f"mock-{self.subdomain}-tunnel-token"
        self.tunnel_id: str = "mock-tunnel-id-12345"
        self.backup_unlocked: bool = True
        self.paired: bool = True
        self.bound: bool = True
        self.backup_sources: list[Any] = []
        self.egress_bytes: int = 0
        self.tokens: dict[str, dict[str, Any]] = {
            "ABCD-EFGH-JKMN-PQRS-TVWX": {
                "device_id": "dev_mock_luna",
                "bound": True,
                "subdomain": "repro",
            }
        }

        self.load()

    def load(self) -> None:
        with self._lock:
            if not self.state_file.exists():
                return
            try:
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                self.mode = data.get("mode", self.mode)
                self.subdomain = data.get("subdomain", self.subdomain)
                self.domain = data.get("domain", self.domain)
                self.hostname = data.get("hostname", f"{self.subdomain}.{self.domain}")
                self.tunnel_token = data.get("tunnel_token", f"mock-{self.subdomain}-tunnel-token")
                self.tunnel_id = data.get("tunnel_id", self.tunnel_id)
                self.backup_unlocked = data.get("backup_unlocked", self.backup_unlocked)
                self.paired = data.get("paired", self.paired)
                self.bound = data.get("bound", self.bound)
                self.backup_sources = data.get("backup_sources", self.backup_sources)
                self.egress_bytes = data.get("egress_bytes", self.egress_bytes)
                if "tokens" in data and isinstance(data["tokens"], dict):
                    self.tokens.update(data["tokens"])
            except Exception as e:
                print(f"[mock-connect] warning: failed to read state from {self.state_file}: {e}", file=sys.stderr)

    def save(self) -> None:
        with self._lock:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "mode": self.mode,
                "subdomain": self.subdomain,
                "domain": self.domain,
                "hostname": self.hostname,
                "tunnel_token": self.tunnel_token,
                "tunnel_id": self.tunnel_id,
                "backup_unlocked": self.backup_unlocked,
                "paired": self.paired,
                "bound": self.bound,
                "backup_sources": self.backup_sources,
                "egress_bytes": self.egress_bytes,
                "tokens": self.tokens,
            }
            tmp = self.state_file.with_suffix(".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(self.state_file)

    def set_mode(self, mode: str) -> str:
        with self._lock:
            mode = mode.strip().lower()
            self.mode = mode
            if mode == "backup_locked":
                self.backup_unlocked = False
            elif mode == "bound":
                self.bound = True
                self.paired = True
                self.tunnel_token = f"mock-{self.subdomain}-tunnel-token"
            elif mode == "bound_spawn":
                self.bound = True
                self.paired = True
                self.tunnel_token = "eyJhbGciOiJDEBUG_TUNNEL_TOKEN_FOR_SPAWN_PATH"
            elif mode == "unbound":
                self.bound = False
            self.save()
            return self.mode

    def set_domain(self, subdomain: str, domain: str | None = None) -> dict[str, str]:
        with self._lock:
            subdomain = subdomain.strip().lower()
            self.subdomain = subdomain
            if domain:
                self.domain = domain.strip().lower()
            self.hostname = f"{self.subdomain}.{self.domain}"
            if not self.mode.startswith("bound_spawn"):
                self.tunnel_token = f"mock-{self.subdomain}-tunnel-token"
            self.bound = True
            if self.mode == "unbound":
                self.mode = "bound"
            self.save()
            return {
                "hostname": self.hostname,
                "subdomain": self.subdomain,
                "domain": self.domain,
                "tunnel_token": self.tunnel_token,
            }

    def set_backup_unlocked(self, unlocked: bool) -> bool:
        with self._lock:
            self.backup_unlocked = unlocked
            if unlocked and self.mode == "backup_locked":
                self.mode = "bound"
            elif not unlocked and self.mode == "bound":
                self.mode = "backup_locked"
            self.save()
            return self.backup_unlocked

    def add_token(self, token: str, device_id: str = "dev_mock_luna") -> str:
        with self._lock:
            norm = normalize_token(token)
            grouped = group_token(norm)
            self.tokens[grouped] = {
                "device_id": device_id,
                "bound": True,
                "subdomain": self.subdomain,
            }
            self.save()
            return grouped

    def get_backup_stats(self) -> dict[str, Any]:
        with self._lock:
            count = 0
            total_bytes = 0
            if self.storage_dir.exists():
                for root, _, files in os.walk(self.storage_dir):
                    for f in files:
                        p = Path(root) / f
                        try:
                            total_bytes += p.stat().st_size
                            count += 1
                        except OSError:
                            pass

            cost_monthly = (total_bytes / 1_000_000_000_000.0) * PRICE_PER_TB_MONTHLY
            return {
                "ok": True,
                "backup_unlocked": self.backup_unlocked,
                "objects_count": count,
                "total_bytes": total_bytes,
                "total_formatted": format_bytes(total_bytes),
                "egress_bytes": self.egress_bytes,
                "egress_formatted": format_bytes(self.egress_bytes),
                "cost_monthly_usd": round(cost_monthly, 4),
                "rate": "$8/TB/month",
                "storage_dir": str(self.storage_dir),
            }

    def clean_storage(self) -> int:
        with self._lock:
            removed = 0
            if self.storage_dir.exists():
                for root, dirs, files in os.walk(self.storage_dir, topdown=False):
                    for f in files:
                        try:
                            (Path(root) / f).unlink()
                            removed += 1
                        except OSError:
                            pass
                    for d in dirs:
                        try:
                            (Path(root) / d).rmdir()
                        except OSError:
                            pass
            self.egress_bytes = 0
            self.save()
            return removed

    def to_status_dict(self) -> dict[str, Any]:
        with self._lock:
            stats = self.get_backup_stats()
            return {
                "device_id": "dev_mock_luna",
                "mode": self.mode,
                "bound": self.bound,
                "paired": self.paired,
                "backup_unlocked": self.backup_unlocked,
                "hostname": self.hostname,
                "subdomain": self.subdomain,
                "domain": self.domain,
                "tunnel_token": self.tunnel_token,
                "tunnel_id": self.tunnel_id,
                "backup_sources": self.backup_sources,
                "storage": stats,
                "active_tokens": list(self.tokens.keys()),
            }


class MockConnectHandler(BaseHTTPRequestHandler):
    """HTTP request handler for Luna Connect mock endpoints."""

    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> MockState:
        return self.server.mock_state  # type: ignore[attr-defined]

    @property
    def storage_dir(self) -> Path:
        return self.state.storage_dir

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[mock-connect] {self.address_string()} {fmt % args}")

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: Any, extra: dict[str, str] | None = None) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self._send(status, raw, "application/json", extra)

    def _send_challenge(self) -> None:
        self._send(
            403,
            CF_HTML.encode("utf-8"),
            "text/html; charset=UTF-8",
            {"cf-mitigated": "challenge"},
        )

    def _check_auth(self) -> tuple[bool, str]:
        """Validate Authorization header containing a Bearer Crockford device token."""
        auth = self.headers.get("Authorization", "").strip()
        if not auth.startswith("Bearer "):
            return False, "missing Bearer token"
        token = auth[7:].strip()
        norm = normalize_token(token)
        if not is_valid_crockford(norm):
            return False, "malformed Crockford token"
        return True, norm

    def _safe_object_path(self, rel: str) -> Path | None:
        """Resolve a relative object path securely within storage_dir."""
        rel = rel.lstrip("/")
        if ".." in rel or not rel:
            return None
        target = (self.storage_dir / rel).resolve()
        try:
            target.relative_to(self.storage_dir.resolve())
        except ValueError:
            return None
        return target

    # ---------------- GET Handlers ----------------

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # Health checks
        if path in ("/healthz", "/api/v1/healthz"):
            if self.state.mode == "challenge":
                self._send_challenge()
                return
            self._send_json(200, {"ok": True, "mode": self.state.mode})
            return

        # Legacy & debug mode switch endpoint
        if path == "/_debug/mode":
            self._send_json(200, {"mode": self.state.mode})
            return

        # Full mock status & inspection
        if path in ("/_mock/status", "/_mock/state"):
            self._send_json(200, self.state.to_status_dict())
            return

        # Backup storage stats
        if path in ("/_mock/backup/stats", "/api/v1/backup/status", "/api/v1/billing/usage"):
            self._send_json(200, self.state.get_backup_stats())
            return

        # List backups (/api/v1/backups)
        if path == "/api/v1/backups":
            objects = []
            if self.storage_dir.exists():
                for root, _, files in os.walk(self.storage_dir):
                    for f in files:
                        p = Path(root) / f
                        try:
                            rel = str(p.relative_to(self.storage_dir))
                            size = p.stat().st_size
                            mtime = int(p.stat().st_mtime)
                            content = p.read_bytes()
                            c_hash = hashlib.sha256(content).hexdigest()
                            objects.append({
                                "relative_path": rel,
                                "size": size,
                                "content_hash": c_hash,
                                "updated_at": mtime,
                            })
                        except OSError:
                            pass
            self._send_json(200, {
                "objects": objects,
                "total_objects": len(objects),
                "total_bytes": sum(o["size"] for o in objects),
                "note": "Latest cloud copy in mock storage.",
            })
            return

        # Domain availability check
        if path == "/api/v1/domain/available":
            name = (query.get("name") or [""])[0].strip().lower()
            if not name:
                self._send_json(400, {"error": "name parameter is required"})
                return
            available = name != "taken"
            self._send_json(200, {
                "available": available,
                "hostname": f"{name}.{self.state.domain}",
            })
            return

        # Onboarding / account devices
        if path == "/api/v1/account/devices":
            self._send_json(200, {
                "devices": [{
                    "id": "dev_mock_luna",
                    "name": self.state.subdomain,
                    "subdomain": self.state.subdomain,
                    "hostname": self.state.hostname,
                    "paired": self.state.paired,
                    "bound": self.state.bound,
                }]
            })
            return

        # GET Backup Object: /api/v1/backup/objects/*
        if path.startswith("/api/v1/backup/objects/"):
            rel = path[len("/api/v1/backup/objects/") :]
            target = self._safe_object_path(rel)
            if not target or not target.is_file():
                self._send_json(404, {"error": "That file is not in cloud backup."})
                return
            try:
                data = target.read_bytes()
                self.state.egress_bytes += len(data)
                self.state.save()
                c_hash = hashlib.sha256(data).hexdigest()
                self._send(
                    200,
                    data,
                    "application/octet-stream",
                    {
                        "X-Content-Hash": c_hash,
                        "Content-Disposition": f'attachment; filename="{target.name}"',
                    },
                )
            except OSError as e:
                self._send_json(500, {"error": f"Failed reading object: {e}"})
            return

        # Primary Status Pull: /api/v1/status
        if path == "/api/v1/status":
            mode = self.state.mode

            if mode == "challenge":
                self._send_challenge()
                return
            if mode == "unbound":
                self._send_json(403, {"error": "unbound"})
                return
            if mode == "401":
                self._send_json(401, {"error": "This Luna is not signed in to Connect."})
                return

            # Validate auth header
            ok, norm = self._check_auth()
            if not ok:
                self._send_json(401, {"error": "This Luna is not linked to Luna Connect. Add your device token in Settings → About → Advanced."})
                return

            # Check port header from lunad if sent
            local_port = self.headers.get("X-Luna-Local-Port")
            if local_port:
                print(f"[mock-connect] lunad reported local port: {local_port}")

            resp = {
                "device_id": "dev_mock_luna",
                "bound": self.state.bound,
                "paired": self.state.paired,
                "backup_unlocked": self.state.backup_unlocked,
                "hostname": self.state.hostname,
                "subdomain": self.state.subdomain,
                "domain": self.state.domain,
                "tunnel_token": self.state.tunnel_token,
                "tunnel_id": self.state.tunnel_id,
                "backup_sources": self.state.backup_sources,
            }
            self._send_json(200, resp)
            return

        self._send_json(404, {"error": f"not found: {path}"})

    # ---------------- POST Handlers ----------------

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        raw = self._read_body()
        payload: dict[str, Any] = {}
        if raw:
            try:
                payload = json.loads(raw.decode("utf-8"))
            except json.JSONDecodeError:
                self._send_json(400, {"error": "invalid json"})
                return

        # Debug mode switch
        if path in ("/_debug/mode", "/_mock/mode"):
            mode = str(payload.get("mode", "")).strip().lower()
            allowed = {"bound", "unbound", "challenge", "401", "backup_locked", "storage_full", "bound_spawn"}
            if mode not in allowed:
                self._send_json(400, {"error": f"mode must be one of: {', '.join(sorted(allowed))}"})
                return
            self.state.set_mode(mode)
            print(f"[mock-connect] mode switched -> {mode}")
            self._send_json(200, {"ok": True, "mode": mode})
            return

        # Mock domain control
        if path == "/_mock/domain":
            sub = str(payload.get("subdomain", "")).strip().lower()
            dom = payload.get("domain")
            if not sub:
                self._send_json(400, {"error": "subdomain is required"})
                return
            res = self.state.set_domain(sub, dom)
            self._send_json(200, {"ok": True, **res})
            return

        # Mock backup unlock/lock
        if path == "/_mock/backup/unlock":
            self.state.set_backup_unlocked(True)
            self._send_json(200, {"ok": True, "backup_unlocked": True})
            return

        if path == "/_mock/backup/lock":
            self.state.set_backup_unlocked(False)
            self._send_json(200, {"ok": True, "backup_unlocked": False})
            return

        # Mock clean storage
        if path == "/_mock/backup/clean":
            removed = self.state.clean_storage()
            self._send_json(200, {"ok": True, "removed_objects": removed})
            return

        # Mock mint token
        if path == "/_mock/token/mint":
            token = mint_device_token()
            self.state.add_token(token)
            self._send_json(200, {
                "ok": True,
                "token": token,
                "normalized": normalize_token(token),
                "setup_prefix": setup_prefix(token),
            })
            return

        # Mock state reset
        if path == "/_mock/reset":
            self.state.mode = "bound"
            self.state.subdomain = "repro"
            self.state.domain = "luna.servers.libreloom.org"
            self.state.hostname = f"{self.state.subdomain}.{self.state.domain}"
            self.state.tunnel_token = f"mock-{self.state.subdomain}-tunnel-token"
            self.state.backup_unlocked = True
            self.state.bound = True
            self.state.paired = True
            self.state.clean_storage()
            self.state.save()
            self._send_json(200, {"ok": True, "state": self.state.to_status_dict()})
            return

        # POST /api/v1/domain (lunad changing domain)
        if path == "/api/v1/domain":
            ok, _ = self._check_auth()
            if not ok:
                self._send_json(401, {"error": "unauthorized"})
                return
            sub = str(payload.get("subdomain", "")).strip().lower()
            if not sub:
                self._send_json(400, {"error": "subdomain is required"})
                return
            res = self.state.set_domain(sub)
            self._send_json(200, {
                "hostname": res["hostname"],
                "subdomain": res["subdomain"],
                "tunnel_token": res["tunnel_token"],
            })
            return

        # POST /api/v1/first-user (lunad acknowledgement)
        if path == "/api/v1/first-user":
            self._send_json(200, {"ok": True})
            return

        # POST /api/v1/unregister (lunad deactivation)
        if path == "/api/v1/unregister":
            self.state.set_mode("unbound")
            self._send_json(200, {"ok": True})
            return

        # POST /api/v1/devices/bind (account binding a token)
        if path == "/api/v1/devices/bind":
            code = str(payload.get("code", "")).strip()
            norm = normalize_token(code)
            if not is_valid_crockford(norm):
                self._send_json(400, {"error": "Type the full device token (****-****-****-****-****)."})
                return
            token_grouped = group_token(norm)
            self.state.add_token(token_grouped)
            self.state.set_mode("bound")
            self._send_json(200, {
                "device_id": "dev_mock_luna",
                "already_bound": False,
                "token": token_grouped,
            })
            return

        self._send_json(404, {"error": f"not found: {path}"})

    # ---------------- PUT Handlers ----------------

    def do_PUT(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # PUT Backup Object: /api/v1/backup/objects/*
        if path.startswith("/api/v1/backup/objects/"):
            mode = self.state.mode
            if mode == "challenge":
                self._send_challenge()
                return
            if mode == "401":
                self._send_json(401, {"error": "unauthorized"})
                return
            if mode == "storage_full":
                self._send_json(413, {"error": "Cloud backup for this account is full. Remove some files, then try again."})
                return
            if mode == "backup_locked" or not self.state.backup_unlocked:
                self._send_json(402, {"error": "Add a payment card at connect.luna.libreloom.org so we can store a cloud backup. It costs $8 per terabyte each month."})
                return

            ok, _ = self._check_auth()
            if not ok:
                self._send_json(401, {"error": "unauthorized"})
                return

            rel = path[len("/api/v1/backup/objects/") :]
            target = self._safe_object_path(rel)
            if not target:
                self._send_json(400, {"error": "Cloud backup did not receive a valid file path."})
                return

            body = self._read_body()
            content_hash = hashlib.sha256(body).hexdigest()

            # Verify client content-hash header if provided
            client_hash = self.headers.get("X-Content-Hash", "").strip().lower()
            if client_hash and client_hash != content_hash:
                self._send_json(400, {"error": "The file did not match what Luna said it sent. Try the copy again."})
                return

            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
                print(f"[mock-connect] stored backup chunk: {rel} ({format_bytes(len(body))})")
                self._send_json(200, {
                    "ok": True,
                    "size": len(body),
                    "content_hash": content_hash,
                })
            except OSError as e:
                self._send_json(500, {"error": f"Failed saving backup object: {e}"})
            return

        self._send_json(404, {"error": f"not found: {path}"})

    # ---------------- DELETE Handlers ----------------

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # DELETE /api/v1/devices/* (account unbinding device)
        if path.startswith("/api/v1/devices/"):
            self.state.set_mode("unbound")
            self._send_json(200, {"ok": True})
            return

        # DELETE Backup Object: /api/v1/backup/objects/*
        if path.startswith("/api/v1/backup/objects/"):
            ok, _ = self._check_auth()
            if not ok:
                self._send_json(401, {"error": "unauthorized"})
                return

            rel = path[len("/api/v1/backup/objects/") :]
            target = self._safe_object_path(rel)
            if target and target.is_file():
                try:
                    target.unlink()
                    print(f"[mock-connect] deleted backup chunk: {rel}")
                except OSError as e:
                    self._send_json(500, {"error": f"Failed deleting backup object: {e}"})
                    return
            self._send_json(200, {"ok": True})
            return

        self._send_json(404, {"error": f"not found: {path}"})


# ---------------- CLI Client Helpers ----------------


def http_client_request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    timeout: float = 1.0,
) -> tuple[int, dict[str, Any]]:
    """Send an HTTP request to the running mock server, returning (status_code, parsed_json)."""
    url = f"http://{host}:{port}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if payload is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, {"raw": raw}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"error": raw}
    except Exception as e:
        return 0, {"error": str(e)}


def is_server_running(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> bool:
    code, _ = http_client_request("GET", "/healthz", host=host, port=port)
    return code in (200, 403)


# ---------------- CLI Commands ----------------


def cmd_status(args: argparse.Namespace) -> int:
    host = args.host
    port = args.port
    online = is_server_running(host, port)

    if online:
        code, data = http_client_request("GET", "/_mock/status", host=host, port=port)
        if code != 200:
            print(f"Error communicating with mock server: {data}", file=sys.stderr)
            return 1
        st = data
    else:
        # Fall back to reading state file directly
        state = MockState(args.state_file, args.storage_dir)
        st = state.to_status_dict()

    if getattr(args, "json", False):
        print(json.dumps(st, indent=2))
        return 0

    mode = st.get("mode", "unknown")
    bound = st.get("bound", False)
    storage = st.get("storage", {})
    cost = storage.get("cost_monthly_usd", 0.0)
    unlocked = st.get("backup_unlocked", False)
    server_status = f"ONLINE (http://{host}:{port})" if online else "OFFLINE"

    print("=" * 60)
    print(f"Luna Connect Mock: {server_status}")
    print("=" * 60)
    print(f"  Mode:            {mode.upper()}")
    print(f"  Bound:           {'Yes' if bound else 'No'}")
    print(f"  Hostname:        {st.get('hostname') or 'None'}")
    print(f"  Subdomain:       {st.get('subdomain') or 'None'}")
    print(f"  Tunnel Token:    {st.get('tunnel_token') or 'None'}")
    print(f"  Cloud Backup:    {'UNLOCKED (active)' if unlocked else 'LOCKED ($8/TB unpaid)'}")
    print(f"  Stored Objects:  {storage.get('objects_count', 0)} files ({storage.get('total_formatted', '0 B')})")
    print(f"  Egress Bandwidth:{storage.get('egress_formatted', '0 B')}")
    print(f"  Estimated Cost:  ${cost:.4f} / month (@ $8/TB/month)")
    print(f"  Storage Dir:     {storage.get('storage_dir', str(args.storage_dir))}")

    active_tokens = st.get("active_tokens", [])
    if active_tokens:
        print(f"  Mock Tokens:     {', '.join(active_tokens)}")
    print("=" * 60)
    return 0


def cmd_mode_set(args: argparse.Namespace) -> int:
    mode = args.mode.strip().lower()
    host = args.host
    port = args.port

    if is_server_running(host, port):
        code, data = http_client_request("POST", "/_mock/mode", {"mode": mode}, host=host, port=port)
        if code == 200:
            print(f">> Mode updated to '{mode}' on running mock server (http://{host}:{port}).")
            return 0
        print(f"Error updating mode on server: {data}", file=sys.stderr)
        return 1

    state = MockState(args.state_file, args.storage_dir)
    state.set_mode(mode)
    print(f">> Mode set to '{mode}' in state file (server offline; takes effect when started).")
    return 0


def cmd_domain_set(args: argparse.Namespace) -> int:
    sub = args.subdomain.strip().lower()
    dom = args.domain.strip().lower() if args.domain else None
    host = args.host
    port = args.port

    if is_server_running(host, port):
        code, data = http_client_request("POST", "/_mock/domain", {"subdomain": sub, "domain": dom}, host=host, port=port)
        if code == 200:
            print(f">> Subdomain updated to '{data.get('subdomain')}' -> hostname: {data.get('hostname')}")
            print(f"   Tunnel token: {data.get('tunnel_token')}")
            return 0
        print(f"Error updating domain on server: {data}", file=sys.stderr)
        return 1

    state = MockState(args.state_file, args.storage_dir)
    res = state.set_domain(sub, dom)
    print(f">> Subdomain set to '{res['subdomain']}' -> hostname: {res['hostname']} (server offline).")
    print(f"   Tunnel token: {res['tunnel_token']}")
    return 0


def cmd_backup_unlock(args: argparse.Namespace) -> int:
    host = args.host
    port = args.port

    if is_server_running(host, port):
        code, data = http_client_request("POST", "/_mock/backup/unlock", {}, host=host, port=port)
        if code == 200:
            print(f">> Cloud backup UNLOCKED on running mock server (http://{host}:{port}).")
            return 0
        print(f"Error unlocking backup: {data}", file=sys.stderr)
        return 1

    state = MockState(args.state_file, args.storage_dir)
    state.set_backup_unlocked(True)
    print(">> Cloud backup UNLOCKED in state file (server offline).")
    return 0


def cmd_backup_lock(args: argparse.Namespace) -> int:
    host = args.host
    port = args.port

    if is_server_running(host, port):
        code, data = http_client_request("POST", "/_mock/backup/lock", {}, host=host, port=port)
        if code == 200:
            print(f">> Cloud backup LOCKED on running mock server (http://{host}:{port}).")
            return 0
        print(f"Error locking backup: {data}", file=sys.stderr)
        return 1

    state = MockState(args.state_file, args.storage_dir)
    state.set_backup_unlocked(False)
    print(">> Cloud backup LOCKED in state file (server offline).")
    return 0


def cmd_backup_stats(args: argparse.Namespace) -> int:
    host = args.host
    port = args.port

    if is_server_running(host, port):
        code, data = http_client_request("GET", "/_mock/backup/stats", host=host, port=port)
        stats = data if code == 200 else {}
    else:
        state = MockState(args.state_file, args.storage_dir)
        stats = state.get_backup_stats()

    count = stats.get("objects_count", 0)
    total_fmt = stats.get("total_formatted", "0 B")
    egress_fmt = stats.get("egress_formatted", "0 B")
    cost = stats.get("cost_monthly_usd", 0.0)
    unlocked = stats.get("backup_unlocked", False)

    print("Luna Connect Cloud Backup Stats:")
    print(f"  Status:          {'UNLOCKED (active)' if unlocked else 'LOCKED ($8/TB unpaid)'}")
    print(f"  Stored Objects:  {count}")
    print(f"  Total Stored:    {total_fmt} ({stats.get('total_bytes', 0):,} bytes)")
    print(f"  Egress Bandwidth:{egress_fmt} ({stats.get('egress_bytes', 0):,} bytes)")
    print(f"  Simulated Cost:  ${cost:.4f} / month (@ $8.00/TB/month)")
    print(f"  Storage Path:    {stats.get('storage_dir', str(args.storage_dir))}")
    return 0


def cmd_backup_clean(args: argparse.Namespace) -> int:
    host = args.host
    port = args.port

    if is_server_running(host, port):
        code, data = http_client_request("POST", "/_mock/backup/clean", {}, host=host, port=port)
        if code == 200:
            print(f">> Cleaned {data.get('removed_objects', 0)} mock backup objects on server.")
            return 0
        print(f"Error cleaning backup objects on server: {data}", file=sys.stderr)
        return 1

    state = MockState(args.state_file, args.storage_dir)
    removed = state.clean_storage()
    print(f">> Cleaned {removed} mock backup objects from {args.storage_dir}.")
    return 0


def cmd_mint_token(args: argparse.Namespace) -> int:
    token = mint_device_token()
    norm = normalize_token(token)
    prefix = setup_prefix(token)

    write_path: Path | None = None
    if getattr(args, "write_to", None):
        write_path = Path(args.write_to)
    elif getattr(args, "write", False):
        write_path = DEFAULT_DEVICE_TOKEN_FILE

    if write_path:
        write_path.parent.mkdir(parents=True, exist_ok=True)
        write_path.write_text(f"{token}\n", encoding="utf-8")
        try:
            write_path.chmod(0o600)
        except OSError:
            pass

    # Register token with server or state
    host = args.host
    port = args.port
    if is_server_running(host, port):
        http_client_request("POST", "/_mock/token/mint", {"token": token}, host=host, port=port)
    else:
        state = MockState(args.state_file, args.storage_dir)
        state.add_token(token)

    print("Minted Crockford Device Token:")
    print(f"  Token:           {token}")
    print(f"  Normalized:      {norm}")
    print(f"  Setup Prefix:    {prefix} (first 8 chars)")
    if write_path:
        print(f"  Written To:      {write_path} (mode 0600)")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            print(f">> Sent SIGTERM to mock server process (PID {pid}).")
            for _ in range(20):
                time.sleep(0.1)
                try:
                    os.kill(pid, 0)
                except OSError:
                    break
            if PID_FILE.exists():
                PID_FILE.unlink()
            print(">> Mock Connect server stopped.")
            return 0
        except (ValueError, OSError) as e:
            print(f"Warning stopping PID: {e}", file=sys.stderr)
            if PID_FILE.exists():
                PID_FILE.unlink()

    # Try checking via HTTP port
    if is_server_running(args.host, args.port):
        print(f">> A server is running on {args.host}:{args.port}, but PID file was not found.", file=sys.stderr)
        return 1

    print(">> Mock Connect server is not running.")
    return 0


def run_server(host: str, port: int, state_file: Path, storage_dir: Path, mode: str | None = None) -> int:
    """Run the ThreadingHTTPServer in foreground."""
    state = MockState(state_file, storage_dir)
    if mode:
        state.set_mode(mode)

    storage_dir.mkdir(parents=True, exist_ok=True)

    server = ThreadingHTTPServer((host, port), MockConnectHandler)
    server.mock_state = state  # type: ignore[attr-defined]

    # Save PID file
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(str(os.getpid()), encoding="utf-8")

    def _handle_signal(sig: int, _frame: Any) -> None:
        print(f"\n[mock-connect] received signal {sig}, shutting down...")
        if PID_FILE.exists():
            PID_FILE.unlink()
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    print("=" * 60)
    print(f"Luna Connect Mock Server listening on http://{host}:{port}")
    print(f"  Mode:            {state.mode}")
    print(f"  Subdomain:       {state.subdomain}")
    print(f"  Hostname:        {state.hostname}")
    print(f"  Cloud Backup:    {'UNLOCKED' if state.backup_unlocked else 'LOCKED'}")
    print(f"  Storage Dir:     {storage_dir}")
    print(f"  State File:      {state_file}")
    print("=" * 60)
    print("Control shortcuts:")
    print(f"  Mode switch:     curl -X POST http://{host}:{port}/_mock/mode -d '{{\"mode\":\"challenge\"}}'")
    print(f"  Status:          python3 luna/scripts/mock-connect.py status")
    print("=" * 60)

    try:
        server.serve_forever()
    finally:
        if PID_FILE.exists():
            PID_FILE.unlink()
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    host = args.host
    port = args.port
    mode = getattr(args, "mode", None)

    if getattr(args, "daemon", False):
        import subprocess

        cmd = [
            sys.executable,
            str(Path(__file__).resolve()),
            "serve",
            "--host",
            host,
            "--port",
            str(port),
            "--state-file",
            str(args.state_file),
            "--storage-dir",
            str(args.storage_dir),
        ]
        if mode:
            cmd.extend(["--mode", mode])

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        print(f">> Started mock Connect server in background (PID {proc.pid}) at http://{host}:{port}")
        return 0

    return run_server(host, port, args.state_file, args.storage_dir, mode)


# ---------------- Main Argument Parser ----------------


def main() -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--host", default=argparse.SUPPRESS, help=f"Server host (default: {DEFAULT_HOST})")
    common.add_argument("--port", type=int, default=argparse.SUPPRESS, help=f"Server port (default: {DEFAULT_PORT})")
    common.add_argument("--state-file", type=Path, default=argparse.SUPPRESS, help="Path to state JSON file")
    common.add_argument("--storage-dir", type=Path, default=argparse.SUPPRESS, help="Path to mock cloud storage directory")

    parser = argparse.ArgumentParser(description="Luna Connect Mock Server & CLI", parents=[common])

    sub = parser.add_subparsers(dest="subcommand")

    # status
    p_status = sub.add_parser("status", parents=[common], help="Show mock server status and storage usage")
    p_status.add_argument("--json", action="store_true", help="Print raw JSON status")
    p_status.set_defaults(func=cmd_status)

    # mode
    p_mode = sub.add_parser("mode", parents=[common], help="Inspect or change mock response mode")
    p_mode_sub = p_mode.add_subparsers(dest="mode_cmd", required=True)
    p_mode_set = p_mode_sub.add_parser("set", parents=[common], help="Set mock response mode")
    p_mode_set.add_argument(
        "mode",
        choices=["bound", "unbound", "challenge", "401", "backup_locked", "storage_full", "bound_spawn"],
        help="Response mode simulation",
    )
    p_mode_set.set_defaults(func=cmd_mode_set)

    # domain
    p_domain = sub.add_parser("domain", parents=[common], help="Inspect or set domain configuration")
    p_domain_sub = p_domain.add_subparsers(dest="domain_cmd", required=True)
    p_domain_set = p_domain_sub.add_parser("set", parents=[common], help="Set subdomain and optional custom domain")
    p_domain_set.add_argument("subdomain", help="Subdomain name (e.g. photos)")
    p_domain_set.add_argument("domain", nargs="?", default=None, help="Domain suffix (default: luna.servers.libreloom.org)")
    p_domain_set.set_defaults(func=cmd_domain_set)

    # backup
    p_backup = sub.add_parser("backup", parents=[common], help="Inspect or configure cloud backup simulation")
    p_backup_sub = p_backup.add_subparsers(dest="backup_cmd", required=True)
    p_backup_sub.add_parser("unlock", parents=[common], help="Unlock cloud backup ($8/TB paid)").set_defaults(func=cmd_backup_unlock)
    p_backup_sub.add_parser("lock", parents=[common], help="Lock cloud backup ($8/TB unpaid)").set_defaults(func=cmd_backup_lock)
    p_backup_sub.add_parser("stats", parents=[common], help="Display backup object count, storage, and cost").set_defaults(func=cmd_backup_stats)
    p_backup_sub.add_parser("clean", parents=[common], help="Remove all stored mock backup objects").set_defaults(func=cmd_backup_clean)

    # mint-token
    p_mint = sub.add_parser("mint-token", parents=[common], help="Generate a valid Crockford device token")
    p_mint.add_argument("--write", action="store_true", help="Write to luna/dev/device-token")
    p_mint.add_argument("--write-to", help="Write to specific file path")
    p_mint.set_defaults(func=cmd_mint_token)

    # serve
    p_serve = sub.add_parser("serve", parents=[common], aliases=["server", "run", "start"], help="Start the mock Connect HTTP server")
    p_serve.add_argument(
        "--mode",
        choices=["bound", "unbound", "challenge", "401", "backup_locked", "storage_full", "bound_spawn"],
        help="Initial server mode",
    )
    p_serve.add_argument("--daemon", "-d", action="store_true", help="Run server in background")
    p_serve.set_defaults(func=cmd_serve)

    # stop
    p_stop = sub.add_parser("stop", parents=[common], help="Stop background mock Connect server")
    p_stop.set_defaults(func=cmd_stop)


    # Default to "serve" if no command provided
    if len(sys.argv) == 1:
        args = parser.parse_args(["serve"])
    else:
        args = parser.parse_args()

    args.host = getattr(args, "host", None) or DEFAULT_HOST
    args.port = getattr(args, "port", None) or DEFAULT_PORT
    args.state_file = getattr(args, "state_file", None) or DEFAULT_STATE_FILE
    args.storage_dir = getattr(args, "storage_dir", None) or DEFAULT_STORAGE_DIR

    if not hasattr(args, "func"):
        parser.print_help()
        return 1

    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
