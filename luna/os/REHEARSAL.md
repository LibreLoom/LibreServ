# Luna Batch 1 — 5-unit rehearsal

The rehearsal proves the pipeline (order → flash → package → ship → support),
not market demand. Do not skip a step to save time; a skipped step is a
support call later.

## 0. Materials (per unit)
- 1× x86_64 PC to flash (mini PC, Wyse 3040, or similar) + its PSU
- 1× USB stick for the rapidinstall ISO (8 GB is plenty)
- 1× qualified USB Wi-Fi dongle + 1× qualified USB BLE dongle when the box has no radio (see hardware/QUALIFICATION.md)
- Ethernet cable + printed quick-start card (luna.local / http://luna / 169.254.42.42 / app)

## 1. Flash
- [ ] `os/build-rootfs.sh` produced `os/dist/luna-rootfs-x86_64.tar.gz`
- [ ] `os/make-iso.sh` produced `os/dist/luna-rapidinstall-x86_64.iso`
- [ ] ISO written to USB (`dd … of=/dev/sdX`); USB is **not** the target disk
- [ ] PC boots the USB (BIOS or UEFI; Secure Boot off)
- [ ] Installer shows built-in storage (`/dev/sda`, `/dev/nvme0n1`, or `/dev/mmcblk0`)
- [ ] Typed `install luna`; installer finished; USB removed; reboot from internal disk
- [ ] `e2fsck -f` on the Luna root partition (`…p3` / `sda3`) is clean if checked afterwards

## 2. First boot
- [ ] Power on from eMMC; front LED is lit; no smoke
- [ ] `ping luna.local` answers from the LAN
- [ ] `http://luna.local` opens the setup wizard
- [ ] Direct-cable test: laptop Ethernet → Luna, browse `http://169.254.42.42`

## 3. Setup wizard
- [ ] Ethernet detected → Wi-Fi offered as optional
- [ ] Wi-Fi scan lists a network; wrong password shows the plain-language error
- [ ] Admin account created; name saved; wizard completes to drives

## 4. Storage safety
- [ ] Unrecognized FAT32 drive → "Look inside" is read-only, contents listed
- [ ] Adoption writes exactly one `.luna` file; nothing else changed (diff the drive before/after)
- [ ] Eject says safe to remove; replug returns the drive

## 5. Files & links
- [ ] 100 MB file uploads and downloads; checksums match
- [ ] 2 GB chunked upload resumes after pulling the cable mid-upload
- [ ] WebDAV mount works from Finder and Explorer
- [ ] Public link with password works; wrong password is refused

## 6. Remote access
- [ ] Luna Connect activates with a free key and serves the device URL
- [ ] Turn off → URL stops; turn on again → URL returns

## 7. Reliability
- [ ] `GET /api/v1/drives/{id}/health` shows SMART data
- [ ] Unplug one storage drive → calm "not connected" state, no hangs
- [ ] Replug → state returns to ready

## 8. Ship
- [ ] QA checklist signed per unit
- [ ] Unit serial recorded with the box label
- [ ] Package: unit, PSU, cable, quick-start card; no loose screws
