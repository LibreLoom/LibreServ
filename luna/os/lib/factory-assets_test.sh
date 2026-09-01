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

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT

# First usable line skips blanks and comments.
cat >"$WORK/TOKENS" <<'EOF'
# header
   # also comment

AAAA-BBBB-CCCC-DDDD-EEEE
FFFF-GGGG-HHHH-JJJJ-KKKK
EOF
assert_eq "$(factory_tokens_first_line "$WORK/TOKENS")" "AAAA-BBBB-CCCC-DDDD-EEEE" "first line skips comments"

# Drop first usable line; keep header comments and remaining tokens.
assert_true factory_tokens_drop_first "$WORK/TOKENS"
assert_eq "$(factory_tokens_first_line "$WORK/TOKENS")" "FFFF-GGGG-HHHH-JJJJ-KKKK" "second peel after drop"
grep -q '^# header$' "$WORK/TOKENS" || {
	echo "FAIL comments before first token should remain" >&2
	fail=$((fail + 1))
}
grep -q 'AAAA-BBBB' "$WORK/TOKENS" && {
	echo "FAIL first token should be gone" >&2
	fail=$((fail + 1))
}

# Peel helper consumes and returns token.
mkdir -p "$WORK/assets"
printf '%s\n' 'ONE-TOKEN-AAAA-BBBB-CCCC' 'TWO-TOKEN-DDDD-EEEE-FFFF' >"$WORK/assets/TOKENS"
_got=$(factory_peel_token_from_dir "$WORK/assets")
assert_eq "$_got" "ONE-TOKEN-AAAA-BBBB-CCCC" "peel returns first token"
assert_eq "$(factory_tokens_first_line "$WORK/assets/TOKENS")" "TWO-TOKEN-DDDD-EEEE-FFFF" "magazine advanced"

# Empty / comment-only magazine → no peel.
printf '%s\n' '# only comments' '' >"$WORK/assets/TOKENS"
assert_false factory_peel_token_from_dir "$WORK/assets"

# Missing TOKENS → no peel.
rm -f "$WORK/assets/TOKENS"
assert_false factory_peel_token_from_dir "$WORK/assets"

# Write device-token onto a fake LUNA_DATA volume (contents of /var/lib/luna).
mkdir -p "$WORK/root"
assert_true factory_write_device_token "$WORK/root" "ZZZZ-YYYY-XXXX-WWWW-VVVV"
assert_eq "$(cat "$WORK/root/device-token")" "ZZZZ-YYYY-XXXX-WWWW-VVVV" "device-token contents"

# Legacy one-shot setup-token when LUNAASSETS is absent (no blkid label).
mkdir -p "$WORK/payload" "$WORK/root2"
printf '%s\n' 'LEGACY-TOKEN-AAAA-BBBB-CCCC' >"$WORK/payload/setup-token"
# Override device lookup so apply does not try a real mount.
factory_assets_device() { printf ''; }
_mnt=/sentinel-luna-data
assert_true factory_apply_device_token "$WORK/root2" "$WORK/payload" >/dev/null
assert_eq "$(cat "$WORK/root2/device-token")" "LEGACY-TOKEN-AAAA-BBBB-CCCC" "legacy setup-token fallback"
assert_eq "$_mnt" "/sentinel-luna-data" "factory_apply must not clobber caller _mnt (Wyse os-image.sha256 cp)"

# CR-stripped Windows line endings.
printf 'CRLF-TOKEN-1111-2222-3333\r\nNEXT-TOKEN-4444-5555-6666\r\n' >"$WORK/crlf"
assert_eq "$(factory_tokens_first_line "$WORK/crlf")" "CRLF-TOKEN-1111-2222-3333" "strip CR"

# Device token validation (Crockford format, 16–32 chars normalized).
assert_true factory_is_valid_device_token "AAAA-BBBB-CCCC-DDDD-EEEE"
assert_true factory_is_valid_device_token "aaaa-bbbb-cccc-dddd-eeee"
assert_false factory_is_valid_device_token "too-short"
assert_false factory_is_valid_device_token "XXXX@YYYY-ZZZZ-OOOO-WWWW-QQQQ"

# Invalid MAG top line is not peeled — magazine unchanged.
mkdir -p "$WORK/assets2"
printf '%s\n' 'not-a-valid-token' 'AAAA-BBBB-CCCC-DDDD-EEEE' >"$WORK/assets2/TOKENS"
assert_false factory_peel_token_from_dir "$WORK/assets2"
assert_eq "$(factory_tokens_first_line "$WORK/assets2/TOKENS")" "not-a-valid-token" "invalid mag line kept"

if [ "$fail" -ne 0 ]; then
	echo "$fail failed" >&2
	exit 1
fi
echo "os/lib/factory-assets_test.sh ok"
