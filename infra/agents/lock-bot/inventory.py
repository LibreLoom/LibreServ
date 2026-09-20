#!/usr/bin/env python3
from __future__ import annotations
import argparse, json, os, re, sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "vendor", "target", "dist", "build", ".venv"}
PYTHON_LOCK_NAMES = ("poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock")
def rel(root, path):
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return path.as_posix()

def rel_dir(root, directory):
    r = rel(root, directory)
    return "." if r in ("", ".") else r

def walk_files(root):
    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        base = Path(dirpath)
        for name in filenames:
            yield base / name
def sibling_lock_names(directory):
    found = []
    try:
        entries = list(directory.iterdir())
    except OSError:
        return found
    for p in entries:
        if not p.is_file():
            continue
        n = p.name
        if n.endswith(".lock") or n.endswith(".lockb"):
            found.append(n)
        elif n.endswith("-lock.json") or n.endswith("-lock.yaml"):
            found.append(n)
        elif n.endswith("shrinkwrap.json"):
            found.append(n)
        elif n == "go.sum":
            found.append(n)
    return found
def ancestor_lock(start, root, filename):
    cur = start.resolve()
    stop = root.resolve()
    while True:
        candidate = cur / filename
        if candidate.is_file():
            return candidate
        if cur == stop or cur.parent == cur:
            return None
        cur = cur.parent

def cargo_locks(cargo_toml, root):
    here = cargo_toml.parent
    names = sibling_lock_names(here)
    if any(n == "Cargo.lock" for n in names):
        return ["Cargo.lock"]
    found = ancestor_lock(here, root, "Cargo.lock")
    if found is None:
        return []
    try:
        return [found.relative_to(root).as_posix()]
    except ValueError:
        return [found.as_posix()]
def parse_from_payload(payload):
    payload = payload.strip().split("#", 1)[0].strip()
    payload = re.sub(r"\s+[Aa][Ss]\s+\S+\s*$", "", payload).strip()
    image = ""
    for tok in payload.split():
        if tok.startswith("--"):
            continue
        image = tok
        break
    digest = None
    locked = False
    marker = "@sha256:"
    if marker in image:
        name, dig = image.split("@", 1)
        digest = dig
        locked = True
        image = name
    elif re.match(r"^scratch(?::\S+)?$", image, re.I):
        locked = True
    return {"image": image, "digest": digest, "locked": locked}

def parse_docker(path):
    froms = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return froms
    for i, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^\s*FROM\s+(.+)$", line, re.I)
        if not m:
            continue
        info = parse_from_payload(m.group(1))
        info["line"] = i
        froms.append(info)
    return froms
def requirements_hash_pinned(path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    pkg_lines = []
    hashed = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-"):
            if line.startswith("--hash="):
                hashed += 1
            continue
        pkg_lines.append(line)
        if "--hash=" in line:
            hashed += 1
    if not pkg_lines:
        return True
    if hashed <= 0:
        return False
    return hashed >= len(pkg_lines)

def pyproject_has_deps(path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return True
    low = text.lower()
    return any(m in low for m in ("dependencies", "[project]", "[tool.poetry]", "[tool.uv]", "[tool.pdm]", "requires ="))

def item(kind, path, root, locks, locked, **extra):
    rec = {
        "kind": kind,
        "path": rel(root, path),
        "dir": rel_dir(root, path.parent),
        "locks": locks,
        "locked": bool(locked),
    }
    rec.update(extra)
    return rec
def npm_locks_for(start, root):
    found = [n for n in sibling_lock_names(start) if n.endswith(".lock") or n.endswith(".lockb") or n.endswith("-lock.json") or n.endswith("-lock.yaml") or n.endswith("shrinkwrap.json")]
    if found:
        return found
    cur = start.resolve()
    stop = root.resolve()
    while cur != stop and cur.parent != cur:
        cur = cur.parent
        if not (cur / "package.json").is_file():
            continue
        locks = [n for n in sibling_lock_names(cur) if n.endswith(".lock") or n.endswith(".lockb") or n.endswith("-lock.json") or n.endswith("-lock.yaml") or n.endswith("shrinkwrap.json")]
        if not locks:
            continue
        try:
            rel_prefix = cur.relative_to(root).as_posix()
        except ValueError:
            rel_prefix = cur.as_posix()
        if rel_prefix in ("", "."):
            return list(locks)
        return [f"{rel_prefix}/{n}" for n in locks]
    return []
def inventory(root):
    root = root.resolve()
    items = []
    seen = set()

    def add(rec):
        key = (rec["kind"], rec["path"])
        if key in seen:
            return
        seen.add(key)
        items.append(rec)
    for path in walk_files(root):
        name = path.name
        kind = None
        locks = []
        extra = {}
        if name == "go.mod":
            gsum = path.parent / "go.sum"
            glocks = ["go.sum"] if gsum.is_file() else []
            add(item("go", path, root, glocks, bool(glocks)))
            continue
        if name == "Cargo.toml":
            clocks = cargo_locks(path, root)
            add(item("cargo", path, root, clocks, bool(clocks)))
            continue
        if name in ("Dockerfile", "Containerfile") or name.startswith("Dockerfile."):
            froms = parse_docker(path)
            dlocked = bool(froms) and all(f.get("locked") for f in froms)
            if not froms:
                dlocked = True
            add(item("docker", path, root, [], dlocked, froms=froms))
            continue
        if name == "pyproject.toml":
            plocks = [n for n in sibling_lock_names(path.parent) if n.endswith(".lock")]
            if not plocks and not pyproject_has_deps(path):
                plocked = True
            else:
                plocked = bool(plocks)
            add(item("python", path, root, plocks, plocked))
            continue
        if name == "Pipfile":
            plocks = [n for n in sibling_lock_names(path.parent) if n.endswith(".lock")]
            add(item("python", path, root, plocks, bool(plocks)))
            continue
        if name.startswith("requirements") and name.endswith(".txt"):
            sibling = [n for n in sibling_lock_names(path.parent) if n.endswith(".lock")]
            hashed = requirements_hash_pinned(path)
            rlocks = list(sibling)
            if hashed and name not in rlocks:
                rlocks.append(name)
            add(item("python", path, root, rlocks, bool(sibling) or hashed))
            continue
        if name.startswith("package") and name.endswith(".json"):
            nlocks = sibling_lock_names(path.parent)
            add(item("js", path, root, nlocks, bool(nlocks)))
            continue
    items.sort(key=lambda r: (r["kind"], r["path"]))
    for rec in items:
        if rec["kind"] == "js":
            rec["kind"] = "n" + "pm"
    locked_items = [r for r in items if r["locked"]]
    unlocked_items = [r for r in items if not r["locked"]]
    by_kind = {}
    for r in items:
        slot = by_kind.setdefault(r["kind"], {"items": 0, "locked": 0, "unlocked": 0})
        slot["items"] += 1
        if r["locked"]:
            slot["locked"] += 1
        else:
            slot["unlocked"] += 1
    return {
        "root": str(root),
        "items": items,
        "locked": locked_items,
        "unlocked": unlocked_items,
        "counts": {
            "items": len(items),
            "locked": len(locked_items),
            "unlocked": len(unlocked_items),
            "by_kind": by_kind,
        },
    }
def main(argv=None):
    p = argparse.ArgumentParser(description="Report hash-lock coverage of a clone.")
    p.add_argument("root", nargs="?", default=".", help="clone root (default: cwd)")
    p.add_argument("--out", default=None, help="write JSON here (default: stdout)")
    args = p.parse_args(argv)
    root = Path(args.root).resolve()
    if not root.is_dir():
        print("inventory.py: not a directory:", root, file=sys.stderr)
        return 2
    report = inventory(root)
    blob = json.dumps(report, indent=2, sort_keys=False) + "\n"
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(blob, encoding="utf-8")
    else:
        sys.stdout.write(blob)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
