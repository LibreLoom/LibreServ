#!/bin/sh
# Factory stick helpers: LUNAASSETS partition + TOKENS magazine (dash-safe).
# Each official pairing line contains a 20-character uppercase Crockford Device
# ID and a six-character uppercase hexadecimal Verification code, separated by
# one literal space.

# Print the first non-empty, non-# line from $1 without normalizing its fields.
# Returns 1 if none. Only CR from FAT / Windows line endings is removed.
factory_tokens_first_line() {
	_file="$1"
	[ -f "$_file" ] || return 1
	while IFS= read -r _line || [ -n "$_line" ]; do
		_line=$(printf '%s' "$_line" | tr -d '\r')
		_check=$(printf '%s' "$_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		case "$_check" in
		"" | \#*)
			continue
			;;
		esac
		printf '%s\n' "$_line"
		return 0
	done <"$_file"
	return 1
}

# Rewrite $1 without its first usable pairing line. Keeps blank lines and
# comments; drops only the first non-empty non-# line. Returns 1 on I/O failure.
factory_tokens_drop_first() {
	_file="$1"
	_tmp="${2:-$_file.tmp}"
	[ -f "$_file" ] || return 1
	_dropped=0
	: >"$_tmp" || return 1
	while IFS= read -r _line || [ -n "$_line" ]; do
		if [ "$_dropped" -eq 0 ]; then
			_check=$(printf '%s' "$_line" | tr -d '\r')
			_check=$(printf '%s' "$_check" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
			case "$_check" in
			"" | \#*)
				printf '%s\n' "$_line" >>"$_tmp" || return 1
				continue
				;;
			esac
			_dropped=1
			continue
		fi
		printf '%s\n' "$_line" >>"$_tmp" || return 1
	done <"$_file"
	[ "$_dropped" -eq 1 ] || return 1
	mv -f "$_tmp" "$_file" || return 1
	sync 2>/dev/null || true
	return 0
}

# Resolve the LUNAASSETS block device (empty if missing).
factory_assets_device() {
	if command -v blkid >/dev/null 2>&1; then
		blkid -L LUNAASSETS 2>/dev/null || true
	fi
}

# Mount LUNAASSETS rw at $1. Returns 0 on success.
# Variable names must not collide with rapidinstall's data-partition mount (_mnt).
factory_assets_mount() {
	_fa_mnt="$1"
	_dev="$(factory_assets_device)"
	[ -n "$_dev" ] || return 1
	[ -b "$_dev" ] || return 1
	mkdir -p "$_fa_mnt" || return 1
	mount -t vfat -o rw,utf8,umask=000 "$_dev" "$_fa_mnt" 2>/dev/null \
		|| mount -o rw,umask=000 "$_dev" "$_fa_mnt" 2>/dev/null \
		|| return 1
	return 0
}

factory_assets_umount() {
	_fa_mnt="$1"
	umount "$_fa_mnt" 2>/dev/null || true
	rmdir "$_fa_mnt" 2>/dev/null || true
}

# Normalize a manually entered Device ID for display-style groups and Crockford
# look-alikes. TOKENS lines do not use this normalization: their format is exact.
factory_normalize_device_uid() {
	_norm=$(printf '%s' "$1" | tr -d '\r' | sed 's/[-_[:space:]]//g' | tr 'a-z' 'A-Z')
	_norm=$(printf '%s' "$_norm" | sed 's/I/1/g; s/L/1/g; s/O/0/g')
	printf '%s' "$_norm"
}

# True when $1 is an ungrouped uppercase 20-character Crockford Device ID.
factory_is_valid_device_uid() {
	_uid="$1"
	[ "${#_uid}" -eq 20 ] || return 1
	case "$_uid" in
	*[!0123456789ABCDEFGHJKMNPQRSTVWXYZ]*) return 1 ;;
	esac
	return 0
}

# True when $1 is an uppercase six-character hexadecimal Verification code.
factory_is_valid_pairing_code() {
	_code="$1"
	[ "${#_code}" -eq 6 ] || return 1
	case "$_code" in
	*[!0123456789ABCDEF]*) return 1 ;;
	esac
	return 0
}

# Validate one exact TOKENS line and print it in canonical form. The line must
# be "<20-character Crockford Device ID> <6-hex Verification code>" with one
# literal space, no grouping, and no leading or trailing whitespace.
factory_pairing_line() {
	_line=$(printf '%s' "$1" | tr -d '\r')
	_pair=$(printf '%s\n' "$_line" | awk 'NF == 2 && $0 ~ /^[^[:space:]]+ [^[:space:]]+$/ { print $1, $2; found = 1 } END { if (!found) exit 1 }') || return 1
	_uid="${_pair% *}"
	_code="${_pair#* }"
	factory_is_valid_device_uid "$_uid" || return 1
	factory_is_valid_pairing_code "$_code" || return 1
	printf '%s %s\n' "$_uid" "$_code"
}

# Peel the first valid pairing line from a mounted LUNAASSETS directory ($1).
# Malformed lines are consumed and skipped so one bad export does not block the
# next unit. On success prints "<Device ID> <Verification code>".
# Returns: 0 = peeled, 1 = no usable line, 2 = rewrite failed after peel intent.
factory_peel_pairing_line_from_dir() {
	_assets="$1"
	_tokens="$_assets/TOKENS"
	[ -f "$_tokens" ] || return 1
	while _line=$(factory_tokens_first_line "$_tokens"); do
		if ! factory_tokens_drop_first "$_tokens"; then
			return 2
		fi
		if _pair=$(factory_pairing_line "$_line"); then
			printf '%s\n' "$_pair"
			return 0
		fi
	done
	return 1
}

# Write the public Device ID and secret Verification code as separate files on
# the mounted LUNA_DATA volume ($1), which is /var/lib/luna at runtime.
factory_write_pairing_material() {
	_root="$1"
	_uid="$2"
	_code="$3"
	factory_is_valid_device_uid "$_uid" || return 1
	factory_is_valid_pairing_code "$_code" || return 1
	mkdir -p "$_root" || return 1
	# Write the code first: a crash between the two writes leaves no Device ID,
	# so a later setup attempt can safely consume another magazine line.
	(umask 077; printf '%s\n' "$_code" >"$_root/pairing-code") || return 1
	chmod 600 "$_root/pairing-code" || return 1
	printf '%s\n' "$_uid" >"$_root/device-uid" || return 1
	chmod 644 "$_root/device-uid" || return 1
	return 0
}

# TTY prompt: collect Device ID and Verification code separately. Empty Enter at
# Device ID skips Connect; invalid values re-prompt only the field that was wrong.
factory_prompt_pairing_material() {
	_root="$1"
	printf '%s\n' \
		"" \
		"Enter the Device ID and Verification code from your Luna Connect quick-start card." \
		"Open connect.luna.libreloom.org/onboarding in a browser on the same network, or press Enter at Device ID to set up without Connect."
	while :; do
		printf '%s' "Device ID: "
		read -r _uid || _uid=""
		_uid=$(printf '%s' "$_uid" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		if [ -z "$_uid" ]; then
			echo "Skipped. You can connect Luna later in Settings > Luna Connect."
			return 0
		fi
		_uid=$(factory_normalize_device_uid "$_uid")
		if factory_is_valid_device_uid "$_uid"; then
			break
		fi
		printf '%s\n' "Check the Device ID. It has 20 characters, usually shown in five groups of four."
	done
	while :; do
		printf '%s' "Verification code: "
		if ! read -r _code; then
			echo "No Verification code entered." >&2
			return 1
		fi
		_code=$(printf '%s' "$_code" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr 'a-f' 'A-F')
		if factory_is_valid_pairing_code "$_code"; then
			break
		fi
		printf '%s\n' "Check the Verification code. It is six characters long and uses only 0-9 and A-F."
	done
	if ! factory_write_pairing_material "$_root" "$_uid" "$_code"; then
		echo "Could not save the Device ID and Verification code onto Luna." >&2
		return 1
	fi
	echo "Device ID and Verification code saved."
	return 0
}

# Full post-flash path: peel from LUNAASSETS, else prompt on a TTY.
# Returns 0 on success/skip; 1 on hard failure (e.g. magazine rewrite failed).
factory_apply_pairing_material() {
	_root="$1"
	_assets_mnt="$(mktemp -d)" || return 1
	if factory_assets_mount "$_assets_mnt"; then
		_first=$(factory_tokens_first_line "$_assets_mnt/TOKENS") || _first=""
		if [ -n "$_first" ]; then
			_peel_rc=0
			_pair=$(factory_peel_pairing_line_from_dir "$_assets_mnt") || _peel_rc=$?
			if [ "$_peel_rc" -eq 2 ]; then
				factory_assets_umount "$_assets_mnt"
				echo "Could not update the TOKENS magazine on LUNAASSETS. Stopped so the same pairing code is not used twice." >&2
				return 1
			fi
			if [ "$_peel_rc" -eq 0 ] && [ -n "$_pair" ]; then
				_uid="${_pair% *}"
				_code="${_pair#* }"
				factory_assets_umount "$_assets_mnt"
				if ! factory_write_pairing_material "$_root" "$_uid" "$_code"; then
					echo "Could not save the Device ID and Verification code onto Luna." >&2
					return 1
				fi
				echo "Device ID and Verification code taken from LUNAASSETS magazine."
				return 0
			fi
		fi
		factory_assets_umount "$_assets_mnt"
	else
		rmdir "$_assets_mnt" 2>/dev/null || true
	fi

	if [ -t 0 ]; then
		factory_prompt_pairing_material "$_root" || return 1
	fi
	return 0
}
