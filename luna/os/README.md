# Luna OS

Build pipeline for the Luna box's Alpine operating system.

```sh
# 1. Build the musl daemon (host or inside Alpine):
#    cargo build --release --features ble -p lunad
#    or set LUNAD_BIN=/path/to/lunad

# 2. Rootfs (needs rootless podman)
./os/build-rootfs.sh                  # → os/dist/luna-rootfs-x86_64.tar.gz

# 3. Raw ext4 image
./os/make-image.sh                    # → os/dist/luna-os-x86_64.img

# 4. Flash a whole disk (NEVER a partition)
./os/flash.sh /dev/sdX
```

Quick-start card addresses served by this image: `luna.local`, `http://luna`,
and direct-cable `http://169.254.42.42`.
