#!/bin/bash
# Shared zero-downtime deploy for the Connect servers (sol-connect, luna-connect).
#
#   deploy.sh <unit> [--channel stable|beta]        newest signed release from the feed (default)
#   deploy.sh <unit> --version X.Y.Z                one exact release, via its signed SHA256SUMS.txt
#   deploy.sh <unit> --head [--no-pull|--branch N]  build from this checkout (dev)
#
# Units: sol-connect, luna-connect (settings in units/<unit>.conf).
#
# Feed and --version paths download the prebuilt server binary and web bundle
# and check them (minisign signature, size, sha256); nothing is built on the
# server. Both then swap blue/green: drain one instance, swap binary + web
# bundle, start, health-check (roll back on failure), then the other.
#
# Options:
#   --channel stable|beta   feed channel (default stable)
#   --version X.Y.Z         exact version; must be newer than installed unless --allow-downgrade
#   --allow-downgrade       permit --version to install the same or an older version
#   --head                  build from the current checkout (keeps the old behavior of each script)
#   --no-pull               with --head: do not fetch/reset the checkout first (luna-connect)
#   --branch NAME           with --head: reset to origin/NAME and build it
#   --force                 recovery: skip peer-health gates (luna-connect soft drain)
#   --stage-only            fetch, verify, download and unpack, then stop before touching
#                           systemd or the install dir; writes no state; needs no root
#   -h, --help
#
# Environment (all optional; mainly for tests):
#   FEED_BASE     default https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds
#   PACKAGE_BASE  default https://gt.plainskill.net/api/packages/LibreLoom/generic
#   KEY_FILE      minisign public key; default keys/<unit key> in this checkout
#   STATE_DIR     default /var/lib/connect-deploy (<unit>/installed-version, <unit>/published-<channel>)
#   STAGE_DIR     default <install dir>/.deploy-stage (must share a filesystem with the install dir)
#   STAGE_ONLY=1  same as --stage-only
#   TEST_URL_FROM / TEST_URL_TO   rewrite a URL prefix after verification (tests only)
#
# The signing key is read from this checkout (keys/), so keep the checkout current
# (git pull) before deploying. Retired: connect-v* / luna-connect-v* tags, --tag, --latest-tag.

set -euo pipefail
export LC_ALL=C

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export PATH="/usr/local/go/bin:${PATH:-/usr/bin:/bin}"

FEED_BASE="${FEED_BASE:-https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds}"
PACKAGE_BASE="${PACKAGE_BASE:-https://gt.plainskill.net/api/packages/LibreLoom/generic}"
STATE_DIR="${STATE_DIR:-/var/lib/connect-deploy}"
STAGE_ONLY="${STAGE_ONLY:-0}"
HEALTH_TIMEOUT=30
FORCE_DEPLOY=0
LAST_ERROR=""   # machine-readable reason of the last failed check (see feed-testdata/README.md)
PART=""         # part JSON chosen by select_part
DL_PATH=""      # path of the file download_part/download_checked just wrote

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1" >&2; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }
log_step()  { echo -e "${BLUE}[STEP]${NC} $1" >&2; }

usage() { sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' | sed '$d'; }

# --- Strict semver (2.0) -----------------------------------------------------

_SV_ID='(0|[1-9][0-9]*)'
_SV_PRE='(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
_SV_RE="^${_SV_ID}\\.${_SV_ID}\\.${_SV_ID}(-${_SV_PRE}(\\.${_SV_PRE})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?\$"

semver_valid() { [[ "${1:-}" =~ $_SV_RE ]]; }

# Compare two non-negative integers without leading zeros: -1, 0 or 1.
_numcmp() {
    if [ "${#1}" -ne "${#2}" ]; then
        [ "${#1}" -lt "${#2}" ] && echo -1 || echo 1
    elif [ "$1" = "$2" ]; then echo 0
    elif [[ "$1" < "$2" ]]; then echo -1
    else echo 1
    fi
}

# semver_cmp A B -> -1 (A<B), 0, 1. Both must be valid. Build metadata ignored.
semver_cmp() {
    local a="${1%%+*}" b="${2%%+*}" ca cb pa="" pb="" r i
    ca="${a%%-*}"; cb="${b%%-*}"
    [[ "$a" == *-* ]] && pa="${a#*-}"
    [[ "$b" == *-* ]] && pb="${b#*-}"
    local -a xa xb
    IFS=. read -ra xa <<<"$ca"
    IFS=. read -ra xb <<<"$cb"
    for i in 0 1 2; do
        r="$(_numcmp "${xa[$i]}" "${xb[$i]}")"
        [ "$r" != 0 ] && { echo "$r"; return 0; }
    done
    if [ -z "$pa" ] && [ -z "$pb" ]; then echo 0; return 0; fi
    if [ -z "$pa" ]; then echo 1; return 0; fi
    if [ -z "$pb" ]; then echo -1; return 0; fi
    IFS=. read -ra xa <<<"$pa"
    IFS=. read -ra xb <<<"$pb"
    local n="${#xa[@]}" x y
    [ "${#xb[@]}" -gt "$n" ] && n="${#xb[@]}"
    for ((i = 0; i < n; i++)); do
        [ "$i" -ge "${#xa[@]}" ] && { echo -1; return 0; }
        [ "$i" -ge "${#xb[@]}" ] && { echo 1; return 0; }
        x="${xa[$i]}"; y="${xb[$i]}"
        if [[ "$x" =~ ^[0-9]+$ ]] && [[ "$y" =~ ^[0-9]+$ ]]; then
            r="$(_numcmp "$x" "$y")"
        elif [[ "$x" =~ ^[0-9]+$ ]]; then r=-1
        elif [[ "$y" =~ ^[0-9]+$ ]]; then r=1
        elif [ "$x" = "$y" ]; then r=0
        elif [[ "$x" < "$y" ]]; then r=-1
        else r=1
        fi
        [ "$r" != 0 ] && { echo "$r"; return 0; }
    done
    echo 0
}

# --- Fetch, verify, select, download (reusable; tests source this file) ------

# Prefix rewrite applied to download URLs only after the feed was verified.
rewrite_url() {
    local u="$1"
    if [ -n "${TEST_URL_FROM:-}" ] && [[ "$u" == "$TEST_URL_FROM"* ]]; then
        u="${TEST_URL_TO:-}${u#"$TEST_URL_FROM"}"
    fi
    printf '%s' "$u"
}

http_get() { curl -fsSL --retry 2 --connect-timeout 15 --max-time 600 -o "$2" "$1"; }

# fetch_signed URL OUT: URL -> OUT and URL.minisig -> OUT.minisig
fetch_signed() {
    LAST_ERROR=""
    if ! http_get "$1" "$2" || ! http_get "$1.minisig" "$2.minisig"; then
        LAST_ERROR="fetch-failed"
        log_error "Could not download $1 (and its .minisig)"
        return 1
    fi
}

# verify_sig FILE SIG KEYFILE: minisign over the exact bytes of FILE.
verify_sig() {
    LAST_ERROR=""
    if ! command -v minisign >/dev/null 2>&1; then
        LAST_ERROR="no-minisign"
        log_error "minisign is not installed"
        return 1
    fi
    if ! minisign -Vm "$1" -x "$2" -p "$3" >/dev/null 2>&1; then
        LAST_ERROR="bad-signature"
        log_error "Signature check failed for $(basename "$1")"
        return 1
    fi
}

# check_feed UNIT CHANNEL FEEDFILE NEWEST_SEEN: format, unit, channel, replay.
# Run verify_sig first. On failure LAST_ERROR is unknown-format | bad-feed |
# wrong-unit | wrong-channel | replayed.
check_feed() {
    local unit="$1" channel="$2" file="$3" seen="${4:-}" v
    LAST_ERROR=""
    if ! jq -e 'type == "object" and .format == 1' "$file" >/dev/null 2>&1; then
        LAST_ERROR="unknown-format"
        log_error "This feed uses a format this script does not understand"
        return 1
    fi
    if [ "$(jq -r '.unit // ""' "$file")" != "$unit" ]; then
        LAST_ERROR="wrong-unit"; log_error "Feed is for a different unit than ${unit}"; return 1
    fi
    if [ "$(jq -r '.channel // ""' "$file")" != "$channel" ]; then
        LAST_ERROR="wrong-channel"; log_error "Feed is for a different channel than ${channel}"; return 1
    fi
    v="$(jq -r '.version // ""' "$file")"
    if ! semver_valid "$v"; then
        LAST_ERROR="bad-feed"; log_error "Feed version is not valid semver: ${v}"; return 1
    fi
    local pub
    pub="$(jq -r '.published // ""' "$file")"
    if ! [[ "$pub" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
        LAST_ERROR="bad-feed"; log_error "Feed has no valid published time"; return 1
    fi
    if [ -n "$seen" ] && [[ "$pub" < "$seen" ]]; then
        LAST_ERROR="replayed"
        log_error "Feed is older (${pub}) than the newest one already seen (${seen}); refusing a replayed feed"
        return 1
    fi
}

# select_part FEEDFILE NAME OS ARCH -> sets PART (JSON); LAST_ERROR=missing-part if none.
select_part() {
    local part
    LAST_ERROR=""
    PART=""
    part="$(jq -c --arg n "$2" --arg os "$3" --arg arch "$4" '
        [.parts[]? | select(.name == $n and (.os == $os or .os == "any") and (.arch == $arch or .arch == "any"))]
        | first // empty' "$1")" || part=""
    if [ -z "$part" ]; then
        LAST_ERROR="missing-part"
        log_error "Feed has no '$2' part for $3/$4"
        return 1
    fi
    PART="$part"
}

_sha256() { sha256sum "$1" | cut -d' ' -f1; }

# download_checked URL DEST SIZE SHA256: SIZE may be empty (skipped). On failure
# LAST_ERROR is all-urls-failed | size-mismatch | sha-mismatch.
_check_file() {
    local f="$1" size="$2" sha="$3"
    if [ -n "$size" ] && [ "$(stat -c %s "$f")" != "$size" ]; then
        LAST_ERROR="size-mismatch"; return 1
    fi
    if [ "$(_sha256 "$f")" != "$sha" ]; then
        LAST_ERROR="sha-mismatch"; return 1
    fi
}

# download_part PARTJSON DESTDIR: tries urls in order; sets DL_PATH.
download_part() {
    local part="$1" dir="$2" file size sha url dest tmp try_err=""
    LAST_ERROR=""
    file="$(jq -r '.file // ""' <<<"$part")"
    size="$(jq -r '.size // ""' <<<"$part")"
    sha="$(jq -r '.sha256 // ""' <<<"$part")"
    if ! [[ "$file" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "$file" == .* ]] || ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
        LAST_ERROR="bad-feed"; log_error "Feed part has an invalid file name or sha256"; return 1
    fi
    dest="$dir/$file"
    tmp="$dest.part"
    while IFS= read -r url; do
        [ -n "$url" ] || continue
        url="$(rewrite_url "$url")"
        log_info "  Downloading ${file} from ${url}"
        if ! http_get "$url" "$tmp"; then
            log_warn "  Download failed, trying the next address"
            continue
        fi
        if _check_file "$tmp" "$size" "$sha"; then
            mv -f "$tmp" "$dest"
            DL_PATH="$dest"
            LAST_ERROR=""
            return 0
        fi
        try_err="$LAST_ERROR"
        rm -f "$tmp"
        log_error "  ${file} from ${url} failed its ${try_err} check"
        # A corrupt copy is final: do not accept a different address after seeing bad bytes.
        LAST_ERROR="$try_err"
        return 1
    done < <(jq -r '.urls[]? // empty' <<<"$part")
    LAST_ERROR="all-urls-failed"
    log_error "Could not download ${file} from any address"
    return 1
}

# sums_lookup FILENAME SUMSFILE -> sha256 of the line whose name field equals FILENAME exactly.
sums_lookup() {
    awk -v f="$1" '{ n = $2; sub(/^\*/, "", n); if (n == f) { print $1; exit } }' "$2"
}

# --- Unit config, state ------------------------------------------------------

load_unit() {
    UNIT="$1"
    if ! [[ "$UNIT" =~ ^[a-z][a-z-]*$ ]] || [ ! -f "$SCRIPT_DIR/units/$UNIT.conf" ]; then
        log_error "Unknown unit '${UNIT}'. Known: $(basename -a "$SCRIPT_DIR"/units/*.conf | sed 's/\.conf$//' | tr '\n' ' ')"
        return 1
    fi
    # shellcheck source=/dev/null
    source "$SCRIPT_DIR/units/$UNIT.conf"
    KEY_FILE="${KEY_FILE:-$REPO_ROOT/keys/$KEY_NAME}"
    STAGE_DIR="${STAGE_DIR:-$INSTALL_DIR/.deploy-stage}"
}

state_path() { echo "$STATE_DIR/$UNIT/$1"; }
read_state() { local f; f="$(state_path "$1")"; [ -f "$f" ] && head -n1 "$f" || true; }
write_state() {
    mkdir -p "$STATE_DIR/$UNIT"
    printf '%s\n' "$2" >"$(state_path "$1").tmp"
    mv -f "$(state_path "$1").tmp" "$(state_path "$1")"
}

# --- Staging: leaves $STAGE_DIR/server and $STAGE_DIR/web ready ---------------

# Unpack the web bundle into $2 after refusing unsafe or incomplete archives.
unpack_web() {
    local tarball="$1" dest="$2" req listing
    LAST_ERROR=""
    if ! listing="$(tar -tzf "$tarball" 2>/dev/null)"; then
        LAST_ERROR="bad-archive"; log_error "The web bundle is not a readable .tar.gz"; return 1
    fi
    if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$listing"; then
        LAST_ERROR="bad-archive"; log_error "The web bundle has unsafe paths"; return 1
    fi
    rm -rf "$dest"
    mkdir -p "$dest"
    tar -xzf "$tarball" -C "$dest" --no-same-owner --no-same-permissions
    for req in "${WEB_REQUIRE[@]}"; do
        if [ ! -e "$dest/$req" ]; then
            LAST_ERROR="bad-archive"
            log_error "The web bundle is missing '${req}'"
            return 1
        fi
    done
}

stage_artifacts() { # SERVERFILE WEBTARBALL
    local srv="$1" tarball="$2"
    mv -f "$srv" "$STAGE_DIR/server"
    chmod 755 "$STAGE_DIR/server"
    unpack_web "$tarball" "$STAGE_DIR/web"
}

# stage_from_feed CHANNEL. Sets STAGED_VERSION, NO_UPDATE=1 when already current.
stage_from_feed() {
    local channel="$1" feed="$STAGE_DIR/feed.json" seen pub version installed
    log_step "Fetching ${UNIT} ${channel} feed"
    fetch_signed "$FEED_BASE/$UNIT/$channel.json" "$feed" || return 1
    verify_sig "$feed" "$feed.minisig" "$KEY_FILE" || return 1
    seen="$(read_state "published-$channel")"
    check_feed "$UNIT" "$channel" "$feed" "$seen" || return 1
    version="$(jq -r .version "$feed")"
    pub="$(jq -r .published "$feed")"
    if [ "$STAGE_ONLY" != 1 ] && { [ -z "$seen" ] || [[ "$seen" < "$pub" ]]; }; then
        write_state "published-$channel" "$pub"
    fi
    installed="$(read_state installed-version)"
    if semver_valid "$installed" && [ "$(semver_cmp "$version" "$installed")" -le 0 ]; then
        log_info "${UNIT} ${installed} is up to date (feed has ${version}, ${channel})."
        NO_UPDATE=1
        return 0
    fi
    log_info "Installing ${UNIT} ${version} (currently: ${installed:-unknown})"
    select_part "$feed" server linux amd64 || return 1
    download_part "$PART" "$STAGE_DIR" || return 1
    local srv="$DL_PATH"
    select_part "$feed" web any any || return 1
    download_part "$PART" "$STAGE_DIR" || return 1
    stage_artifacts "$srv" "$DL_PATH" || return 1
    STAGED_VERSION="$version"
}

# stage_from_version VERSION ALLOW_DOWNGRADE
stage_from_version() {
    local version="$1" downgrade="$2" base sums installed want sha dl tarball srv
    if ! semver_valid "$version"; then
        LAST_ERROR="bad-version"; log_error "'${version}' is not a valid version (expected X.Y.Z)"; return 1
    fi
    installed="$(read_state installed-version)"
    if [ "$downgrade" != 1 ] && semver_valid "$installed" && [ "$(semver_cmp "$version" "$installed")" -le 0 ]; then
        LAST_ERROR="not-newer"
        log_error "${version} is not newer than the installed ${installed}. Pass --allow-downgrade to install it anyway."
        return 1
    fi
    log_step "Fetching ${UNIT} ${version} checksums"
    base="$PACKAGE_BASE/$UNIT/$version"
    sums="$STAGE_DIR/SHA256SUMS.txt"
    fetch_signed "$base/SHA256SUMS.txt" "$sums" || return 1
    verify_sig "$sums" "$sums.minisig" "$KEY_FILE" || return 1
    for want in "$UNIT-server-linux-amd64" "$UNIT-web.tar.gz"; do
        sha="$(sums_lookup "$want" "$sums")"
        if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]]; then
            LAST_ERROR="missing-part"; log_error "SHA256SUMS.txt has no entry for ${want}"; return 1
        fi
        dl="$STAGE_DIR/$want"
        log_info "  Downloading ${want}"
        http_get "$(rewrite_url "$base/$want")" "$dl.part" || { LAST_ERROR="all-urls-failed"; log_error "Could not download ${want}"; return 1; }
        _check_file "$dl.part" "" "$sha" || { log_error "${want} failed its ${LAST_ERROR} check"; return 1; }
        mv -f "$dl.part" "$dl"
    done
    srv="$STAGE_DIR/$UNIT-server-linux-amd64"
    tarball="$STAGE_DIR/$UNIT-web.tar.gz"
    stage_artifacts "$srv" "$tarball" || return 1
    STAGED_VERSION="$version"
}

# --- Checkout handling for --head (ported from the old scripts) --------------

current_branch_name() { git symbolic-ref -q --short HEAD 2>/dev/null || echo ""; }

warn_if_main_behind_origin() {
    git rev-parse --verify origin/main >/dev/null 2>&1 || return 0
    local behind
    behind="$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)"
    if [ "${behind:-0}" -gt 0 ]; then
        log_warn "main is ${behind} commit(s) behind origin/main — deploy with --head to clobber to origin/main"
    fi
}

# Discard host dirt and make HEAD exactly match commitish (branch tip, tag, or SHA).
clobber_to_ref() {
    local ref="$1" branch=""
    log_info "Clobbering checkout to ${ref} (reset --hard + clean -fd)..."
    if ! git rev-parse --verify "${ref}^{commit}" >/dev/null 2>&1; then
        log_error "Ref not found after fetch: ${ref}"
        return 1
    fi
    case "$ref" in
        origin/*)
            branch="${ref#origin/}"
            git checkout -f -B "$branch" "$ref"
            ;;
        *)
            if git show-ref --verify --quiet "refs/heads/${ref}" 2>/dev/null; then
                git checkout -f -B "$ref" "$ref"
            elif git show-ref --verify --quiet "refs/remotes/origin/${ref}" 2>/dev/null; then
                git checkout -f -B "$ref" "origin/${ref}"
            else
                git checkout -f "$ref"
            fi
            ;;
    esac
    git reset --hard "$ref"
    git clean -fd
    log_info "Checkout is now $(git rev-parse --short HEAD) ($(git describe --tags --always --dirty 2>/dev/null || true))"
}

checkout_main() {
    if [ "$(current_branch_name)" != "main" ]; then
        log_info "Checking out main..."
        git checkout -f main
    fi
}

clobber_branch_from_origin() {
    local branch="$1"
    log_info "Fetching origin/${branch}..."
    if ! git fetch origin "$branch"; then
        log_error "git fetch origin ${branch} failed"
        return 1
    fi
    if ! git rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
        log_warn "origin/${branch} not found — deploying local ${branch} checkout as-is"
        git checkout -f "$branch" 2>/dev/null || git checkout -f -B "$branch"
        git clean -fd
        return 0
    fi
    clobber_to_ref "origin/${branch}"
}

# Prepare the branch to build: hard-reset to origin (--head/--branch) unless --no-pull.
sync_head_checkout() {
    local no_pull="${1:-0}" want_main="${2:-0}" deploy_branch="${3:-}"
    if [ -n "$deploy_branch" ]; then
        if [ "$no_pull" -eq 1 ]; then
            log_info "Checking out local ${deploy_branch} (--no-pull)..."
            git checkout -f "$deploy_branch"
            git clean -fd
            return 0
        fi
        clobber_branch_from_origin "$deploy_branch"
        return 0
    fi
    if [ "$want_main" -eq 1 ]; then
        if [ "$no_pull" -eq 1 ]; then
            checkout_main
            git clean -fd
            warn_if_main_behind_origin
            return 0
        fi
        clobber_branch_from_origin "main"
        return 0
    fi
    if [ "$(current_branch_name)" != "main" ]; then
        return 0
    fi
    if [ "$no_pull" -eq 1 ]; then
        warn_if_main_behind_origin
        return 0
    fi
    clobber_branch_from_origin "main"
}

# Per-unit --head checkout: HEAD_SYNC=origin-main (luna) or current (sol).
prepare_head_checkout() {
    local no_pull="$1" branch="$2"
    cd "$REPO_ROOT"
    if [ -n "$branch" ]; then
        sync_head_checkout "$no_pull" 0 "$branch"
    elif [ "$HEAD_SYNC" = "origin-main" ]; then
        sync_head_checkout "$no_pull" 1 ""
    else
        git checkout -f HEAD
        [ -n "${HEAD_CLEAN_PATH:-}" ] && { git clean -fd "$HEAD_CLEAN_PATH" >/dev/null 2>&1 || true; }
    fi
    local b
    b="$(current_branch_name)"
    log_info "Deploying ${b:-HEAD} at $(git rev-parse --short HEAD) ($(git rev-parse HEAD))"
}

stage_from_head() { # NO_PULL BRANCH
    prepare_head_checkout "$1" "$2" || return 1
    log_step "Building ${UNIT} from source"
    build_head "$STAGE_DIR" || return 1
    for req in "${WEB_REQUIRE[@]}"; do
        [ -e "$STAGE_DIR/web/$req" ] || { log_error "Build produced no web/${req}"; return 1; }
    done
    STAGED_VERSION="head-$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
}

# --- Blue/green rollout ------------------------------------------------------

svc_of() { echo "${SERVICE_PREFIX}$1"; }
drain_file_for() { echo "${DATA_DIR}/drain-${1}"; }
is_healthy() { curl -sf --max-time 3 "http://127.0.0.1:${1}${HEALTH_PATH}" >/dev/null 2>&1; }

any_instance_healthy() {
    local inst
    for inst in "${INSTANCES[@]}"; do
        is_healthy "${inst##*:}" && return 0
    done
    return 1
}

# peer_of NAME -> "name:port" of the first other instance.
peer_of() {
    local inst
    for inst in "${INSTANCES[@]}"; do
        [ "${inst%%:*}" != "$1" ] && { echo "$inst"; return 0; }
    done
    return 1
}

wait_healthy() {
    local name="$1" port="$2" elapsed=0
    while ! is_healthy "$port"; do
        elapsed=$((elapsed + 1))
        [ "$elapsed" -ge "$HEALTH_TIMEOUT" ] && return 1
        sleep 1
    done
    log_info "  ${name} healthy after ${elapsed}s"
}

hard_stop_instance() {
    local name="$1"
    rm -f "$(drain_file_for "$name")"
    if ! systemctl is-active --quiet "$(svc_of "$name")"; then
        log_info "  ${name} already stopped"
        return 0
    fi
    log_info "  Hard-stopping ${name} (no soft drain)..."
    systemctl stop "$(svc_of "$name")" || { log_error "  systemctl stop $(svc_of "$name") failed"; return 1; }
}

drain_stop() {
    log_info "  Draining $1 (stopping service)..."
    systemctl stop "$(svc_of "$1")" 2>/dev/null || true
    sleep "${DRAIN_WAIT:-2}"
}

# Soft drain: fail the health path so Caddy drops this upstream, then stop the unit.
# Without --force, never stop an instance unless its peer is healthy.
drain_soft() {
    local name="$1" port="$2" peer peer_name peer_port df elapsed=0 soft_ok=0
    peer="$(peer_of "$name")"; peer_name="${peer%%:*}"; peer_port="${peer##*:}"
    df="$(drain_file_for "$name")"

    if ! is_healthy "$peer_port"; then
        if [ "$FORCE_DEPLOY" -eq 1 ]; then
            if ! any_instance_healthy; then
                log_warn "  Cold start: no instance healthy — skipping soft drain for ${name}"
            else
                log_warn "  Peer ${peer_name} (:${peer_port}) not healthy — --force: deploying ${name} anyway"
            fi
            hard_stop_instance "$name"
            return $?
        fi
        log_error "  Peer ${peer_name} (:${peer_port}) is not healthy — refusing to drain ${name} (would 503 the site)"
        return 1
    fi
    if ! systemctl is-active --quiet "$(svc_of "$name")"; then
        log_info "  ${name} already stopped — skipping drain"
        rm -f "$df"
        return 0
    fi
    log_info "  Soft-draining ${name} (Caddy must drop it before stop)..."
    mkdir -p "$DATA_DIR"
    touch "$df"
    while [ "$elapsed" -lt 15 ]; do
        if ! is_healthy "$port"; then soft_ok=1; break; fi
        sleep 1
        elapsed=$((elapsed + 1))
    done
    if [ "$soft_ok" -eq 1 ]; then
        log_info "  ${name} draining after ${elapsed}s — waiting ${CADDY_DRAIN_GRACE}s for Caddy"
        sleep "$CADDY_DRAIN_GRACE"
    else
        log_warn "  Soft drain ignored after ${elapsed}s (old binary without drain file support?)"
        log_warn "  Falling back to hard stop — brief 502/503 blip possible until Caddy notices"
    fi
    if ! systemctl stop "$(svc_of "$name")"; then
        rm -f "$df"
        log_error "  systemctl stop $(svc_of "$name") failed"
        return 1
    fi
    rm -f "$df"   # clear before restart so the new process reports healthy
}

drain() {
    case "$DRAIN_STYLE" in
        soft) drain_soft "$@" ;;
        *)    drain_stop "$1" ;;
    esac
}

# Swap the shared binary and web bundle in (once, while the first instance is drained).
install_files() {
    local bin="$INSTALL_DIR/$BINARY_NAME" web="$INSTALL_DIR/web"
    log_info "  Swapping binary and web bundle..."
    [ -f "$bin" ] && cp -p "$bin" "$bin.bak"
    mv -f "$STAGE_DIR/server" "$bin.new"
    chmod 755 "$bin.new"
    mv -f "$bin.new" "$bin"
    rm -rf "$web.old"
    [ -d "$web" ] && mv "$web" "$web.old"
    mv "$STAGE_DIR/web" "$web"
    if [ "$(id -u)" -eq 0 ] && id "$SERVICE_USER" >/dev/null 2>&1; then
        chown -R "$SERVICE_USER:$SERVICE_USER" "$web"
    fi
}

restore_files() {
    local bin="$INSTALL_DIR/$BINARY_NAME" web="$INSTALL_DIR/web"
    [ -f "$bin.bak" ] && cp -p "$bin.bak" "$bin"
    if [ -d "$web.old" ]; then
        rm -rf "$web"
        mv "$web.old" "$web"
    fi
}

deploy_instance() { # NAME PORT FIRST
    local name="$1" port="$2" first="$3" svc
    svc="$(svc_of "$name")"
    log_step "Deploying instance ${name} (port ${port})"
    drain "$name" "$port" || return 1
    if [ "$first" = 1 ]; then
        install_files
    fi
    rm -f "$(drain_file_for "$name")"
    log_info "  Starting ${svc}..."
    systemctl start "$svc"
    if ! wait_healthy "$name" "$port"; then
        log_error "  ${name} failed to become healthy — rolling back"
        restore_files
        rm -f "$(drain_file_for "$name")"
        systemctl restart "$svc" || systemctl start "$svc" || true
        sleep 2
        if is_healthy "$port"; then
            log_warn "  ${name} rolled back to the previous version (healthy)"
        else
            log_error "  ${name} rollback also failed — check journalctl -u ${svc}"
        fi
        return 1
    fi
    if [ "$DRAIN_STYLE" = soft ]; then
        sleep "$CADDY_DRAIN_GRACE"   # let Caddy put this upstream back before draining the peer
    fi
    log_info "  ${name} deployed"
}

require_root() {
    if [ "${EUID:-$(id -u)}" -ne 0 ]; then
        log_error "Run as root so systemctl can stop/start instances: sudo $0 $*"
        return 1
    fi
}

preflight() {
    log_step "Preflight"
    local inst name port unhealthy=0 svc
    if [ ! -d "$INSTALL_DIR" ] || [ ! -d "$CONFIG_DIR" ]; then
        log_error "${INSTALL_DIR} or ${CONFIG_DIR} is missing. Run this unit's deploy/setup.sh first."
        return 1
    fi
    for inst in "${INSTANCES[@]}"; do
        name="${inst%%:*}"; port="${inst##*:}"; svc="$(svc_of "$name")"
        if ! systemctl cat "$svc" >/dev/null 2>&1; then
            log_error "Systemd service ${svc} not found. Run this unit's deploy/setup.sh first."
            return 1
        fi
        [ "$DRAIN_STYLE" = soft ] || continue
        if ! systemctl is-active --quiet "$svc"; then
            log_error "  ${svc} is not active ($(systemctl is-active "$svc"))"; unhealthy=1; continue
        fi
        if ! is_healthy "$port"; then
            log_error "  ${svc} is up but ${HEALTH_PATH} on :${port} failed"; unhealthy=1; continue
        fi
        log_info "  ${name} healthy on :${port}"
    done
    if [ "$unhealthy" -ne 0 ]; then
        if [ "$FORCE_DEPLOY" -eq 1 ]; then
            if ! any_instance_healthy; then
                log_warn "Preflight failed but --force set — cold start (both instances down)."
            else
                log_warn "Preflight failed but --force set — continuing with a degraded deploy."
            fi
            return 0
        fi
        log_error "Fix the unhealthy instance first (journalctl -u ${SERVICE_PREFIX}a -u ${SERVICE_PREFIX}b)."
        log_error "Draining the only live instance is what produces a site-wide 503. To accept the risk: add --force"
        return 1
    fi
    if [ "$DRAIN_STYLE" = soft ]; then
        local ok=1
        for inst in "${INSTANCES[@]}"; do
            grep -q "localhost:${inst##*:}" /etc/caddy/Caddyfile 2>/dev/null || ok=0
        done
        [ "$ok" = 1 ] || log_warn "Caddyfile may not list every instance port — zero-downtime cannot work with a single upstream."
    fi
}

rollout() {
    local inst name port first=1
    for inst in "${INSTANCES[@]}"; do
        name="${inst%%:*}"; port="${inst##*:}"
        if ! deploy_instance "$name" "$port" "$first"; then
            log_error "Deployment failed at instance ${name}."
            if [ "$first" = 0 ]; then
                log_warn "An earlier instance is still running the new version in memory; files were restored. Re-run to retry."
            else
                log_error "The other instance is still running."
            fi
            return 1
        fi
        first=0
    done
}

# --- Main --------------------------------------------------------------------

cleanup_stage() {
    if [ "$STAGE_ONLY" != 1 ] && [ -n "${STAGE_DIR:-}" ] && [ -d "$STAGE_DIR" ]; then
        rm -rf "$STAGE_DIR"
    fi
}

main() {
    if [ $# -eq 0 ]; then usage; return 1; fi
    case "$1" in -h|--help) usage; return 0 ;; esac
    load_unit "$1" || return 1
    shift

    local want_head=0 mode=feed channel=stable version="" downgrade=0 no_pull=0 branch=""
    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help) usage; return 0 ;;
            --channel)
                channel="${2:-}"
                case "$channel" in stable|beta) ;; *) log_error "--channel must be stable or beta"; return 1 ;; esac
                shift 2 ;;
            --version)
                [ -n "${2:-}" ] || { log_error "--version needs a version"; return 1; }
                mode=version; version="$2"; shift 2 ;;
            --allow-downgrade) downgrade=1; shift ;;
            --head) want_head=1; shift ;;
            --no-pull) no_pull=1; shift ;;
            --branch)
                [ -n "${2:-}" ] || { log_error "--branch needs a branch name"; return 1; }
                branch="$2"; mode="head"; shift 2 ;;
            --force) FORCE_DEPLOY=1; shift ;;
            --stage-only) STAGE_ONLY=1; shift ;;
            --tag|--latest-tag|--allow-old-tag)
                log_error "$1 is retired: connect-v*/luna-connect-v* tags are no longer used. Plain deploy follows the feed; --version X.Y.Z picks a release; --head builds this checkout."
                return 1 ;;
            *) log_error "Unknown option: $1"; usage; return 1 ;;
        esac
    done
    if [ "$want_head" = 1 ] && [ "$mode" = version ]; then
        log_error "--version cannot be combined with --head or --branch"; return 1
    fi
    [ "$want_head" = 1 ] && mode="head"
    if [ "$mode" = head ] && [ "$downgrade" = 1 ]; then
        log_warn "--allow-downgrade has no effect with --head"
    fi
    if [ "$mode" != head ] && { [ "$no_pull" = 1 ]; }; then
        log_error "--no-pull only applies to --head"; return 1
    fi

    log_step "${UNIT} — zero-downtime deploy"
    [ "$STAGE_ONLY" = 1 ] || require_root "$UNIT" "$@" || return 1
    if [ "$STAGE_ONLY" != 1 ]; then
        preflight || return 1
    else
        log_info "Stage only: nothing will be installed or restarted."
    fi

    # Same filesystem as the install dir, so installing is a rename.
    case "$STAGE_DIR" in ""|/|/tmp|/var|/opt|/usr|/etc|"$HOME") log_error "Refusing to use '${STAGE_DIR}' as the staging dir"; return 1 ;; esac
    rm -rf "$STAGE_DIR"
    mkdir -p "$STAGE_DIR"
    trap cleanup_stage EXIT

    NO_UPDATE=0
    STAGED_VERSION=""
    case "$mode" in
        feed)    stage_from_feed "$channel" || { log_error "Deploy stopped${LAST_ERROR:+ (${LAST_ERROR})}."; return 1; } ;;
        version) stage_from_version "$version" "$downgrade" || { log_error "Deploy stopped${LAST_ERROR:+ (${LAST_ERROR})}."; return 1; } ;;
        head)    stage_from_head "$no_pull" "$branch" || { log_error "Build failed."; return 1; } ;;
    esac
    [ "$NO_UPDATE" = 1 ] && return 0

    if [ "$STAGE_ONLY" = 1 ]; then
        log_step "Stage only: ${UNIT} ${STAGED_VERSION} is verified and unpacked in ${STAGE_DIR}"
        echo "$STAGED_VERSION"
        return 0
    fi

    if [ "$DRAIN_STYLE" = soft ] && [ "$FORCE_DEPLOY" -eq 1 ] && ! any_instance_healthy; then
        log_warn "Cold start mode: neither instance is healthy — sequential start (${INSTANCES[0]%%:*}, then ${INSTANCES[1]%%:*})."
    fi
    rollout || return 1
    write_state installed-version "$STAGED_VERSION"

    log_step "Deployment complete (${UNIT} ${STAGED_VERSION})"
    local inst
    for inst in "${INSTANCES[@]}"; do
        echo "  ${inst%%:*}: http://127.0.0.1:${inst##*:}  ($(systemctl is-active "$(svc_of "${inst%%:*}")"))" >&2
    done
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
