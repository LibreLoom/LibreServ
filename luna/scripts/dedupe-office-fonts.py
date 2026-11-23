#!/usr/bin/env python3
"""Drop duplicate bodies from EuroOffice's generated web fonts.

allfontsgen copies a source TTF from core-fonts/ into fonts/NNN byte-for-byte,
then XOR-masks its first min(32, size) bytes in place (the correct16 mask).
Both files have the same length; only bytes 0..32 differ. The image used to
ship both copies. This script records the masked bytes in fonts/aliases.json,
removes the generated copy, and lets lunad rebuild the original bytes from
core-fonts when the editor asks for NNN.

No served byte changes: the handler writes the recorded masked bytes followed
by the core-font tail. Run from install-eurooffice-assets.sh after generation.
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
            # Hash of the exact bytes lunad will serve. Lets a 304 answer
            # without reading the core font on every editor open.
            "sha256": hashlib.sha256(data).hexdigest(),
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
    elif manifest.is_file():
        # Already deduped means the generated copies are gone and the manifest
        # is the record of them. A leftover digit-named font means this run
        # simply failed to match, so keep the hard failure instead of silently
        # shipping the duplicates with a manifest that may be stale.
        leftover = [p.name for p in fonts.iterdir() if p.is_file() and p.name.isdigit()]
        if leftover:
            raise SystemExit(
                f"font dedup found no aliases but {len(leftover)} generated fonts "
                f"remain (for example {leftover[0]}): check fonts/ and core-fonts/."
            )
        print("font dedup: already deduped, keeping existing aliases.json")
        return
    else:
        raise SystemExit(
            "font dedup found no aliases: the pack would ship the duplicate "
            "font bodies again. Check the generated fonts/ and core-fonts/ trees."
        )

    print(
        f"font dedup: {len(aliases)} aliases, {removed} bytes of duplicate bodies removed"
    )


if __name__ == "__main__":
    main()
