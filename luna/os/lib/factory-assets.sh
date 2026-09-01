#!/bin/sh
# Factory stick helpers: LUNAASSETS partition + TOKENS magazine (dash-safe).
# Official setup codes (purchased from LibreLoom) live one-per-line in TOKENS on the writable FAT
# partition labeled LUNAASSETS. Each flash peels the first usable line.

# Print first non-empty, non-# line from $1. Returns 1 if none.
factory_tokens_first_line() {
	_file="$1"
	[ -f "$_file" ] || return 1
	while IFS= read -r _line || [ -n "$_line" ]; do
		# Trim CR (FAT / Windows editors) and leading/trailing spaces.
		_line=$(printf '%s' "$_line" | tr -d '\r')
		_line=$(printf '%s' "$_line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		case "$_line" in
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

# Peel one token from a mounted LUNAASSETS directory ($1).
# On success prints the token and removes it from TOKENS.
# Returns: 0 = peeled, 1 = no magazine / empty / invalid top line, 2 = rewrite failed after peel intent.
factory_peel_token_from_dir() {
	_assets="$1"
	_tokens="$_assets/TOKENS"
	[ -f "$_tokens" ] || return 1
	_tok="$(factory_tokens_first_line "$_tokens")" || return 1
	[ -n "$_tok" ] || return 1
	if ! factory_is_valid_device_token "$_tok"; then
		return 1
	fi
	if ! factory_tokens_drop_first "$_tokens"; then
		return 2
	fi
	printf '%s\n' "$_tok"
	return 0
}

# Normalize a device token like lunad (Crockford base32, drop separators).
factory_normalize_device_token() {
	_norm=$(printf '%s' "$1" | tr -d '\r' | sed 's/[- _]//g' | tr 'a-z' 'A-Z')
	_norm=$(printf '%s' "$_norm" | sed 's/I/1/g; s/L/1/g; s/O/0/g')
	printf '%s' "$_norm"
}

# True when $1 is a plausible Luna Connect device token (16–32 Crockford chars).
factory_is_valid_device_token() {
	_norm=$(factory_normalize_device_token "$1")
	_len=${#_norm}
	[ "$_len" -ge 16 ] && [ "$_len" -le 32 ] || return 1
	case "$_norm" in
	*[!0123456789ABCDEFGHJKMNPQRSTVWXYZ]*) return 1 ;;
	esac
	return 0
}

# Write device token onto the mounted LUNA_DATA volume ($1).
# At runtime that volume is mounted at /var/lib/luna → /var/lib/luna/setup-token.
factory_write_setup_token() {
	_root="$1"
	_tok="$2"
	mkdir -p "$_root" || return 1
	printf '%s\n' "$_tok" >"$_root/setup-token" || return 1
	chmod 600 "$_root/setup-token" || return 1
	return 0
}

# TTY prompt: valid token saved, empty Enter skips, invalid re-prompts.
factory_prompt_device_token() {
	_root="$1"
	printf '%s\n' \
		"" \
		"Type your device token from Luna Connect and press enter now for the best experience." \
		"Go to https://connect.luna.libreloom.org to get started." \
		"LibreServ Luna is offline-first, though, so all functionality is available without our service, which is open-source and exists to make remote access & cloud backup configuration easy." \
		"If you would like to opt-out for now, you can just press enter, leaving the field empty."
	while :; do
		printf '%s' ">>> "
		# shellcheck disable=SC2162
		read _tok || _tok=""
		_tok=$(printf '%s' "$_tok" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
		if [ -z "$_tok" ]; then
			echo "Skipped. Luna Connect is off until you add a device token in Luna."
			return 0
		fi
		if ! factory_is_valid_device_token "$_tok"; then
			printf '%s\n' \
				"Check your token. If you meant to skip this step, press enter without typing anything."
			continue
		fi
		if ! factory_write_setup_token "$_root" "$_tok"; then
			echo "Could not save the device token onto Luna." >&2
			return 1
		fi
		echo "Device token saved."
		return 0
	done
}

# Full post-flash path: peel from LUNAASSETS, else legacy setup-token paths, else TTY paste.
# $1 = mounted LUNA_DATA volume. $2 = HERE (installer payload dir).
# Returns 0 on success/skip; 1 on hard failure (e.g. mag rewrite failed).
factory_apply_setup_token() {
	_root="$1"
	_here="${2:-}"
	_assets_mnt="$(mktemp -d)" || return 1
	if factory_assets_mount "$_assets_mnt"; then
		_peel_rc=0
		_first=$(factory_tokens_first_line "$_assets_mnt/TOKENS") || _first=""
		if [ -n "$_first" ] && factory_is_valid_device_token "$_first"; then
			_tok=$(factory_peel_token_from_dir "$_assets_mnt") || _peel_rc=$?
			if [ "$_peel_rc" -eq 2 ]; then
				factory_assets_umount "$_assets_mnt"
				echo "Could not update the TOKENS magazine on LUNAASSETS. Stopped so the same code is not used twice." >&2
				return 1
			fi
			if [ "$_peel_rc" -eq 0 ] && [ -n "$_tok" ]; then
				factory_assets_umount "$_assets_mnt"
				if ! factory_write_setup_token "$_root" "$_tok"; then
					echo "Could not save the device token onto Luna." >&2
					return 1
				fi
				echo "Device token taken from LUNAASSETS magazine."
				return 0
			fi
		fi
		factory_assets_umount "$_assets_mnt"
	else
		rmdir "$_assets_mnt" 2>/dev/null || true
	fi

	_token_src=""
	for _c in "$_here/setup-token" /src/setup-token /iso/setup-token; do
		if [ -f "$_c" ]; then
			_token_src="$_c"
			break
		fi
	done
	if [ -n "$_token_src" ]; then
		_legacy=$(cat "$_token_src")
		if factory_is_valid_device_token "$_legacy"; then
			mkdir -p "$_root" || return 1
			cp "$_token_src" "$_root/setup-token" || return 1
			chmod 600 "$_root/setup-token" || return 1
			echo "Device token saved from the installer USB."
			return 0
		fi
	fi

	if [ -t 0 ]; then
		factory_prompt_device_token "$_root" || return 1
	fi
	return 0
}
