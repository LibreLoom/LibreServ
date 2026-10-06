#!/bin/sh
# luna-run picks the newer of the data-dir and baked lunad. Pulls the script
# out of the rootfs fragment and checks its semver comparison against the
# shared feed fixtures, then checks the pick end to end with fake binaries.
set -eu

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
FRAG="$ROOT/os/lib/build-rootfs.d/01.frag"
CASES="$ROOT/../infra/feed-testdata/cases.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT INT
fail=0

# The script between <<'RUN' and RUN in the fragment.
sed -n "/<<'RUN'\$/,/^RUN\$/p" "$FRAG" | sed '1d;$d' >"$WORK/luna-run"
[ -s "$WORK/luna-run" ] || { echo "FAIL cannot find luna-run in $FRAG" >&2; exit 1; }
chmod +x "$WORK/luna-run"

LUNA_RUN_SOURCE_ONLY=1
export LUNA_RUN_SOURCE_ONLY
# shellcheck disable=SC1091
. "$WORK/luna-run"

expect_cmp() {
	_got=$(luna_semver_cmp "$1" "$2")
	if [ "$_got" != "$3" ]; then
		echo "FAIL luna_semver_cmp $1 $2 = $_got, want $3" >&2
		fail=$((fail + 1))
	fi
}

# Every pair from the fixtures' ascending list must order correctly.
if [ -f "$CASES" ]; then
	_list=$(sed -n '/"ascending"/,/\]/p' "$CASES" | grep -o '"[^"]*"' | tail -n +2 | tr -d '"')
	[ -n "$_list" ] || { echo "FAIL could not read the ascending list" >&2; exit 1; }
	_i=0
	for _a in $_list; do
		_j=0
		for _b in $_list; do
			if [ "$_i" -lt "$_j" ]; then _w=-1; elif [ "$_i" -gt "$_j" ]; then _w=1; else _w=0; fi
			expect_cmp "$_a" "$_b" "$_w"
			_j=$((_j + 1))
		done
		_i=$((_i + 1))
	done
	# Every fixture version must be valid; every invalid one rejected.
	for _v in $_list; do
		luna_semver_valid "$_v" || { echo "FAIL $_v should be valid" >&2; fail=$((fail + 1)); }
	done
	sed -n '/"invalid"/,/\]/p' "$CASES" | grep -o '"[^"]*"' | tail -n +2 | tr -d '"' >"$WORK/invalid" || true
	# Quoted entries with spaces and the empty string are checked below by hand.
	while IFS= read -r _v; do
		[ -n "$_v" ] || continue
		case $_v in *" "*) continue ;; esac
		if luna_semver_valid "$_v"; then
			echo "FAIL $_v should be rejected" >&2
			fail=$((fail + 1))
		fi
	done <"$WORK/invalid"
fi
for _v in " 1.0.0" "1.0.0 " "" "v1.0.0" "1.0.0-beta.01"; do
	if luna_semver_valid "$_v"; then echo "FAIL '$_v' should be rejected" >&2; fail=$((fail + 1)); fi
done

# Corner cases beyond the fixtures.
expect_cmp 1.0.0+build.5 1.0.0+other 0
expect_cmp 1.0.0-alpha 1.0.0-alpha.1 -1
expect_cmp 1.0.0-alpha.1 1.0.0-alpha.beta -1
expect_cmp 1.0.0-alpha.beta 1.0.0-beta -1
expect_cmp 1.0.0-beta.11 1.0.0-rc.1 -1
expect_cmp 10.0.0 9.0.0 1
expect_cmp 0.4.0-beta.9 0.4.0-beta.10 -1
expect_cmp 123456789012345678901234567890.0.0 99999999999999999999.0.0 1

# End to end: fake lunads that print a version (or something else).
fake() { # path, output, [exit status]
	printf '#!/bin/sh\n%s\nexit %s\n' "$2" "${3:-0}" >"$1"
	chmod +x "$1"
}
pick() { # data version output, baked output -> which one was chosen
	mkdir -p "$WORK/pick"
	rm -f "$WORK/pick/data" "$WORK/pick/baked"
	[ -z "$1" ] || fake "$WORK/pick/data" "$1" "${3:-0}"
	[ -z "$2" ] || fake "$WORK/pick/baked" "$2"
	DATA_LUNAD="$WORK/pick/data"
	BAKED_LUNAD="$WORK/pick/baked"
	luna_pick_lunad | sed "s|$WORK/pick/||"
}
expect_pick() {
	if [ "$1" != "$2" ]; then echo "FAIL $3: picked '$1', want '$2'" >&2; fail=$((fail + 1)); fi
}
expect_pick "$(pick 'echo 0.5.0' 'echo 0.4.0')" data "newer data-dir lunad wins"
expect_pick "$(pick 'echo 0.4.0' 'echo 0.5.0')" baked "a stale daemon-only update must not shadow a newer OS"
expect_pick "$(pick 'echo 0.4.0' 'echo 0.4.0')" baked "a tie goes to the baked one"
expect_pick "$(pick 'echo 0.4.0' 'echo 0.4.0-beta.2')" data "a release beats its beta"
expect_pick "$(pick '' 'echo 0.4.0')" baked "no data-dir lunad"
expect_pick "$(pick 'echo oops' 'echo 0.4.0')" baked "unparseable output falls back"
expect_pick "$(pick 'echo lunad 9.9.9' 'echo 0.4.0')" data "a trailing version field is read"
expect_pick "$(pick 'echo 9.9.9' 'echo 0.4.0' 3)" data "exit status is not trusted over output"
expect_pick "$(pick 'echo 1.2' 'echo 0.4.0')" baked "non-semver output falls back"
expect_pick "$(pick 'exit 1' 'echo 0.4.0' 1)" baked "a data-dir lunad that fails falls back"

if [ "$fail" -ne 0 ]; then
	echo "luna_run_test: $fail failure(s)" >&2
	exit 1
fi
echo "luna_run_test: ok"
