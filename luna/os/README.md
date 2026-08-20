# Luna OS

Build pipeline for the Luna box's Alpine operating system.

Thin clients boot from **eMMC** (`/dev/mmcblk0`, first partition `mmcblk0p1`).
That chip stays in the box, so install from a USB **rapidinstall ISO** rather
than pulling a disk.

```sh
# 1. Build the musl daemon (host or inside Alpine):
#    cargo build --release --features ble -p lunad
#    or set LUNAD_BIN=/path/to/lunad

# 2. Rootfs (needs rootless podman)
./os/build-rootfs.sh                  # → os/dist/luna-rootfs-x86_64.tar.gz

# 3. Rapidinstall ISO (BIOS hybrid — `dd` to a USB stick)
./os/make-iso.sh                      # → os/dist/luna-rapidinstall-x86_64.iso
#    dd if=os/dist/luna-rapidinstall-x86_64.iso of=/dev/sdX bs=4M conv=fsync
#    Boot the thin client from that USB. The installer picks eMMC, asks you
#    to type  install luna  and never erases the USB stick.

# Optional: raw ext4 image (workstation / VM)
./os/make-image.sh                    # → os/dist/luna-os-x86_64.img

# Optional: flash a whole disk that is attached to this machine
# (SATA/NVMe on a bench — not the usual thin-client path)
./os/flash.sh /dev/sdX                # also accepts /dev/mmcblk0
```

Quick-start card addresses served by this image: `luna.local`, `http://luna`,
and direct-cable `http://169.254.42.42`.
