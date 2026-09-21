#!/bin/sh
# Musl link flags for lunad / luna-console baked into Luna OS.
#
# rustc's self-contained musl target uses rcrt1 (self-relocating CRT). If the
# linker also emits PT_INTERP (/lib/ld-musl-x86_64.so.1) — musl-gcc's default
# dynamic crt — the image is relocated twice, writes a non-canonical pointer,
# and SIGSEGVs in _start_c before main. That is the .36/.37 ISO crash: OpenRC
# looks frozen because luna + luna-console never stay up.
#
# Force crt-static + static-pie so rcrt1 is self-consistent. Prefer rust-lld
# over musl-gcc so we never pick up a dynamic INTERP by accident.

luna_musl_target_env() {
	printf '%s' "$1" | tr 'abcdefghijklmnopqrstuvwxyz-' 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'
}

luna_musl_find_lld() {
	if command -v rust-lld >/dev/null 2>&1; then
		command -v rust-lld
		return 0
	fi
	_sysroot="$(rustc --print sysroot 2>/dev/null || true)"
	_host="$(rustc -vV 2>/dev/null | awk '/^host:/{print $2}')"
	if [ -n "$_sysroot" ] && [ -n "$_host" ] && [ -x "$_sysroot/lib/rustlib/${_host}/bin/rust-lld" ]; then
		printf '%s\n' "$_sysroot/lib/rustlib/${_host}/bin/rust-lld"
		return 0
	fi
	return 1
}

luna_musl_export() {
	_target="${1:-x86_64-unknown-linux-musl}"
	_flags="-C target-feature=+crt-static -C link-self-contained=yes"
	_env="$(luna_musl_target_env "$_target")"
	_lld="$(luna_musl_find_lld || true)"
	if [ -n "$_lld" ]; then
		export "CARGO_TARGET_${_env}_LINKER=${_lld}"
	elif command -v musl-gcc >/dev/null 2>&1; then
		# gcc driver flag; rust-lld does not accept -static-pie.
		_flags="${_flags} -C link-arg=-static-pie"
		_cc_env="$(printf '%s' "$_target" | tr '-' '_')"
		export "CC_${_cc_env}=musl-gcc"
		export "CARGO_TARGET_${_env}_LINKER=musl-gcc"
	fi
	# Target-scoped. Global RUSTFLAGS=+crt-static makes rustc refuse
	# proc-macros on the host gnu target (desktop GTK CI).
	_tf="CARGO_TARGET_${_env}_RUSTFLAGS"
	eval "_prev=\${${_tf}:-}"
	if [ -n "$_prev" ]; then
		export "${_tf}=${_prev} ${_flags}"
	else
		export "${_tf}=${_flags}"
	fi
}

luna_musl_assert_static_pie() {
	_bin="$1"
	if [ ! -x "$_bin" ]; then
		echo "missing executable $_bin" >&2
		return 1
	fi
	if command -v readelf >/dev/null 2>&1; then
		if readelf -l "$_bin" | grep -q 'INTERP'; then
			echo "FAIL: $_bin has PT_INTERP (dynamic musl + rcrt1 crashes in _start_c)" >&2
			return 1
		fi
	fi
	if command -v file >/dev/null 2>&1; then
		_desc="$(file "$_bin")"
		case "$_desc" in
		*static-pie* | *statically\ linked*) ;;
		*)
			echo "FAIL: $_bin is not static-pie ($_desc)" >&2
			return 1
			;;
		esac
	fi
	return 0
}

# lunad --help must exit 0 inside Alpine (the OS the ISO installs).
luna_musl_smoke_lunad() {
	_bin="$1"
	luna_musl_assert_static_pie "$_bin" || return 1
	_dir="$(CDPATH= cd -- "$(dirname "$_bin")" && pwd)"
	_base="$(basename "$_bin")"
	if command -v podman >/dev/null 2>&1; then
		podman run --rm --network=none -v "${_dir}:/w:z" alpine:3.24 "/w/${_base}" --help >/dev/null
		return $?
	fi
	"$_bin" --help >/dev/null
}

# luna-console has no --help and wants a tty. A mislinked binary SIGSEGVs
# immediately (139); a good one fails on /dev/tty1 (1) or is killed by timeout.
luna_musl_smoke_console() {
	_bin="$1"
	luna_musl_assert_static_pie "$_bin" || return 1
	_dir="$(CDPATH= cd -- "$(dirname "$_bin")" && pwd)"
	_base="$(basename "$_bin")"
	_rc=0
	if command -v podman >/dev/null 2>&1; then
		podman run --rm --network=none -v "${_dir}:/w:z" alpine:3.24 \
			timeout 1 "/w/${_base}" >/dev/null 2>&1 || _rc=$?
	else
		timeout 1 "$_bin" >/dev/null 2>&1 || _rc=$?
	fi
	# 139 SIGSEGV, 132 SIGILL — the rcrt1/PT_INTERP crash.
	if [ "$_rc" -eq 139 ] || [ "$_rc" -eq 132 ]; then
		echo "FAIL: $_bin crashed (exit $_rc) — not a static-pie musl binary" >&2
		return 1
	fi
	return 0
}
