#!/bin/sh
# Behavioral guardrails for rapidinstall's dash-safe console wait.
# Debian live uses dash as /bin/sh; bash-only read -n/-t must never return.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
fail=0

assert_eq() {
	_msg="$1"
	_got="$2"
	_want="$3"
	if [ "$_got" != "$_want" ]; then
		echo "FAIL $_msg (got=$_got want=$_want)" >&2
		fail=$((fail + 1))
	fi
}

assert_ge() {
	_msg="$1"
	_got="$2"
	_want="$3"
	if [ "$_got" -lt "$_want" ]; then
		echo "FAIL $_msg (got=$_got want>=$_want)" >&2
		fail=$((fail + 1))
	fi
}

assert_ok() {
	_msg="$1"
	shift
	if ! "$@"; then
		echo "FAIL $_msg" >&2
		fail=$((fail + 1))
	fi
}

# dash rejects bash read flags immediately (the old ISO bug).
if command -v dash >/dev/null 2>&1; then
	_rc=0
	dash -c 'IFS= read -r -n 1 _' >/dev/null 2>&1 || _rc=$?
	assert_ok "dash read -n must fail (illegal option)" test "$_rc" -ne 0
fi

# timeout+dd with a silent fifo: no key → exit 124 after ~2s (not instant).
# Open the write end in the background so open(2) on the read end does not block forever.
_fifo="$(mktemp -u)"
mkfifo "$_fifo"
( sleep 10 >"$_fifo" ) &
_writer=$!
_start="$(date +%s)"
_rc=0
timeout 2 dd bs=1 count=1 of=/dev/null 2>/dev/null <"$_fifo" || _rc=$?
_elapsed=$(($(date +%s) - _start))
kill "$_writer" 2>/dev/null || true
wait "$_writer" 2>/dev/null || true
rm -f "$_fifo"
assert_eq "timeout+dd with no input must exit 124" "$_rc" "124"
assert_ge "timeout+dd with no input must wait ~2s" "$_elapsed" 1

# timeout+dd: key available → exit 0 quickly and consume one byte.
_rc=0
printf '7' | timeout 5 dd bs=1 count=1 of=/dev/null 2>/dev/null || _rc=$?
assert_eq "timeout+dd with a key must succeed" "$_rc" "0"

# rapidinstall source must use the fixed pattern.
assert_ok "rapidinstall must use timeout 5 dd" \
	grep -q 'timeout 5 dd bs=1 count=1' "$HERE/rapidinstall.sh"
assert_ok "rapidinstall must enable cbreak for single-key reads" \
	grep -q 'stty -icanon' "$HERE/rapidinstall.sh"
assert_ok "rapidinstall must not use read -n" \
	sh -c "! grep -q 'read -r -n' \"$HERE/rapidinstall.sh\""
assert_ok "rapidinstall must not use read -t" \
	sh -c "! grep -q 'read -r -t' \"$HERE/rapidinstall.sh\""

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/rapidinstall_wait_test.sh ok"
