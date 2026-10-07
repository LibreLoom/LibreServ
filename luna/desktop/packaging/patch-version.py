#!/usr/bin/env python3
"""Write a version into the version slot of a finished Luna Desktop binary.

usage: patch-version.py <binary> <version>

The app's version is not compiled in for release builds (see update.rs): the
slot is a marker followed by 64 NUL bytes. Run on the copy that ships, never
on the cached build output.
"""
import sys

MARK = b"LUNA-DESKTOP-VERSION-V1:"

path, version = sys.argv[1], sys.argv[2].encode()
if not 0 < len(version) <= 64 or b"\0" in version:
    sys.exit("version does not fit the 64-byte slot: %r" % version)
data = bytearray(open(path, "rb").read())
if data.count(MARK) != 1:
    sys.exit("%s has %d version slots, expected 1" % (path, data.count(MARK)))
at = data.index(MARK) + len(MARK)
if any(data[at:at + 64]):
    sys.exit("the version slot is not empty: the build was not a patch build")
data[at:at + len(version)] = version
open(path, "wb").write(data)
