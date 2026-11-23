#!/usr/bin/env python3
"""Synthetic round-trip for dedupe-office-fonts.py."""

import base64
import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("dedupe-office-fonts.py")


class DedupeTest(unittest.TestCase):
    def test_manifest_round_trips_the_masked_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            core = root / "core-fonts"
            fonts = root / "fonts"
            core.mkdir()
            fonts.mkdir()

            source = bytes(range(96))
            generated = bytearray(source)
            for i in range(32):
                generated[i] ^= 0xA5
            (core / "real.ttf").write_bytes(source)
            (fonts / "024").write_bytes(generated)
            # A font with no core-font twin stays in place.
            (fonts / "099").write_bytes(b"unique" * 16)

            proc = subprocess.run(
                [sys.executable, str(SCRIPT), str(root)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("1 aliases", proc.stdout)

            manifest = json.loads((fonts / "aliases.json").read_text())
            alias = manifest["fonts"]["024"]
            self.assertEqual(alias["src"], "core-fonts/real.ttf")
            self.assertEqual(
                base64.b64decode(alias["head"]), bytes(generated[:32])
            )
            self.assertEqual(alias["sha256"], hashlib.sha256(bytes(generated)).hexdigest())
            self.assertFalse((fonts / "024").exists())
            self.assertTrue((fonts / "099").exists())

            rebuilt = base64.b64decode(alias["head"]) + source[32:]
            self.assertEqual(rebuilt, bytes(generated))
            self.assertEqual(hashlib.sha256(rebuilt).digest(), hashlib.sha256(bytes(generated)).digest())

    def test_second_run_keeps_the_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            core = root / "core-fonts"
            fonts = root / "fonts"
            core.mkdir()
            fonts.mkdir()
            source = bytes(range(96))
            generated = bytearray(source)
            for i in range(32):
                generated[i] ^= 0xA5
            (core / "real.ttf").write_bytes(source)
            (fonts / "024").write_bytes(generated)

            first = subprocess.run(
                [sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            manifest = (fonts / "aliases.json").read_bytes()
            second = subprocess.run(
                [sys.executable, str(SCRIPT), str(root)], capture_output=True, text=True
            )
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertIn("already deduped", second.stdout)
            self.assertEqual((fonts / "aliases.json").read_bytes(), manifest)

    def test_no_aliases_fails_the_pack_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "core-fonts").mkdir()
            (root / "fonts").mkdir()
            (root / "fonts" / "024").write_bytes(b"not a font" * 8)
            proc = subprocess.run(
                [sys.executable, str(SCRIPT), str(root)],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("no aliases", proc.stderr)


if __name__ == "__main__":
    unittest.main()
