#!/bin/sh
# Static + optional live checks that Luna OS musl binaries stay static-pie.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
OS="$ROOT/os"
fail=0

assert_file_has() {
	_f="$1"
	_pat="$2"
	_msg="$3"
	if ! grep -q "$_pat" "$_f"; then
		echo "FAIL $_msg (missing '$_pat' in $_f)" >&2
		fail=$((fail + 1))
	fi
}

assert_file_lacks() {
	_f="$1"
	_pat="$2"
	_msg="$3"
	if grep -q "$_pat" "$_f"; then
		echo "FAIL $_msg (found '$_pat' in $_f)" >&2
		fail=$((fail + 1))
	fi
}

assert_file_has "$OS/lib/musl-link.sh" 'link-arg=-static-pie' "musl-gcc path must pass -static-pie to the gcc driver"
assert_file_has "$OS/lib/musl-link.sh" 'link-self-contained=yes' "musl link must use rustc self-contained crt"
assert_file_has "$OS/lib/musl-link.sh" 'PT_INTERP' "musl link helper must document the INTERP/rcrt1 crash"
assert_file_has "$OS/lib/musl-link.sh" 'rust-lld' "musl link must prefer rust-lld over musl-gcc"
assert_file_has "$OS/build-iso.sh" 'os/lib/musl-link.sh' "ISO build must source musl-link.sh"
assert_file_has "$OS/build-iso.sh" 'luna_musl_export' "ISO build must export static-pie flags"
assert_file_has "$OS/build-iso.sh" 'luna_musl_smoke_lunad' "ISO build must smoke-test musl lunad"
assert_file_has "$OS/build-iso.sh" 'luna_musl_smoke_console' "ISO build must smoke-test musl luna-console"
assert_file_lacks "$OS/build-iso.sh" 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc' \
	"ISO build must not set musl-gcc as linker without static-pie helpers"
assert_file_lacks "$ROOT/../release.sh" 'segfaults on generic' \
	"release.sh must not claim musl lunad only crashes on glibc hosts"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/musl-binaries_test.sh ok"
