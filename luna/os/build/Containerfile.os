# Toolchain for the Luna OS image: Alpine's apk (assembles the rootfs) plus
# mkfs.ext4 -d and xz (turn it into the slot image). Used by build/rootfs.sh
# and build/image.sh. Scripts inside never call podman.
# The base pin comes from lib/alpine-image.sh (passed as a build arg).
# alpine:3.24, pinned by digest. The release tool builds this image without
# build arguments, so this default is the pin (lib/alpine-image.sh must match).
ARG ALPINE_IMAGE=docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6

# The kernel stage. build/kernel-build.sh starts from Alpine's linux-lts config
# and switches the common boot storage path to built-in. The result lands in
# /kout; 06.frag builds a storage-only initramfs for the remaining root-disk
# controllers before trimming runtime modules.
# Built on Debian, not Alpine: the kernel's own build tools (scripts/config,
# objtool) are bash and glibc programs and want the headers Alpine leaves out.
# Only a kernel and its modules come out of this stage, so the build host's
# libc never reaches the image.
# debian:bookworm, pinned by digest (the release tool builds this image
# without build arguments, so this default is the pin).
ARG DEBIAN_IMAGE=docker.io/library/debian@sha256:2c037a04925515fdd6ea85ea14a682d0e79931f5e9f5d07b6dbfc6ba12f9e858

# Alpine's own kernel config, which the build starts from. The install trigger
# would build an initramfs this stage cannot build, so a trigger error is fine:
# only the config file in /boot is wanted.
FROM ${ALPINE_IMAGE} AS kconfig
RUN apk add --no-cache linux-lts >/dev/null 2>&1 || true

FROM ${DEBIAN_IMAGE} AS kernel
# KERNEL_RECIPE only busts the cache: this image is built once per Containerfile
# hash, so without it an edited kernel-build.sh would keep the old kernel.
ARG KERNEL_RECIPE=dev
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential bc bison flex libelf-dev libssl-dev perl xz-utils curl \
      kmod ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=kconfig /boot/ /alpine-boot/
COPY kernel-build.sh /kernel-build.sh
RUN echo "kernel recipe $KERNEL_RECIPE" && sh /kernel-build.sh

FROM ${ALPINE_IMAGE}
# g++ and onnxruntime-dev build luna-clip (os/clip), photo search's model
# runner, against the same Alpine ONNX Runtime the image ships.
# kmod trims the rootfs (lib/build-rootfs.d/06.frag): depmod rewrites the module
# index after the pruned drivers are gone.
RUN apk add --no-cache e2fsprogs xz tar curl ca-certificates zstd g++ onnxruntime-dev \
	kmod
COPY --from=kernel /out/vmlinuz-lts /kout/vmlinuz-lts
COPY --from=kernel /out/modules /kout/modules
