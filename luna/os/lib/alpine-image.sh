# Shared Alpine container pin for OS image builds.
# Sourced by build-rootfs.sh, make-image.sh, and make-iso.sh.
# shellcheck shell=sh
ALPINE_IMAGE="${ALPINE_IMAGE:-docker.io/library/alpine:3.24}"
case "$ALPINE_IMAGE" in
*:latest)
	echo "ALPINE_IMAGE must be pinned (e.g. alpine:3.24), got $ALPINE_IMAGE" >&2
	exit 1
	;;
esac
