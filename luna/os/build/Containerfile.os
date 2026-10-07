# Toolchain for the Luna OS image: Alpine's apk (assembles the rootfs) plus
# mkfs.ext4 -d and xz (turn it into the slot image). Used by build/rootfs.sh
# and build/image.sh. Scripts inside never call podman.
# The base pin comes from lib/alpine-image.sh (passed as a build arg).
ARG ALPINE_IMAGE=docker.io/library/alpine:3.24
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache e2fsprogs xz tar curl ca-certificates
