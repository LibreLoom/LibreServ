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

assert_le() {
	_msg="$1"
	_got="$2"
	_want="$3"
	if [ "$_got" -gt "$_want" ]; then
		echo "FAIL $_msg (got=$_got want<=$_want)" >&2
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
_fifo="$(mktemp -u)"
mkfifo "$_fifo"
( sleep 10 >"$_fifo" ) &
_writer=$!
_start="$(date +%s)"
_rc=0
timeout --foreground 2 dd bs=1 count=1 of=/dev/null 2>/dev/null <"$_fifo" || _rc=$?
_elapsed=$(($(date +%s) - _start))
kill "$_writer" 2>/dev/null || true
wait "$_writer" 2>/dev/null || true
rm -f "$_fifo"
assert_eq "timeout --foreground +dd with no input must exit 124" "$_rc" "124"
assert_ge "timeout --foreground +dd with no input must wait ~2s" "$_elapsed" 1

_rc=0
printf '7' | timeout --foreground 5 dd bs=1 count=1 of=/dev/null 2>/dev/null || _rc=$?
assert_eq "timeout --foreground +dd with a key must succeed" "$_rc" "0"

# stdin is not a tty (/dev/null): wait_override_key must still pause, not
# treat EOF as a key and not skip the window.
# shellcheck disable=SC1091
. "$HERE/lib/console.sh"
_start="$(date +%s)"
_rc=0
wait_override_key 2 </dev/null >/dev/null || _rc=$?
_elapsed=$(($(date +%s) - _start))
assert_eq "wait_override_key on /dev/null must time out (not treat EOF as a key)" "$_rc" "1"
assert_ge "wait_override_key on /dev/null must wait ~2s" "$_elapsed" 1
assert_le "wait_override_key on /dev/null must not hang" "$_elapsed" 4

# On a real tty, the countdown text must be printed (the ISO bug: prompt never
# appeared because output went to tty1 after chvt).
_pty_out="$(mktemp)"
_pty_elapsed="$(python3 - "$_pty_out" "$HERE/lib/console.sh" <<'PY'
import os, pty, sys, time, select
out_path, console_sh = sys.argv[1], sys.argv[2]
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.setsid()
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    if slave > 2:
        os.close(slave)
    os.execvp("sh", ["sh", "-c",
        '. "%s"; wait_override_key 3' % console_sh])
os.close(slave)
start = time.time()
buf = b""
while time.time() - start < 8:
    r, _, _ = select.select([master], [], [], 0.1)
    if master in r:
        try:
            chunk = os.read(master, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
    wpid, _ = os.waitpid(pid, os.WNOHANG)
    if wpid:
        t0 = time.time()
        while time.time() - t0 < 0.3:
            r, _, _ = select.select([master], [], [], 0.05)
            if master not in r:
                break
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            buf += chunk
        break
else:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
open(out_path, "wb").write(buf)
print(int(round(time.time() - start)))
PY
)"
assert_ok "wait_override_key on a tty must print the override prompt" \
	grep -q 'Press any key to pick another disk' "$_pty_out"
assert_ge "wait_override_key on a tty must wait ~3s" "$_pty_elapsed" 2
rm -f "$_pty_out"

assert_ok "rapidinstall must source console.sh" \
	grep -q 'lib/console.sh' "$HERE/rapidinstall.sh"
assert_ok "rapidinstall must call wait_override_key" \
	grep -q 'wait_override_key' "$HERE/rapidinstall.sh"
assert_ok "console wait must use timeout --foreground" \
	grep -q 'timeout --foreground' "$HERE/lib/console.sh"
assert_ok "rapidinstall must not skip wait on [ -t 0 ]" \
	sh -c "! grep -q 'if \\[ -t 0 \\] && command -v timeout' \"$HERE/rapidinstall.sh\""
assert_ok "rapidinstall must not use read -n" \
	sh -c "! grep -q 'read -r -n' \"$HERE/rapidinstall.sh\""
assert_ok "rapidinstall must not use read -t" \
	sh -c "! grep -q 'read -r -t' \"$HERE/rapidinstall.sh\""

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/rapidinstall_wait_test.sh ok"
