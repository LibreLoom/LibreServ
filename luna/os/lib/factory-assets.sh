#!/bin/sh
# Factory stick helpers: LUNAASSETS partition + TOKENS magazine (dash-safe).
# Official booklet codes live one-per-line in TOKENS on the writable FAT
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
factory_assets_mount() {
	_mnt="$1"
	_dev="$(factory_assets_device)"
	[ -n "$_dev" ] || return 1
	[ -b "$_dev" ] || return 1
	mkdir -p "$_mnt" || return 1
	mount -t vfat -o rw,utf8,umask=000 "$_dev" "$_mnt" 2>/dev/null \
		|| mount -o rw,umask=000 "$_dev" "$_mnt" 2>/dev/null \
		|| return 1
	return 0
}

factory_assets_umount() {
	_mnt="$1"
	umount "$_mnt" 2>/dev/null || true
	rmdir "$_mnt" 2>/dev/null || true
}

# Peel one token from a mounted LUNAASSETS directory ($1).
# On success prints the token and removes it from TOKENS.
# Returns: 0 = peeled, 1 = no magazine / empty, 2 = rewrite failed after peel intent.
factory_peel_token_from_dir() {
	_assets="$1"
	_tokens="$_assets/TOKENS"
	[ -f "$_tokens" ] || return 1
	_tok="$(factory_tokens_first_line "$_tokens")" || return 1
	[ -n "$_tok" ] || return 1
	if ! factory_tokens_drop_first "$_tokens"; then
		return 2
	fi
	printf '%s\n' "$_tok"
	return 0
}

# Write official setup code onto a mounted Luna root ($1).
factory_write_setup_token() {
	_root="$1"
	_tok="$2"
	mkdir -p "$_root/var/lib/luna" || return 1
	printf '%s\n' "$_tok" >"$_root/var/lib/luna/setup-token" || return 1
	chmod 600 "$_root/var/lib/luna/setup-token" || return 1
	return 0
}

# Full post-flash path: peel from LUNAASSETS, else legacy setup-token paths, else TTY paste.
# $1 = mounted Luna root. $2 = HERE (installer payload dir).
# Returns 0 on success/skip; 1 on hard failure (e.g. mag rewrite failed).
factory_apply_setup_token() {
	_root="$1"
	_here="${2:-}"
	_assets_mnt="$(mktemp -d)" || return 1
	if factory_assets_mount "$_assets_mnt"; then
		_peel_rc=0
		_tok=$(factory_peel_token_from_dir "$_assets_mnt") || _peel_rc=$?
		factory_assets_umount "$_assets_mnt"
		if [ "$_peel_rc" -eq 2 ]; then
			echo "Could not update the TOKENS magazine on LUNAASSETS. Stopped so the same code is not used twice." >&2
			return 1
		fi
		if [ "$_peel_rc" -eq 0 ] && [ -n "$_tok" ]; then
			if ! factory_write_setup_token "$_root" "$_tok"; then
				echo "Could not save the official setup code onto Luna." >&2
				return 1
			fi
			echo "Official setup code taken from LUNAASSETS magazine."
			return 0
		fi
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
		mkdir -p "$_root/var/lib/luna" || return 1
		cp "$_token_src" "$_root/var/lib/luna/setup-token" || return 1
		chmod 600 "$_root/var/lib/luna/setup-token" || return 1
		echo "Official setup code saved from the installer USB."
		return 0
	fi

	if [ -t 0 ]; then
		echo
		echo "Official setup code from Luna Connect. Paste it and press Enter, or press Enter to skip."
		# shellcheck disable=SC2162
		read _tok || _tok=""
		if [ -n "$_tok" ]; then
			if ! factory_write_setup_token "$_root" "$_tok"; then
				echo "Could not save the setup code onto Luna." >&2
				return 1
			fi
			echo "Setup code saved."
		else
			echo "Skipped. This install is local-only until you enter a code in Luna."
		fi
	fi
	return 0
}
