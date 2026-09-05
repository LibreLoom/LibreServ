#!/bin/sh
# Physical-console helpers for the rapidinstall live ISO (dash-safe).
# PID 1 with init= often has no controlling tty. Talk to /dev/console (the
# kernel console the user is already looking at). Do not chvt to tty1: if the
# switch fails or lags, the 5s disk-override prompt is printed off-screen.

# Redirect this shell's stdin/stdout/stderr onto the kernel console.
# Safe to call more than once. Does not exec a new process.
# If we already have a tty (interactive test, or start.sh attached us),
# leave fds alone.
attach_installer_console() {
	if [ -t 0 ] && [ -t 1 ]; then
		return 0
	fi
	_dev=""
	if [ -c /dev/console ]; then
		_dev=/dev/console
	elif [ -c /dev/tty0 ]; then
		_dev=/dev/tty0
	elif [ -c /dev/tty1 ]; then
		_dev=/dev/tty1
	fi
	[ -n "$_dev" ] || return 1
	exec <"$_dev" >"$_dev" 2>&1 || return 1
	if command -v stty >/dev/null 2>&1; then
		stty sane 2>/dev/null || true
	fi
	return 0
}

console_cbreak() {
	# Deliver each key immediately — default cooked mode waits for Enter.
	stty -icanon min 1 time 0 -echo 2>/dev/null || true
}

console_sane() {
	stty sane 2>/dev/null || true
}

# One byte from stdin. Dash-safe — no bash read -n/-t.
read_console_byte() {
	dd bs=1 count=1 2>/dev/null
}

_timeout_dd() {
	_dur="$1"
	if ! command -v timeout >/dev/null 2>&1; then
		return 127
	fi
	# --foreground: GNU timeout otherwise puts dd in a new process
	# group, so a TTY read can get EIO instantly (no 5s wait).
	if [ -z "${_TIMEOUT_HAS_FG:-}" ]; then
		if timeout --foreground 0.01 true >/dev/null 2>&1; then
			_TIMEOUT_HAS_FG=1
		else
			_TIMEOUT_HAS_FG=0
		fi
	fi
	if [ "$_TIMEOUT_HAS_FG" = 1 ]; then
		timeout --foreground "$_dur" dd bs=1 count=1 of=/dev/null 2>/dev/null
		return $?
	fi
	timeout "$_dur" dd bs=1 count=1 of=/dev/null 2>/dev/null
	return $?
}

drain_stdin() {
	# Discard leftover keys (GRUB Enter, etc.) so they do not skip the wait.
	console_cbreak
	while :; do
		_timeout_dd 0.05 || break
	done
}

# Wait up to $1 seconds (default 5) for a key.
# Returns 0 if a key was pressed, 1 if the window elapsed.
# Always consumes about that many seconds unless a key is pressed — never
# skip the window just because stdin is not a tty.
wait_override_key() {
	_secs="${1:-5}"
	# Caller (rapidinstall/start.sh) must already have attached the console.
	# Do not exec onto /dev/console here — tests source this file.
	if [ -t 0 ] && command -v timeout >/dev/null 2>&1; then
		console_cbreak
		drain_stdin
		_i=0
		_got=1
		while [ "$_i" -lt "$_secs" ]; do
			_left=$((_secs - _i))
			printf '\rDo nothing for %s seconds to continue. Press any key to pick another disk. ' "$_left"
			if _timeout_dd 1; then
				_got=0
				break
			fi
			_i=$((_i + 1))
		done
		printf '\n'
		console_sane
		return "$_got"
	fi
	# No console or no timeout: still pause so flash never starts instantly.
	_i=0
	while [ "$_i" -lt "$_secs" ]; do
		_left=$((_secs - _i))
		printf '\rDo nothing for %s seconds to continue. Press any key to pick another disk. ' "$_left"
		sleep 1
		_i=$((_i + 1))
	done
	printf '\n'
	return 1
}

# After the disk is chosen: type INSTALL and press Enter, or shut down.
# QEMU / automation may set LUNA_CONFIRM=INSTALL on the kernel command line.
confirm_install() {
	_disk="$1"
	if [ "${LUNA_CONFIRM:-}" = "INSTALL" ]; then
		echo "Confirm override set (LUNA_CONFIRM=INSTALL). Continuing."
		return 0
	fi
	# Drop leftover single-key presses from the disk picker, then restore
	# line mode so INSTALL + Enter works with echo.
	drain_stdin
	console_sane
	echo
	echo "Luna will erase $_disk and install. This cannot be undone."
	echo "Type INSTALL (all capital letters) and press Enter to continue."
	echo "Anything else shuts this computer down."
	printf "Confirm: "
	_confirm=""
	IFS= read -r _confirm || true
	# Strip CR from USB keyboards that send CR+LF.
	_confirm="$(printf '%s' "$_confirm" | tr -d '\r')"
	if [ "$_confirm" = "INSTALL" ]; then
		return 0
	fi
	echo
	echo "That was not INSTALL. Shutting down."
	sync
	if command -v poweroff >/dev/null 2>&1; then
		exec poweroff -f
	fi
	if [ -x /sbin/poweroff ]; then
		exec /sbin/poweroff -f
	fi
	if command -v halt >/dev/null 2>&1; then
		exec halt -f
	fi
	exit 1
}
