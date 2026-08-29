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
#    Debian live boots the installer (keyboard, NVMe, firmware); it writes the
#    Alpine Luna rootfs to built-in storage.
#    One-shot (web UI + musl lunad + rootfs + ISO):
./os/build-iso.sh                     # → os/dist/luna-rapidinstall-x86_64.iso
#    Or after a rootfs already exists:
./os/make-iso.sh                      # → os/dist/luna-rapidinstall-x86_64.iso
#    If live-build fails with "umount: chroot/proc: target is busy" (common when
#    an IDE indexer holds fds under the repo), rebuild with:
#    LUNA_LIVE_WORK=/var/tmp/luna-debian-live ./os/make-iso.sh
#    dd if=os/dist/luna-rapidinstall-x86_64.iso of=/dev/sdX bs=4M conv=fsync
#    Boot the PC from that USB (BIOS or UEFI; turn Secure Boot off).
#    GRUB should load Linux on its own. You should see "Luna rapidinstall"
#    — not a grub> prompt.
#    The installer picks the smallest non-USB disk and starts after 5s
#    (press a key to pick another disk from a numbered list). It never
#    erases the USB stick.
#
#    Factory OEM: the hybrid image includes a writable FAT partition labeled
#    LUNAASSETS (256 MiB). Mount it after dd and put one official setup code
#    (purchased-from-LibreLoom path) per line in a file named TOKENS. Each flash peels the first line onto the
#    unit as /var/lib/luna/setup-token and rewrites the magazine. Later factory
#    assets (device photos, etc.) also belong on LUNAASSETS. A one-shot
#    setup-token file next to the ISO payload still works for a single unit.

# Optional: raw ext4 image (workstation / VM)
./os/make-image.sh                    # → os/dist/luna-os-x86_64.img

# Optional: flash a whole disk attached to this machine
./os/flash.sh /dev/sdX                # also /dev/nvme0n1 /dev/mmcblk0
```

Installed layout (GPT): 1 MiB BIOS GRUB, EFI System partition (`LUNAESP`),
OS slot A (`LUNA_A`), OS slot B (`LUNA_B`), and data (`LUNA_DATA` at
`/var/lib/luna`). GRUB tryboot selects the slot; a failed boot rolls back.
GRUB is installed for `i386-pc` and `x86_64-efi`.

This kernel is Alpine 3.24 **x86_64** (x86-64-v2) on the **installed** system. The
rapidinstall USB boots a pinned **Debian 12 live** image for reliable hardware
support, then flashes the Alpine OS slots above.

Quick-start: Plug the included RJ45 (ethernet) cable from Luna into your router or modem. Phone stays
on home internet. Open the address shown on Luna's screen, or try `luna.local`.

## Photo library

Photos lives under each data drive — never on the OS eMMC:

- `{drive}/.lunagallery/gallery.sqlite` — index, favorites, albums, invites
- `{drive}/.lunathumbs/` — JPEG previews
- `{drive}/.luna-shared-albums/{id}/` — uploads into shared albums

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

Lunad looks at Forgejo tags that start with `luna-v` (for example `luna-v0.2.0`)
on `LibreLoom/LibreServ`. LibreServ releases stay on `v*` (for example `v0.0.13`)
and are ignored by the Luna updater. Release assets:

- `lunad-linux-amd64` (or `lunad-linux-arm64`) — always
- `luna-os-x86_64.img` — OS cuts only (raw A/B slot image; no Luna state)
- `luna-rapidinstall-x86_64.iso` — OS cuts only (factory / recovery USB)
- `SHA256SUMS.txt` (required)
- `SHA256SUMS.txt.minisig` (required — minisign, public key in `keys/lsluna.minisign.pub`)

Before you `dd` an ISO, verify the checksums file:

```sh
minisign -Vm SHA256SUMS.txt -p keys/lsluna.minisign.pub
sha256sum -c SHA256SUMS.txt
```

An admin taps **Install update** in Settings. That downloads the lunad binary
(when newer), checks the signature then the checksum, and installs it under
`/var/lib/luna/bin/lunad` on the data partition. If the release includes
`luna-os-x86_64.img` and its SHA256 differs from the hash stored on data, the
same tap also writes that image to the inactive OS slot and reboots into it
(GRUB tryboot; a bad boot falls back). Settings does not split “software” vs
“system” — OS need and apply are automatic from the hash. A missing or wrong
signature installs nothing.

Env overrides: `LUNA_UPDATES_API`, `LUNA_UPDATES_OWNER`, `LUNA_UPDATES_REPO`
seed the defaults. An admin can instead point Luna at a different Forgejo
instance/repo from Settings → About → Advanced, and that choice is
stored in Luna's database, survives reboots, and wins over the env vars. The
same panel swaps the minisign public keys the updater trusts. Changing those
keys without a matching signer breaks updates — the updater refuses a release
whose `SHA256SUMS.txt.minisig` no longer verifies against the configured keys.
