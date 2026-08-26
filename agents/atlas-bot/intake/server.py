#!/usr/bin/env python3
from __future__ import annotations
import hashlib, hmac, json, os, subprocess, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET = os.environ.get("ATLAS_WEBHOOK_SECRET", "")
BOT = os.environ.get("ATLAS_BOT_LOGIN", "atlas-bot")
COOK = os.environ.get("ATLAS_COOK", "/opt/atlas-bot/cook.sh")
ORG = os.environ.get("ATLAS_ORG", "LibreLoom")

def _sig_ok(body: bytes, header: str) -> bool:
    if not SECRET:
        return False
    want = hmac.new(SECRET.encode(), body, hashlib.sha256).hexdigest()
    got = (header or "").strip()
    if got.startswith("sha256="):
        got = got[7:]
    return hmac.compare_digest(want, got)

def _ticket(payload: dict) -> tuple[str, str, str]:
    repo = payload.get("repository") or {}
    owner = (repo.get("owner") or {}).get("login") or ""
    name = repo.get("name") or ""
    issue = payload.get("issue") or {}
    pr = payload.get("pull_request") if isinstance(payload.get("pull_request"), dict) else {}
    index = str(issue.get("number") or pr.get("number") or "")
    return owner, name, index

def _wanted(payload: dict) -> bool:
    sender = ((payload.get("sender") or {}).get("login") or "")
    if sender == BOT:
        return False
    owner, name, index = _ticket(payload)
    if owner != ORG:
        return False
    action = payload.get("action") or ""
    comment = ((payload.get("comment") or {}).get("body") or "").lower()
    issue = payload.get("issue") or {}
    pr = payload.get("pull_request") if isinstance(payload.get("pull_request"), dict) else {}
    body = (issue.get("body") or pr.get("body") or "").lower()
    mention = "@" + BOT.lower()
    if mention in comment:
        print(f"[intake] mention {owner}/{name}#{index} by {sender}", flush=True)
        return True
    if action in ("opened", "created") and mention in body:
        print(f"[intake] opened-with-mention {owner}/{name}#{index} by {sender}", flush=True)
        return True
    if action == "assigned":
        assignee = ((payload.get("assignee") or {}).get("login") or "")
        assignees = [a.get("login") for a in (issue.get("assignees") or pr.get("assignees") or [])]
        if assignee == BOT or BOT in assignees:
            print(f"[intake] assigned {owner}/{name}#{index} by {sender}", flush=True)
            return True
    return False

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("[intake]", fmt % args, flush=True)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"atlas-bot intake\n")
    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        sig = self.headers.get("X-Forgejo-Signature") or self.headers.get("X-Gitea-Signature") or ""
        if not _sig_ok(body, sig):
            self.send_response(401); self.end_headers(); return
        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            self.send_response(400); self.end_headers(); return
        self.send_response(202); self.end_headers()
        if not _wanted(payload):
            return
        path = "/tmp/atlas-event-%s-%s.json" % (os.getpid(), threading.get_ident())
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(payload))
        threading.Thread(target=_run, args=(path,), daemon=True).start()

def _run(path: str) -> None:
    print(f"[intake] cook start {path}", flush=True)
    try:
        rc = subprocess.run([COOK, path], check=False).returncode
        print(f"[intake] cook exit {rc}", flush=True)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass

def main() -> None:
    port = int(os.environ.get("ATLAS_INTAKE_PORT", "8787"))
    print(f"[intake] listening :{port}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()

if __name__ == "__main__":
    main()
