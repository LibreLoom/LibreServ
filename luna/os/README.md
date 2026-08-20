# Luna OS

Build pipeline for the Luna box's Alpine operating system.

The rapidinstall ISO and the flashed disk target **ordinary x86_64 PCs**:
BIOS or UEFI, SATA / NVMe / eMMC. First hardware bring-up is a mini PC;
thin clients (Wyse 3040) use the same image. The live USB and the installed
disk both boot in either firmware mode.

```sh
# 1. Build the musl daemon (host or inside Alpine):
#    cargo build --release --features ble -p lunad
#    or set LUNAD_BIN=/path/to/lunad

# 2. Rootfs (needs Podman)
./os/build-rootfs.sh                  # → os/dist/luna-rootfs-x86_64.tar.gz

# 3. Rapidinstall ISO (`dd` to a USB stick)
./os/make-iso.sh                      # → os/dist/luna-rapidinstall-x86_64.iso
#    dd if=os/dist/luna-rapidinstall-x86_64.iso of=/dev/sdX bs=4M conv=fsync
#    Boot the PC from that USB (BIOS or UEFI; turn Secure Boot off).
#    The installer picks built-in storage, asks you to type  install luna
#    and never erases the USB stick.

# Optional: raw ext4 image (workstation / VM)
./os/make-image.sh                    # → os/dist/luna-os-x86_64.img

# Optional: flash a whole disk attached to this machine
./os/flash.sh /dev/sdX                # also /dev/nvme0n1 /dev/mmcblk0
```

Installed layout (GPT): 1 MiB BIOS GRUB partition, EFI System partition,
then Luna root (`LABEL=LUNA`). GRUB is installed for `i386-pc` and
`x86_64-efi`.

This kernel is Alpine 3.24 **x86_64** (x86-64-v2). 32-bit-only PCs and very
old 64-bit CPUs without SSE4.2 are a later ISO, not this one.

Quick-start card addresses: `luna.local`, `http://luna`,
and direct-cable `http://169.254.42.42`.
