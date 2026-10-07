# Toolchain for the Luna OS image: Alpine's apk (assembles the rootfs) plus
# mkfs.ext4 -d and xz (turn it into the slot image). Used by build/rootfs.sh
# and build/image.sh. Scripts inside never call podman.
# The base pin comes from lib/alpine-image.sh (passed as a build arg).
# alpine:3.24, pinned by digest. The release tool builds this image without
# build arguments, so this default is the pin (lib/alpine-image.sh must match).
ARG ALPINE_IMAGE=docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache e2fsprogs xz tar curl ca-certificates
