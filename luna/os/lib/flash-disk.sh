#!/bin/sh
# Write Luna OS onto a whole disk so it can start on ordinary x86_64 machines:
# BIOS (mini PCs, older boxes) and UEFI (Wyse 3040, modern mini PCs).
# GPT: bios_grub + ESP + LUNA_A + LUNA_B + LUNA_DATA.
# Both OS slots get the same rootfs at factory. GRUB tryboot picks the slot;
# Luna state lives on LUNA_DATA mounted at /var/lib/luna.

_wait_block() {
	_path="$1"
	_n=0
	while [ ! -b "$_path" ] && [ "$_n" -lt 20 ]; do
		sleep 1
		_n=$((_n + 1))
	done
	[ -b "$_path" ]
}

_find_boot_images() {
	_rootmnt="$1"
	_k=vmlinuz-lts
	_i=initramfs-lts
	if [ ! -e "$_rootmnt/boot/$_k" ]; then
		_k="$(basename "$(find "$_rootmnt/boot" -maxdepth 1 -name 'vmlinuz-*' | head -1)")"
	fi
	if [ ! -e "$_rootmnt/boot/$_i" ]; then
		_i="$(basename "$(find "$_rootmnt/boot" -maxdepth 1 -name 'initramfs-*' | head -1)")"
	fi
	if [ -z "$_k" ] || [ "$_k" = "." ] || [ ! -e "$_rootmnt/boot/$_k" ]; then
		echo "The Luna archive has no kernel in /boot. Refusing to write a bootloader that cannot start." >&2
		return 1
	fi
	printf '%s\n' "$_k" "$_i"
}

# Dual-slot GRUB menu with tryboot. Lives on the ESP so rewriting a slot
# cannot erase the bootloader config. grubenv keys:
#   luna_slot=A|B  luna_boot_ok=0|1  luna_tries=0|1|2|3
_write_grub_cfg() {
	_cfgpath="$1"
	_uuid_a="$2"
	_uuid_b="$3"
	_k="$4"
	_i="$5"

	mkdir -p "$(dirname "$_cfgpath")"
	{
		echo 'set timeout=2'
		echo 'set default=0'
		echo 'insmod part_gpt'
		echo 'insmod ext2'
		echo 'insmod fat'
		echo 'insmod search'
		echo 'insmod search_fs_uuid'
		echo 'insmod search_label'
		echo 'insmod loadenv'
		echo 'search --no-floppy --label LUNAESP --set=esp'
		echo 'set envfile=($esp)/grub/grubenv'
		echo 'load_env -f $envfile'
		echo 'if [ -z "$luna_slot" ]; then set luna_slot=A; fi'
		echo 'if [ -z "$luna_boot_ok" ]; then set luna_boot_ok=1; fi'
		echo 'if [ -z "$luna_tries" ]; then set luna_tries=3; fi'
		# Failed boot: count down tries, then flip to the other slot.
		echo 'if [ "$luna_boot_ok" != "1" ]; then'
		echo '  if [ "$luna_tries" = "0" ]; then'
		echo '    if [ "$luna_slot" = "B" ]; then set luna_slot=A; else set luna_slot=B; fi'
		echo '    set luna_boot_ok=1'
		echo '    set luna_tries=3'
		echo '    save_env -f $envfile luna_slot luna_boot_ok luna_tries'
		echo '  elif [ "$luna_tries" = "1" ]; then'
		echo '    set luna_tries=0'
		echo '    save_env -f $envfile luna_tries'
		echo '  elif [ "$luna_tries" = "2" ]; then'
		echo '    set luna_tries=1'
		echo '    save_env -f $envfile luna_tries'
		echo '  else'
		echo '    set luna_tries=2'
		echo '    save_env -f $envfile luna_tries'
		echo '  fi'
		echo 'fi'
		echo 'menuentry "Luna" {'
		echo '    if [ "$luna_slot" = "B" ]; then'
		echo "      search --no-floppy --fs-uuid --set=root ${_uuid_b}"
		echo "      linux /boot/${_k} root=UUID=${_uuid_b} luna.slot=B modules=ext4 rootfstype=ext4 rootflags=ro,noatime quiet"
		echo '    else'
		echo "      search --no-floppy --fs-uuid --set=root ${_uuid_a}"
		echo "      linux /boot/${_k} root=UUID=${_uuid_a} luna.slot=A modules=ext4 rootfstype=ext4 rootflags=ro,noatime quiet"
		echo '    fi'
		echo "    initrd /boot/${_i}"
		echo '}'
	} >"$_cfgpath"
}

# UEFI fallback loader on the ESP — loads the shared grub.cfg next to grubenv.
_write_efi_grub_cfg() {
	_espmnt="$1"

	mkdir -p "$_espmnt/EFI/BOOT/grub"
	{
		echo 'insmod part_gpt'
		echo 'insmod fat'
		echo 'insmod search'
		echo 'insmod search_label'
		echo 'search --no-floppy --label LUNAESP --set=root'
		echo 'set prefix=($root)/grub'
		echo 'export prefix'
		echo 'configfile $prefix/grub.cfg'
	} >"$_espmnt/EFI/BOOT/grub/grub.cfg"
}

_write_grubenv() {
	_espmnt="$1"
	_slot="${2:-A}"
	mkdir -p "$_espmnt/grub"
	# grub-editenv creates a 1024-byte env block; fall back to a minimal file.
	if command -v grub-editenv >/dev/null 2>&1; then
		grub-editenv "$_espmnt/grub/grubenv" create
		grub-editenv "$_espmnt/grub/grubenv" set "luna_slot=$_slot"
		grub-editenv "$_espmnt/grub/grubenv" set "luna_boot_ok=1"
		grub-editenv "$_espmnt/grub/grubenv" set "luna_tries=3"
	else
		# Placeholder; real media always has grub-editenv from the ISO.
		printf '# GRUB Environment Block\nluna_slot=%s\nluna_boot_ok=1\nluna_tries=3\n' "$_slot" >"$_espmnt/grub/grubenv"
	fi
}

# Debian live's grub-install puts BOOTX64.EFI on the ESP but often does not
# populate ($root)/boot/grub/x86_64-efi/*.mod. The ESP chainloader sets
# prefix=($root)/grub, so modules must live under ESP/grub/<platform>/.
_install_grub_modules() {
	_bootdir="$1"
	_platform="$2"
	_modsrc=""
	case "$_platform" in
	x86_64-efi)
		for _d in /usr/lib/grub/x86_64-efi /usr/lib/grub-efi-amd64; do
			if [ -f "$_d/ext2.mod" ]; then
				_modsrc="$_d"
				break
			fi
		done
		;;
	i386-pc)
		for _d in /usr/lib/grub/i386-pc /usr/lib/grub-pc; do
			if [ -f "$_d/ext2.mod" ]; then
				_modsrc="$_d"
				break
			fi
		done
		;;
	*)
		echo "unknown GRUB platform: $_platform" >&2
		return 1
		;;
	esac
	if [ -z "$_modsrc" ]; then
		echo "GRUB $_platform modules not found in the installer environment." >&2
		return 1
	fi
	_destdir="$_bootdir/$_platform"
	mkdir -p "$_destdir"
	cp -a "$_modsrc"/*.mod "$_destdir/" 2>/dev/null || true
	cp -a "$_modsrc"/*.lst "$_destdir/" 2>/dev/null || true
	if [ ! -f "$_destdir/ext2.mod" ]; then
		echo "GRUB $_platform ext2.mod missing after copy to $_destdir." >&2
		return 1
	fi
}

_disk_is_mounted() {
	_base="$(block_name "$1")"
	while read -r _src _rest; do
		_m="$(basename "$_src" 2>/dev/null)" || continue
		case "$_m" in
		"$_base" | "$_base"[0-9]* | "$_base"p[0-9]*)
			return 0
			;;
		esac
	done <"${LUNA_PROC_MOUNTS:-/proc/mounts}"
	return 1
}

_flash_guards() {
	_dev="$1"
	_tarball="$2"

	if ! is_whole_disk "$_dev"; then
		echo "Luna only flashes a whole disk (for example /dev/sda, /dev/nvme0n1, or /dev/mmcblk0), not a partition." >&2
		return 2
	fi
	if is_emmc_aux "$_dev"; then
		echo "That device is a special eMMC boot area, not the computer's storage. Refusing." >&2
		return 2
	fi
	if is_install_media "$_dev"; then
		echo "That disk is the USB stick this installer booted from. Luna will not erase it." >&2
		return 2
	fi
	if [ ! -b "$_dev" ] && [ -z "${LUNA_FAKE_BLOCK:-}" ]; then
		echo "No disk at $_dev." >&2
		return 2
	fi
	if _disk_is_mounted "$_dev"; then
		echo "Refusing: $_dev (or one of its partitions) is currently mounted." >&2
		return 2
	fi
	if [ ! -f "$_tarball" ]; then
		echo "missing Luna OS archive: $_tarball" >&2
		return 2
	fi
	if ! command -v grub-install >/dev/null 2>&1; then
		echo "This environment is missing GRUB. Boot the rapidinstall ISO instead." >&2
		return 1
	fi
	return 0
}

# Extract rootfs onto a mounted slot and stamp fstab for LUNA_DATA.
_populate_slot() {
	_mnt="$1"
	_tarball="$2"
	_label="$3"
	tar -xzf "$_tarball" -C "$_mnt"
	# Ensure data mountpoint exists; fstab is completed by build-rootfs, but
	# older tarballs may lack the LUNA_DATA line — append if missing.
	mkdir -p "$_mnt/var/lib/luna"
	if [ -f "$_mnt/etc/fstab" ] && ! grep -q 'LABEL=LUNA_DATA' "$_mnt/etc/fstab" 2>/dev/null; then
		printf 'LABEL=LUNA_DATA /var/lib/luna ext4 defaults,noatime 0 2\n' >>"$_mnt/etc/fstab"
	fi
	# Slot identity for operators (not a Settings split).
	printf 'slot=%s\n' "$_label" >"$_mnt/etc/luna-slot"
}

# Write hex SHA256 to $1/os-image.sha256. First field only (GNU sha256sum line).
_record_os_image_hash() {
	_dir="$1"
	_hash="$2"
	_hash=$(printf '%s' "$_hash" | awk '{print $1}')
	[ -n "$_hash" ] || return 1
	mkdir -p "$_dir" || return 1
	printf '%s\n' "$_hash" >"$_dir/os-image.sha256" || return 1
	chmod 644 "$_dir/os-image.sha256" 2>/dev/null || true
	return 0
}

# Hash from an in-memory value, a .sha256 companion (first field), or sha256sum of $2.
_resolve_os_image_hash() {
	if [ -n "${1:-}" ]; then
		printf '%s\n' "$1" | awk '{print $1}'
		return 0
	fi
	_img="${2:-}"
	if [ -n "$_img" ] && [ -f "${_img}.sha256" ]; then
		awk '{print $1; exit}' "${_img}.sha256"
		return 0
	fi
	if [ -n "$_img" ] && [ -f "$_img" ]; then
		sha256sum "$_img" | awk '{print $1}'
		return 0
	fi
	return 1
}

# Record the OS image SHA256 onto the data partition so OTA can compare.
_write_os_image_hash() {
	_record_os_image_hash "$1" "$2"
}

flash_luna_disk() {
	_dev="$1"
	_tarball="$2"
	# Optional third arg: path to luna-os-*.img (or its .sha256 companion via env).
	_slot_img="${3:-${LUNA_OS_IMAGE:-}}"
	_flash_guards "$_dev" "$_tarball" || return

	_bios="$(partition_bios_grub "$_dev")"
	_esp="$(partition_esp "$_dev")"
	_root_a="$(partition_root_a "$_dev")"
	_root_b="$(partition_root_b "$_dev")"
	_data="$(partition_data "$_dev")"
	_slot_sectors=$((LUNA_SLOT_SIZE_MIB * 2048))

	echo "==> partitioning $_dev (GPT, BIOS + UEFI, A/B + data)"
	sfdisk --wipe always "$_dev" <<PART
label: gpt
unit: sectors
first-lba: 2048

start=2048, size=2048, type=21686148-6449-6E6F-744E-656564454649, name=BIOSGRUB
size=262144, type=C12A7328-F81F-11D2-BA4B-00A0C93EC93B, name=ESP, bootable
size=${_slot_sectors}, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name=LUNA_A
size=${_slot_sectors}, type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name=LUNA_B
type=0FC63DAF-8483-4772-8E79-3D69D8477DE4, name=LUNA_DATA
PART
	sleep 1
	if command -v partprobe >/dev/null 2>&1; then
		partprobe "$_dev" 2>/dev/null || true
	fi
	if ! _wait_block "$_bios" || ! _wait_block "$_esp" || ! _wait_block "$_root_a" \
		|| ! _wait_block "$_root_b" || ! _wait_block "$_data"; then
		echo "The new partitions never appeared. Stopped before erasing further." >&2
		return 1
	fi

	echo "==> formatting EFI, OS slots, and data"
	mkfs.vfat -F 32 -n LUNAESP "$_esp"
	if [ -n "$_slot_img" ] && [ -f "$_slot_img" ]; then
		echo "==> writing OS image to slot A and slot B"
		dd if="$_slot_img" of="$_root_a" bs=4M status=none conv=fsync
		dd if="$_slot_img" of="$_root_b" bs=4M status=none conv=fsync
		# Relabel in case the image carried a generic label.
		e2label "$_root_a" LUNA_A 2>/dev/null || true
		e2label "$_root_b" LUNA_B 2>/dev/null || true
		_os_hash="$(sha256sum "$_slot_img" | awk '{print $1}')"
	else
		mkfs.ext4 -F -L LUNA_A "$_root_a"
		mkfs.ext4 -F -L LUNA_B "$_root_b"
		_os_hash=""
	fi
	mkfs.ext4 -F -L LUNA_DATA "$_data"
	_uuid_a="$(blkid -s UUID -o value "$_root_a")"
	_uuid_b="$(blkid -s UUID -o value "$_root_b")"
	if [ -z "$_uuid_a" ] || [ -z "$_uuid_b" ]; then
		echo "Could not read the Luna slot UUIDs for GRUB." >&2
		return 1
	fi

	_mnt_a="$(mktemp -d /tmp/luna-a.XXXXXX)" || return 1
	_mnt_b="$(mktemp -d /tmp/luna-b.XXXXXX)" || {
		rmdir "$_mnt_a" 2>/dev/null || true
		return 1
	}
	_espmnt="$(mktemp -d /tmp/luna-esp.XXXXXX)" || {
		rmdir "$_mnt_a" "$_mnt_b" 2>/dev/null || true
		return 1
	}
	_datamnt="$(mktemp -d /tmp/luna-data.XXXXXX)" || {
		rmdir "$_mnt_a" "$_mnt_b" "$_espmnt" 2>/dev/null || true
		return 1
	}
	# shellcheck disable=SC2064
	trap 'umount "${_datamnt:-}" 2>/dev/null || true; umount "${_espmnt:-}" 2>/dev/null || true; umount "${_mnt_b:-}" 2>/dev/null || true; umount "${_mnt_a:-}" 2>/dev/null || true; rmdir "${_datamnt:-}" "${_espmnt:-}" "${_mnt_b:-}" "${_mnt_a:-}" 2>/dev/null || true; trap - EXIT INT' EXIT INT

	if ! mount "$_root_a" "$_mnt_a"; then
		echo "Mounting slot A failed." >&2
		return 1
	fi
	if ! mount "$_root_b" "$_mnt_b"; then
		echo "Mounting slot B failed." >&2
		return 1
	fi
	if ! mount "$_esp" "$_espmnt"; then
		echo "Mounting the EFI partition failed." >&2
		return 1
	fi
	if ! mount "$_data" "$_datamnt"; then
		echo "Mounting the data partition failed." >&2
		return 1
	fi

	if [ -z "$_slot_img" ] || [ ! -f "$_slot_img" ]; then
		echo "==> extracting Luna OS onto slot A and slot B"
		_populate_slot "$_mnt_a" "$_tarball" A
		_populate_slot "$_mnt_b" "$_tarball" B
		# Hash of a deterministic stamp when no release image is present.
		if [ -f "$_mnt_a/etc/apk-manifest.txt" ]; then
			_os_hash="$(sha256sum "$_mnt_a/etc/apk-manifest.txt" | awk '{print $1}')"
		fi
	else
		# Image already written; still ensure mountpoints/labels for GRUB probe.
		mkdir -p "$_mnt_a/var/lib/luna" "$_mnt_b/var/lib/luna"
		printf 'slot=A\n' >"$_mnt_a/etc/luna-slot"
		printf 'slot=B\n' >"$_mnt_b/etc/luna-slot"
	fi

	if [ -n "$_os_hash" ]; then
		_write_os_image_hash "$_datamnt" "$_os_hash"
	fi

	echo "==> installing bootloader (BIOS and UEFI, A/B tryboot)"
	mkdir -p "$_espmnt/EFI/BOOT" "$_espmnt/grub"
	if ! _boot_imgs="$(_find_boot_images "$_mnt_a")"; then
		return 1
	fi
	_k="$(printf '%s\n' "$_boot_imgs" | sed -n '1p')"
	_i="$(printf '%s\n' "$_boot_imgs" | sed -n '2p')"
	_write_grub_cfg "$_espmnt/grub/grub.cfg" "$_uuid_a" "$_uuid_b" "$_k" "$_i"
	# Mirror onto both slots so a BIOS boot-directory fallback still works.
	_write_grub_cfg "$_mnt_a/boot/grub/grub.cfg" "$_uuid_a" "$_uuid_b" "$_k" "$_i"
	_write_grub_cfg "$_mnt_b/boot/grub/grub.cfg" "$_uuid_a" "$_uuid_b" "$_k" "$_i"
	_write_efi_grub_cfg "$_espmnt"
	_write_grubenv "$_espmnt" A

	_bios_ok=0
	_efi_ok=0
	# Prefer ESP as boot-directory so slot rewrites do not erase GRUB modules.
	if grub-install --target=i386-pc --boot-directory="$_espmnt/grub" "$_dev"; then
		_bios_ok=1
	elif grub-install --target=i386-pc --boot-directory="$_mnt_a/boot" --root-directory="$_mnt_a" "$_dev"; then
		_bios_ok=1
	fi
	if grub-install --target=x86_64-efi --efi-directory="$_espmnt" \
		--boot-directory="$_espmnt/grub" --removable --no-nvram "$_dev"; then
		_efi_ok=1
	fi
	grub-install --target=i386-efi --efi-directory="$_espmnt" \
		--boot-directory="$_espmnt/grub" --removable --no-nvram "$_dev" 2>/dev/null || true
	if [ -f "$_espmnt/EFI/BOOT/BOOTX64.EFI" ] || [ -f "$_espmnt/EFI/BOOT/BOOTIA32.EFI" ]; then
		_efi_ok=1
	fi
	if ! _install_grub_modules "$_espmnt/grub" x86_64-efi; then
		# Fall back to modules on slot A (legacy path).
		_install_grub_modules "$_mnt_a/boot/grub" x86_64-efi || {
			echo "UEFI GRUB modules could not be installed." >&2
			return 1
		}
	fi
	_install_grub_modules "$_espmnt/grub" i386-pc 2>/dev/null || true
	_install_grub_modules "$_mnt_a/boot/grub" i386-pc 2>/dev/null || true
	if [ "$_bios_ok" -eq 0 ] && [ "$_efi_ok" -eq 0 ]; then
		echo "GRUB could not install a BIOS or UEFI bootloader. This computer would not start after reboot." >&2
		return 1
	fi

	echo "==> syncing"
	sync
	umount "$_datamnt"
	umount "$_espmnt"
	umount "$_mnt_b"
	umount "$_mnt_a"
	rmdir "$_datamnt" "$_espmnt" "$_mnt_b" "$_mnt_a" 2>/dev/null || true
	trap - EXIT INT
}
