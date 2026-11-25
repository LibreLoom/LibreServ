#!/usr/bin/env python3
"""Automated test suite for Luna Connect Mock Server and CLI."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "mocks" / "mock-connect.py"
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


def json_req(
    method: str,
    path: str,
    payload: dict | None = None,
    *,
    token: str | None = None,
    luna_id: str | None = None,
    account: str | None = None,
    raw: bytes | None = None,
) -> tuple[int, dict[str, str], bytes]:
    headers: dict[str, str] = {}
    body = raw
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if luna_id:
        headers["X-Luna-Id"] = luna_id
    if account:
        headers["X-Mock-Account"] = account
    return http_req(method, path, body=body, headers=headers)


def pair_identity(uid: str, verification: str) -> tuple[int, dict[str, str], bytes, str]:
    status, _, body = json_req(
        "POST", "/api/v1/devices/pair",
        {"device_uid": uid, "verification_code": verification},
        account="acct_mock",
    )
    if status != 200:
        return status, {}, body, ""
    pairing_id = json.loads(body)["pairing_id"]
    status, _, body = json_req(
        "POST", "/api/v1/devices/pair/claim",
        {"device_uid": uid, "verification_code": verification},
    )
    token = json.loads(body).get("auth_token", "") if status == 200 else ""
    return status, {"pairing_id": pairing_id}, body, token


def test_suite() -> None:
    temp_dir = Path(tempfile.mkdtemp(prefix="luna-mock-test-"))
    state_file = temp_dir / "state.json"
    storage_dir = temp_dir / "storage"
    credential_file = temp_dir / "connect-credential"

    test_env = {
        "MOCK_CONNECT_HOST": TEST_HOST,
        "MOCK_CONNECT_PORT": str(TEST_PORT),
        "LUNA_DATA_DIR": str(temp_dir),
        "LUNA_MOCK_STORAGE_DIR": str(storage_dir),
        "LUNA_MOCK_QUOTA_BYTES": "128",
    }

    server_proc = None
    try:
        print(">> [1/10] Testing offline CLI management...")
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

        # Mint the Device ID, reusable Verification code, and rolling credential.
        code, out, _ = run_cli(
            "--host", TEST_HOST,
            "--port", str(TEST_PORT),
            "--state-file", str(state_file),
            "--storage-dir", str(storage_dir),
            "mint-device", "--write",
            env=test_env,
        )
        assert code == 0, out
        assert credential_file.is_file()
        token = credential_file.read_text().strip()
        assert len(token) == 43
        assert state_file.stat().st_mode & 0o777 == 0o600
        assert credential_file.stat().st_mode & 0o777 == 0o600
        assert (temp_dir / "pairing-code").stat().st_mode & 0o777 == 0o600

        # Set domain after minting; a fresh identity starts without an address.
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

        mock_state_type = runpy.run_path(str(SCRIPT))["MockState"]
        expiry_state = mock_state_type(temp_dir / "expiry.json", temp_dir / "expiry-storage")
        expiry_uid, expiry_code = expiry_state.mint_device()
        expiry_pair, status = expiry_state.start_pair(expiry_uid, expiry_code, "acct_mock", 100)
        assert status == "ok"
        expiry_state.pairing_expires_at = 101
        assert expiry_state.pair_status(expiry_pair, "acct_mock", 101) == ("unbound", "")
        assert expiry_state.pair_status(expiry_pair, "acct_mock", 101) == ("", "")

        print(">> [2/10] Launching mock server on test port...")
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

        print(">> [3/10] Testing Health and Status endpoints...")
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

        print(">> [4/10] Testing Domain and Device endpoints...")
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

        print(">> [5/10] Testing Cloud Backup upload, get, delete, stats...")
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

        print(">> [6/10] Testing Modes & Error Simulation...")
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
        assert json.loads(body)["code"] == "device_unbound"

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

        # 4. Pair again after unbind, then test backup locked (402).
        run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "mode", "set", "unbound", env=test_env)
        uid = (temp_dir / "device-uid").read_text().strip()
        verification = (temp_dir / "pairing-code").read_text().strip()
        st, _, body = http_req(
            "POST", "/api/v1/devices/pair",
            body=json.dumps({"device_uid": uid, "verification_code": verification}).encode("utf-8"),
            headers={"X-Mock-Account": "acct_mock", "Content-Type": "application/json"},
        )
        assert st == 200, body
        st, _, body = http_req(
            "POST", "/api/v1/devices/pair/claim",
            body=json.dumps({"device_uid": uid, "verification_code": verification}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
        )
        assert st == 200, body
        token = json.loads(body)["auth_token"]

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

        # 5. Storage full mode (507 Insufficient Storage).
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
        assert st == 507

        print(">> [7/10] Testing Live CLI control on running server...")
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
        assert "Objects: 2" in out

        code, out, _ = run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "backup", "clean", env=test_env)
        assert code == 0
        assert "Removed 2 objects" in out

        code, out, _ = run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "status", env=test_env)
        assert code == 0
        assert "ONLINE" in out
        assert "BOUND" in out

        print(">> [8/10] Testing pairing budgets, rolling credentials, and device routes...")
        st, _, body = json_req("POST", "/_mock/device/mint", {})
        assert st == 200, body
        minted = json.loads(body)
        uid = minted["device_uid"].replace("-", "")
        verification = minted["verification_code"]

        # Ordinary unbound polling is valid but has no active attempt. It must
        # return the generic 404 without spending any of the five failures.
        for _ in range(7):
            st, _, _ = json_req("POST", "/api/v1/devices/pair/claim", {"device_uid": uid, "verification_code": verification})
            assert st == 404
        counters = json.loads(state_file.read_text())["rate_counters"]
        assert f"pair-device:{uid}" not in counters

        wrong_code = "000000" if verification != "000000" else "FFFFFF"
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            statuses = list(pool.map(
                lambda _: json_req(
                    "POST", "/api/v1/devices/pair/claim",
                    {"device_uid": uid, "verification_code": wrong_code},
                )[0],
                range(10),
            ))
        assert statuses.count(404) == 5, statuses
        assert statuses.count(429) == 5, statuses
        counters = json.loads(state_file.read_text())["rate_counters"]
        assert counters[f"pair-device:{uid}"]["count"] == 5

        # A fresh UID avoids the deliberately exhausted bucket while retaining
        # the same trusted-IP counter, which is still below its separate limit.
        st, _, body = json_req("POST", "/_mock/device/mint", {})
        assert st == 200, body
        minted = json.loads(body)
        uid = minted["device_uid"].replace("-", "")
        verification = minted["verification_code"]
        st, _, body = json_req(
            "POST", "/api/v1/devices/pair",
            {"device_uid": uid, "verification_code": verification},
            account="acct_mock",
        )
        assert st == 200, body
        pairing_id = json.loads(body)["pairing_id"]
        st, _, body = json_req("GET", f"/api/v1/devices/pair/{pairing_id}", account="acct_mock")
        assert st == 200 and json.loads(body)["status"] == "waiting", body
        st, _, body = json_req(
            "POST", "/api/v1/devices/pair/claim",
            {"device_uid": uid, "verification_code": verification},
        )
        assert st == 200, body
        token = json.loads(body)["auth_token"]
        st, _, body = json_req("GET", f"/api/v1/devices/pair/{pairing_id}", account="acct_mock")
        assert st == 200 and json.loads(body)["status"] == "bound", body
        device_id = json.loads(body)["device_id"]

        st, _, body = json_req("POST", "/api/v1/token/refresh", token=token)
        assert st == 200, body
        rotated = json.loads(body)["auth_token"]
        st, _, _ = json_req("GET", "/api/v1/status", token=token)
        assert st == 401
        st, _, body = json_req("POST", "/api/v1/token/refresh", token=token)
        assert st == 200 and json.loads(body)["auth_token"] == rotated, body
        st, _, body = json_req("POST", "/api/v1/token/refresh", token=rotated)
        assert st == 200, body
        previous_token, token = rotated, json.loads(body)["auth_token"]
        st, _, _ = json_req("GET", "/api/v1/status", token="A" * 43)
        assert st == 401

        for method, suffix in (("POST", "setup-grant"), ("POST", "revoke"), ("POST", "recover"), ("POST", "domain")):
            st, _, _ = json_req(method, f"/api/v1/devices/wrong-device/{suffix}", {}, account="acct_mock")
            assert st == 404, (method, suffix)
        st, _, _ = json_req("DELETE", "/api/v1/devices/wrong-device", account="acct_mock")
        assert st == 404
        st, _, _ = json_req("GET", "/api/v1/status", token=token)
        assert st == 200

        st, _, _ = json_req("POST", "/api/v1/unregister", token=token)
        assert st == 200
        saved_state = json.loads(state_file.read_text())
        assert saved_state["auth_token"] == ""
        assert len(saved_state["auth_token_hash"]) == 64
        assert len(saved_state["previous_auth_token_hash"]) == 64
        assert saved_state["previous_valid_until"] == 0
        assert state_file.stat().st_mode & 0o777 == 0o600
        for old_token in (token, previous_token):
            st, _, body = json_req("GET", "/api/v1/status", token=old_token)
            assert st == 403 and json.loads(body)["code"] == "device_unbound", body
        st, _, body = json_req("POST", "/api/v1/token/refresh", token=previous_token)
        assert st == 403 and json.loads(body)["code"] == "device_unbound", body
        st, _, _ = json_req("GET", "/api/v1/status", token="A" * 43)
        assert st == 401

        st, _, _, token = pair_identity(uid, verification)
        assert st == 200
        st, _, body = json_req("POST", f"/api/v1/devices/{device_id}/revoke", {}, account="acct_mock")
        assert st == 200, body
        st, _, body = json_req("GET", "/api/v1/status", token=token)
        assert st == 403 and json.loads(body)["code"] == "device_revoked", body

        # Account-authorized recovery creates a fresh attempt; Luna still claims
        # it with the same Device ID and reusable Verification code.
        st, _, body = json_req("POST", f"/api/v1/devices/{device_id}/recover", {}, account="acct_mock")
        assert st == 200, body
        recovery_pair = json.loads(body)["pairing_id"]
        st, _, body = json_req("GET", f"/api/v1/devices/pair/{recovery_pair}", account="acct_mock")
        assert st == 200 and json.loads(body)["status"] == "waiting", body
        st, _, body = json_req(
            "POST", "/api/v1/devices/pair/claim",
            {"device_uid": uid, "verification_code": verification},
        )
        assert st == 200, body
        token = json.loads(body)["auth_token"]

        print(">> [9/10] Testing storage ownership, hashes, paging, signing keys, and quota...")
        st, _, _ = json_req("PUT", "/api/v1/storage/records/notes/no-id", raw=b"x", token=token)
        assert st == 400
        st, _, _ = json_req("PUT", "/api/v1/storage/packs/not-a-hash", raw=b"x", token=token, luna_id="luna-test")
        assert st == 400
        st, _, _ = json_req("PUT", f"/api/v1/storage/packs/{'a' * 64}", raw=b"wrong", token=token, luna_id="luna-test")
        assert st == 400

        pack_body = b"pack-data"
        pack_id = hashlib.sha256(pack_body).hexdigest()
        st, _, body = json_req("PUT", f"/api/v1/storage/packs/{pack_id}", raw=pack_body, token=token, luna_id="luna-test")
        assert st == 200 and json.loads(body)["created"] is True, body
        st, _, _ = json_req("GET", f"/api/v1/storage/packs/{pack_id}", token=token, luna_id="other-luna")
        assert st == 404
        st, _, body = json_req("GET", f"/api/v1/storage/packs/{pack_id}", token=token, luna_id="luna-test")
        assert st == 200 and body == pack_body
        st, _, _ = json_req("DELETE", f"/api/v1/storage/packs/{pack_id}", token=token, luna_id="luna-test")
        assert st == 204
        st, _, _ = json_req("DELETE", f"/api/v1/storage/packs/{pack_id}", token=token, luna_id="luna-test")
        assert st == 204

        for name in ("c.json", "a.json", "b.json"):
            st, _, body = json_req("PUT", f"/api/v1/storage/records/snapshots/{name}", raw=b"v", token=token, luna_id="luna-test")
            assert st == 200, body
        st, _, body = json_req("GET", "/api/v1/storage/records/snapshots", token=token, luna_id="luna-test")
        assert st == 200 and json.loads(body) == {"names": ["a.json", "b.json", "c.json"]}, body
        st, _, body = json_req("GET", "/api/v1/storage/records/snapshots?limit=1", token=token, luna_id="luna-test")
        assert st == 200, body
        page = json.loads(body)
        assert page["names"] == ["a.json"] and page["total"] == 3 and page["next_after"] == "a.json"
        version = page["version"]
        assert version > 0
        st, _, body = json_req("PUT", "/api/v1/storage/records/snapshots/a.json", raw=b"updated", token=token, luna_id="luna-test")
        assert st == 200, body
        st, _, _ = json_req(
            "GET", f"/api/v1/storage/records/snapshots?limit=1&after=a.json&version={version}&total=3",
            token=token, luna_id="luna-test",
        )
        assert st == 409
        st, _, body = json_req("GET", "/api/v1/storage/records/snapshots?limit=2", token=token, luna_id="luna-test")
        page = json.loads(body)
        assert page["names"] == ["a.json", "b.json"] and page["next_after"] == "b.json", body
        st, _, body = json_req(
            "GET", f"/api/v1/storage/records/snapshots?limit=2&after=b.json&version={page['version']}&total=3",
            token=token, luna_id="luna-test",
        )
        assert st == 200 and json.loads(body)["names"] == ["c.json"], body

        for name in ("scope-a.1", "scope-a.2", "scope-b.1"):
            st, _, _ = json_req("PUT", f"/api/v1/storage/records/psnapshots/{name}", raw=b"v", token=token, luna_id="luna-test")
            assert st == 200
        st, _, body = json_req("GET", "/api/v1/storage/records/psnapshots?limit=1&prefix=scope-a.", token=token, luna_id="luna-test")
        assert st == 200 and json.loads(body)["total"] == 2 and json.loads(body)["next_after"] == "scope-a.1", body
        for query in ("limit=0", "limit=1&limit=2", "limit=1&after=a.json", "limit=1&version=-1"):
            st, _, _ = json_req("GET", f"/api/v1/storage/records/snapshots?{query}", token=token, luna_id="luna-test")
            assert st == 400, query

        signing_key = "a" * 3968
        signing_path = "/api/v1/storage/luna-ids/luna-test/signing-public"
        st, _, body = json_req("POST", signing_path, raw=signing_key.encode("ascii"), token=token)
        assert st == 200, body
        st, _, _ = json_req("POST", signing_path, raw=signing_key.encode("ascii"), token=token)
        assert st == 200
        st, _, _ = json_req("POST", signing_path, raw=("b" * 3968).encode("ascii"), token=token)
        assert st == 409
        st, _, _ = json_req("POST", signing_path, raw=("a" * 128).encode("ascii"), token=token)
        assert st == 400

        st, _, body = json_req("PUT", "/api/v1/storage/records/quota/full", raw=b"x" * 128, token=token, luna_id="luna-test")
        assert st == 507, body
        st, _, body = json_req("PUT", "/api/v1/storage/records/quota/large", raw=b"x" * ((1 << 20) + 1), token=token, luna_id="luna-test")
        assert st == 413, body
        st, _, body = json_req("GET", "/api/v1/storage/usage", token=token, luna_id="luna-test")
        assert st == 200 and json.loads(body)["quota_bytes"] == 128, body
        assert json.loads(body)["used_bytes"] <= 128

        # A new Connect device on the same mock account cannot take over the
        # first device's X-Luna-Id namespace.
        st, _, body = json_req("POST", "/_mock/device/mint", {})
        assert st == 200, body
        minted = json.loads(body)
        uid = minted["device_uid"].replace("-", "")
        verification = minted["verification_code"]
        st, _, _, token = pair_identity(uid, verification)
        assert st == 200
        st, _, _ = json_req("PUT", "/api/v1/storage/records/notes/takeover", raw=b"x", token=token, luna_id="luna-test")
        assert st == 403
        st, _, _ = json_req("POST", signing_path, raw=signing_key.encode("ascii"), token=token)
        assert st == 403
        run_cli("--host", TEST_HOST, "--port", str(TEST_PORT), "mode", "set", "bound", env=test_env)

        print(">> [10/10] Testing Legacy _debug/mode endpoint compatibility...")
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
