# Luna OS

Build pipeline for the Luna box's Alpine operating system.

Batch 1 target is a **Dell Wyse 3040**: UEFI, OS on **eMMC** (`/dev/mmcblk0`,
ESP `p1` + Luna root `p2`). That chip stays in the box, so install from a USB
**rapidinstall ISO**.

```sh
# 1. Build the musl daemon (host or inside Alpine):
#    cargo build --release --features ble -p lunad
#    or set LUNAD_BIN=/path/to/lunad

# 2. Rootfs (needs Podman)
./os/build-rootfs.sh                  # → os/dist/luna-rootfs-x86_64.tar.gz

# 3. Rapidinstall ISO (UEFI + BIOS hybrid — `dd` to a USB stick)
./os/make-iso.sh                      # → os/dist/luna-rapidinstall-x86_64.iso
#    dd if=os/dist/luna-rapidinstall-x86_64.iso of=/dev/sdX bs=4M conv=fsync
#    Boot the Wyse 3040 from that USB (UEFI). The installer picks eMMC, asks
#    you to type  install luna  and never erases the USB stick.

# Optional: raw ext4 image (workstation / VM — not the 3040 path)
./os/make-image.sh                    # → os/dist/luna-os-x86_64.img

# Optional: flash a whole disk attached to this machine
./os/flash.sh /dev/sdX                # also accepts /dev/mmcblk0
```

Quick-start card addresses served by this image: `luna.local`, `http://luna`,
and direct-cable `http://169.254.42.42`.
