#!/bin/sh
# Factory stick helpers: LUNAASSETS partition + TOKENS magazine (dash-safe).
# Each official TOKENS line is one 20-character uppercase Crockford device
# token, such as 7K4M2Q9XR8N36T5W1PZH. A hand-edited line may be grouped,
# lowercase, or use look-alike letters: it is normalized before validating.

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

# Rewrite $1 without its first usable token line. Keeps blank lines and
# comments; drops only the first non-empty non-# line. Returns 1 on I/O failure.
factory_tokens_drop_first() {
	_file="$1"
	_tmp="${2:-$_file.tmp}"
	[ -f "$_file" ] || return 1
	_dropped=0
	: >"$_tmp" || return 1
	# `_drop_line`, not `_line`: the caller keeps the peeled line in `_line`
	# while this rewrite runs, and shell variables are global.
	while IFS= read -r _drop_line || [ -n "$_drop_line" ]; do
		if [ "$_dropped" -eq 0 ]; then
			_check=$(printf '%s' "$_drop_line" | tr -d '\r')
			_check=$(printf '%s' "$_check" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
			case "$_check" in
			"" | \#*)
				printf '%s\n' "$_drop_line" >>"$_tmp" || return 1
				continue
				;;
			esac
			_dropped=1
			continue
		fi
		printf '%s\n' "$_drop_line" >>"$_tmp" || return 1
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

# Normalize a manually entered device token for display-style groups and
# Crockford look-alikes. TOKENS lines do not use this normalization: their
# format is exact.
factory_normalize_device_token() {
	_norm=$(printf '%s' "$1" | tr -d '\r' | sed 's/[-_[:space:]]//g' | tr 'a-z' 'A-Z')
	_norm=$(printf '%s' "$_norm" | sed 's/I/1/g; s/L/1/g; s/O/0/g')
	printf '%s' "$_norm"
}

# True when $1 is an ungrouped uppercase 20-character Crockford device token.
factory_is_valid_device_token() {
	_tok="$1"
	[ "${#_tok}" -eq 20 ] || return 1
	case "$_tok" in
	*[!0123456789ABCDEFGHJKMNPQRSTVWXYZ]*) return 1 ;;
	esac
	return 0
}

# Validate one TOKENS line and print its token. The line is normalized first
# (dashes and spaces dropped, uppercased, I/L to 1, O to 0) and must then be
# exactly 20 Crockford characters.
factory_magazine_token() {
	_tok=$(factory_normalize_device_token "$1")
	factory_is_valid_device_token "$_tok" || return 1
	printf '%s\n' "$_tok"
}

# Peel the first valid token line from a mounted LUNAASSETS directory ($1).
# Malformed lines are consumed and skipped so one bad export does not block the
# next unit. On success prints the device token.
# Returns: 0 = peeled, 1 = no usable line, 2 = rewrite failed after peel intent.
factory_peel_token_from_dir() {
	_assets="$1"
	_tokens="$_assets/TOKENS"
	[ -f "$_tokens" ] || return 1
	while _peel_line=$(factory_tokens_first_line "$_tokens"); do
		if ! factory_tokens_drop_first "$_tokens"; then
			return 2
		fi
		if _peel_tok=$(factory_magazine_token "$_peel_line"); then
			printf '%s\n' "$_peel_tok"
			return 0
		fi
	done
	return 1
}

# Write the device token onto the mounted LUNA_DATA volume ($1), which is
# /var/lib/luna at runtime, as device-token with mode 0600.
factory_write_device_token() {
	_root="$1"
	_tok="$2"
	factory_is_valid_device_token "$_tok" || return 1
	mkdir -p "$_root" || return 1
	(umask 077; printf '%s\n' "$_tok" >"$_root/device-token") || return 1
	chmod 600 "$_root/device-token" || return 1
	return 0
}

# TTY prompt: one device token field. Empty Enter skips Connect; an invalid
# value re-prompts.
factory_prompt_device_token() {
	_root="$1"
	printf '%s\n' \
		"" \
		"Enter the device token from your quick-start card." \
		"You can also add or change it later in Settings → About → Advanced → Device token. Press Enter to set up without Luna Connect."
	while :; do
		printf '%s' "Device token: "
		if ! read -r _tok; then
			echo "No device token entered. Luna works fully without Luna Connect."
			return 0
		fi
		_tok=$(printf '%s' "$_tok" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		if [ -z "$_tok" ]; then
			echo "Skipped. You can add a device token later in Settings → About → Advanced → Device token."
			return 0
		fi
		_tok=$(factory_normalize_device_token "$_tok")
		if factory_is_valid_device_token "$_tok"; then
			break
		fi
		printf '%s\n' "Check the device token. It has 20 characters, usually shown in five groups of four."
	done
	if ! factory_write_device_token "$_root" "$_tok"; then
		echo "Could not save the device token onto Luna." >&2
		return 1
	fi
	echo "Device token saved."
	return 0
}

# Full post-flash path: peel from LUNAASSETS, else a device-token file on the
# installer USB, else prompt on a TTY.
# $1 = mounted LUNA_DATA volume. $2 = HERE (installer payload dir). Returns 0 on success/skip; 1 on hard failure
# (e.g. magazine rewrite failed).
factory_apply_device_token() {
	_root="$1"
	_here="${2:-}"
	_assets_mnt="$(mktemp -d)" || return 1
	if factory_assets_mount "$_assets_mnt"; then
		_peel_rc=0
		_tok=$(factory_peel_token_from_dir "$_assets_mnt") || _peel_rc=$?
		if [ "$_peel_rc" -eq 2 ]; then
			factory_assets_umount "$_assets_mnt"
			echo "Could not update the TOKENS magazine on LUNAASSETS. Stopped so the same device token is not used twice." >&2
			return 1
		fi
		if [ "$_peel_rc" -eq 0 ] && [ -n "$_tok" ]; then
			factory_assets_umount "$_assets_mnt"
			if ! factory_write_device_token "$_root" "$_tok"; then
				echo "Could not save the device token onto Luna." >&2
				return 1
			fi
			echo "Device token taken from LUNAASSETS magazine."
			return 0
		fi
		factory_assets_umount "$_assets_mnt"
	else
		rmdir "$_assets_mnt" 2>/dev/null || true
	fi

	_token_src=""
	for _c in "${_here:+$_here/device-token}" /src/device-token /iso/device-token; do
		if [ -n "$_c" ] && [ -f "$_c" ]; then
			_token_src="$_c"
			break
		fi
	done
	if [ -n "$_token_src" ]; then
		_usb=$(factory_normalize_device_token "$(cat "$_token_src")")
		if factory_is_valid_device_token "$_usb"; then
			if ! factory_write_device_token "$_root" "$_usb"; then
				echo "Could not save the device token onto Luna." >&2
				return 1
			fi
			echo "Device token saved from the installer USB."
			return 0
		fi
	fi

	if [ -t 0 ]; then
		factory_prompt_device_token "$_root" || return 1
	fi
	return 0
}
