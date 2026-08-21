# Luna OS

Build pipeline for the Luna box's Alpine operating system.

The rapidinstall ISO and the flashed disk target **ordinary x86_64 PCs**:
BIOS or UEFI, SATA / NVMe / eMMC. First hardware bring-up is a mini PC;
thin clients (Wyse 3040) use the same image. The live USB and the installed
disk both boot in either firmware mode.

```sh
# 1. Build the musl daemon (host or inside Alpine):
#    cargo build --release -p lunad
#    or set LUNAD_BIN=/path/to/lunad

# 2. Rootfs (needs Podman)
./os/build-rootfs.sh                  # → os/dist/luna-rootfs-x86_64.tar.gz

# 3. Rapidinstall ISO (`dd` to a USB stick)
#    One-shot (web UI + musl lunad + rootfs + ISO):
./os/build-iso.sh                     # → os/dist/luna-rapidinstall-x86_64.iso
#    Or after a rootfs already exists:
./os/make-iso.sh                      # → os/dist/luna-rapidinstall-x86_64.iso
#    dd if=os/dist/luna-rapidinstall-x86_64.iso of=/dev/sdX bs=4M conv=fsync
#    Boot the PC from that USB (BIOS or UEFI; turn Secure Boot off).
#    GRUB should load Linux on its own. You should see "Luna rapidinstall"
#    and be asked to type  install luna  — not a grub> prompt.
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

## Photo previews (HEIC)

Phone backups are often HEIC. The daemon stays a musl Rust binary and does **not**
link `libheif`. The OS image installs Alpine `libheif` + `libheif-tools`
(`heif-dec` / `heif-convert`) so Luna can make JPEG previews. Capture dates are
read from EXIF inside the file (JPEG APP1 or the HEIF `Exif` item). Originals
are never rewritten.

If you build a custom rootfs without those packages, HEIC files still appear in
the gallery when they have EXIF, but previews stay empty until `heif-dec` is
installed.

## Software updates (no re-flash)

Lunad looks at Forgejo tags that start with `luna-v` (for example `luna-v0.2.0`)
on `LibreLoom/LibreServ`. LibreServ releases stay on `v*` (for example `v0.0.13`)
and are ignored by the Luna updater. Release assets:

- `lunad-linux-amd64` (or `lunad-linux-arm64`)
- `luna-rapidinstall-x86_64.iso` on OS cuts
- `SHA256SUMS.txt` (required — install refuses a missing or mismatched checksum)

An admin taps **Install update** in Settings. That replaces `/usr/local/bin/lunad`
and exits so OpenRC restarts the daemon. A new OS image is only needed for a
full re-flash, not for ordinary lunad updates.

Env overrides: `LUNA_UPDATES_API`, `LUNA_UPDATES_OWNER`, `LUNA_UPDATES_REPO`.
