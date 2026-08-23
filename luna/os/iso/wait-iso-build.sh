#!/bin/sh
# Wait for make-iso / live-build to finish. Exits immediately on success or failure.
# Usage: os/iso/wait-iso-build.sh [logfile] [max_seconds]
set -eu

LOG="${1:-/tmp/debian-iso-host.log}"
MAX="${2:-7200}"
INTERVAL=10

_ok_pat='^built .*/luna-rapidinstall-.*\.iso'
_fail_pat='^ERROR:|^E: |Unable to locate package|cp: cannot stat|isohybrid: not found|apt-ftparchive: not found|Couldn.t download packages|.rsvg.: No such file|cannot open binary/isolinux/bootlogo|live-build did not produce|lb build failed|ISO build failed|does not have a Release file|Cannot install into target|Operation not permitted|404 Not Found|unexpected end of file|gzip: stdin|die "'

_elapsed=0
while [ "$_elapsed" -lt "$MAX" ]; do
	if [ -f "$LOG" ]; then
		if grep -qE "$_ok_pat" "$LOG" 2>/dev/null; then
			grep -E "$_ok_pat" "$LOG" | tail -1
			exit 0
		fi
		if grep -qE "$_fail_pat" "$LOG" 2>/dev/null; then
			echo "FAIL (see $LOG)" >&2
			tail -30 "$LOG" >&2
			exit 1
		fi
	fi
	if ! pgrep -xf ".*(lb build|make-iso\.sh|build-debian-live\.sh).*" >/dev/null 2>&1; then
		if [ -f "$LOG" ] && grep -qE "$_ok_pat" "$LOG" 2>/dev/null; then
			grep -E "$_ok_pat" "$LOG" | tail -1
			exit 0
		fi
		echo "FAIL: build process exited without success marker (see $LOG)" >&2
		tail -30 "$LOG" 2>/dev/null >&2 || true
		exit 1
	fi
	sleep "$INTERVAL"
	_elapsed=$((_elapsed + INTERVAL))
done

echo "FAIL: timed out after ${MAX}s (see $LOG)" >&2
tail -30 "$LOG" 2>/dev/null >&2 || true
exit 1
