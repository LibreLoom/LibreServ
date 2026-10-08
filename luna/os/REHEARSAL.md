# Luna Batch 1 — 5-unit rehearsal

The rehearsal proves the pipeline (order → flash → package → ship → support),
not market demand. Do not skip a step to save time; a skipped step is a
support call later.

## 0. Materials (per unit)
- 1× x86_64 PC to flash (mini PC, Wyse 3040, or similar) + its PSU
- 1× USB stick for the rapidinstall ISO (8 GB is plenty; includes LUNAASSETS)
- Ethernet patch cable (in the box)
- Official device token (purchased from LibreLoom)

## 1. Flash
- [ ] `os/build-rootfs.sh` + `os/make-image.sh` produced `os/dist/luna-os-x86_64.img.xz`
- [ ] `os/make-iso.sh` produced `os/dist/luna-rapidinstall-x86_64.iso`
- [ ] ISO written to USB (`dd … of=/dev/sdX`); USB is **not** the target disk
- [ ] Factory stick: mount `LUNAASSETS`, put official device tokens in `TOKENS` (one per line); each flash peels the first line
- [ ] PC boots the USB (BIOS or UEFI; Secure Boot off)
- [ ] Installer shows built-in storage (`/dev/sda`, `/dev/nvme0n1`, or `/dev/mmcblk0`)
- [ ] Waited 5s (or pressed a number to pick another disk); typed INSTALL and pressed Enter; installer finished; USB removed; reboot from internal disk
- [ ] Typed something other than INSTALL after disk selection → machine shut down (did not erase)
- [ ] `e2fsck -f` on the Luna root partition (`…p3` / `sda3`) is clean if checked afterwards

## 2. First boot
- [ ] Power on from eMMC; front LED is lit; no smoke
- [ ] `ping luna.local` answers from the LAN
- [ ] On the console, `cat /etc/resolv.conf` lists a `nameserver` and `ping -c1 example.com` answers (root is read-only; the file is a link to `/run/resolv.conf`)
- [ ] `http://luna.local` opens the setup wizard (maybe)
- [ ] HDMI shows the current IPv4 (or waiting-for-address) and device token (including after setup / Connect claim)

## 3. Setup wizard
- [ ] Ethernet cable detected; no Luna Setup network; no Wi-Fi scan required
- [ ] Admin account created; name saved; wizard completes to drives

## 4. Storage safety
- [ ] Unrecognized FAT32 drive → "Add drive" preview is read-only, contents listed
- [ ] Adoption adds only Luna's own hidden `.luna-…` items (one `.luna-….sqlite3` database and its `-thumbs` folder); nothing else changed (diff the drive before/after)
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
