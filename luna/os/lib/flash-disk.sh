#!/bin/sh
# Write Luna OS onto a whole disk so it can start on ordinary x86_64 machines:
# BIOS (mini PCs, older boxes) and UEFI (Wyse 3040, modern mini PCs).
# GPT: bios_grub + ESP + LUNA_A + LUNA_B + LUNA_DATA.
# Both OS slots get the same slot image (luna-os-*.img.xz, streamed through
# `xz -dc`) at factory. GRUB tryboot picks the slot;
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
		echo "The Luna system image has no kernel in /boot. Refusing to write a bootloader that cannot start." >&2
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
		# Label search fails on some thin-client UEFI (Wyse) when \$root is already
		# the ESP. Prefer the grubenv file that only exists on LUNAESP.
		echo 'search --no-floppy --file --set=esp /grub/grubenv'
		echo 'if [ -z "$esp" ]; then search --no-floppy --label LUNAESP --set=esp; fi'
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
		echo "      linux /boot/${_k} root=UUID=${_uuid_b} luna.slot=B modules=ext4 rootfstype=ext4 rootflags=ro,noatime panic=10 quiet"
		echo '    else'
		echo "      search --no-floppy --fs-uuid --set=root ${_uuid_a}"
		echo "      linux /boot/${_k} root=UUID=${_uuid_a} luna.slot=A modules=ext4 rootfstype=ext4 rootflags=ro,noatime panic=10 quiet"
		echo '    fi'
		echo "    initrd /boot/${_i}"
		echo '}'
	} >"$_cfgpath"
}

# UEFI paths: Debian grub-install --removable uses prefix /EFI/BOOT and
# overwrites EFI/BOOT/grub.cfg. Always rewrite after grub-install.
# Prefer a full copy of /grub/grub.cfg so a Wyse that never finds LUNAESP
# still gets the Luna menu. Stub is only when the shared file is not there yet.
_write_efi_grub_cfg() {
	_espmnt="$1"

	mkdir -p "$_espmnt/EFI/BOOT/grub"
	if [ -f "$_espmnt/grub/grub.cfg" ]; then
		cp "$_espmnt/grub/grub.cfg" "$_espmnt/EFI/BOOT/grub.cfg"
		cp "$_espmnt/grub/grub.cfg" "$_espmnt/EFI/BOOT/grub/grub.cfg"
		return 0
	fi
	{
		echo 'insmod part_gpt'
		echo 'insmod fat'
		echo 'insmod search'
		echo 'insmod search_fs_file'
		echo 'insmod search_label'
		echo 'search --no-floppy --file --set=root /grub/grub.cfg'
		echo 'if [ -z "$root" ]; then search --no-floppy --label LUNAESP --set=root; fi'
		echo 'set prefix=($root)/grub'
		echo 'export prefix'
		echo 'configfile $prefix/grub.cfg'
	} >"$_espmnt/EFI/BOOT/grub/grub.cfg"
	cp "$_espmnt/EFI/BOOT/grub/grub.cfg" "$_espmnt/EFI/BOOT/grub.cfg"
}

# Self-contained UEFI GRUB (same idea as the rapidinstall ISO). prefix=/grub
# so firmware that ignores our grub.cfg still looks at ESP/grub/grub.cfg.
_embed_uefi_grub() {
	_espmnt="$1"
	_efi_ok=0
	mkdir -p "$_espmnt/EFI/BOOT"
	if [ -f /usr/lib/grub/x86_64-efi/moddep.lst ] && command -v grub-mkimage >/dev/null 2>&1; then
		if grub-mkimage \
			-O x86_64-efi \
			-o "$_espmnt/EFI/BOOT/BOOTX64.EFI" \
			-p /grub \
			-d /usr/lib/grub/x86_64-efi \
			all_video boot cat configfile echo efi_gop efi_uga ext2 fat font \
			gzio halt linux loadenv ls lsefi normal part_gpt part_msdos \
			reboot search search_fs_file search_fs_uuid search_label \
			sleep test true; then
			_efi_ok=1
		fi
	fi
	if [ -f /usr/lib/grub/i386-efi/moddep.lst ] && command -v grub-mkimage >/dev/null 2>&1; then
		grub-mkimage \
			-O i386-efi \
			-o "$_espmnt/EFI/BOOT/BOOTIA32.EFI" \
			-p /grub \
			-d /usr/lib/grub/i386-efi \
			all_video boot cat configfile echo efi_gop ext2 fat font \
			gzio halt linux loadenv ls lsefi normal part_gpt part_msdos \
			reboot search search_fs_file search_fs_uuid search_label \
			sleep test true 2>/dev/null || true
	fi
	[ "$_efi_ok" -eq 1 ]
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
	_img="$2"

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
	if [ ! -f "$_img" ]; then
		echo "Luna's system file is missing: $_img" >&2
		return 2
	fi
	if ! command -v xz >/dev/null 2>&1; then
		echo "This environment is missing xz, which unpacks Luna's system file." >&2
		return 1
	fi
	if ! command -v grub-install >/dev/null 2>&1; then
		echo "This environment is missing GRUB. Boot the rapidinstall ISO instead." >&2
		return 1
	fi
	return 0
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

# sha256 of the exact .img.xz at $1, which is what Luna records as
# os-image.sha256 and compares against the update feed. When a
# <image>.sha256 companion sits beside it (the ISO always stages one), the two
# must agree: a damaged or swapped file stops the install before the disk is
# erased. Prints the hash; returns 1 on a mismatch or unreadable file.
_verify_os_image() {
	_img="$1"
	_got="$(sha256sum "$_img" 2>/dev/null | awk '{print $1}')"
	[ -n "$_got" ] || return 1
	if [ -f "$_img.sha256" ]; then
		_want="$(awk '{print $1; exit}' "$_img.sha256")"
		[ "$_want" = "$_got" ] || return 1
	fi
	printf '%s\n' "$_got"
}

# Stream the .img.xz at $1 onto block device (or file) $2. dash has no
# pipefail, so xz writes straight to the device and its own exit status counts.
_write_slot() {
	xz -dc "$1" >"$2" || return 1
	sync
}

# Record the OS image SHA256 onto the data partition so OTA can compare.
_write_os_image_hash() {
	_record_os_image_hash "$1" "$2"
}

# flash_luna_disk <whole disk> <luna-os-*.img.xz>
# Sets _os_hash (sha256 of that .img.xz) for the caller to record.
flash_luna_disk() {
	_dev="$1"
	_slot_img="${2:-${LUNA_OS_IMAGE:-}}"
	_flash_guards "$_dev" "$_slot_img" || return
	# Check the file before anything is erased.
	if ! _os_hash="$(_verify_os_image "$_slot_img")"; then
		echo "Luna's system file is damaged (its checksum does not match). Nothing was erased." >&2
		return 1
	fi

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
	echo "==> writing OS image to slot A and slot B"
	_write_slot "$_slot_img" "$_root_a" || {
		echo "Writing Luna to slot A failed." >&2
		return 1
	}
	_write_slot "$_slot_img" "$_root_b" || {
		echo "Writing Luna to slot B failed." >&2
		return 1
	}
	# Both slots come from one image, so they share a filesystem UUID; GRUB and
	# the kernel pick a slot by UUID, so slot B needs its own.
	e2fsck -fy "$_root_b" >/dev/null 2>&1 || [ $? -le 1 ] || {
		echo "Slot B did not check clean after writing." >&2
		return 1
	}
	tune2fs -U random "$_root_b" >/dev/null || {
		echo "Could not give slot B its own identity." >&2
		return 1
	}
	# Relabel in case the image carried a generic label.
	e2label "$_root_a" LUNA_A 2>/dev/null || true
	e2label "$_root_b" LUNA_B 2>/dev/null || true
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

	# Image already written; still ensure mountpoints/labels for GRUB probe.
	mkdir -p "$_mnt_a/var/lib/luna" "$_mnt_b/var/lib/luna"
	printf 'slot=A\n' >"$_mnt_a/etc/luna-slot"
	printf 'slot=B\n' >"$_mnt_b/etc/luna-slot"
	if ! _write_os_image_hash "$_datamnt" "$_os_hash"; then
		echo "Could not write os-image.sha256 onto the data partition. Install failed." >&2
		return 1
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
	_write_grubenv "$_espmnt" A

	_bios_ok=0
	_efi_ok=0
	# --boot-directory is the directory that holds grub/: the ESP root, so GRUB reads
	# ESP/grub/grub.cfg (the file written above). Using $_espmnt/grub here would put
	# everything under ESP/grub/grub/ and BIOS boots would stop at a grub> prompt.
	# The ESP (not a slot) keeps GRUB modules safe when a slot is rewritten.
	if grub-install --target=i386-pc --boot-directory="$_espmnt" "$_dev"; then
		_bios_ok=1
	elif grub-install --target=i386-pc --boot-directory="$_mnt_a/boot" --root-directory="$_mnt_a" "$_dev"; then
		_bios_ok=1
	fi
	# Debian --removable writes EFI/BOOT/BOOTX64.EFI and a stub grub.cfg
	# that search.fs_uuid's the ESP — that stub is what drops Wyse to a
	# GRUB shell. Install the binary, then replace cfg + embed our core.
	if grub-install --target=x86_64-efi --efi-directory="$_espmnt" \
		--boot-directory="$_espmnt" --removable --no-nvram "$_dev"; then
		_efi_ok=1
	fi
	grub-install --target=i386-efi --efi-directory="$_espmnt" \
		--boot-directory="$_espmnt" --removable --no-nvram "$_dev" 2>/dev/null || true
	if _embed_uefi_grub "$_espmnt"; then
		_efi_ok=1
	fi
	# Must run after grub-install so Debian cannot wipe our cfg.
	_write_efi_grub_cfg "$_espmnt"
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
	# Same modules under EFI/BOOT so a prefix of /EFI/BOOT can insmod.
	_install_grub_modules "$_espmnt/EFI/BOOT" x86_64-efi 2>/dev/null || true
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
