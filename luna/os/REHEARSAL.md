# Luna Batch 1 — 5-unit rehearsal

The rehearsal proves the pipeline (order → flash → package → ship → support),
not market demand. Do not skip a step to save time; a skipped step is a
support call later.

## 0. Materials (per unit)
- 1× x86_64 PC to flash (mini PC, Wyse 3040, or similar) + its PSU
- 1× USB stick for the rapidinstall ISO (8 GB is plenty; includes LUNAASSETS)
- Ethernet patch cable (in the box)
- Printed booklet with the official setup code

## 1. Flash
- [ ] `os/build-rootfs.sh` produced `os/dist/luna-rootfs-x86_64.tar.gz`
- [ ] `os/make-iso.sh` produced `os/dist/luna-rapidinstall-x86_64.iso`
- [ ] ISO written to USB (`dd … of=/dev/sdX`); USB is **not** the target disk
- [ ] Factory stick: mount `LUNAASSETS`, put booklet codes in `TOKENS` (one per line); each flash peels the first line
- [ ] PC boots the USB (BIOS or UEFI; Secure Boot off)
- [ ] Installer shows built-in storage (`/dev/sda`, `/dev/nvme0n1`, or `/dev/mmcblk0`)
- [ ] Waited 5s (or pressed a number to pick another disk); installer finished; USB removed; reboot from internal disk
- [ ] `e2fsck -f` on the Luna root partition (`…p3` / `sda3`) is clean if checked afterwards

## 2. First boot
- [ ] Power on from eMMC; front LED is lit; no smoke
- [ ] `ping luna.local` answers from the LAN
- [ ] `http://luna.local` opens the setup wizard (maybe)
- [ ] HDMI shows the current IPv4 (or waiting-for-address) and booklet code while unclaimed

## 3. Setup wizard
- [ ] Ethernet cable detected; no Luna Setup network; no Wi-Fi scan required
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
- [ ] Luna Connect assigns {name}.luna.servers.libreloom.org and serves the device URL
- [ ] Turn off → URL stops; turn on again → URL returns

## 7. Reliability
- [ ] `GET /api/v1/drives/{id}/health` shows SMART data
- [ ] Unplug one storage drive → calm "not connected" state, no hangs
- [ ] Replug → state returns to ready

## 8. Ship
- [ ] QA checklist signed per unit
- [ ] Unit serial recorded with the box label
- [ ] Package: unit, PSU, cable, quick-start card; no loose screws
