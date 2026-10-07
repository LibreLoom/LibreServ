# Shared Alpine container pin for OS image builds.
# Sourced by build-rootfs.sh, make-image.sh, and make-iso.sh.
# shellcheck shell=sh
# alpine:3.24, pinned by digest (keep in step with build/Containerfile.os).
ALPINE_IMAGE="${ALPINE_IMAGE:-docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6}"
case "$ALPINE_IMAGE" in
*:latest)
	echo "ALPINE_IMAGE must be pinned (by digest), got $ALPINE_IMAGE" >&2
	exit 1
	;;
esac
