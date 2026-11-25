#!/usr/bin/env python3
"""Luna Connect mock with device pairing, rolling credentials, and setup grants.

The mock keeps the development backup/domain controls and implements the same
device-auth contract as luna/connect. Account routes accept X-Mock-Account (or
the mock_connect_account cookie) so local clients can exercise pairing without a
real Connect account session.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import signal
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.environ.get("LUNA_DATA_DIR", ROOT / "dev"))
DEFAULT_HOST = os.environ.get("MOCK_CONNECT_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("MOCK_CONNECT_PORT", "18765"))
DEFAULT_STORAGE_DIR = Path(os.environ.get("LUNA_MOCK_STORAGE_DIR", DATA_DIR / "mock-cloud-storage"))
DEFAULT_STATE_FILE = DATA_DIR / "mock-connect-state.json"
PID_FILE = DATA_DIR / "mock-connect.pid"
DEVICE_UID_FILE = DATA_DIR / "device-uid"
PAIRING_CODE_FILE = DATA_DIR / "pairing-code"
CONNECT_CREDENTIAL_FILE = DATA_DIR / "connect-credential"

CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PRICE_PER_TB_MONTHLY = 8.00
PAIRING_SECONDS = 600
REFRESH_SECONDS = 300
OVERLAP_SECONDS = 60
GRANT_SECONDS = 600
DEVICE_FAILURES = 5
DEVICE_IP_FAILURES = 20
ACCOUNT_FAILURES = 20
IP_FAILURES = 50
FAILURE_WINDOW = 600
ACCOUNT_WINDOW = 3600
RECENT_IP_SECONDS = 600
MAX_STORAGE_PACK_BYTES = 64 << 20
MAX_STORAGE_RECORD_BYTES = 1 << 20
MAX_STORAGE_RECORD_PAGE_SIZE = 256
MAX_LUNAS_PER_ACCOUNT = 25
DEFAULT_QUOTA_BYTES = 2_000_000_000_000
STORAGE_LUNA_ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")
STORAGE_SCOPE_RE = re.compile(r"^[a-z0-9-]{1,64}$")
STORAGE_NAME_RE = re.compile(r"^[a-z0-9._-]{1,128}$")
STORAGE_PACK_ID_RE = re.compile(r"^[0-9a-f]{64}$")
UNSIGNED_DECIMAL_RE = re.compile(r"^[0-9]+$")

CF_HTML = """<!DOCTYPE html>
<html lang="en-US"><head><title>Just a moment...</title></head><body>
<div class="cf-browser-verification"><h1>Just a moment...</h1></div>
</body></html>"""


def normalize_uid(raw: str) -> str:
    out: list[str] = []
    for char in raw.strip():
        if char in "- _":
            continue
        char = char.upper()
        if char in ("I", "L"):
            char = "1"
        elif char == "O":
            char = "0"
        out.append(char)
    return "".join(out)


def valid_uid(uid: str) -> bool:
    return len(uid) == 20 and all(char in CROCKFORD_ALPHABET for char in uid)


def group_uid(uid: str) -> str:
    return "-".join(uid[index : index + 4] for index in range(0, len(uid), 4))


def mint_uid() -> str:
    return "".join(secrets.choice(CROCKFORD_ALPHABET) for _ in range(20))


def mint_code() -> str:
    return secrets.token_hex(3).upper()


def valid_code(code: str) -> bool:
    return len(code) == 6 and all(char in "0123456789ABCDEF" for char in code)


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


def format_bytes(size: int | float) -> str:
    power = 1000.0
    number = float(size)
    for label in ("B", "KB", "MB", "GB", "TB", "PB"):
        if abs(number) < power:
            return f"{int(number)} B" if label == "B" else f"{number:.1f} {label}"
        number /= power
    return f"{number:.1f} EB"


def write_private(path: Path, value: str) -> None:
    """Create or replace a local secret without ever making it world-readable."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(value + "\n")


def write_private_atomic(path: Path, data: str | bytes) -> None:
    """Atomically replace a mock file with an owner-only file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        raw = data.encode("utf-8") if isinstance(data, str) else data
        with os.fdopen(descriptor, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        path.chmod(0o600)
    finally:
        temporary.unlink(missing_ok=True)


def valid_storage_name(value: str) -> bool:
    return bool(STORAGE_NAME_RE.fullmatch(value)) and value != "." and ".." not in value


def public_ip(raw: str) -> str:
    try:
        parsed = ipaddress.ip_address(raw.strip("[]"))
    except ValueError:
        return ""
    if not parsed.is_global or parsed.is_private or parsed.is_loopback or parsed.is_link_local:
        return ""
    return str(parsed)


def trusted_proxy(raw: str) -> bool:
    try:
        parsed = ipaddress.ip_address(raw)
    except ValueError:
        return False
    if parsed.is_loopback:
        return True
    for entry in os.environ.get("LUNACONNECT_TRUSTED_PROXIES", "").split(","):
        entry = entry.strip()
        if not entry:
            continue
        try:
            if "/" in entry:
                if parsed in ipaddress.ip_network(entry, strict=False):
                    return True
            elif parsed == ipaddress.ip_address(entry):
                return True
        except ValueError:
            continue
    return False


class MockState:
    """Thread-safe persistent state for the Luna Connect mock."""

    def __init__(self, state_file: Path, storage_dir: Path):
        self.state_file = state_file
        self.storage_dir = storage_dir
        self._lock = threading.RLock()
        self.mode = os.environ.get("MOCK_MODE", "unbound").strip().lower()
        self.subdomain = "repro"
        self.domain = "luna.servers.libreloom.org"
        self.hostname = f"{self.subdomain}.{self.domain}"
        self.tunnel_token = f"mock-{self.subdomain}-tunnel-token"
        self.tunnel_id = "mock-tunnel-id-12345"
        self.backup_unlocked = True
        self.backup_sources: list[Any] = []
        self.egress_bytes = 0
        self.storage_lunas: dict[str, dict[str, dict[str, str]]] = {}
        self.record_versions: dict[str, int] = {}
        self.rate_counters: dict[str, dict[str, int]] = {}
        try:
            quota = int(os.environ.get("LUNA_MOCK_QUOTA_BYTES", str(DEFAULT_QUOTA_BYTES)))
        except ValueError:
            quota = DEFAULT_QUOTA_BYTES
        self.quota_bytes = quota if quota > 0 else DEFAULT_QUOTA_BYTES
        self._new_identity()
        self.load()

    def _new_identity(self) -> None:
        self.device_id = "dev_" + secrets.token_hex(8)
        self.device_uid = mint_uid()
        self.verification_code = mint_code()
        self.state = "unbound"
        self.account_id = ""
        self.auth_token = ""
        self.auth_token_hash = ""
        self.previous_auth_token_hash = ""
        self.previous_valid_until = 0
        self.pairing_id = ""
        self.pairing_account_id = ""
        self.pairing_expires_at = 0
        self.setup_grant = ""
        self.setup_grant_account = ""
        self.setup_grant_expires_at = 0
        self.setup_grant_used_at = 0
        self.last_public_ip = ""
        self.last_public_ip_at = 0

    def load(self) -> None:
        with self._lock:
            if not self.state_file.exists():
                return
            try:
                self.state_file.chmod(0o600)
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                for key in (
                    "mode", "subdomain", "domain", "hostname", "tunnel_token", "tunnel_id",
                    "backup_unlocked", "backup_sources", "egress_bytes", "device_id", "device_uid",
                    "verification_code", "state", "account_id", "auth_token", "auth_token_hash",
                    "previous_auth_token_hash", "previous_valid_until", "pairing_id", "pairing_account_id",
                    "pairing_expires_at", "setup_grant", "setup_grant_account", "setup_grant_expires_at",
                    "setup_grant_used_at", "last_public_ip", "last_public_ip_at",
                ):
                    if key in data:
                        setattr(self, key, data[key])
                if isinstance(data.get("storage_lunas"), dict):
                    self.storage_lunas = data["storage_lunas"]
                if isinstance(data.get("record_versions"), dict):
                    self.record_versions = {str(key): int(value) for key, value in data["record_versions"].items()}
                if isinstance(data.get("rate_counters"), dict):
                    self.rate_counters = data["rate_counters"]
                if self.state not in ("unbound", "pairing", "bound", "revoked"):
                    self.state = "unbound"
            except Exception as error:
                print(f"[mock-connect] warning: failed to read state: {error}", file=sys.stderr)

    def save(self) -> None:
        with self._lock:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            data = {
                "mode": self.mode, "subdomain": self.subdomain, "domain": self.domain,
                "hostname": self.hostname, "tunnel_token": self.tunnel_token,
                "tunnel_id": self.tunnel_id, "backup_unlocked": self.backup_unlocked,
                "backup_sources": self.backup_sources, "egress_bytes": self.egress_bytes,
                "storage_lunas": self.storage_lunas, "record_versions": self.record_versions,
                "rate_counters": self.rate_counters,
                "device_id": self.device_id, "device_uid": self.device_uid,
                "verification_code": self.verification_code, "state": self.state,
                "account_id": self.account_id, "auth_token": self.auth_token,
                "auth_token_hash": self.auth_token_hash,
                "previous_auth_token_hash": self.previous_auth_token_hash,
                "previous_valid_until": self.previous_valid_until,
                "pairing_id": self.pairing_id, "pairing_account_id": self.pairing_account_id,
                "pairing_expires_at": self.pairing_expires_at, "setup_grant": self.setup_grant,
                "setup_grant_account": self.setup_grant_account,
                "setup_grant_expires_at": self.setup_grant_expires_at,
                "setup_grant_used_at": self.setup_grant_used_at,
                "last_public_ip": self.last_public_ip, "last_public_ip_at": self.last_public_ip_at,
            }
            write_private_atomic(self.state_file, json.dumps(data, indent=2) + "\n")

    def set_mode(self, mode: str) -> str:
        with self._lock:
            self.mode = mode.strip().lower()
            if self.mode == "backup_locked":
                self.backup_unlocked = False
            elif self.mode == "bound":
                self.backup_unlocked = True
                if self.state == "unbound":
                    self.state = "bound"
                    self.account_id = "acct_mock"
                    self._issue_credential_locked()
            elif self.mode == "bound_spawn":
                self.backup_unlocked = True
                self.tunnel_token = "eyJhbGciOiJDEBUG_TUNNEL_TOKEN_FOR_SPAWN_PATH"
                if self.state == "unbound":
                    self.state = "bound"
                    self.account_id = "acct_mock"
                    self._issue_credential_locked()
            elif self.mode == "unbound":
                self._unbind_locked()
            self.save()
            return self.mode

    def set_domain(self, subdomain: str, domain: str | None = None) -> dict[str, str]:
        with self._lock:
            self.subdomain = subdomain.strip().lower()
            if domain:
                self.domain = domain.strip().lower()
            self.hostname = f"{self.subdomain}.{self.domain}"
            if not self.mode.startswith("bound_spawn"):
                self.tunnel_token = f"mock-{self.subdomain}-tunnel-token"
            self.save()
            return {
                "hostname": self.hostname, "subdomain": self.subdomain,
                "domain": self.domain, "tunnel_token": self.tunnel_token,
            }

    def set_backup_unlocked(self, unlocked: bool) -> bool:
        with self._lock:
            self.backup_unlocked = unlocked
            if unlocked and self.mode == "backup_locked":
                self.mode = "bound"
            elif not unlocked and self.mode == "bound":
                self.mode = "backup_locked"
            self.save()
            return unlocked

    def mint_device(self) -> tuple[str, str]:
        with self._lock:
            self._new_identity()
            self.subdomain = ""
            self.hostname = ""
            self.tunnel_id = ""
            self.tunnel_token = ""
            self.mode = "unbound"
            self.save()
            return self.device_uid, self.verification_code

    def reset(self) -> None:
        with self._lock:
            self._new_identity()
            self.mode = "unbound"
            self.subdomain = "repro"
            self.domain = "luna.servers.libreloom.org"
            self.hostname = f"{self.subdomain}.{self.domain}"
            self.tunnel_token = f"mock-{self.subdomain}-tunnel-token"
            self.tunnel_id = "mock-tunnel-id-12345"
            self.backup_unlocked = True
            self.storage_lunas = {}
            self.record_versions = {}
            self.clean_storage()
            self.save()

    def _expire_pairing_locked(self, now: int) -> bool:
        if self.state == "pairing" and self.pairing_expires_at <= now:
            self.state = "unbound"
            self.account_id = ""
            self.pairing_id = ""
            self.pairing_account_id = ""
            self.pairing_expires_at = 0
            return True
        return False

    def _issue_credential_locked(self) -> None:
        self.auth_token = mint_secret()
        self.auth_token_hash = hash_token(self.auth_token)
        self.previous_auth_token_hash = ""
        self.previous_valid_until = 0

    def _clear_credentials_locked(self, *, keep_tombstones: bool = False) -> None:
        self.auth_token = ""
        self.previous_valid_until = 0
        if not keep_tombstones:
            self.auth_token_hash = ""
            self.previous_auth_token_hash = ""
        self.setup_grant = ""
        self.setup_grant_account = ""
        self.setup_grant_expires_at = 0
        self.setup_grant_used_at = 0
        self.pairing_id = ""
        self.pairing_account_id = ""
        self.pairing_expires_at = 0

    def start_pair(self, uid: str, code: str, account_id: str, now: int) -> tuple[str, str]:
        with self._lock:
            self._expire_pairing_locked(now)
            if normalize_uid(uid) != self.device_uid or not hmac.compare_digest(code, self.verification_code):
                return "", "invalid"
            if self.state not in ("unbound", "pairing"):
                return "", "invalid"
            if self.state == "pairing" and self.pairing_expires_at > now:
                if self.pairing_account_id == account_id:
                    return self.pairing_id, "ok"
                return "", "invalid"
            if self.account_id and self.account_id != account_id:
                return "", "invalid"
            self._clear_credentials_locked()
            self.state = "pairing"
            self.account_id = account_id
            self.pairing_id = "pair_" + secrets.token_hex(8)
            self.pairing_account_id = account_id
            self.pairing_expires_at = now + PAIRING_SECONDS
            self.save()
            return self.pairing_id, "ok"

    def claim_pair(self, uid: str, code: str, now: int) -> tuple[str, str]:
        with self._lock:
            expired = self._expire_pairing_locked(now)
            if normalize_uid(uid) != self.device_uid or not hmac.compare_digest(code, self.verification_code):
                return "", "invalid"
            if self.state != "pairing" or not self.pairing_id or self.pairing_expires_at <= now:
                if expired:
                    self.save()
                if self.state in ("unbound", "pairing"):
                    return "", "no_attempt"
                return "", "invalid"
            self.state = "bound"
            self._issue_credential_locked()
            self.setup_grant = ""
            self.setup_grant_used_at = 0
            # Connect keeps the pairing row after a successful claim so the
            # account's poll can observe the bound device ID.
            self.save()
            return self.auth_token, "ok"

    def pair_status(self, pairing_id: str, account_id: str, now: int) -> tuple[str, str]:
        with self._lock:
            if not self.pairing_id or self.pairing_id != pairing_id or self.pairing_account_id != account_id:
                return "", ""
            if self.state == "bound":
                return "bound", self.device_id
            if self.state == "pairing" and self.pairing_expires_at > now:
                return "waiting", ""
            # Match Connect's one-time expired result: the attempt is found and
            # reported as unbound, then removed. A later poll gets a generic 404.
            self.state = "unbound"
            self.account_id = ""
            self.pairing_id = ""
            self.pairing_account_id = ""
            self.pairing_expires_at = 0
            self.save()
            return "unbound", ""

    def cancel_pair(self, pairing_id: str, account_id: str) -> bool:
        with self._lock:
            if self.state != "pairing" or self.pairing_id != pairing_id or self.pairing_account_id != account_id:
                return False
            self.state = "unbound"
            self.account_id = ""
            self.pairing_id = ""
            self.pairing_account_id = ""
            self.pairing_expires_at = 0
            self.save()
            return True

    def credential_state(self, token: str, now: int | None = None) -> str:
        if not valid_secret(token):
            return "invalid"
        digest = hash_token(token)
        with self._lock:
            if self.state in ("unbound", "revoked") and digest in (
                self.auth_token_hash,
                self.previous_auth_token_hash,
            ):
                return f"device_{self.state}"
            if (
                self.state == "bound"
                and self.auth_token
                and self.auth_token_hash == digest
                and hmac.compare_digest(token, self.auth_token)
            ):
                return "current"
            if (
                self.state == "bound"
                and self.previous_auth_token_hash
                and self.previous_auth_token_hash == digest
                and self.previous_valid_until > (int(time.time()) if now is None else now)
            ):
                return "previous"
            return "invalid"

    def authenticate(self, token: str) -> bool:
        return self.credential_state(token) == "current"

    def refresh(self, token: str, now: int) -> tuple[str, str]:
        with self._lock:
            state = self.credential_state(token, now)
            if state in ("device_unbound", "device_revoked"):
                return "", state
            if state == "current":
                self.previous_auth_token_hash = self.auth_token_hash
                self.previous_valid_until = now + OVERLAP_SECONDS
                self.auth_token = mint_secret()
                self.auth_token_hash = hash_token(self.auth_token)
                self.save()
                return self.auth_token, ""
            if state == "previous" and self.auth_token:
                return self.auth_token, ""
            return "", ""

    def observe(self, token: str, client_ip: str, now: int) -> None:
        if not self.authenticate(token):
            return
        ip = public_ip(client_ip)
        if ip:
            with self._lock:
                self.last_public_ip = ip
                self.last_public_ip_at = now
                self.save()

    def _unbind_locked(self) -> None:
        self.state = "unbound"
        self.account_id = ""
        self.subdomain = ""
        self.hostname = ""
        self.tunnel_id = ""
        self.tunnel_token = ""
        self._clear_credentials_locked(keep_tombstones=True)

    def unbind(self, token: str) -> bool:
        with self._lock:
            if not self.authenticate(token):
                return False
            self._unbind_locked()
            self.save()
            return True

    def account_unbind(self, account_id: str, device_id: str) -> bool:
        with self._lock:
            if self.device_id != device_id or self.account_id != account_id or self.state == "unbound":
                return False
            self._unbind_locked()
            self.save()
            return True

    def revoke(self, account_id: str, device_id: str) -> bool:
        with self._lock:
            if self.device_id != device_id or self.account_id != account_id:
                return False
            if self.state == "revoked":
                return True
            if self.state not in ("pairing", "bound"):
                return False
            self.state = "revoked"
            self.subdomain = ""
            self.hostname = ""
            self.tunnel_id = ""
            self.tunnel_token = ""
            self._clear_credentials_locked(keep_tombstones=True)
            self.save()
            return True

    def recover(self, account_id: str, device_id: str, now: int) -> str:
        with self._lock:
            if self.device_id != device_id or self.account_id != account_id or self.state != "revoked":
                return ""
            self._clear_credentials_locked()
            self.state = "pairing"
            self.pairing_id = "pair_" + secrets.token_hex(8)
            self.pairing_account_id = account_id
            self.pairing_expires_at = now + PAIRING_SECONDS
            self.save()
            return self.pairing_id

    def issue_grant(self, account_id: str, device_id: str, now: int) -> str:
        with self._lock:
            if self.device_id != device_id or self.account_id != account_id or self.state != "bound":
                return ""
            self.setup_grant = mint_secret()
            self.setup_grant_account = account_id
            self.setup_grant_expires_at = now + GRANT_SECONDS
            self.setup_grant_used_at = 0
            self.save()
            return self.setup_grant

    def consume_grant(self, token: str, grant: str, now: int) -> bool:
        with self._lock:
            if not self.authenticate(token) or not self.setup_grant or self.setup_grant_used_at:
                return False
            if self.setup_grant_expires_at <= now or not hmac.compare_digest(grant, self.setup_grant):
                return False
            self.setup_grant_used_at = now
            self.save()
            return True

    @staticmethod
    def _rate_key(kind: str, value: str) -> str:
        return f"{kind}:{value}"

    def _rate_context_locked(self, uid: str, account_id: str, client_ip: str, now: int) -> tuple[str, int]:
        if not account_id and self.pairing_id and normalize_uid(uid) == self.device_uid:
            account_id = self.pairing_account_id
        limit = DEVICE_FAILURES
        if client_ip and client_ip == self.last_public_ip and now - self.last_public_ip_at <= RECENT_IP_SECONDS:
            limit = DEVICE_IP_FAILURES
        return account_id, limit

    def _rate_blocked_locked(self, uid: str, account_id: str, client_ip: str, now: int, device_limit: int) -> bool:
        for key, limit, window in (
            (self._rate_key("pair-device", uid), device_limit, FAILURE_WINDOW),
            (self._rate_key("pair-account", account_id), ACCOUNT_FAILURES, ACCOUNT_WINDOW),
            (self._rate_key("pair-ip", client_ip), IP_FAILURES, FAILURE_WINDOW),
        ):
            if not key.split(":", 1)[1]:
                continue
            row = self.rate_counters.get(key)
            if row and now - row["start"] < window and row["count"] >= limit:
                return True
        return False

    def _rate_failure_locked(self, uid: str, account_id: str, client_ip: str, now: int, device_limit: int) -> None:
        for key, limit, window in (
            (self._rate_key("pair-device", uid), device_limit, FAILURE_WINDOW),
            (self._rate_key("pair-account", account_id), ACCOUNT_FAILURES, ACCOUNT_WINDOW),
            (self._rate_key("pair-ip", client_ip), IP_FAILURES, FAILURE_WINDOW),
        ):
            if not key.split(":", 1)[1]:
                continue
            row = self.rate_counters.get(key)
            if not row or now - row["start"] >= window:
                self.rate_counters[key] = {"count": 1, "start": now}
            elif row["count"] < limit:
                row["count"] += 1
        self.save()

    def start_pair_attempt(self, uid: str, code: str, account_id: str, client_ip: str, now: int) -> tuple[str, str]:
        """Check the budget and start pairing under one lock, including failures."""
        with self._lock:
            account_id, device_limit = self._rate_context_locked(uid, account_id, client_ip, now)
            if not valid_uid(uid) or not valid_code(code):
                self._rate_failure_locked(uid, account_id, client_ip, now, device_limit)
                return "", "invalid"
            if self._rate_blocked_locked(uid, account_id, client_ip, now, device_limit):
                return "", "blocked"
            pairing_id, status = self.start_pair(uid, code, account_id, now)
            if status == "invalid":
                self._rate_failure_locked(uid, account_id, client_ip, now, device_limit)
            return pairing_id, status

    def claim_pair_attempt(self, uid: str, code: str, client_ip: str, now: int) -> tuple[str, str]:
        """Claim atomically; valid no-attempt polls never spend failure budget."""
        with self._lock:
            account_id, device_limit = self._rate_context_locked(uid, "", client_ip, now)
            if not valid_uid(uid) or not valid_code(code):
                self._rate_failure_locked(uid, account_id, client_ip, now, device_limit)
                return "", "invalid"
            if self._rate_blocked_locked(uid, account_id, client_ip, now, device_limit):
                return "", "blocked"
            token, status = self.claim_pair(uid, code, now)
            if status == "invalid":
                self._rate_failure_locked(uid, account_id, client_ip, now, device_limit)
            return token, status

    @staticmethod
    def _storage_account_dir(storage_dir: Path, account_id: str) -> Path:
        # Account IDs are not path components. The mock still isolates each
        # account's quota and inventory while keeping on-disk names fixed-shape.
        digest = hashlib.sha256(account_id.encode("utf-8")).hexdigest()
        return storage_dir / "accounts" / digest

    def storage_luna_dir(self, account_id: str, luna_id: str) -> Path:
        return self._storage_account_dir(self.storage_dir, account_id) / "lunas" / luna_id

    @staticmethod
    def _record_version_key(account_id: str, luna_id: str) -> str:
        return f"{account_id}\0{luna_id}"

    def _storage_binding_locked(
        self, account_id: str, luna_id: str, device_id: str, *, claim: bool
    ) -> tuple[dict[str, str] | None, str]:
        account = self.storage_lunas.get(account_id, {})
        binding = account.get(luna_id)
        if binding is None and claim:
            if len(account) >= MAX_LUNAS_PER_ACCOUNT:
                return None, "limit"
            account = self.storage_lunas.setdefault(account_id, {})
            binding = {"device_id": device_id, "signing_public": ""}
            account[luna_id] = binding
        if binding is not None and binding.get("device_id") != device_id:
            return None, "forbidden"
        return binding, ""

    def check_storage_binding(self, account_id: str, luna_id: str, device_id: str) -> str:
        with self._lock:
            _, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=False)
            return error

    def storage_used(self, account_id: str) -> int:
        with self._lock:
            root = self._storage_account_dir(self.storage_dir, account_id)
            total = 0
            if root.exists():
                for directory, _, files in os.walk(root):
                    for filename in files:
                        try:
                            total += (Path(directory) / filename).stat().st_size
                        except OSError:
                            pass
            return total

    def storage_pack_exists(self, account_id: str, luna_id: str, pack_id: str) -> bool:
        with self._lock:
            return (self.storage_luna_dir(account_id, luna_id) / "packs" / pack_id).is_file()

    def storage_usage(self, account_id: str, luna_id: str, device_id: str) -> tuple[int, dict[str, Any]]:
        with self._lock:
            _, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=False)
            if error:
                return error, {}
            return "", {"used_bytes": self.storage_used(account_id), "quota_bytes": self.quota_bytes}

    def record_version(self, account_id: str, luna_id: str) -> int:
        with self._lock:
            return self.record_versions.get(self._record_version_key(account_id, luna_id), 0)

    def _bump_record_version_locked(self, account_id: str, luna_id: str) -> None:
        key = self._record_version_key(account_id, luna_id)
        self.record_versions[key] = self.record_versions.get(key, 0) + 1

    @staticmethod
    def _set_signing_public_locked(binding: dict[str, str], key: str) -> str:
        existing = binding.get("signing_public", "")
        if existing and existing != key:
            return "conflict"
        binding["signing_public"] = key
        return ""

    def register_signing_public(
        self, account_id: str, device_id: str, luna_id: str, key: str
    ) -> str:
        key = key.strip().lower()
        if len(key) != 3968 or any(char not in "0123456789abcdef" for char in key):
            return "invalid"
        with self._lock:
            binding, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=True)
            if error:
                return error
            assert binding is not None
            error = self._set_signing_public_locked(binding, key)
            if error:
                return error
            self.save()
            return ""

    def put_storage_pack(
        self, account_id: str, device_id: str, luna_id: str, pack_id: str, body: bytes
    ) -> tuple[int, dict[str, Any]]:
        with self._lock:
            _, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=False)
            if error:
                return (409 if error == "limit" else 403), {"error": "Cloud storage belongs to another device or this account has too many Lunas."}
            if not self.backup_unlocked:
                return 402, {"error": "Add a payment card at connect.luna.libreloom.org to store your cloud backup."}
            target = self.storage_luna_dir(account_id, luna_id) / "packs" / pack_id
            if target.is_file():
                return 200, {"ok": True, "id": pack_id, "created": False}
            remaining = self.quota_bytes - self.storage_used(account_id)
            if remaining <= 0:
                return 507, {"error": "Your cloud storage is full."}
            if len(body) > MAX_STORAGE_PACK_BYTES and remaining >= MAX_STORAGE_PACK_BYTES:
                return 413, {"error": "That data is too large to store in cloud storage. The limit is 64 MB per piece."}
            if len(body) > remaining:
                return 507, {"error": "Your cloud storage is full."}
            if hashlib.sha256(body).hexdigest() != pack_id:
                return 400, {"error": "The data did not match its ID. Try the upload again from Luna."}
            _, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=True)
            if error:
                return (409 if error == "limit" else 403), {"error": "Cloud storage belongs to another device or this account has too many Lunas."}
            write_private_atomic(target, body)
            self.save()
            return 200, {"ok": True, "id": pack_id, "size": len(body), "created": True}

    def put_storage_record(
        self, account_id: str, device_id: str, luna_id: str, kind: str, name: str, body: bytes
    ) -> tuple[int, dict[str, Any]]:
        with self._lock:
            binding, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=False)
            if error:
                return (409 if error == "limit" else 403), {"error": "Cloud storage belongs to another device or this account has too many Lunas."}
            if not self.backup_unlocked:
                return 402, {"error": "Add a payment card at connect.luna.libreloom.org to store your cloud backup."}
            if len(body) > MAX_STORAGE_RECORD_BYTES:
                return 413, {"error": "That record is too large. The limit is 1 MB."}
            target = self.storage_luna_dir(account_id, luna_id) / "records" / kind / name
            old_size = target.stat().st_size if target.is_file() else 0
            if self.storage_used(account_id) - old_size + len(body) > self.quota_bytes:
                return 507, {"error": "Your cloud storage is full."}
            key = ""
            if kind == "identity" and name == "public":
                key = body.decode("ascii", errors="ignore").strip().lower()
                if len(key) != 3968 or any(char not in "0123456789abcdef" for char in key):
                    return 400, {"error": "That signing key is not valid. Update Luna and try again."}
                if binding is not None and binding.get("signing_public") not in ("", key):
                    return 409, {"error": "Cloud storage already has a different signing key for this Luna."}
            binding, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=True)
            if error:
                return (409 if error == "limit" else 403), {"error": "Cloud storage belongs to another device or this account has too many Lunas."}
            if key:
                assert binding is not None
                error = self._set_signing_public_locked(binding, key)
                if error:
                    return 409, {"error": "Cloud storage already has a different signing key for this Luna."}
            write_private_atomic(target, body)
            self._bump_record_version_locked(account_id, luna_id)
            self.save()
            return 200, {"ok": True, "bytes": len(body)}

    def list_storage_records(
        self, account_id: str, device_id: str, luna_id: str, kind: str
    ) -> tuple[str, list[str], int]:
        with self._lock:
            _, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=False)
            if error:
                return error, [], 0
            directory = self.storage_luna_dir(account_id, luna_id) / "records" / kind
            names = sorted(item.name for item in directory.iterdir() if item.is_file()) if directory.exists() else []
            return "", names, self.record_versions.get(self._record_version_key(account_id, luna_id), 0)

    def delete_storage_object(
        self, account_id: str, device_id: str, luna_id: str, relative: str
    ) -> str:
        with self._lock:
            _, error = self._storage_binding_locked(account_id, luna_id, device_id, claim=False)
            if error:
                return error
            target = self.storage_luna_dir(account_id, luna_id) / relative
            if not target.is_file():
                return ""
            target.unlink()
            if relative.startswith("records/"):
                self._bump_record_version_locked(account_id, luna_id)
            self.save()
            return ""

    def record_storage_egress(self, account_id: str, size: int) -> None:
        with self._lock:
            self.egress_bytes += size
            self.save()

    def get_backup_stats(self) -> dict[str, Any]:
        with self._lock:
            count = 0
            total_bytes = 0
            if self.storage_dir.exists():
                for root, _, files in os.walk(self.storage_dir):
                    for filename in files:
                        try:
                            total_bytes += (Path(root) / filename).stat().st_size
                            count += 1
                        except OSError:
                            pass
            return {
                "ok": True, "backup_unlocked": self.backup_unlocked,
                "objects_count": count, "total_bytes": total_bytes,
                "total_formatted": format_bytes(total_bytes), "egress_bytes": self.egress_bytes,
                "egress_formatted": format_bytes(self.egress_bytes),
                "cost_monthly_usd": round((total_bytes / 1_000_000_000_000.0) * PRICE_PER_TB_MONTHLY, 4),
                "rate": "$8/TB/month", "storage_dir": str(self.storage_dir),
            }

    def clean_storage(self) -> int:
        with self._lock:
            removed = 0
            if self.storage_dir.exists():
                for root, dirs, files in os.walk(self.storage_dir, topdown=False):
                    for filename in files:
                        try:
                            (Path(root) / filename).unlink()
                            removed += 1
                        except OSError:
                            pass
                    for dirname in dirs:
                        try:
                            (Path(root) / dirname).rmdir()
                        except OSError:
                            pass
            self.egress_bytes = 0
            self.record_versions = {}
            self.save()
            return removed

    def to_status_dict(self) -> dict[str, Any]:
        with self._lock:
            stats = self.get_backup_stats()
            return {
                "device_id": self.device_id, "device_uid": group_uid(self.device_uid),
                "verification_code": self.verification_code, "state": self.state,
                "mode": self.mode, "bound": self.state == "bound", "paired": self.state == "bound",
                "backup_unlocked": self.backup_unlocked, "hostname": self.hostname,
                "subdomain": self.subdomain, "domain": self.domain,
                "tunnel_token": self.tunnel_token, "tunnel_id": self.tunnel_id,
                "backup_sources": self.backup_sources, "storage": stats,
            }


class MockConnectHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    @property
    def state(self) -> MockState:
        return self.server.mock_state  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[mock-connect] {self.address_string()} {fmt % args}")

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, status: int, payload: Any, extra: dict[str, str] | None = None) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json", extra)

    def _send_challenge(self) -> None:
        self._send(403, CF_HTML.encode("utf-8"), "text/html; charset=UTF-8", {"cf-mitigated": "challenge"})

    def _read_body(self, limit: int | None = None) -> bytes:
        raw_length = self.headers.get("Content-Length", "0") or "0"
        try:
            length = int(raw_length)
        except ValueError:
            raise ValueError("invalid Content-Length") from None
        if length < 0:
            raise ValueError("invalid Content-Length")
        if limit is not None and length > limit:
            raise OverflowError("request body is too large")
        return self.rfile.read(length) if length > 0 else b""

    def _read_json(self) -> dict[str, Any] | None:
        try:
            raw = self._read_body()
        except ValueError:
            self._send_json(400, {"error": "invalid content length"})
            return None
        if not raw:
            return {}
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, {"error": "invalid json"})
            return None
        if not isinstance(value, dict):
            self._send_json(400, {"error": "invalid json"})
            return None
        return value

    def _client_ip(self) -> str:
        host = self.client_address[0]
        if trusted_proxy(host):
            for header in ("CF-Connecting-IP", "X-Real-IP", "X-Forwarded-For"):
                value = self.headers.get(header, "").split(",", 1)[0].strip()
                try:
                    return str(ipaddress.ip_address(value))
                except ValueError:
                    continue
        return host

    def _account_id(self) -> str:
        header = self.headers.get("X-Mock-Account", "").strip()
        if header:
            return header
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return "acct_mock"
        morsel = cookie.get("mock_connect_account")
        return (morsel.value.strip() or "acct_mock") if morsel else "acct_mock"

    def _bearer(self) -> str:
        header = self.headers.get("Authorization", "").strip()
        return header[7:].strip() if header.startswith("Bearer ") else ""

    def _send_credential_state(self, code: str) -> None:
        message = "This Luna's connection to Luna Connect is no longer active."
        self._send_json(403, {"error": message, "message": message, "code": code})

    def _require_auth(self) -> str:
        token = self._bearer()
        credential_state = self.state.credential_state(token)
        if credential_state in ("device_unbound", "device_revoked"):
            self._send_credential_state(credential_state)
            return ""
        if credential_state != "current":
            self._send_json(401, {"error": "This Luna is not linked to Luna Connect. Pair it again in Settings → Luna Connect."})
            return ""
        self.state.observe(token, self._client_ip(), int(time.time()))
        return token

    def _simulation(self) -> bool:
        if self.state.mode == "challenge":
            self._send_challenge()
            return True
        if self.state.mode == "401":
            self._send_json(401, {"error": "This Luna is not signed in to Connect."})
            return True
        return False

    def _safe_object_path(self, relative: str) -> Path | None:
        relative = relative.lstrip("/")
        if not relative or ".." in relative:
            return None
        target = (self.state.storage_dir / relative).resolve()
        try:
            target.relative_to(self.state.storage_dir.resolve())
        except ValueError:
            return None
        return target

    def _pairing_input(self, payload: dict[str, Any]) -> tuple[str, str]:
        uid = normalize_uid(str(payload.get("device_uid", "")))
        code = str(payload.get("verification_code", "")).strip().upper()
        return uid, code

    def _pairing_id_from_path(self, path: str) -> str:
        prefix = "/api/v1/devices/pair/"
        if not path.startswith(prefix):
            return ""
        pairing_id = urllib.parse.unquote(path[len(prefix) :])
        return pairing_id if pairing_id and "/" not in pairing_id else ""

    def _device_action_id(self, path: str, action: str = "") -> str:
        prefix = "/api/v1/devices/"
        if not path.startswith(prefix):
            return ""
        remainder = urllib.parse.unquote(path[len(prefix) :])
        suffix = f"/{action}" if action else ""
        if suffix and not remainder.endswith(suffix):
            return ""
        device_id = remainder[: -len(suffix)] if suffix else remainder
        if not device_id or "/" in device_id or device_id != self.state.device_id:
            return ""
        return device_id

    def _storage_scope(self) -> tuple[str, str, str] | None:
        luna_id = self.headers.get("X-Luna-Id", "").strip()
        if not STORAGE_LUNA_ID_RE.fullmatch(luna_id):
            self._send_json(400, {"error": "Luna did not say which Luna is asking. Update Luna and try again."})
            return None
        with self.state._lock:
            account_id, device_id = self.state.account_id, self.state.device_id
        error = self.state.check_storage_binding(account_id, luna_id, device_id)
        if error:
            if error == "forbidden":
                self._send_json(403, {"error": "This Luna's cloud storage belongs to another device on your account."})
            else:
                self._send_json(409, {"error": "This account already has 25 Lunas with cloud backups."})
            return None
        return account_id, device_id, luna_id

    @staticmethod
    def _storage_route(path: str) -> tuple[str, str, str] | None:
        parts = [urllib.parse.unquote(part) for part in path.split("/")]
        if parts[:5] == ["", "api", "v1", "storage", "usage"] and len(parts) == 5:
            return "usage", "", ""
        if len(parts) == 6 and parts[:5] == ["", "api", "v1", "storage", "packs"]:
            return "pack", parts[5], ""
        if len(parts) == 6 and parts[:5] == ["", "api", "v1", "storage", "records"]:
            return "record_list", parts[5], ""
        if len(parts) == 7 and parts[:5] == ["", "api", "v1", "storage", "records"]:
            return "record", parts[5], parts[6]
        return None

    @staticmethod
    def _parse_record_page(query: dict[str, list[str]]) -> tuple[int, str, str, int | None, int | None]:
        paged = {"limit", "after", "prefix", "version", "total"}.intersection(query)
        if not paged:
            return 256, "", "", None, None
        if len(query.get("limit", [])) != 1:
            raise ValueError("missing or repeated page limit")
        raw_limit = query["limit"][0]
        if not UNSIGNED_DECIMAL_RE.fullmatch(raw_limit):
            raise ValueError("invalid page limit")
        limit = int(raw_limit)
        if limit < 1 or limit > MAX_STORAGE_RECORD_PAGE_SIZE:
            raise ValueError("page limit out of range")
        if len(query.get("after", [])) > 1:
            raise ValueError("repeated page cursor")
        after = query.get("after", [""])[0]
        if after and not valid_storage_name(after):
            raise ValueError("invalid page cursor")
        if len(query.get("prefix", [])) > 1:
            raise ValueError("repeated page prefix")
        prefix = query.get("prefix", [""])[0]
        if prefix and (not valid_storage_name(prefix) or not prefix.endswith(".") or (after and not after.startswith(prefix))):
            raise ValueError("invalid page prefix")

        def unsigned(name: str) -> int | None:
            values = query.get(name, [])
            if len(values) > 1:
                raise ValueError(f"repeated page {name}")
            if not values:
                return None
            if not UNSIGNED_DECIMAL_RE.fullmatch(values[0]):
                raise ValueError(f"invalid page {name}")
            return int(values[0])

        version, total = unsigned("version"), unsigned("total")
        if (version is None) != (total is None) or (after and version is None):
            raise ValueError("page continuation needs both version and total")
        return limit, after, prefix, version, total

    def _backup_mode(self) -> bool:
        if self._simulation():
            return True
        if self.state.mode == "storage_full":
            self._send_json(507, {"error": "Your cloud storage is full."})
            return True
        if self.state.mode == "backup_locked" or not self.state.backup_unlocked:
            self._send_json(402, {"error": "Add a payment card at connect.luna.libreloom.org to store your cloud backup."})
            return True
        return False

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path in ("/healthz", "/api/v1/healthz"):
            if self._simulation():
                return
            self._send_json(200, {"ok": True, "mode": self.state.mode})
            return
        if path == "/_debug/mode":
            self._send_json(200, {"mode": self.state.mode})
            return
        if path in ("/_mock/status", "/_mock/state"):
            self._send_json(200, self.state.to_status_dict())
            return
        if path == "/_mock/backup/stats":
            self._send_json(200, self.state.get_backup_stats())
            return
        if path == "/api/v1/domain/available":
            name = urllib.parse.parse_qs(parsed.query).get("name", [""])[0].strip().lower()
            if not name:
                self._send_json(400, {"error": "name parameter is required"})
                return
            self._send_json(200, {"available": name != "taken", "hostname": f"{name}.{self.state.domain}"})
            return
        if path == "/api/v1/account/devices":
            devices = []
            if self.state.account_id == self._account_id():
                devices.append({
                    "id": self.state.device_id, "device_uid": group_uid(self.state.device_uid),
                    "state": self.state.state, "name": self.state.subdomain,
                    "subdomain": self.state.subdomain, "hostname": self.state.hostname,
                    "bound": self.state.state == "bound",
                })
            self._send_json(200, {"devices": devices})
            return
        if path.startswith("/api/v1/devices/pair/"):
            pairing_id = self._pairing_id_from_path(path)
            if not pairing_id:
                self._send_json(404, {"error": "That pairing attempt was not found."})
                return
            status, device_id = self.state.pair_status(pairing_id, self._account_id(), int(time.time()))
            if not status:
                self._send_json(404, {"error": "That pairing attempt was not found."})
                return
            out: dict[str, Any] = {"status": status}
            if status == "bound":
                out["device_id"] = device_id
            self._send_json(200, out)
            return
        if path.startswith("/api/v1/storage/"):
            if not self._require_auth():
                return
            self._storage_get(path, urllib.parse.parse_qs(parsed.query, keep_blank_values=True))
            return
        if path in ("/api/v1/backup/status", "/api/v1/billing/usage"):
            if not self._require_auth():
                return
            self._send_json(200, self.state.get_backup_stats())
            return
        if path == "/api/v1/backups":
            if not self._require_auth():
                return
            objects = []
            for root, _, files in os.walk(self.state.storage_dir):
                for filename in files:
                    target = Path(root) / filename
                    try:
                        content = target.read_bytes()
                        objects.append({
                            "relative_path": str(target.relative_to(self.state.storage_dir)),
                            "size": len(content), "content_hash": hashlib.sha256(content).hexdigest(),
                            "updated_at": int(target.stat().st_mtime),
                        })
                    except OSError:
                        pass
            self._send_json(200, {"objects": objects, "total_objects": len(objects), "total_bytes": sum(item["size"] for item in objects)})
            return
        if path.startswith("/api/v1/backup/objects/"):
            if not self._require_auth():
                return
            target = self._safe_object_path(path[len("/api/v1/backup/objects/") :])
            if not target or not target.is_file():
                self._send_json(404, {"error": "That file is not in cloud backup."})
                return
            try:
                data = target.read_bytes()
                self.state.egress_bytes += len(data)
                self.state.save()
                self._send(200, data, "application/octet-stream", {
                    "X-Content-Hash": hashlib.sha256(data).hexdigest(),
                    "Content-Disposition": f'attachment; filename="{target.name}"',
                })
            except OSError as error:
                self._send_json(500, {"error": f"Failed reading object: {error}"})
            return
        if path == "/api/v1/status":
            if self._simulation():
                return
            token = self._require_auth()
            if not token:
                return
            self.state.observe(token, self._client_ip(), int(time.time()))
            self._send_json(200, {
                "device_id": self.state.device_id, "bound": True, "paired": True,
                "backup_unlocked": self.state.backup_unlocked, "hostname": self.state.hostname,
                "subdomain": self.state.subdomain, "domain": self.state.domain,
                "tunnel_token": self.state.tunnel_token, "tunnel_id": self.state.tunnel_id,
                "backup_sources": self.state.backup_sources, "wan_ip": self._client_ip(),
            })
            return
        self._send_json(404, {"error": f"not found: {path}"})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if not path.startswith("/_debug/") and not path.startswith("/_mock/") and self._simulation():
            return
        signing_parts = [urllib.parse.unquote(part) for part in path.split("/")]
        if len(signing_parts) == 7 and signing_parts[:5] == ["", "api", "v1", "storage", "luna-ids"] and signing_parts[6] == "signing-public":
            if not self._require_auth():
                return
            try:
                raw = self._read_body(4096)
            except (ValueError, OverflowError):
                self._send_json(400, {"error": "Could not read that signing key. Try again."})
                return
            if "application/json" in self.headers.get("Content-Type", "").lower():
                try:
                    key = str(json.loads(raw.decode("utf-8")).get("signing_public", ""))
                except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                    self._send_json(400, {"error": "That signing key is not valid. Update Luna and try again."})
                    return
            else:
                key = raw.decode("ascii", errors="ignore")
            luna_id = signing_parts[5]
            if not STORAGE_LUNA_ID_RE.fullmatch(luna_id):
                self._send_json(400, {"error": "That Luna ID is not valid. Update Luna and try again."})
                return
            with self.state._lock:
                account_id, device_id = self.state.account_id, self.state.device_id
            error = self.state.register_signing_public(account_id, device_id, luna_id, key)
            if error:
                status = {"invalid": 400, "forbidden": 403, "conflict": 409, "limit": 409}[error]
                messages = {
                    "invalid": "That signing key is not valid. Update Luna and try again.",
                    "forbidden": "This Luna's cloud storage belongs to another device on your account.",
                    "conflict": "Cloud storage already has a different signing key for this Luna.",
                    "limit": "This account already has 25 Lunas with cloud backups.",
                }
                self._send_json(status, {"error": messages[error]})
                return
            self._send_json(200, {"ok": True})
            return
        if path in ("/api/v1/devices/pair/claim", "/api/v1/devices/pair"):
            try:
                raw = self._read_body()
                value = json.loads(raw.decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("pairing body must be an object")
                payload = value
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                now, client_ip = int(time.time()), self._client_ip()
                if path.endswith("/claim"):
                    self.state.claim_pair_attempt("", "", client_ip, now)
                    self._send_json(404, {"error": "That Device ID or verification code is wrong or is no longer pairing. Check both and try again."})
                else:
                    self.state.start_pair_attempt("", "", self._account_id(), client_ip, now)
                    self._send_json(400, {"error": "That Device ID or verification code is wrong or is no longer pairing. Check both and try again."})
                return
        else:
            payload = self._read_json()
            if payload is None:
                return
        if path in ("/_debug/mode", "/_mock/mode"):
            mode = str(payload.get("mode", "")).strip().lower()
            allowed = {"bound", "unbound", "challenge", "401", "backup_locked", "storage_full", "bound_spawn"}
            if mode not in allowed:
                self._send_json(400, {"error": f"mode must be one of: {', '.join(sorted(allowed))}"})
                return
            self.state.set_mode(mode)
            self._send_json(200, {"ok": True, "mode": mode})
            return
        if path == "/_mock/domain":
            subdomain = str(payload.get("subdomain", "")).strip().lower()
            if not subdomain:
                self._send_json(400, {"error": "subdomain is required"})
                return
            self._send_json(200, {"ok": True, **self.state.set_domain(subdomain, payload.get("domain"))})
            return
        if path == "/_mock/backup/unlock":
            self.state.set_backup_unlocked(True)
            self._send_json(200, {"ok": True, "backup_unlocked": True})
            return
        if path == "/_mock/backup/lock":
            self.state.set_backup_unlocked(False)
            self._send_json(200, {"ok": True, "backup_unlocked": False})
            return
        if path == "/_mock/backup/clean":
            self._send_json(200, {"ok": True, "removed_objects": self.state.clean_storage()})
            return
        if path == "/_mock/device/mint":
            uid, code = self.state.mint_device()
            self._send_json(200, {"ok": True, "device_uid": group_uid(uid), "verification_code": code})
            return
        if path == "/_mock/reset":
            self.state.reset()
            self._send_json(200, {"ok": True, "state": self.state.to_status_dict()})
            return
        if path == "/api/v1/token/refresh":
            rotated, credential_state = self.state.refresh(self._bearer(), int(time.time()))
            if credential_state in ("device_unbound", "device_revoked"):
                self._send_credential_state(credential_state)
                return
            if not rotated:
                self._send_json(401, {"error": "This Luna is not linked to Luna Connect."})
                return
            self._send_json(200, {"auth_token": rotated, "refresh_after_seconds": REFRESH_SECONDS})
            return
        if path == "/api/v1/devices/pair/claim":
            uid, code = self._pairing_input(payload)
            token, status = self.state.claim_pair_attempt(uid, code, self._client_ip(), int(time.time()))
            if status == "blocked":
                self._send_json(429, {"error": "Too many pairing attempts. Wait a few minutes, then try again."})
                return
            if status != "ok":
                self._send_json(404, {"error": "That Device ID or verification code is wrong or is no longer pairing. Check both and try again."})
                return
            self._send_json(200, {"auth_token": token, "device_id": self.state.device_id, "refresh_after_seconds": REFRESH_SECONDS})
            return
        if path == "/api/v1/devices/pair":
            uid, code = self._pairing_input(payload)
            pairing_id, status = self.state.start_pair_attempt(uid, code, self._account_id(), self._client_ip(), int(time.time()))
            if status == "blocked":
                self._send_json(429, {"error": "Too many pairing attempts. Wait a few minutes, then try again."})
                return
            if status != "ok":
                self._send_json(400, {"error": "That Device ID or verification code is wrong or is no longer pairing. Check both and try again."})
                return
            self._send_json(200, {"pairing_id": pairing_id})
            return
        if path.startswith("/api/v1/devices/") and path.endswith("/setup-grant"):
            if not self._device_action_id(path, "setup-grant"):
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            grant = self.state.issue_grant(self._account_id(), self.state.device_id, int(time.time()))
            if not grant:
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            out: dict[str, Any] = {"setup_grant": grant}
            if self.state.hostname:
                out["setup_url"] = f"https://{self.state.hostname}/setup#setup_grant={grant}"
            self._send_json(200, out)
            return
        if path == "/api/v1/devices/setup-grant/consume":
            token = self._require_auth()
            if not token:
                return
            grant = str(payload.get("setup_grant", ""))
            if not self.state.consume_grant(token, grant, int(time.time())):
                self._send_json(400, {"error": "That setup link is no longer valid. Create a new one in Luna Connect."})
                return
            self._send_json(200, {"ok": True})
            return
        if path.startswith("/api/v1/devices/") and path.endswith("/revoke"):
            if not self._device_action_id(path, "revoke") or not self.state.revoke(self._account_id(), self.state.device_id):
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            self._send_json(200, {"ok": True, "id": self.state.device_id, "status": "revoked"})
            return
        if path.startswith("/api/v1/devices/") and path.endswith("/recover"):
            # The mock has no account passwords; X-Mock-Account is its staff/test
            # substitute for the real route's password step-up.
            if not self._device_action_id(path, "recover"):
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            pairing_id = self.state.recover(self._account_id(), self.state.device_id, int(time.time()))
            if not pairing_id:
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            self._send_json(200, {"pairing_id": pairing_id})
            return
        if path.startswith("/api/v1/devices/") and path.endswith("/domain"):
            if not self._device_action_id(path, "domain") or self.state.account_id != self._account_id() or self.state.state != "bound":
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            subdomain = str(payload.get("subdomain", "")).strip().lower()
            if not subdomain:
                self._send_json(400, {"error": "subdomain is required"})
                return
            self._send_json(201, {"device_id": self.state.device_id, **self.state.set_domain(subdomain)})
            return
        if path == "/api/v1/domain":
            token = self._require_auth()
            if not token:
                return
            subdomain = str(payload.get("subdomain", "")).strip().lower()
            if not subdomain:
                self._send_json(400, {"error": "subdomain is required"})
                return
            self._send_json(200, self.state.set_domain(subdomain))
            return
        if path == "/api/v1/unregister":
            token = self._require_auth()
            if not token:
                return
            if not self.state.unbind(token):
                self._send_json(401, {"error": "unauthorized"})
                return
            self._send_json(200, {"ok": True})
            return
        if path.startswith("/api/v1/storage/"):
            if not self._require_auth():
                return
            self._storage_post(path, payload)
            return
        self._send_json(404, {"error": f"not found: {path}"})

    def do_PUT(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if self._simulation():
            return
        if path.startswith("/api/v1/storage/"):
            if not self._require_auth():
                return
            self._storage_put(path)
            return
        if path.startswith("/api/v1/backup/objects/"):
            if not self._require_auth() or self._backup_mode():
                return
            target = self._safe_object_path(path[len("/api/v1/backup/objects/") :])
            if not target:
                self._send_json(400, {"error": "Cloud backup did not receive a valid file path."})
                return
            try:
                body = self._read_body()
            except ValueError:
                self._send_json(400, {"error": "Cloud backup did not receive a valid upload."})
                return
            digest = hashlib.sha256(body).hexdigest()
            client_hash = self.headers.get("X-Content-Hash", "").strip().lower()
            if client_hash and client_hash != digest:
                self._send_json(400, {"error": "The file did not match what Luna said it sent. Try the copy again."})
                return
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
                self._send_json(200, {"ok": True, "size": len(body), "content_hash": digest})
            except OSError as error:
                self._send_json(500, {"error": f"Failed saving backup object: {error}"})
            return
        self._send_json(404, {"error": f"not found: {path}"})

    def do_DELETE(self) -> None:  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if self._simulation():
            return
        if path.startswith("/api/v1/devices/pair/"):
            pairing_id = self._pairing_id_from_path(path)
            if not pairing_id or not self.state.cancel_pair(pairing_id, self._account_id()):
                self._send_json(404, {"error": "That pairing attempt was not found."})
                return
            self._send_json(200, {"ok": True})
            return
        if path.startswith("/api/v1/devices/"):
            if not self._device_action_id(path) or not self.state.account_unbind(self._account_id(), self.state.device_id):
                self._send_json(404, {"error": "That Luna is not on this account."})
                return
            self._send_json(200, {"ok": True})
            return
        if path.startswith("/api/v1/storage/"):
            if not self._require_auth():
                return
            self._storage_delete(path)
            return
        if path.startswith("/api/v1/backup/objects/"):
            if not self._require_auth():
                return
            target = self._safe_object_path(path[len("/api/v1/backup/objects/") :])
            if target and target.is_file():
                try:
                    target.unlink()
                except OSError as error:
                    self._send_json(500, {"error": f"Failed deleting backup object: {error}"})
                    return
            self._send_json(200, {"ok": True})
            return
        self._send_json(404, {"error": f"not found: {path}"})

    def _storage_get(self, path: str, query: dict[str, list[str]]) -> None:
        route = self._storage_route(path)
        if route is None:
            self._send_json(404, {"error": f"not found: {path}"})
            return
        scope = self._storage_scope()
        if scope is None:
            return
        account_id, device_id, luna_id = scope
        category, first, second = route
        if category == "usage":
            error, usage = self.state.storage_usage(account_id, luna_id, device_id)
            if error:
                self._send_json(403, {"error": "This Luna's cloud storage belongs to another device on your account."})
                return
            self._send_json(200, usage)
            return
        if category == "pack":
            if not STORAGE_PACK_ID_RE.fullmatch(first):
                self._send_json(404, {"error": "That pack is not in cloud storage."})
                return
            target = self.state.storage_luna_dir(account_id, luna_id) / "packs" / first
            if not target.is_file():
                self._send_json(404, {"error": "That pack is not in cloud storage."})
                return
            try:
                data = target.read_bytes()
            except OSError:
                self._send_json(404, {"error": "That pack is not in cloud storage."})
                return
            self.state.record_storage_egress(account_id, len(data))
            self._send(200, data, "application/octet-stream")
            return
        if category == "record_list":
            if not valid_storage_name(first):
                self._send_json(400, {"error": "That record kind is not valid. Use only lowercase letters, numbers, dots, dashes and underscores."})
                return
            try:
                limit, after, prefix, requested_version, requested_total = self._parse_record_page(query)
            except ValueError:
                self._send_json(400, {"error": "That backup listing page is not valid. Try again."})
                return
            error, names, version = self.state.list_storage_records(account_id, device_id, luna_id, first)
            if error:
                self._send_json(403, {"error": "This Luna's cloud storage belongs to another device on your account."})
                return
            paged = bool({"limit", "after", "prefix", "version", "total"}.intersection(query))
            if not paged:
                self._send_json(200, {"names": names})
                return
            if requested_version is not None and requested_version != version:
                self._send_json(409, {"error": "The cloud backup list changed during restore. Try restoring again."})
                return
            matching = [name for name in names if not prefix or name.startswith(prefix)]
            total = len(matching) if requested_total is None else requested_total
            remaining = [name for name in matching if name > after]
            page = remaining[:limit]
            next_after = page[-1] if len(remaining) > limit else None
            out: dict[str, Any] = {"names": page, "total": total, "version": version}
            if next_after is not None:
                out["next_after"] = next_after
            self._send_json(200, out)
            return
        if category == "record":
            if not valid_storage_name(first) or not valid_storage_name(second):
                self._send_json(404, {"error": "That record is not in cloud storage."})
                return
            target = self.state.storage_luna_dir(account_id, luna_id) / "records" / first / second
            if not target.is_file():
                self._send_json(404, {"error": "That record is not in cloud storage."})
                return
            try:
                data = target.read_bytes()
            except OSError:
                self._send_json(404, {"error": "That record is not in cloud storage."})
                return
            self.state.record_storage_egress(account_id, len(data))
            self._send(200, data, "application/octet-stream")
            return
        self._send_json(404, {"error": f"not found: {path}"})

    def _storage_put(self, path: str) -> None:
        route = self._storage_route(path)
        if route is None or route[0] not in ("pack", "record"):
            self._send_json(404, {"error": f"not found: {path}"})
            return
        scope = self._storage_scope()
        if scope is None:
            return
        account_id, device_id, luna_id = scope
        category, first, second = route
        if category == "pack" and not STORAGE_PACK_ID_RE.fullmatch(first):
            self._send_json(400, {"error": "That pack ID is not valid. Try the upload again from Luna."})
            return
        scope = self.headers.get("X-Luna-Scope", "").strip()
        if category == "pack" and scope and not STORAGE_SCOPE_RE.fullmatch(scope):
            self._send_json(400, {"error": "That pack label is not valid. Try the upload again from Luna."})
            return
        if category == "record" and (not valid_storage_name(first) or not valid_storage_name(second)):
            self._send_json(400, {"error": "That record name is not valid. Use only lowercase letters, numbers, dots, dashes and underscores."})
            return
        if self._backup_mode():
            return
        if category == "pack" and self.state.storage_pack_exists(account_id, luna_id, first):
            self._send_json(200, {"ok": True, "id": first, "created": False})
            return
        limit = MAX_STORAGE_PACK_BYTES + 1 if category == "pack" else MAX_STORAGE_RECORD_BYTES + 1
        try:
            body = self._read_body(limit)
        except OverflowError:
            if category == "record":
                self._send_json(413, {"error": "That record is too large. The limit is 1 MB."})
            elif self.state.quota_bytes - self.state.storage_used(account_id) < MAX_STORAGE_PACK_BYTES:
                self._send_json(507, {"error": "Your cloud storage is full."})
            else:
                self._send_json(413, {"error": "That data is too large to store in cloud storage. The limit is 64 MB per piece."})
            return
        except ValueError:
            self._send_json(400, {"error": "Could not read that upload. Try again."})
            return
        if category == "pack":
            status, response = self.state.put_storage_pack(account_id, device_id, luna_id, first, body)
        else:
            status, response = self.state.put_storage_record(account_id, device_id, luna_id, first, second, body)
        self._send_json(status, response)

    def _storage_post(self, path: str, payload: dict[str, Any]) -> None:
        self._send_json(404, {"error": f"not found: {path}"})

    def _storage_delete(self, path: str) -> None:
        route = self._storage_route(path)
        if route is None or route[0] not in ("pack", "record"):
            self._send_json(404, {"error": f"not found: {path}"})
            return
        scope = self._storage_scope()
        if scope is None:
            return
        account_id, device_id, luna_id = scope
        category, first, second = route
        if category == "pack":
            if not STORAGE_PACK_ID_RE.fullmatch(first):
                self._send_json(404, {"error": "That pack is not in cloud storage."})
                return
            relative = f"packs/{first}"
        else:
            if not valid_storage_name(first) or not valid_storage_name(second):
                self._send_json(400, {"error": "That record name is not valid. Use only lowercase letters, numbers, dots, dashes and underscores."})
                return
            relative = f"records/{first}/{second}"
        error = self.state.delete_storage_object(account_id, device_id, luna_id, relative)
        if error:
            self._send_json(403, {"error": "This Luna's cloud storage belongs to another device on your account."})
            return
        self._send(204, b"", "application/json")


def http_client_request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    host: str = DEFAULT_HOST,
    port: int = DEFAULT_PORT,
    timeout: float = 1.0,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_headers = dict(headers or {})
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"http://{host}:{port}{path}", data=data, headers=request_headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            try:
                return response.status, json.loads(raw)
            except json.JSONDecodeError:
                return response.status, {"raw": raw}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8")
        try:
            return error.code, json.loads(raw)
        except json.JSONDecodeError:
            return error.code, {"error": raw}
    except Exception as error:
        return 0, {"error": str(error)}


def is_server_running(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> bool:
    code, _ = http_client_request("GET", "/healthz", host=host, port=port)
    return code in (200, 403)


def cmd_status(args: argparse.Namespace) -> int:
    online = is_server_running(args.host, args.port)
    if online:
        code, state = http_client_request("GET", "/_mock/status", host=args.host, port=args.port)
        if code != 200:
            print(f"Error communicating with mock server: {state}", file=sys.stderr)
            return 1
    else:
        state = MockState(args.state_file, args.storage_dir).to_status_dict()
    if args.json:
        print(json.dumps(state, indent=2))
        return 0
    storage = state.get("storage", {})
    print("=" * 60)
    print(f"Luna Connect Mock: {'ONLINE' if online else 'OFFLINE'} (http://{args.host}:{args.port})")
    print(f"  Mode:            {state.get('mode', 'unknown').upper()}")
    print(f"  State:           {state.get('state', 'unknown')}")
    print(f"  Device ID:       {state.get('device_uid')}")
    print(f"  Verification:    {state.get('verification_code')}")
    print(f"  Hostname:        {state.get('hostname') or 'None'}")
    print(f"  Cloud Backup:    {'UNLOCKED' if state.get('backup_unlocked') else 'LOCKED'}")
    print(f"  Stored Objects:  {storage.get('objects_count', 0)} ({storage.get('total_formatted', '0 B')})")
    print(f"  Storage Dir:     {storage.get('storage_dir', args.storage_dir)}")
    print("=" * 60)
    return 0


def cmd_mode_set(args: argparse.Namespace) -> int:
    if is_server_running(args.host, args.port):
        code, data = http_client_request("POST", "/_mock/mode", {"mode": args.mode}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error updating mode: {data}", file=sys.stderr)
            return 1
        print(f">> Mode updated to '{data['mode']}'.")
        return 0
    MockState(args.state_file, args.storage_dir).set_mode(args.mode)
    print(f">> Mode set to '{args.mode}' in the state file.")
    return 0


def cmd_domain_set(args: argparse.Namespace) -> int:
    if is_server_running(args.host, args.port):
        code, data = http_client_request("POST", "/_mock/domain", {"subdomain": args.subdomain, "domain": args.domain}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error updating domain: {data}", file=sys.stderr)
            return 1
        print(f">> {data['subdomain']} -> {data['hostname']}")
        return 0
    result = MockState(args.state_file, args.storage_dir).set_domain(args.subdomain, args.domain)
    print(f">> {result['subdomain']} -> {result['hostname']}")
    return 0


def cmd_backup_unlock(args: argparse.Namespace) -> int:
    if is_server_running(args.host, args.port):
        code, data = http_client_request("POST", "/_mock/backup/unlock", {}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error unlocking backup: {data}", file=sys.stderr)
            return 1
        print(">> Cloud backup unlocked.")
        return 0
    MockState(args.state_file, args.storage_dir).set_backup_unlocked(True)
    print(">> Cloud backup unlocked in the state file.")
    return 0


def cmd_backup_lock(args: argparse.Namespace) -> int:
    if is_server_running(args.host, args.port):
        code, data = http_client_request("POST", "/_mock/backup/lock", {}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error locking backup: {data}", file=sys.stderr)
            return 1
        print(">> Cloud backup locked.")
        return 0
    MockState(args.state_file, args.storage_dir).set_backup_unlocked(False)
    print(">> Cloud backup locked in the state file.")
    return 0


def cmd_backup_stats(args: argparse.Namespace) -> int:
    if is_server_running(args.host, args.port):
        code, stats = http_client_request("GET", "/_mock/backup/stats", host=args.host, port=args.port)
        if code != 200:
            stats = {}
    else:
        stats = MockState(args.state_file, args.storage_dir).get_backup_stats()
    print(f"Objects: {stats.get('objects_count', 0)}")
    print(f"Stored:  {stats.get('total_formatted', '0 B')}")
    print(f"Egress:  {stats.get('egress_formatted', '0 B')}")
    print(f"Cost:    ${stats.get('cost_monthly_usd', 0):.4f}/month")
    return 0


def cmd_backup_clean(args: argparse.Namespace) -> int:
    if is_server_running(args.host, args.port):
        code, data = http_client_request("POST", "/_mock/backup/clean", {}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error cleaning storage: {data}", file=sys.stderr)
            return 1
        print(f">> Removed {data['removed_objects']} objects.")
        return 0
    print(f">> Removed {MockState(args.state_file, args.storage_dir).clean_storage()} objects.")
    return 0


def cmd_mint_device(args: argparse.Namespace) -> int:
    online = is_server_running(args.host, args.port)
    if online:
        code, minted = http_client_request("POST", "/_mock/device/mint", {}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error minting identity: {minted}", file=sys.stderr)
            return 1
        uid = normalize_uid(minted["device_uid"])
        verification = minted["verification_code"]
    else:
        state = MockState(args.state_file, args.storage_dir)
        uid, verification = state.mint_device()
    print("Minted Luna device identity:")
    print(f"  Device ID:       {group_uid(uid)}")
    print(f"  Normalized:      {uid}")
    print(f"  Verification:    {verification}")
    if not args.write:
        return 0

    CONNECT_CREDENTIAL_FILE.unlink(missing_ok=True)
    write_private(DEVICE_UID_FILE, uid)
    write_private(PAIRING_CODE_FILE, verification)
    if online:
        headers = {"X-Mock-Account": "acct_mock"}
        code, started = http_client_request("POST", "/api/v1/devices/pair", {"device_uid": uid, "verification_code": verification}, host=args.host, port=args.port, headers=headers)
        if code != 200:
            print(f"Error starting mock pairing: {started}", file=sys.stderr)
            return 1
        code, claimed = http_client_request("POST", "/api/v1/devices/pair/claim", {"device_uid": uid, "verification_code": verification}, host=args.host, port=args.port)
        if code != 200:
            print(f"Error claiming mock pairing: {claimed}", file=sys.stderr)
            return 1
        credential = claimed["auth_token"]
    else:
        state = MockState(args.state_file, args.storage_dir)
        now = int(time.time())
        _, status = state.start_pair(uid, verification, "acct_mock", now)
        if status != "ok":
            print("Error starting mock pairing.", file=sys.stderr)
            return 1
        credential, claim_status = state.claim_pair(uid, verification, now)
        if claim_status != "ok":
            print("Error claiming mock pairing.", file=sys.stderr)
            return 1
    if not credential:
        print("Error claiming mock pairing.", file=sys.stderr)
        return 1
    write_private(CONNECT_CREDENTIAL_FILE, credential)
    print(f"  Written:         {DEVICE_UID_FILE}, {PAIRING_CODE_FILE}, {CONNECT_CREDENTIAL_FILE} (mode 0600)")
    return 0


def cmd_stop(args: argparse.Namespace) -> int:
    if PID_FILE.exists():
        try:
            pid = int(PID_FILE.read_text().strip())
            os.kill(pid, signal.SIGTERM)
            print(f">> Sent SIGTERM to mock server (PID {pid}).")
            PID_FILE.unlink(missing_ok=True)
            return 0
        except (ValueError, OSError) as error:
            print(f"Warning stopping PID: {error}", file=sys.stderr)
            PID_FILE.unlink(missing_ok=True)
    if is_server_running(args.host, args.port):
        print(f">> A server is running on {args.host}:{args.port}, but its PID file was not found.", file=sys.stderr)
        return 1
    print(">> Mock Connect server is not running.")
    return 0


def run_server(host: str, port: int, state_file: Path, storage_dir: Path, mode: str | None = None) -> int:
    state = MockState(state_file, storage_dir)
    if mode:
        state.set_mode(mode)
    storage_dir.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((host, port), MockConnectHandler)
    server.mock_state = state  # type: ignore[attr-defined]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    write_private(PID_FILE, str(os.getpid()))

    def stop(_signal: int, _frame: Any) -> None:
        print("\n[mock-connect] shutting down...")
        PID_FILE.unlink(missing_ok=True)
        sys.exit(0)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(f"Luna Connect mock listening on http://{host}:{port}")
    print(f"Device ID: {group_uid(state.device_uid)}")
    print(f"Verification code: {state.verification_code}")
    try:
        server.serve_forever()
    finally:
        PID_FILE.unlink(missing_ok=True)
    return 0


def cmd_serve(args: argparse.Namespace) -> int:
    if args.daemon:
        import subprocess

        command = [sys.executable, str(Path(__file__).resolve()), "serve", "--host", args.host, "--port", str(args.port), "--state-file", str(args.state_file), "--storage-dir", str(args.storage_dir)]
        if args.mode:
            command.extend(["--mode", args.mode])
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        print(f">> Started mock Connect server (PID {process.pid}) at http://{args.host}:{args.port}")
        return 0
    return run_server(args.host, args.port, args.state_file, args.storage_dir, args.mode)


def main() -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--host", default=argparse.SUPPRESS)
    common.add_argument("--port", type=int, default=argparse.SUPPRESS)
    common.add_argument("--state-file", type=Path, default=argparse.SUPPRESS)
    common.add_argument("--storage-dir", type=Path, default=argparse.SUPPRESS)
    parser = argparse.ArgumentParser(description="Luna Connect Mock Server & CLI", parents=[common])
    sub = parser.add_subparsers(dest="subcommand")

    status = sub.add_parser("status", parents=[common])
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=cmd_status)

    mode = sub.add_parser("mode", parents=[common])
    mode_sub = mode.add_subparsers(dest="mode_cmd", required=True)
    mode_set = mode_sub.add_parser("set", parents=[common])
    mode_set.add_argument("mode", choices=["bound", "unbound", "challenge", "401", "backup_locked", "storage_full", "bound_spawn"])
    mode_set.set_defaults(func=cmd_mode_set)

    domain = sub.add_parser("domain", parents=[common])
    domain_sub = domain.add_subparsers(dest="domain_cmd", required=True)
    domain_set = domain_sub.add_parser("set", parents=[common])
    domain_set.add_argument("subdomain")
    domain_set.add_argument("domain", nargs="?")
    domain_set.set_defaults(func=cmd_domain_set)

    backup = sub.add_parser("backup", parents=[common])
    backup_sub = backup.add_subparsers(dest="backup_cmd", required=True)
    backup_sub.add_parser("unlock", parents=[common]).set_defaults(func=cmd_backup_unlock)
    backup_sub.add_parser("lock", parents=[common]).set_defaults(func=cmd_backup_lock)
    backup_sub.add_parser("stats", parents=[common]).set_defaults(func=cmd_backup_stats)
    backup_sub.add_parser("clean", parents=[common]).set_defaults(func=cmd_backup_clean)

    mint = sub.add_parser("mint-device", parents=[common], help="Mint a Device ID and verification code")
    mint.add_argument("--write", action="store_true", help="Write device-uid, pairing-code, and a mock connect-credential")
    mint.set_defaults(func=cmd_mint_device)

    serve = sub.add_parser("serve", parents=[common], aliases=["server", "run", "start"])
    serve.add_argument("--mode", choices=["bound", "unbound", "challenge", "401", "backup_locked", "storage_full", "bound_spawn"])
    serve.add_argument("--daemon", "-d", action="store_true")
    serve.set_defaults(func=cmd_serve)

    sub.add_parser("stop", parents=[common]).set_defaults(func=cmd_stop)

    args = parser.parse_args(["serve"] if len(sys.argv) == 1 else sys.argv[1:])
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
