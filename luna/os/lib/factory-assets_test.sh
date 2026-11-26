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

TOK1=7K4M2Q9XR8N36T5W1PZH
TOK2=ZZZZYYYYXXXXWWWWVVVV

# First usable line skips blanks and comments without normalizing the line.
cat >"$WORK/TOKENS" <<EOF
# header
   # also comment

$TOK1
$TOK2
EOF
assert_eq "$(factory_tokens_first_line "$WORK/TOKENS")" "$TOK1" "first line skips comments"

# Drop first usable line; keep header comments and remaining token lines.
assert_true factory_tokens_drop_first "$WORK/TOKENS"
assert_eq "$(factory_tokens_first_line "$WORK/TOKENS")" "$TOK2" "second peel after drop"
grep -q '^# header$' "$WORK/TOKENS" || {
	echo "FAIL comments before first token should remain" >&2
	fail=$((fail + 1))
}
grep -q "$TOK1" "$WORK/TOKENS" && {
	echo "FAIL first token should be gone" >&2
	fail=$((fail + 1))
}

# Peel helper consumes and returns the exact token.
mkdir -p "$WORK/assets"
printf '%s\n' "$TOK1" "$TOK2" >"$WORK/assets/TOKENS"
_got=$(factory_peel_token_from_dir "$WORK/assets")
assert_eq "$_got" "$TOK1" "peel returns first token"
assert_eq "$(factory_tokens_first_line "$WORK/assets/TOKENS")" "$TOK2" "magazine advanced"

# Empty / comment-only magazine: no peel.
printf '%s\n' '# only comments' '' >"$WORK/assets/TOKENS"
assert_false factory_peel_token_from_dir "$WORK/assets"

# Missing TOKENS: no peel.
rm -f "$WORK/assets/TOKENS"
assert_false factory_peel_token_from_dir "$WORK/assets"

# Malformed lines are consumed; the next exact token is still usable.
mkdir -p "$WORK/assets2"
printf '%s\n' 'not-a-valid-token' "$TOK1" >"$WORK/assets2/TOKENS"
assert_eq "$(factory_peel_token_from_dir "$WORK/assets2")" "$TOK1" "malformed line does not block the next unit"
assert_false test -s "$WORK/assets2/TOKENS"

# The old two-field pairing format is malformed now and is consumed.
mkdir -p "$WORK/assets-old"
printf '%s\n' "$TOK1 A3F91C" "$TOK2" >"$WORK/assets-old/TOKENS"
assert_eq "$(factory_peel_token_from_dir "$WORK/assets-old")" "$TOK2" "two-field line is skipped"

# Leading/trailing whitespace is not silently canonicalized.
mkdir -p "$WORK/assets3"
printf '  %s  \n%s\n' "$TOK1" "$TOK2" >"$WORK/assets3/TOKENS"
assert_eq "$(factory_tokens_first_line "$WORK/assets3/TOKENS")" "  $TOK1  " "first line preserves field whitespace"
assert_false factory_magazine_token "  $TOK1  "
assert_eq "$(factory_peel_token_from_dir "$WORK/assets3")" "$TOK2" "non-exact line is skipped"

# CR-stripped Windows line endings.
printf '%s\r\n%s\r\n' "$TOK1" "$TOK2" >"$WORK/crlf"
assert_eq "$(factory_tokens_first_line "$WORK/crlf")" "$TOK1" "strip CR"
assert_eq "$(factory_magazine_token "$(factory_tokens_first_line "$WORK/crlf")")" "$TOK1" "CR-stripped line is a token"

# Token validation: exactly 20 uppercase Crockford characters, no grouping.
assert_true factory_is_valid_device_token "$TOK1"
assert_false factory_is_valid_device_token "7K4M-2Q9X-R8N3-6T5W-1PZH"
assert_false factory_is_valid_device_token "7k4m2q9xr8n36t5w1pzh"
assert_false factory_is_valid_device_token "${TOK1%?}"
assert_false factory_is_valid_device_token "${TOK1}A"
assert_false factory_is_valid_device_token "7K4M2Q9XR8N36T5W1PZI"
assert_false factory_is_valid_device_token "7K4M2Q9XR8N36T5W1PZU"
assert_false factory_is_valid_device_token "A3F91C"

# Manual entry accepts display grouping, Crockford look-alikes, and lowercase.
assert_eq "$(factory_normalize_device_token '7k4m-2q9x-r8n3-6t5w-1pzh')" "$TOK1" "normalize manual token"
assert_eq "$(factory_normalize_device_token '7K4M-2Q9X-R8N3-6T5W-1PZH')" "$TOK1" "keep a valid manual token"
assert_eq "$(factory_normalize_device_token '7K4M-2Q9X-R8N3-6T5W-IPZH')" "$TOK1" "normalize Crockford look-alikes"

# TOKENS lines are exact: one token, nothing else.
assert_eq "$(factory_magazine_token "$TOK1")" "$TOK1" "accept exact token line"
assert_false factory_magazine_token "7K4M-2Q9X-R8N3-6T5W-1PZH"
assert_false factory_magazine_token "7k4m2q9xr8n36t5w1pzh"
assert_false factory_magazine_token "$TOK1 A3F91C"
assert_false factory_magazine_token "$TOK1 "

# Write device-token onto the fake LUNA_DATA volume with mode 0600.
mkdir -p "$WORK/root"
assert_true factory_write_device_token "$WORK/root" "$TOK1"
assert_eq "$(cat "$WORK/root/device-token")" "$TOK1" "device-token contents"
assert_mode "$WORK/root/device-token" 600 "device-token is private"
assert_false test -e "$WORK/root/device-uid"
assert_false test -e "$WORK/root/pairing-code"
assert_false test -e "$WORK/root/setup-token"

# Invalid token is rejected and nothing is written.
mkdir -p "$WORK/root-invalid"
assert_false factory_write_device_token "$WORK/root-invalid" "7K4M-2Q9X-R8N3-6T5W-1PZH"
assert_false test -e "$WORK/root-invalid/device-token"

# Full apply path writes the token from the magazine.
mkdir -p "$WORK/magazine"
printf '%s\n' "$TOK1" >"$WORK/magazine/TOKENS"
factory_assets_mount() { cp "$WORK/magazine/TOKENS" "$1/TOKENS"; }
factory_assets_umount() {
	rm -f "$1/TOKENS"
	rmdir "$1" 2>/dev/null || true
}
assert_true factory_apply_device_token "$WORK/applied" >"$WORK/apply.out"
assert_eq "$(cat "$WORK/applied/device-token")" "$TOK1" "apply writes device-token"
assert_mode "$WORK/applied/device-token" 600 "apply writes device-token privately"
grep -q 'Device token taken from LUNAASSETS' "$WORK/apply.out" || {
	echo "FAIL apply message must name the device token" >&2
	fail=$((fail + 1))
}

# Restore the real mount helpers after the full-apply stub.
# shellcheck disable=SC1091
. "$HERE/factory-assets.sh"

# Without a magazine or a TTY, apply writes nothing. Legacy device-token and
# setup-token files on the installer payload are never read.
mkdir -p "$WORK/payload" "$WORK/root2"
printf '%s\n' 'LEGACY-TOKEN-AAAA-BBBB-CCCC' >"$WORK/payload/device-token"
printf '%s\n' 'LEGACY-TOKEN-AAAA-BBBB-CCCC' >"$WORK/payload/setup-token"
factory_assets_device() { printf ''; }
_mnt=/sentinel-luna-data
assert_true factory_apply_device_token "$WORK/root2" </dev/null >/dev/null
assert_false test -e "$WORK/root2/device-token"
assert_false test -e "$WORK/root2/setup-token"
assert_eq "$_mnt" "/sentinel-luna-data" "factory apply must not clobber caller _mnt"

# Manual prompt takes one grouped, lowercase value and re-prompts on bad input.
printf 'bad\n%s\n' "7k4m-2q9x-r8n3-6t5w-1pzh" |
	factory_prompt_device_token "$WORK/prompted" >"$WORK/prompt.out"
assert_eq "$(cat "$WORK/prompted/device-token")" "$TOK1" "prompt writes the normalized token"
grep -q 'Check the device token' "$WORK/prompt.out" || {
	echo "FAIL invalid device token must re-prompt" >&2
	fail=$((fail + 1))
}

# Empty Enter skips Connect without creating the file.
printf '\n' | factory_prompt_device_token "$WORK/skipped" >"$WORK/skip.out"
assert_false test -e "$WORK/skipped/device-token"

# Whitespace-only input also skips.
printf '   \n' | factory_prompt_device_token "$WORK/skipped2" >"$WORK/skip2.out"
assert_false test -e "$WORK/skipped2/device-token"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/factory-assets_test.sh ok"
