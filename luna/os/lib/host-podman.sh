#!/bin/sh
# Host helpers for the dev wrappers (make-image.sh, build-rootfs.sh, make-iso.sh):
# rootless podman only, named-volume caches, a memory limit. The scripts under
# build/ do the real work inside containers and never call podman, so the
# release tool can run them directly without these helpers.
# Sourced; needs OSDIR (the luna/os directory) set by the caller.
# shellcheck shell=sh

LUNA_BUILD_MEMORY="${LUNA_BUILD_MEMORY:-3g}"
LUNA_ROOTFS_VOLUME="${LUNA_ROOTFS_VOLUME:-luna-os-rootfs}"
LUNA_CACHE_VOLUME="${LUNA_CACHE_VOLUME:-luna-os-cache}"
LUNA_ISO_CACHE_VOLUME="${LUNA_ISO_CACHE_VOLUME:-luna-iso-cache}"

luna_die() {
	echo "ERROR: $*" >&2
	exit 1
}

luna_need_podman() {
	command -v podman >/dev/null 2>&1 || luna_die "podman is required (rootless; no sudo is ever used)"
	[ "$(id -u)" -ne 0 ] || luna_die "run as your normal user: these builds are rootless"
}

# luna_build_image <name> <Containerfile> [build-arg ...]: build once per
# Containerfile content, print the image tag.
luna_build_image() {
	_name="$1"
	_cf="$2"
	shift 2
	_hash="$( { sha256sum <"$_cf"; printf '%s\n' "$@"; } | sha256sum | cut -c1-12)"
	_tag="localhost/luna-$_name:$_hash"
	if ! podman image exists "$_tag"; then
		_args=""
		for _a in "$@"; do _args="$_args --build-arg $_a"; done
		# shellcheck disable=SC2086
		podman build -q -t "$_tag" $_args -f "$_cf" "$(dirname "$_cf")" >/dev/null \
			|| luna_die "could not build the $_name build image"
	fi
	printf '%s\n' "$_tag"
}

# Input hash (see build/input-hash.sh) and the "is dist already current" test.
luna_os_input_hash() {
	sh "$OSDIR/build/input-hash.sh"
}

# luna_os_image_current <dist-dir>: 0 when dist already holds an .img.xz built
# from the current inputs (and LUNA_OS_FORCE is not set).
luna_os_image_current() {
	_dist="$1"
	_f="$_dist/luna-os-${ARCH:-x86_64}.img.xz"
	[ -z "${LUNA_OS_FORCE:-}" ] || return 1
	[ -s "$_f" ] && [ -s "$_f.sha256" ] && [ -s "$_f.inputs" ] || return 1
	[ "$(cat "$_f.inputs")" = "$(luna_os_input_hash)" ]
}
