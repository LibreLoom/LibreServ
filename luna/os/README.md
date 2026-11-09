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

# 2. Editor packs, then the OS image (rootless Podman, no sudo). The packs are
#    part of the image, so they must exist before the rootfs is built:
make eurooffice-pack drawio-pack        # → os/dist/*-pack.tar.zst
#    The rootfs lives in a podman volume; ownership is right inside the user
#    namespace and nothing runs as root.
./os/build-rootfs.sh                  # rootfs → volume luna-os-rootfs
./os/make-image.sh                    # → os/dist/luna-os-x86_64.img.xz (+ .sha256)
#    The .img.xz is compressed once. The OTA update part, the installer ISO and
#    the box's os-image.sha256 all use these exact bytes. Skipped when the OS
#    inputs did not change (os/build/input-hash.sh). LUNA_OS_FORCE=1 rebuilds
#    anyway — and a changed lunad always needs one, because the daemon is
#    inside the image.

# 3. Rapidinstall ISO (`dd` to a USB stick), rootless, no live-build
#    Debian live (mmdebstrap + squashfs + grub-mkrescue) boots the installer
#    (keyboard, NVMe, firmware); it streams the .img.xz to both OS slots.
#    One-shot (web UI + musl lunad + rootfs + image + ISO):
./os/build-iso.sh                     # → os/dist/luna-rapidinstall-x86_64.iso
#    Or after the image already exists:
./os/make-iso.sh                      # → os/dist/luna-rapidinstall-x86_64.iso
#    dd if=os/dist/luna-rapidinstall-x86_64.iso of=/dev/sdX bs=4M conv=fsync
#    Boot the PC from that USB (BIOS or UEFI; turn Secure Boot off).
#    GRUB should load Linux on its own. You should see "Luna rapidinstall"
#    — not a grub> prompt.
#    The installer picks the smallest non-USB disk and waits 5s
#    (press a key to pick another disk from a numbered list). After the
#    disk is chosen you must type INSTALL and press Enter; anything else
#    shuts the machine down. It never erases the USB stick.
#    QEMU automation: add LUNA_CONFIRM=INSTALL on the kernel cmdline.
#
#    Factory OEM: the hybrid image includes a writable FAT partition labeled
#    LUNAASSETS (256 MiB). Mount it after dd and put one official device token
#    (purchased-from-LibreLoom path) per line in a file named TOKENS. Each flash peels the first line onto the
#    unit as /var/lib/luna/device-token and rewrites the magazine. Later factory
#    assets (device photos, etc.) also belong on LUNAASSETS. A one-shot
#    device-token file next to the ISO payload still works for a single unit
#    (the old setup-token name is still accepted as a legacy fallback).

# Optional: flash a whole disk attached to this machine
./os/flash.sh /dev/sdX                # also /dev/nvme0n1 /dev/mmcblk0
```

## Build steps and the release tool

Every build step is an in-container script under `build/` plus a Containerfile;
none of them calls podman or sudo, so the release engine runs them directly in
its own job containers. `os/*.sh` wrappers are for dev use only (rootless
podman, named-volume caches, `--memory` limit via `LUNA_BUILD_MEMORY`).

| Step | Script (inside) | Container | In | Out |
|---|---|---|---|---|
| rootfs | `build/rootfs.sh` | `build/Containerfile.os` | `/luna/os` (ro), `LUNAD_BIN`, `LUNA_CONSOLE_BIN`, `/in/packs`, optional `LUNA_CACHE_DIR` | tree at `/rootfs` (volume) |
| image | `build/image.sh` | `build/Containerfile.os` | `/rootfs`, `/luna/os` | `/out/luna-os-x86_64.img.xz` + `.sha256` |
| ISO | `build/iso.sh` | `build/Containerfile.iso` | `/luna/os`, `/payload` (the `.img.xz`), optional `/cache` | `/out/luna-rapidinstall-x86_64.iso` |

`build/input-hash.sh` prints the OS input hash (rootfs scripts, pins, slot
size). A box records the sha256 of the exact `.img.xz` as `os-image.sha256`,
which is what the update feed lists for the `os` part.

## End-to-end test (QEMU, rootless)

`iso/e2e.sh` installs the ISO onto virtual disks and drives the installed Luna
like a person would: real BIOS/UEFI firmware, SATA / NVMe / eMMC / virtio disks,
USB sticks plugged and pulled, the setup wizard, files, sharing, WebDAV, photos,
signed OS updates with rollbacks, power cuts and a missing cable. Everything runs
in one podman container; nothing is installed on the host and nothing needs root.

```sh
./os/iso/e2e.sh --list               # stages
./os/iso/e2e.sh                      # the default set (a few hours)
./os/iso/e2e.sh boot flow            # just these
./os/iso/e2e.sh lab                  # boot, set up, and wait so you can poke at it
```

It needs a current ISO and slot image. Everything the system runs — lunad,
luna-console, cloudflared, the editor packs — is inside the slot image, so after
changing any of it rebuild with `LUNA_OS_FORCE=1 ./os/make-image.sh` (the install
stage fails loudly if the lunad inside the image is not the one just built).
Work files and logs go to `os/dist/e2e/` (several GiB, sparse); the guest's serial
log is `<name>.serial.log`. For the checks only, the harness gives the installed
disk a serial console and a root shell on it and points Connect at the mock in
`scripts/mocks/`; the shipped image is not changed. What it cannot cover: mDNS
(`luna.local`) over QEMU's user network, real Luna Connect and tunnels, SMART on
real disks, a real keyboard and HDMI screen, Secure Boot, and hardware quirks.

Dev checks without installing QEMU: `iso/boot-test.sh bios|uefi` (boots the ISO
as a USB stick and saves the screen) and `iso/install-test.sh` (runs the whole
installer into a virtual disk, then boots the result).

Installed layout (GPT): 1 MiB BIOS GRUB, EFI System partition (`LUNAESP`),
OS slot A (`LUNA_A`), OS slot B (`LUNA_B`), and data (`LUNA_DATA` at
`/var/lib/luna`). GRUB tryboot selects the slot; a failed boot rolls back.
GRUB is installed for `i386-pc` and `x86_64-efi`.

This kernel is Alpine 3.24 **x86_64** (x86-64-v2) on the **installed** system. The
rapidinstall USB boots a pinned **Debian 12 live** image for reliable hardware
support, then flashes the Alpine OS slots above.

Quick-start: Plug the included RJ45 (ethernet) cable from Luna into your router or modem.
Open the address shown on Luna's screen, or try `luna.local`.

## Photo library

Photos lives under each data drive — never on the OS eMMC:

- `{drive}/.luna-<uuid>.sqlite3` — drive marker + microdb: index, favorites, albums (sharing lives in the central `luna.db` as access members/links)
- `{drive}/.luna-<uuid>-thumbs/` — JPEG previews
- `{drive}/.luna-<uuid>-shared-albums/{id}/` — uploads into shared albums

Phone backups are often HEIC. The daemon stays a musl Rust binary and does **not**
link `libheif`. The OS image installs Alpine `libheif` + `libheif-tools`
(`heif-dec` / `heif-convert`) so Luna can make JPEG previews. Capture dates and
GPS (for Places) are read from EXIF inside the file. Originals are never rewritten.

Video previews use optional `ffmpeg` when present (same pattern as `heif-dec`).
Without it, videos still appear in the gallery with a play badge and empty preview.

If you build a custom rootfs without those packages, HEIC/video files still appear
in the gallery when indexed, but previews stay empty until the tools are installed.

Places uses Leaflet in the browser with OpenStreetMap tiles (fetched by the
client). Luna does not store map tiles on disk.


## Software updates

Lunad reads a **signed release feed** for the `luna` unit at
`https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds/luna/<channel>.json`
(stable or beta) plus a matching `.json.minisig`, verified against the minisign
public key embedded at build time from `keys/luna.minisign.pub`. The feed
lists the files in the Forgejo generic package registry; Luna checks each one's
size and sha256 before use. A missing feed means nothing is published yet.

- `os` — `luna-os-x86_64.img.xz`, the whole system: lunad, luna-console,
  cloudflared and the editor packs are all inside it
- `installer` — `luna-rapidinstall-x86_64.iso.xz`, the factory ISO

Every release ships both. Nothing is reused from an earlier version, because
the image *is* the product.

An admin taps **Install update** in Settings. When the feed's `os` part has a
sha256 that differs from `/var/lib/luna/os-image.sha256`, that tap writes the
image to the inactive OS slot and reboots into it (GRUB tryboot; a bad boot
falls back). There is no separate software update: a new daemon is a new image.
Settings does not split “software” vs “system”. A missing or wrong signature
installs nothing.

**The data partition holds data only.** No daemon, no cloudflared, no editor
packs: those are program files and they live in the image, replaced as a whole
by an OS update. A binary that never changes is not data.

Env overrides `LUNA_UPDATES_FEED` and `LUNA_UPDATES_CHANNEL` seed the defaults.
An admin can instead set the feed address, channel, and trusted minisign keys in
Settings → About → Advanced; that choice is stored in Luna's database, survives
reboots, and wins over the env vars. Changing the keys without a matching signer
breaks updates — the updater refuses a feed that no longer verifies against the
configured keys.
