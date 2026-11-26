#!/bin/sh
# Unit tests for os/lib/factory-assets.sh — no root, no hardware.
set -eu
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
. "$HERE/factory-assets.sh"

fail=0
assert_eq() {
	_got="$1"
	_want="$2"
	_msg="$3"
	if [ "$_got" != "$_want" ]; then
		echo "FAIL $_msg: got '$_got' want '$_want'" >&2
		fail=$((fail + 1))
	fi
}

assert_true() {
	if ! "$@"; then
		echo "FAIL expected true: $*" >&2
		fail=$((fail + 1))
	fi
}

assert_false() {
	if "$@"; then
		echo "FAIL expected false: $*" >&2
		fail=$((fail + 1))
	fi
}

assert_mode() {
	_got="$(stat -c '%a' "$1")"
	_want="$2"
	_msg="$3"
	if [ "$_got" != "$_want" ]; then
		echo "FAIL $_msg: got mode $_got want $_want" >&2
		fail=$((fail + 1))
	fi
}

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT

UID1=7K4M2Q9XR8N36T5W1PZH
CODE1=A3F91C
UID2=ZZZZYYYYXXXXWWWWVVVV
CODE2=0B1C2D

# First usable line skips blanks and comments without normalizing the line.
cat >"$WORK/TOKENS" <<EOF
# header
   # also comment

$UID1 $CODE1
$UID2 $CODE2
EOF
assert_eq "$(factory_tokens_first_line "$WORK/TOKENS")" "$UID1 $CODE1" "first line skips comments"

# Drop first usable line; keep header comments and remaining pairing lines.
assert_true factory_tokens_drop_first "$WORK/TOKENS"
assert_eq "$(factory_tokens_first_line "$WORK/TOKENS")" "$UID2 $CODE2" "second peel after drop"
grep -q '^# header$' "$WORK/TOKENS" || {
	echo "FAIL comments before first pairing line should remain" >&2
	fail=$((fail + 1))
}
grep -q "$UID1" "$WORK/TOKENS" && {
	echo "FAIL first pairing line should be gone" >&2
	fail=$((fail + 1))
}

# Peel helper consumes and returns the exact pairing line.
mkdir -p "$WORK/assets"
printf '%s\n' "$UID1 $CODE1" "$UID2 $CODE2" >"$WORK/assets/TOKENS"
_got=$(factory_peel_pairing_line_from_dir "$WORK/assets")
assert_eq "$_got" "$UID1 $CODE1" "peel returns first pairing line"
assert_eq "$(factory_tokens_first_line "$WORK/assets/TOKENS")" "$UID2 $CODE2" "magazine advanced"

# Empty / comment-only magazine → no peel.
printf '%s\n' '# only comments' '' >"$WORK/assets/TOKENS"
assert_false factory_peel_pairing_line_from_dir "$WORK/assets"

# Missing TOKENS → no peel.
rm -f "$WORK/assets/TOKENS"
assert_false factory_peel_pairing_line_from_dir "$WORK/assets"

# Malformed lines are consumed; the next exact pairing line is still usable.
mkdir -p "$WORK/assets2"
printf '%s\n' 'not-a-valid-token' "$UID1 $CODE1" >"$WORK/assets2/TOKENS"
assert_eq "$(factory_peel_pairing_line_from_dir "$WORK/assets2")" "$UID1 $CODE1" "malformed line does not block the next unit"
assert_false test -s "$WORK/assets2/TOKENS"

# Leading/trailing whitespace is not silently canonicalized.
mkdir -p "$WORK/assets3"
printf '  %s  \n%s\n' "$UID1 $CODE1" "$UID2 $CODE2" >"$WORK/assets3/TOKENS"
assert_eq "$(factory_tokens_first_line "$WORK/assets3/TOKENS")" "  $UID1 $CODE1  " "first line preserves field whitespace"
assert_false factory_pairing_line "$(factory_tokens_first_line "$WORK/assets3/TOKENS")"
assert_eq "$(factory_peel_pairing_line_from_dir "$WORK/assets3")" "$UID2 $CODE2" "non-exact line is skipped"

# CR-stripped Windows line endings.
printf '%s %s\r\n%s %s\r\n' "$UID1" "$CODE1" "$UID2" "$CODE2" >"$WORK/crlf"
assert_eq "$(factory_tokens_first_line "$WORK/crlf")" "$UID1 $CODE1" "strip CR"

# Device ID and Verification code validation.
assert_true factory_is_valid_device_uid "$UID1"
assert_true factory_is_valid_pairing_code "$CODE1"
assert_false factory_is_valid_device_uid "7K4M-2Q9X-R8N3-6T5W-1PZH"
assert_false factory_is_valid_device_uid "7k4m2q9xr8n36t5w1pzh"
assert_false factory_is_valid_device_uid "${UID1%?}"
assert_false factory_is_valid_device_uid "${UID1}A"
assert_false factory_is_valid_device_uid "7K4M2Q9XR8N36T5W1PZI"
assert_false factory_is_valid_pairing_code "a3f91c"
assert_false factory_is_valid_pairing_code "A3F91"
assert_false factory_is_valid_pairing_code "A3F91CC"
assert_false factory_is_valid_pairing_code "A3F91G"

# Manual entry accepts display grouping, Crockford look-alikes, and lowercase.
assert_eq "$(factory_normalize_device_uid '7k4m-2q9x-r8n3-6t5w-1pzh')" "$UID1" "normalize manual Device ID"
assert_eq "$(factory_normalize_device_uid '7K4M-2Q9X-R8N3-6T5W-1PZH')" "$UID1" "keep a valid manual Device ID"
assert_eq "$(factory_normalize_device_uid '7K4M-2Q9X-R8N3-6T5W-IPZH')" "$UID1" "normalize Crockford look-alikes"

# TOKENS accepts exactly one literal space between two uppercase fields.
assert_eq "$(factory_pairing_line "$UID1 $CODE1")" "$UID1 $CODE1" "accept exact pairing line"
assert_false factory_pairing_line "$UID1  $CODE1"
_tab=$(printf '\t')
assert_false factory_pairing_line "$UID1$_tab$CODE1"
assert_false factory_pairing_line " $UID1 $CODE1"
assert_false factory_pairing_line "$UID1 $CODE1 "
assert_false factory_pairing_line "7K4M-2Q9X-R8N3-6T5W-1PZH $CODE1"
assert_false factory_pairing_line "7k4m2q9xr8n36t5w1pzh $CODE1"
assert_false factory_pairing_line "$UID1 a3f91c"
assert_false factory_pairing_line "$UID1"
assert_false factory_pairing_line "$UID1 $CODE1 extra"

# Write separate public Device ID and private Verification code files.
mkdir -p "$WORK/root"
assert_true factory_write_pairing_material "$WORK/root" "$UID1" "$CODE1"
assert_eq "$(cat "$WORK/root/device-uid")" "$UID1" "device-uid contents"
assert_eq "$(cat "$WORK/root/pairing-code")" "$CODE1" "pairing-code contents"
assert_mode "$WORK/root/pairing-code" 600 "pairing-code is private"
assert_mode "$WORK/root/device-uid" 644 "device-uid is public"
assert_false test -e "$WORK/root/device-token"
assert_false test -e "$WORK/root/setup-token"

# Invalid material is rejected rather than normalized into TOKENS files.
mkdir -p "$WORK/root-invalid"
assert_false factory_write_pairing_material "$WORK/root-invalid" "7K4M-2Q9X-R8N3-6T5W-1PZH" "$CODE1"
assert_false test -e "$WORK/root-invalid/device-uid"
assert_false test -e "$WORK/root-invalid/pairing-code"

# Full apply path writes both files from the magazine and reports both names.
mkdir -p "$WORK/magazine"
printf '%s\n' "$UID1 $CODE1" >"$WORK/magazine/TOKENS"
factory_assets_mount() { cp "$WORK/magazine/TOKENS" "$1/TOKENS"; }
factory_assets_umount() {
	rm -f "$1/TOKENS"
	rmdir "$1" 2>/dev/null || true
}
assert_true factory_apply_pairing_material "$WORK/applied" >"$WORK/apply.out"
assert_eq "$(cat "$WORK/applied/device-uid")" "$UID1" "apply writes device-uid"
assert_eq "$(cat "$WORK/applied/pairing-code")" "$CODE1" "apply writes pairing-code"
grep -q 'Device ID and Verification code taken from LUNAASSETS' "$WORK/apply.out" || {
	echo "FAIL apply message must name both pairing fields" >&2
	fail=$((fail + 1))
}

# Restore the real mount helpers after the full-apply stub.
# shellcheck disable=SC1091
. "$HERE/factory-assets.sh"

# Legacy one-shot device-token/setup-token files are ignored when no magazine
# or TTY is available. The caller's data-mount variable must not be clobbered.
mkdir -p "$WORK/payload" "$WORK/root2"
printf '%s\n' 'LEGACY-TOKEN-AAAA-BBBB-CCCC' >"$WORK/payload/device-token"
printf '%s\n' 'LEGACY-TOKEN-AAAA-BBBB-CCCC' >"$WORK/payload/setup-token"
factory_assets_device() { printf ''; }
_mnt=/sentinel-luna-data
assert_true factory_apply_pairing_material "$WORK/root2" </dev/null >/dev/null
assert_false test -e "$WORK/root2/device-token"
assert_false test -e "$WORK/root2/setup-token"
assert_false test -e "$WORK/root2/device-uid"
assert_false test -e "$WORK/root2/pairing-code"
assert_eq "$_mnt" "/sentinel-luna-data" "factory apply must not clobber caller _mnt"

# Manual prompts collect the fields separately and re-prompt only invalid input.
printf 'bad\n%s\nxyz\n%s\n' "$UID1" "$CODE1" |
	factory_prompt_pairing_material "$WORK/prompted" >"$WORK/prompt.out"
assert_eq "$(cat "$WORK/prompted/device-uid")" "$UID1" "prompt writes normalized Device ID"
assert_eq "$(cat "$WORK/prompted/pairing-code")" "$CODE1" "prompt writes uppercase Verification code"
grep -q 'Check the Device ID' "$WORK/prompt.out" || {
	echo "FAIL invalid Device ID must re-prompt" >&2
	fail=$((fail + 1))
}
grep -q 'Check the Verification code' "$WORK/prompt.out" || {
	echo "FAIL invalid Verification code must re-prompt" >&2
	fail=$((fail + 1))
}

# Empty Enter at Device ID skips Connect without creating either file.
printf '\n' | factory_prompt_pairing_material "$WORK/skipped" >"$WORK/skip.out"
assert_false test -e "$WORK/skipped/device-uid"
assert_false test -e "$WORK/skipped/pairing-code"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/factory-assets_test.sh ok"
