#!/usr/bin/env python3
"""Automated test suite for Luna Connect Mock Server and CLI."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "mock-connect.py"
TEST_PORT = 19876
TEST_HOST = "127.0.0.1"


def run_cli(*args: str, env: dict[str, str] | None = None) -> tuple[int, str, str]:
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    res = subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=full_env,
    )
    return res.returncode, res.stdout, res.stderr


def http_req(
    method: str,
    path: str,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    host: str = TEST_HOST,
    port: int = TEST_PORT,
) -> tuple[int, dict[str, str], bytes]:
    url = f"http://{host}:{port}{path}"
    h = headers.copy() if headers else {}
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            return resp.status, hdrs, resp.read()
    except urllib.error.HTTPError as e:
        hdrs = {k.lower(): v for k, v in e.headers.items()}
        return e.code, hdrs, e.read()


def test_suite() -> None:
    temp_dir = Path(tempfile.mkdtemp(prefix="luna-mock-test-"))
    state_file = temp_dir / "state.json"
    storage_dir = temp_dir / "storage"
    device_token_file = temp_dir / "device-token"

    test_env = {
        "MOCK_CONNECT_HOST": TEST_HOST,
        "MOCK_CONNECT_PORT": str(TEST_PORT),
        "LUNA_DATA_DIR": str(temp_dir),
        "LUNA_MOCK_STORAGE_DIR": str(storage_dir),
    }

    server_proc = None
    try:
        print(">> [1/8] Testing offline CLI management...")
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "--state-file", str(state_file),
            "--storage-dir", str(storage_dir),
            "status",
            env=test_env,
        )
        assert code == 0, f"Status failed: {out}"
        assert "OFFLINE" in out

        # Set domain offline
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "--state-file", str(state_file),
            "--storage-dir", str(storage_dir),
            "domain", "set", "lunabox",
            env=test_env,
        )
        assert code == 0
        assert "lunabox" in out

        # Mint token
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "--state-file", str(state_file),
            "--storage-dir", str(storage_dir),
            "mint-token", "--write-to", str(device_token_file),
            env=test_env,
        )
        assert code == 0
        assert device_token_file.is_file()
        token = device_token_file.read_text().strip()
        assert len(token) == 24  # 20 chars + 4 dashes

        print(">> [2/8] Launching mock server on test port...")
        server_cmd = [
            sys.executable,
            str(SCRIPT),
            "serve",
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "--state-file", str(state_file),
            "--storage-dir", str(storage_dir),
            "--mode", "bound",
        ]
        server_proc = subprocess.Popen(server_cmd, env={**os.environ, **test_env})

        # Wait for server to start
        connected = False
        for _ in range(30):
            time.sleep(0.1)
            try:
                st, _, data = http_req("GET", "/healthz")
                if st == 200:
                    connected = True
                    break
            except Exception:
                pass
        assert connected, "Server failed to start!"
        print("   Server online!")

        print(">> [3/8] Testing Health and Status endpoints...")
        st, _, data = http_req("GET", "/api/v1/healthz")
        assert st == 200
        assert json.loads(data).get("ok") is True

        # Test Status with Bearer token
        st, _, data = http_req(
            "GET",
            "/api/v1/status",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert st == 200
        status_json = json.loads(data)
        assert status_json["bound"] is True
        assert status_json["subdomain"] == "lunabox"
        assert status_json["hostname"] == "lunabox.luna.servers.libreloom.org"
        assert status_json["tunnel_token"] == "mock-lunabox-tunnel-token"
        assert status_json["backup_unlocked"] is True

        # Test Status with missing token
        st, _, data = http_req("GET", "/api/v1/status")
        assert st == 401

        # Test Status with invalid token
        st, _, data = http_req("GET", "/api/v1/status", headers={"Authorization": "Bearer BAD!NOTCROCKFORD"})
        assert st == 401

        print(">> [4/8] Testing Domain and Device endpoints...")
        # Domain available
        st, _, data = http_req("GET", "/api/v1/domain/available?name=awesomebox")
        assert st == 200
        assert json.loads(data)["available"] is True

        # Change domain via POST /api/v1/domain
        st, _, data = http_req(
            "POST",
            "/api/v1/domain",
            body=json.dumps({"subdomain": "cloudvault"}).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
        assert st == 200
        dom_resp = json.loads(data)
        assert dom_resp["subdomain"] == "cloudvault"
        assert dom_resp["hostname"] == "cloudvault.luna.servers.libreloom.org"
        assert dom_resp["tunnel_token"] == "mock-cloudvault-tunnel-token"

        # First user
        st, _, _ = http_req("POST", "/api/v1/first-user")
        assert st == 200

        print(">> [5/8] Testing Cloud Backup upload, get, delete, stats...")
        test_payload = b"Mock Luna Cloud Backup Blob 2026 Test Data!"
        test_hash = hashlib.sha256(test_payload).hexdigest()
        object_rel = "backups/volumes/vol1/chunk001.bin"

        # PUT backup object
        st, _, data = http_req(
            "PUT",
            f"/api/v1/backup/objects/{object_rel}",
            body=test_payload,
            headers={
                "Authorization": f"Bearer {token}",
                "X-Content-Hash": test_hash,
            },
        )
        assert st == 200
        put_resp = json.loads(data)
        assert put_resp["ok"] is True
        assert put_resp["size"] == len(test_payload)
        assert put_resp["content_hash"] == test_hash
        assert (storage_dir / object_rel).is_file()

        # GET backup object
        st, hdrs, body = http_req(
            "GET",
            f"/api/v1/backup/objects/{object_rel}",
        )
        assert st == 200
        assert body == test_payload
        assert hdrs.get("x-content-hash") == test_hash

        # Check backup stats
        st, _, data = http_req("GET", "/api/v1/backup/status")
        assert st == 200
        stats = json.loads(data)
        assert stats["objects_count"] == 1
        assert stats["total_bytes"] == len(test_payload)
        assert stats["egress_bytes"] == len(test_payload)
        assert "cost_monthly_usd" in stats

        # List backups
        st, _, data = http_req("GET", "/api/v1/backups")
        assert st == 200
        blist = json.loads(data)
        assert blist["total_objects"] == 1
        assert blist["objects"][0]["relative_path"] == object_rel

        # DELETE backup object
        st, _, data = http_req(
            "DELETE",
            f"/api/v1/backup/objects/{object_rel}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert st == 200
        assert not (storage_dir / object_rel).exists()

        # GET deleted object -> 404
        st, _, _ = http_req("GET", f"/api/v1/backup/objects/{object_rel}")
        assert st == 404

        print(">> [6/8] Testing Modes & Error Simulation...")
        # 1. Challenge mode
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "mode", "set", "challenge",
            env=test_env,
        )
        assert code == 0
        st, hdrs, body = http_req("GET", "/api/v1/status", headers={"Authorization": f"Bearer {token}"})
        assert st == 403
        assert hdrs.get("cf-mitigated") == "challenge"
        assert b"cf-browser-verification" in body

        # 2. Unbound mode
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "mode", "set", "unbound",
            env=test_env,
        )
        assert code == 0
        st, hdrs, body = http_req("GET", "/api/v1/status", headers={"Authorization": f"Bearer {token}"})
        assert st == 403
        assert "application/json" in hdrs.get("content-type", "")
        assert json.loads(body)["error"] == "unbound"

        # 3. 401 mode
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "mode", "set", "401",
            env=test_env,
        )
        assert code == 0
        st, _, body = http_req("GET", "/api/v1/status", headers={"Authorization": f"Bearer {token}"})
        assert st == 401

        # 4. Backup locked mode (402 Payment Required)
        run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "mode", "set", "bound", env=test_env)
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "backup", "lock",
            env=test_env,
        )
        assert code == 0
        st, _, body = http_req(
            "PUT",
            "/api/v1/backup/objects/chunk.bin",
            body=b"test",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert st == 402
        assert b"payment card" in body

        # 5. Storage full mode (413 Request Entity Too Large)
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "mode", "set", "storage_full",
            env=test_env,
        )
        assert code == 0
        st, _, body = http_req(
            "PUT",
            "/api/v1/backup/objects/chunk.bin",
            body=b"test",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert st == 413

        print(">> [7/8] Testing Live CLI control on running server...")
        # Reset to bound & unlock backup
        run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "mode", "set", "bound", env=test_env)
        run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "backup", "unlock", env=test_env)

        # Upload a chunk to test backup stats & clean CLI
        http_req(
            "PUT",
            "/api/v1/backup/objects/data/file1.bin",
            body=b"A" * 1024,
            headers={"Authorization": f"Bearer {token}"},
        )
        http_req(
            "PUT",
            "/api/v1/backup/objects/data/file2.bin",
            body=b"B" * 2048,
            headers={"Authorization": f"Bearer {token}"},
        )

        code, out, _ = run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "backup", "stats", env=test_env)
        assert code == 0
        assert "Stored Objects:  2" in out

        code, out, _ = run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "backup", "clean", env=test_env)
        assert code == 0
        assert "Cleaned 2 mock backup objects" in out

        code, out, _ = run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "status", env=test_env)
        assert code == 0
        assert "ONLINE" in out
        assert "BOUND" in out

        print(">> [8/8] Testing Legacy _debug/mode endpoint compatibility...")
        st, _, body = http_req("GET", "/_debug/mode")
        assert st == 200
        assert json.loads(body)["mode"] == "bound"

        st, _, body = http_req(
            "POST",
            "/_debug/mode",
            body=b'{"mode":"challenge"}',
            headers={"Content-Type": "application/json"},
        )
        assert st == 200
        assert json.loads(body)["mode"] == "challenge"

        print(">> ALL TESTS PASSED SUCCESSFULLY! :)")

    finally:
        if server_proc:
            server_proc.terminate()
            try:
                server_proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                server_proc.kill()
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    test_suite()
