#!/usr/bin/env python3
"""Drop duplicate bodies from EuroOffice's generated web fonts.

allfontsgen writes fonts/NNN as a 32-byte header followed by the same bytes as
a TTF in core-fonts/. The OS image currently ships both copies. This script
records the header in fonts/aliases.json, removes the full duplicate, and lets
lunad rebuild the original bytes from core-fonts when the editor asks for NNN.

No served byte changes: the handler writes the recorded header followed by the
core-font body. Run from install-eurooffice-assets.sh after font generation.
"""

import base64
import hashlib
import json
import sys
from pathlib import Path


def body(data):
    return data[32:]


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: dedupe-office-fonts.py <eurooffice pack dir>")

    root = Path(sys.argv[1])
    fonts = root / "fonts"
    core = root / "core-fonts"
    if not fonts.is_dir() or not core.is_dir():
        raise SystemExit(f"missing fonts/ or core-fonts/ under {root}")

    # Index core fonts by their body. Two files with the same body are
    # interchangeable for this purpose, so keeping the first is fine.
    bodies = {}
    for path in core.rglob("*"):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if len(data) <= 32:
            continue
        digest = hashlib.sha256(body(data)).digest()
        bodies.setdefault((len(data), digest), path.relative_to(root).as_posix())

    aliases = {}
    removed = 0
    for path in sorted(fonts.iterdir()):
        if not path.is_file() or not path.name.isdigit():
            continue
        data = path.read_bytes()
        if len(data) <= 32:
            continue
        key = (len(data), hashlib.sha256(body(data)).digest())
        source = bodies.get(key)
        if source is None:
            continue
        aliases[path.name] = {
            "src": source,
            "head": base64.b64encode(data[:32]).decode("ascii"),
        }
        path.unlink()
        removed += len(data)

    manifest = fonts / "aliases.json"
    if aliases:
        manifest.write_text(
            json.dumps(
                {"version": 1, "fonts": aliases},
                sort_keys=True,
                separators=(",", ":"),
            )
            + "\n",
            encoding="utf-8",
        )
    else:
        manifest.unlink(missing_ok=True)

    print(
        f"font dedup: {len(aliases)} aliases, {removed} bytes of duplicate bodies removed"
    )


if __name__ == "__main__":
    main()
