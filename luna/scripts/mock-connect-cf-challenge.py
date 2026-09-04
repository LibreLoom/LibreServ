#!/usr/bin/env python3
"""Local Luna Connect mock for CF-challenge vs authentic unbound 403 reproduction.

Modes (set MOCK_MODE env, or switch via POST /_debug/mode):
  challenge  — HTTP 403 HTML + cf-mitigated: challenge  (Cloudflare managed JS challenge)
  unbound    — HTTP 403 application/json {"error":"unbound"}  (real Connect unbind)
  bound      — HTTP 200 with hostname + mock- tunnel_token (lunad skips real cloudflared)
  bound_spawn — HTTP 200 with hostname + non-mock token (forces ensure_tunnel spawn path)
  401        — HTTP 401 JSON (rejected device token)

Default mode: challenge

Usage:
  python3 luna/scripts/mock-connect-cf-challenge.py
  # listens on 127.0.0.1:18765

  LUNA_CONNECT_URL=http://127.0.0.1:18765 make -C luna dev-daemon
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("MOCK_CONNECT_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOCK_CONNECT_PORT", "18765"))
MODE_LOCK = threading.Lock()
MODE = os.environ.get("MOCK_MODE", "challenge").strip().lower()

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
    "hostname": "repro.luna.servers.libreloom.org",
    "subdomain": "repro",
    "tunnel_token": "mock-repro-tunnel-token",
    "backup_unlocked": False,
    "paired": True,
    "bound": True,
}

# Non-mock token so lunad takes the real cloudflared spawn path (for 1033/spawn debugging).
BOUND_SPAWN_JSON = {
    "hostname": "repro.luna.servers.libreloom.org",
    "subdomain": "repro",
    "tunnel_token": "eyJhbGciOiJDEBUG_TUNNEL_TOKEN_FOR_SPAWN_PATH",
    "backup_unlocked": False,
    "paired": True,
    "bound": True,
}


def current_mode() -> str:
    with MODE_LOCK:
        return MODE


def set_mode(mode: str) -> str:
    global MODE
    mode = mode.strip().lower()
    with MODE_LOCK:
        MODE = mode
        return MODE


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        print(f"[mock-connect] {self.address_string()} {fmt % args}")

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return b""
        return self.rfile.read(length)

    def _send(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: dict, extra: dict | None = None) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self._send(status, raw, "application/json", extra)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path in ("/healthz", "/api/v1/healthz"):
            mode = current_mode()
            if mode == "challenge":
                self._send(
                    403,
                    CF_HTML.encode("utf-8"),
                    "text/html; charset=UTF-8",
                    {"cf-mitigated": "challenge"},
                )
                return
            self._send_json(200, {"ok": True, "mode": mode})
            return

        if path == "/_debug/mode":
            self._send_json(200, {"mode": current_mode()})
            return

        if path != "/api/v1/status":
            self._send_json(404, {"error": "not found"})
            return

        mode = current_mode()
        auth = self.headers.get("Authorization", "")
        print(f"[mock-connect] GET /api/v1/status mode={mode} auth={auth[:24]}...")

        if mode == "challenge":
            self._send(
                403,
                CF_HTML.encode("utf-8"),
                "text/html; charset=UTF-8",
                {"cf-mitigated": "challenge"},
            )
            return
        if mode == "unbound":
            self._send_json(403, {"error": "unbound"})
            return
        if mode == "401":
            self._send_json(401, {"error": "This Luna is not signed in to Connect."})
            return
        if mode == "bound":
            self._send_json(200, BOUND_JSON)
            return

        self._send_json(500, {"error": f"unknown mode: {mode}"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        raw = self._read_body()
        if path == "/_debug/mode":
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
            except json.JSONDecodeError:
                self._send_json(400, {"error": "bad json"})
                return
            mode = str(payload.get("mode", "")).strip().lower()
            if mode not in {"challenge", "unbound", "bound", "401"}:
                self._send_json(400, {"error": "mode must be challenge|unbound|bound|401"})
                return
            set_mode(mode)
            print(f"[mock-connect] mode switched -> {mode}")
            self._send_json(200, {"mode": mode})
            return
        self._send_json(404, {"error": "not found"})


def main() -> None:
    set_mode(MODE)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"[mock-connect] listening on http://{HOST}:{PORT} mode={current_mode()}")
    print("[mock-connect] switch: curl -X POST http://127.0.0.1:18765/_debug/mode -d '{\"mode\":\"unbound\"}'")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock-connect] stopped")


if __name__ == "__main__":
    main()
