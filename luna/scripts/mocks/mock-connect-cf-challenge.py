#!/usr/bin/env python3
"""Local Luna Connect mock for challenge and device-state reproduction.

Modes (set MOCK_MODE, or switch with POST /_debug/mode):
  challenge   — HTTP 403 HTML + cf-mitigated: challenge
  unbound     — tombstoned credentials get 403 + code=device_unbound
  revoked     — tombstoned credentials get 403 + code=device_revoked
  bound       — HTTP 200 status; the current rolling credential is required
  bound_spawn — like bound, with a non-mock tunnel token for cloudflared debugging
  401         — HTTP 401 JSON

The script keeps a rolling credential in memory and mirrors it to
``{LUNA_DATA_DIR}/connect-credential`` with mode 0600. It creates missing local
Device ID and Verification code files so a fresh ``luna/dev`` can be used
without the removed permanent device token.

Usage:
  python3 luna/scripts/mocks/mock-connect-cf-challenge.py
  LUNA_CONNECT_URL=http://127.0.0.1:18765 make -C luna dev-daemon

Switch modes without putting a bearer credential in the URL or the log:
  curl -sS -X POST http://127.0.0.1:18765/_debug/mode \
    -H 'Content-Type: application/json' -d '{"mode":"unbound"}'

A Cloudflare challenge leaves the local binding alone. The explicit unbound
and revoked codes let lunad finish an unbind or enter recovery-required state.
POST /api/v1/token/refresh rotates the credential; the previous credential is
accepted there only for 60 seconds.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("LUNA_DATA_DIR", ROOT / "dev"))
HOST = os.environ.get("MOCK_CONNECT_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOCK_CONNECT_PORT", "18765"))
MODES = {"challenge", "unbound", "revoked", "bound", "bound_spawn", "401"}
REFRESH_SECONDS = 300
OVERLAP_SECONDS = 60
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

BOUND_JSON = {
    "device_id": "dev_cf_mock",
    "hostname": "repro.luna.servers.libreloom.org",
    "subdomain": "repro",
    "domain": "luna.servers.libreloom.org",
    "tunnel_token": "mock-repro-tunnel-token",
    "backup_unlocked": False,
    "paired": True,
    "bound": True,
}

# Non-mock token so lunad takes the real cloudflared spawn path.
BOUND_SPAWN_JSON = {
    **BOUND_JSON,
    "tunnel_token": "eyJhbGciOiJDEBUG_TUNNEL_TOKEN_FOR_SPAWN_PATH",
}


def mint_secret() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")


def valid_secret(token: str) -> bool:
    if not token or "=" in token:
        return False
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
    except ValueError:
        return False
    return len(raw) == 32 and base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii") == token


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def write_private(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(value + "\n")


def ensure_local_material() -> str:
    configured = os.environ.get("MOCK_AUTH_TOKEN", "").strip()
    credential_path = DATA_DIR / "connect-credential"
    if credential_path.exists():
        credential_path.chmod(0o600)
    saved = credential_path.read_text(encoding="utf-8").strip() if credential_path.exists() else ""
    token = configured or (saved if valid_secret(saved) else "")
    if not valid_secret(token):
        token = mint_secret()
    write_private(credential_path, token)

    uid_path = DATA_DIR / "device-uid"
    if not uid_path.exists():
        uid = "".join(secrets.choice(CROCKFORD_ALPHABET) for _ in range(20))
        write_private(uid_path, uid)
    code_path = DATA_DIR / "pairing-code"
    if not code_path.exists():
        write_private(code_path, secrets.token_hex(3).upper())
    else:
        code_path.chmod(0o600)
    return token


class CredentialState:
    def __init__(self, token: str, mode: str):
        self.lock = threading.RLock()
        self.mode = mode
        self.auth_token = token
        self.auth_token_hash = hash_token(token)
        self.previous_auth_token_hash = ""
        self.previous_valid_until = 0

    def set_mode(self, mode: str) -> None:
        with self.lock:
            self.mode = mode
            if mode in ("unbound", "revoked"):
                # The hashes stay as non-authenticating tombstones, but the
                # refresh overlap no longer applies after either transition.
                self.previous_valid_until = 0

    def classify(self, token: str, now: int) -> tuple[str, str]:
        if not valid_secret(token):
            return "invalid", ""
        digest = hash_token(token)
        with self.lock:
            if self.mode in ("unbound", "revoked") and digest in (
                self.auth_token_hash,
                self.previous_auth_token_hash,
            ):
                return "tombstone", f"device_{self.mode}"
            if self.mode not in ("bound", "bound_spawn"):
                return "invalid", ""
            if digest == self.auth_token_hash and hmac.compare_digest(token, self.auth_token):
                return "current", ""
            if (
                digest == self.previous_auth_token_hash
                and self.previous_valid_until > now
            ):
                return "previous", ""
            return "invalid", ""

    def refresh(self, token: str, now: int) -> tuple[str, str]:
        with self.lock:
            state, code = self.classify(token, now)
            if state == "tombstone":
                return "", code
            if state == "current":
                self.previous_auth_token_hash = self.auth_token_hash
                self.previous_valid_until = now + OVERLAP_SECONDS
                self.auth_token = mint_secret()
                self.auth_token_hash = hash_token(self.auth_token)
                write_private(DATA_DIR / "connect-credential", self.auth_token)
                return self.auth_token, ""
            if state == "previous":
                return self.auth_token, ""
            return "", ""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def credentials(self) -> CredentialState:
        return self.server.credentials  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        # BaseHTTPRequestHandler logs the request line only. Never add headers:
        # Authorization contains the rolling bearer credential.
        print(f"[mock-connect] {self.address_string()} {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict, extra: dict | None = None) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json", extra)

    def _send_challenge(self) -> None:
        self._send(403, CF_HTML.encode("utf-8"), "text/html; charset=UTF-8", {"cf-mitigated": "challenge"})

    def _send_state_error(self, code: str) -> None:
        message = "This Luna's connection to Luna Connect is no longer active."
        self._send_json(403, {"error": message, "message": message, "code": code})

    @staticmethod
    def _bearer() -> str:
        header = self.headers.get("Authorization", "").strip()
        return header[7:].strip() if header.startswith("Bearer ") else ""

    def _simulation(self) -> bool:
        mode = self.credentials.mode
        if mode == "challenge":
            self._send_challenge()
            return True
        if mode == "401":
            self._send_json(401, {"error": "This Luna is not signed in to Connect."})
            return True
        return False

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/healthz", "/api/v1/healthz"):
            if self._simulation():
                return
            self._send_json(200, {"ok": True, "mode": self.credentials.mode})
            return
        if path in ("/_debug/mode", "/_mock/mode"):
            self._send_json(200, {"mode": self.credentials.mode})
            return
        if path != "/api/v1/status":
            self._send_json(404, {"error": "not found"})
            return
        if self._simulation():
            return
        state, code = self.credentials.classify(self._bearer(), int(time.time()))
        if state == "tombstone":
            self._send_state_error(code)
            return
        if state != "current":
            self._send_json(401, {"error": "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect."})
            return
        payload = BOUND_SPAWN_JSON if self.credentials.mode == "bound_spawn" else BOUND_JSON
        self._send_json(200, payload)

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/_debug/mode":
            try:
                length = int(self.headers.get("Content-Length", "0") or "0")
                if length < 0:
                    raise ValueError("negative content length")
                payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                if not isinstance(payload, dict):
                    raise ValueError("mode body must be an object")
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": "bad json"})
                return
            mode = str(payload.get("mode", "")).strip().lower()
            if mode not in MODES:
                self._send_json(400, {"error": "mode must be challenge|unbound|revoked|bound|bound_spawn|401"})
                return
            self.credentials.set_mode(mode)
            print(f"[mock-connect] mode switched -> {mode}")
            self._send_json(200, {"mode": mode})
            return
        if path != "/api/v1/token/refresh":
            self._send_json(404, {"error": "not found"})
            return
        if self._simulation():
            return
        rotated, code = self.credentials.refresh(self._bearer(), int(time.time()))
        if code:
            self._send_state_error(code)
            return
        if not rotated:
            self._send_json(401, {"error": "This Luna is not linked to Luna Connect."})
            return
        self._send_json(200, {"auth_token": rotated, "refresh_after_seconds": REFRESH_SECONDS})


def main() -> None:
    token = ensure_local_material()
    mode = os.environ.get("MOCK_MODE", "challenge").strip().lower()
    if mode not in MODES:
        raise SystemExit(f"unknown MOCK_MODE: {mode}")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.credentials = CredentialState(token, mode)  # type: ignore[attr-defined]
    print(f"[mock-connect] listening on http://{HOST}:{PORT} mode={mode}")
    print(f"[mock-connect] local credential: {DATA_DIR / 'connect-credential'} (mode 0600)")
    print("[mock-connect] switch: curl -X POST http://127.0.0.1:18765/_debug/mode -d '{\"mode\":\"unbound\"}'")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock-connect] stopped")


if __name__ == "__main__":
    main()
