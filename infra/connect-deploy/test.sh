#!/bin/bash
# Tests for infra/connect-deploy/deploy.sh: semver, signature/feed/part/download
# checks against infra/feed-testdata/cases.json, and stage-only runs of the real
# script against signed throwaway feeds. Needs bash, curl, jq, minisign, python3.
#
#   bash infra/connect-deploy/test.sh        (TMPDIR picks the scratch location)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA="$(cd "$HERE/../feed-testdata" && pwd)"
for tool in curl jq minisign python3; do
    command -v "$tool" >/dev/null 2>&1 || { echo "missing tool: $tool"; exit 2; }
done

# shellcheck source=deploy.sh
source "$HERE/deploy.sh"
set +e   # deploy.sh turned on -e; checks below handle failures themselves

WORK="$(mktemp -d)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  ok  $1"; }
bad() { fail=$((fail + 1)); echo "  FAIL $1"; [ -n "${2:-}" ] && echo "       $2"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected '$2', got '$3'"; fi; }

# Quiet the script's own logging while checking functions.
quiet() { log_info() { :; }; log_warn() { :; }; log_error() { :; }; log_step() { :; }; }
quiet

# --- HTTP server: www/generic -> feed-testdata/files/generic, plus built fixtures
WWW="$WORK/www"
mkdir -p "$WWW/feeds" "$WWW/pkg"
ln -s "$DATA/files/generic" "$WWW/generic"
PORT=0
for _ in 1 2 3 4 5 6 7 8; do
    PORT=$((20000 + RANDOM % 20000))
    python3 -I -m http.server "$PORT" --bind 127.0.0.1 --directory "$WWW" >/dev/null 2>&1 &
    SERVER_PID=$!
    for _ in $(seq 1 30); do
        curl -sf -o /dev/null "http://127.0.0.1:$PORT/" && break 2
        kill -0 "$SERVER_PID" 2>/dev/null || break
        sleep 0.1
    done
    SERVER_PID=""
done
[ -n "$SERVER_PID" ] || { echo "could not start the test web server"; exit 2; }
BASE="http://127.0.0.1:$PORT"

# ============================================================================
echo "semver"
while IFS= read -r v; do
    semver_valid "$v" && ok "valid: $v" || bad "valid: $v"
done < <(jq -r '.semver.ascending[]' "$DATA/cases.json")
while IFS= read -r v; do
    semver_valid "$v" && bad "invalid accepted: '$v'" || ok "invalid rejected: '$v'"
done < <(jq -r '.semver.invalid[]' "$DATA/cases.json")
mapfile -t asc < <(jq -r '.semver.ascending[]' "$DATA/cases.json")
for ((i = 0; i < ${#asc[@]}; i++)); do
    for ((j = 0; j < ${#asc[@]}; j++)); do
        want=0; [ "$i" -lt "$j" ] && want=-1; [ "$i" -gt "$j" ] && want=1
        got="$(semver_cmp "${asc[$i]}" "${asc[$j]}")"
        [ "$got" = "$want" ] || bad "cmp ${asc[$i]} vs ${asc[$j]}" "expected $want, got $got"
    done
done
ok "semver_cmp orders all ${#asc[@]} versions (all pairs)"
eq "build metadata ignored" 0 "$(semver_cmp 1.0.0+a 1.0.0+b)"

# ============================================================================
echo "cases.json (feed checks: signature, format, unit, channel, replay, part, version)"
# fixture urls look like http://feed-test.invalid/generic/<unit>/<ver>/<file>
TEST_URL_FROM="$(jq -r .url_base "$DATA/cases.json")"; TEST_URL_TO="$BASE"; export TEST_URL_FROM TEST_URL_TO
KEY="$DATA/$(jq -r .key "$DATA/cases.json")"
ncases="$(jq '.cases | length' "$DATA/cases.json")"

run_case() { # prints the outcome in the cases.json "expect" vocabulary
    local idx="$1" c feed sig unit chan seen part os arch inst
    c="$(jq -c ".cases[$idx]" "$DATA/cases.json")"
    feed="$DATA/$(jq -r .feed <<<"$c")"; sig="$DATA/$(jq -r .sig <<<"$c")"
    unit="$(jq -r .request.unit <<<"$c")"; chan="$(jq -r .request.channel <<<"$c")"
    seen="$(jq -r .request.newest_published_seen <<<"$c")"
    part="$(jq -r .request.part <<<"$c")"; os="$(jq -r .request.os <<<"$c")"
    arch="$(jq -r .request.arch <<<"$c")"; inst="$(jq -r .request.installed_version <<<"$c")"
    local d="$WORK/case-$idx"; mkdir -p "$d"
    cp "$feed" "$d/feed.json"; cp "$sig" "$d/feed.json.minisig"
    verify_sig "$d/feed.json" "$d/feed.json.minisig" "$KEY" || { echo "reject:$LAST_ERROR"; return; }
    check_feed "$unit" "$chan" "$d/feed.json" "$seen" || { echo "reject:$LAST_ERROR"; return; }
    select_part "$d/feed.json" "$part" "$os" "$arch" || { echo "reject:$LAST_ERROR"; return; }
    if [[ "$(jq -r .expect <<<"$c")" == download-* ]]; then
        if download_part "$PART" "$d"; then echo "download-ok"; else echo "download-fail:$LAST_ERROR"; fi
        return
    fi
    local v; v="$(jq -r .version "$d/feed.json")"
    if semver_valid "$inst" && [ "$(semver_cmp "$v" "$inst")" -le 0 ]; then echo "no-update"; else echo "update"; fi
}
for ((n = 0; n < ncases; n++)); do
    name="$(jq -r ".cases[$n].name" "$DATA/cases.json")"
    want="$(jq -r ".cases[$n].expect" "$DATA/cases.json")"
    eq "$name" "$want" "$(run_case "$n")"
done

echo "SHA256SUMS exact-name rule"
sums="$DATA/$(jq -r .sums.file "$DATA/cases.json")"; sumsig="$DATA/$(jq -r .sums.sig "$DATA/cases.json")"
verify_sig "$sums" "$sumsig" "$KEY" && ok "sums signature verifies" || bad "sums signature verifies"
while IFS=$'\t' read -r name file expect; do
    got="$(sums_lookup "$file" "$sums")"; [ -n "$got" ] || got="not-found"
    eq "$name" "$expect" "$got"
done < <(jq -r '.sums.cases[] | [.name, .file, .expect] | @tsv' "$DATA/cases.json")
printf '%s  *starred.bin\n' "$(printf x | sha256sum | cut -d' ' -f1)" >"$WORK/star.txt"
eq "leading * on the name is allowed" "$(printf x | sha256sum | cut -d' ' -f1)" "$(sums_lookup starred.bin "$WORK/star.txt")"

# ============================================================================
# Stage-only runs of the real script against feeds signed with a throwaway key.
echo "stage-only runs of deploy.sh"
TKEY="$WORK/t"; minisign -G -W -f -p "$TKEY.pub" -s "$TKEY.key" >/dev/null 2>&1 || { echo "minisign -G failed"; exit 2; }
# a second key that nothing trusts
minisign -G -W -f -p "$WORK/other.pub" -s "$WORK/other.key" >/dev/null 2>&1

# make_release UNIT VERSION: files under www/pkg/<unit>/<version>/ (sol layout: admin/ + customer/)
make_release() {
    local unit="$1" ver="$2" d="$WWW/pkg/$1/$2" w="$WORK/web-$1-$2"
    mkdir -p "$d" "$w/admin" "$w/customer"
    printf '#!/bin/sh\necho %s %s\n' "$unit" "$ver" >"$d/$unit-server-linux-amd64"
    echo "<html>$unit $ver admin" >"$w/admin/index.html"; echo "<html>customer" >"$w/customer/index.html"
    tar -czf "$d/$unit-web.tar.gz" -C "$w" admin customer
}
sign() { minisign -S -s "${2:-$TKEY.key}" -m "$1" -x "$1.minisig" >/dev/null 2>&1; }
# make_feed OUTDIR UNIT CHANNEL VERSION PUBLISHED [url-mode]  (feed at OUTDIR/<unit>/<channel>.json)
make_feed() {
    local out="$1" unit="$2" chan="$3" ver="$4" pub="$5" mode="${6:-}" d="$WWW/pkg/$2/$4"
    local sf="$d/$unit-server-linux-amd64" wf="$d/$unit-web.tar.gz"
    local su="$BASE/pkg/$unit/$ver/$unit-server-linux-amd64" wu="$BASE/pkg/$unit/$ver/$unit-web.tar.gz"
    local ssha wsha
    ssha="$(_sha256 "$sf")"; wsha="$(_sha256 "$wf")"
    [ "$mode" = shabad ] && ssha="$(printf 0%.0s $(seq 1 64))"
    local surls
    surls="$(jq -n --arg u "$su" '[$u]')"
    [ "$mode" = fallback ] && surls="$(jq -n --arg u "$su" --arg m "$BASE/missing/x" '[$m, $u]')"
    mkdir -p "$out/$unit"
    jq -n --arg unit "$unit" --arg chan "$chan" --arg ver "$ver" --arg pub "$pub" \
        --argjson ssz "$(stat -c %s "$sf")" --argjson wsz "$(stat -c %s "$wf")" \
        --arg ssha "$ssha" --arg wsha "$wsha" --argjson surls "$surls" --arg wu "$wu" \
        --arg sfile "$unit-server-linux-amd64" --arg wfile "$unit-web.tar.gz" '{
        format: 1, unit: $unit, channel: $chan, version: $ver, published: $pub, notes: "t",
        parts: [
          {name: "server", os: "linux", arch: "amd64", file: $sfile, size: $ssz, sha256: $ssha, urls: $surls},
          {name: "web", os: "any", arch: "any", file: $wfile, size: $wsz, sha256: $wsha, urls: [$wu]}]}' \
        >"$out/$unit/$chan.json"
    sign "$out/$unit/$chan.json"
}

make_release sol-connect 0.2.0
make_release sol-connect 0.3.0
make_release luna-connect 0.2.0
FEEDS="$WWW/feeds"

# stage UNIT [args...]: runs deploy.sh stage-only; sets OUT (combined output) and RC
stage() {
    local unit="$1"; shift
    local sd="$WORK/stage-$RANDOM" st="${STATE:-$WORK/state-$RANDOM}"
    OUT="$(env STAGE_ONLY=1 STAGE_DIR="$sd" STATE_DIR="$st" KEY_FILE="${KEYF:-$TKEY.pub}" \
        FEED_BASE="$BASE/feeds" PACKAGE_BASE="$BASE/pkg" "$HERE/deploy.sh" "$unit" "$@" 2>&1)"
    RC=$?; LASTSTAGE="$sd"
}
expect_ok()   { stage "${@:2}"; if [ "$RC" -eq 0 ]; then ok "$1"; else bad "$1" "rc=$RC: $(tail -3 <<<"$OUT")"; fi; }
expect_fail() { # NAME PATTERN unit args...
    local name="$1" pat="$2"; shift 2; stage "$@"
    if [ "$RC" -ne 0 ] && grep -q -- "$pat" <<<"$OUT"; then ok "$name"; else bad "$name" "rc=$RC: $(tail -3 <<<"$OUT")"; fi
}

make_feed "$FEEDS" sol-connect stable 0.3.0 2026-10-12T14:03:00Z
STATE=""; expect_ok "feed: good stable feed stages sol-connect" sol-connect
eq "feed: staged version printed" "0.3.0" "$(tail -1 <<<"$OUT" | sed 's/\x1b\[[0-9;]*m//g')"
[ -x "$LASTSTAGE/server" ] && [ -f "$LASTSTAGE/web/admin/index.html" ] && [ -f "$LASTSTAGE/web/customer/index.html" ] \
    && ok "feed: server and web bundle staged" || bad "feed: server and web bundle staged"

# luna feed: web root is the web dir itself (index.html at top)
make_luna_release() {
    local d="$WWW/pkg/luna-connect/$1" w="$WORK/lweb-$1"
    mkdir -p "$d" "$w"; echo "<html>luna" >"$w/index.html"
    printf '#!/bin/sh\n' >"$d/luna-connect-server-linux-amd64"
    tar -czf "$d/luna-connect-web.tar.gz" -C "$w" index.html
}
make_luna_release 0.2.0
make_feed "$FEEDS" luna-connect stable 0.2.0 2026-10-12T14:03:00Z
expect_ok "feed: good luna-connect feed stages" luna-connect
[ -f "$LASTSTAGE/web/index.html" ] && ok "feed: luna web bundle unpacked at web root" || bad "feed: luna web bundle unpacked at web root"

make_feed "$FEEDS" sol-connect beta 0.3.0 2026-10-12T14:03:00Z
STATE=""; expect_ok "feed: --channel beta" sol-connect --channel beta

# bad signature: tampered bytes, and a feed signed by an untrusted key
mkdir -p "$FEEDS/t1/sol-connect"; cp "$FEEDS/sol-connect/stable.json" "$FEEDS/t1/sol-connect/stable.json"
cp "$FEEDS/sol-connect/stable.json.minisig" "$FEEDS/t1/sol-connect/stable.json.minisig"
sed -i 's/"t"/"tampered"/' "$FEEDS/t1/sol-connect/stable.json"
stage_fb() { # FEEDSUBDIR unit args...
    local sub="$1"; shift; local sd="$WORK/stage-$RANDOM" st="${STATE:-$WORK/state-$RANDOM}"
    OUT="$(env STAGE_ONLY=1 STAGE_DIR="$sd" STATE_DIR="$st" KEY_FILE="${KEYF:-$TKEY.pub}" \
        FEED_BASE="$BASE/feeds/$sub" PACKAGE_BASE="$BASE/pkg" "$HERE/deploy.sh" "$@" 2>&1)"; RC=$?; LASTSTAGE="$sd"
}
check_fb() { local name="$1" pat="$2"; if [ "$RC" -ne 0 ] && grep -q -- "$pat" <<<"$OUT"; then ok "$name"; else bad "$name" "rc=$RC: $(tail -3 <<<"$OUT")"; fi; }

STATE=""; stage_fb t1 sol-connect; check_fb "feed: tampered feed rejected (bad signature)" "Signature check failed"
make_feed "$FEEDS/t2" sol-connect stable 0.3.0 2026-10-12T14:03:00Z; sign "$FEEDS/t2/sol-connect/stable.json" "$WORK/other.key"
STATE=""; stage_fb t2 sol-connect; check_fb "feed: feed signed by another key rejected" "Signature check failed"

# wrong unit: a luna-connect feed served as sol-connect's
mkdir -p "$FEEDS/t3/sol-connect"; cp "$FEEDS/luna-connect/stable.json" "$FEEDS/t3/sol-connect/stable.json"
cp "$FEEDS/luna-connect/stable.json.minisig" "$FEEDS/t3/sol-connect/stable.json.minisig"
STATE=""; stage_fb t3 sol-connect; check_fb "feed: wrong unit rejected" "different unit"

# replay: a newer published time already seen
STATE="$WORK/state-replay"; mkdir -p "$STATE/sol-connect"; echo 2026-10-13T00:00:00Z >"$STATE/sol-connect/published-stable"
stage sol-connect; check_fb "feed: replayed (older published) rejected" "older"
STATE="$WORK/state-same"; mkdir -p "$STATE/sol-connect"; echo 2026-10-12T14:03:00Z >"$STATE/sol-connect/published-stable"
expect_ok "feed: equal published is accepted" sol-connect

# up to date / older than installed
STATE="$WORK/state-cur"; mkdir -p "$STATE/sol-connect"; echo 0.3.0 >"$STATE/sol-connect/installed-version"
stage sol-connect; if [ "$RC" -eq 0 ] && grep -q "up to date" <<<"$OUT" && [ ! -e "$LASTSTAGE/server" ]; then ok "feed: same version is a no-op"; else bad "feed: same version is a no-op" "$OUT"; fi
echo 0.4.0 >"$STATE/sol-connect/installed-version"
stage sol-connect; if [ "$RC" -eq 0 ] && grep -q "up to date" <<<"$OUT"; then ok "feed: lower version is never installed"; else bad "feed: lower version is never installed" "$OUT"; fi
echo 0.3.0-beta.10 >"$STATE/sol-connect/installed-version"
stage sol-connect; [ "$RC" -eq 0 ] && [ -x "$LASTSTAGE/server" ] && ok "feed: beta.10 -> 0.3.0 installs" || bad "feed: beta.10 -> 0.3.0 installs" "$OUT"
echo head-abc123 >"$STATE/sol-connect/installed-version"
stage sol-connect; [ "$RC" -eq 0 ] && [ -x "$LASTSTAGE/server" ] && ok "feed: after a --head deploy the feed installs" || bad "feed: after a --head deploy the feed installs" "$OUT"
[ ! -e "$STATE/sol-connect/published-stable.tmp" ] && ok "feed: stage-only leaves state untouched" || bad "feed: stage-only state"
eq "feed: stage-only wrote no published state" "" "$(cat "$STATE/sol-connect/published-stable" 2>/dev/null)"

# sha mismatch, url fallback
make_feed "$FEEDS/t4" sol-connect stable 0.3.0 2026-10-12T14:03:00Z shabad
STATE=""; stage_fb t4 sol-connect; check_fb "feed: sha256 mismatch rejected" "sha-mismatch"
make_feed "$FEEDS/t5" sol-connect stable 0.3.0 2026-10-12T14:03:00Z fallback
STATE=""; stage_fb t5 sol-connect; [ "$RC" -eq 0 ] && ok "feed: first url 404 falls back to the second" || bad "feed: url fallback" "$OUT"

# the shared fixture feed (uses the TEST-ONLY key and feed-test.invalid urls): downloads
# and checks pass; the payload is not a real archive, so unpacking is what stops it.
mkdir -p "$FEEDS/fixture/sol-connect"; cp "$DATA/sol-connect-stable.json" "$FEEDS/fixture/sol-connect/stable.json"
cp "$DATA/sol-connect-stable.json.minisig" "$FEEDS/fixture/sol-connect/stable.json.minisig"
STATE=""; KEYF="$KEY" stage_fb fixture sol-connect
if [ "$RC" -ne 0 ] && grep -q "Downloading sol-connect-web.tar.gz" <<<"$OUT" && grep -q "not a readable" <<<"$OUT"; then ok "feed: fixture feed verifies and downloads; fake archive refused"; else bad "feed: fixture feed" "$OUT"; fi

# ---- --version
mkdir -p "$WWW/pkg/sol-connect/0.2.0"
write_sums() { # unit ver [extra decoy lines]
    local d="$WWW/pkg/$1/$2"
    ( cd "$d" && { sha256sum "$1-server-linux-amd64" "$1-web.tar.gz"; echo "$(printf y | sha256sum | cut -d' ' -f1)  old-$1-server-linux-amd64"; } >SHA256SUMS.txt )
    sign "$d/SHA256SUMS.txt"
}
write_sums sol-connect 0.2.0
write_sums sol-connect 0.3.0
STATE=""; expect_ok "version: exact 0.2.0 via SHA256SUMS" sol-connect --version 0.2.0
[ "$(tail -1 <<<"$OUT" | sed 's/\x1b\[[0-9;]*m//g')" = "0.2.0" ] && [ -x "$LASTSTAGE/server" ] && ok "version: staged 0.2.0" || bad "version: staged 0.2.0" "$OUT"
STATE="$WORK/state-v"; mkdir -p "$STATE/sol-connect"; echo 0.3.0 >"$STATE/sol-connect/installed-version"
stage sol-connect --version 0.2.0; check_fb "version: older than installed needs --allow-downgrade" "allow-downgrade"
expect_ok "version: --allow-downgrade permits the older version" sol-connect --version 0.2.0 --allow-downgrade
stage sol-connect --version 0.3.0; check_fb "version: same as installed needs --allow-downgrade" "allow-downgrade"
STATE=""; stage sol-connect --version v0.2.0; check_fb "version: invalid version string rejected" "not a valid version"
stage sol-connect --version 9.9.9; check_fb "version: unknown version fails to download" "Could not download"
# bad signature on the sums
cp "$WWW/pkg/sol-connect/0.2.0/SHA256SUMS.txt" "$WORK/sums.bak"; echo "x" >>"$WWW/pkg/sol-connect/0.2.0/SHA256SUMS.txt"
stage sol-connect --version 0.2.0; check_fb "version: tampered SHA256SUMS rejected" "Signature check failed"
cp "$WORK/sums.bak" "$WWW/pkg/sol-connect/0.2.0/SHA256SUMS.txt"
# sha mismatch: payload changed after signing the sums
echo "tamper" >>"$WWW/pkg/sol-connect/0.2.0/sol-connect-server-linux-amd64"
stage sol-connect --version 0.2.0; check_fb "version: payload not matching the sums rejected" "sha-mismatch"
# a name that is only a substring match does not count
( cd "$WWW/pkg/sol-connect/0.2.0" && grep -v " sol-connect-web.tar.gz" SHA256SUMS.txt | sed 's/  sol-connect-server/  old-sol-connect-server/' >S2 && mv S2 SHA256SUMS.txt && sign SHA256SUMS.txt )
stage sol-connect --version 0.2.0; check_fb "version: only a decoy/substring name in the sums -> missing" "no entry for"

# ---- argument handling
stage sol-connect --tag connect-v1.0.0; check_fb "args: retired --tag refused" "retired"
stage nope; check_fb "args: unknown unit refused" "Unknown unit"
stage sol-connect --version 0.2.0 --head; check_fb "args: --version with --head refused" "cannot be combined"
stage sol-connect --channel nightly; check_fb "args: bad channel refused" "stable or beta"

echo ""
echo "Results: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
