#!/usr/bin/env bash
# Luna Desktop Flatpak repo watcher.
#
# Runs as the luna-flatpak user from a systemd timer (see README.md). For each
# channel it reads the signed release feed, and when a newer Luna Desktop
# Flatpak bundle was published it imports the bundle into the OSTree repo,
# signs it with the repo GPG key, and refreshes the repo metadata.
#
# Safe to run any time and as often as you like: with nothing new it does
# nothing. A lock stops two runs from overlapping.
#
# The bundle in the feed is only INPUT (built by CI with branch = channel, no
# repo URL or GPG keys). The bundle users install is rebuilt here from the
# signed repo with flatpak build-bundle, so their remote verifies signatures.
#
# Bundle ref decision: bundles are built with branch = channel, so the repo
# branch always equals the feed channel. We do NOT use build-import-bundle
# --ref to move a bundle onto another branch: the commit inside the bundle
# records the ref it was built for, and newer flatpak clients refuse a commit
# whose recorded ref differs from the one they asked for. Instead the bundle
# is first imported into a throwaway staging repo and refused unless its only
# ref is app/<APP_ID>/x86_64/<channel>.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# All of these can be overridden from the environment (tests do).
FEED_BASE=${FEED_BASE:-https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds}
KEY_FILE=${KEY_FILE:-$HERE/../../keys/lsluna.minisign.pub}
GPG_PUBKEY_FILE=${GPG_PUBKEY_FILE:-$HERE/../../keys/luna-desktop-flatpak.gpg}
ROOT=${ROOT:-/srv/luna-flatpak}
REPO=${REPO:-$ROOT/repo}
STATE_DIR=${STATE_DIR:-/var/lib/luna-flatpak/state}
STAGING=${STAGING:-$ROOT/.staging}
export GNUPGHOME=${GNUPGHOME:-/var/lib/luna-flatpak/gnupg}
KEYID=${KEYID:-7081D2758F2D56690DA2ACFAEBBC51F23119763B}
APP_ID=${APP_ID:-org.libreloom.LunaDesktop}
ARCH=${ARCH:-x86_64}
CHANNELS=${CHANNELS:-"stable beta"}
UNIT=luna-desktop
REPO_URL=${REPO_URL:-https://flatpak.luna.libreloom.org/repo/}
HOMEPAGE=${HOMEPAGE:-https://github.com/LibreLoom/LibreServ}
REPO_TITLE=${REPO_TITLE:-Luna Desktop}
STATIC_DELTAS=${STATIC_DELTAS:-1}
PRUNE_DEPTH=${PRUNE_DEPTH:-3}
RUNTIME_REPO=${RUNTIME_REPO:-https://flathub.org/repo/flathub.flatpakrepo}

log() { printf '%s\n' "$*"; }
err() { printf 'ERROR: %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Strict semver 2.0 (no leading v, no leading zeros, no build metadata),
# matching infra/feed-testdata/cases.json -> semver.

SEMVER_RE='^(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$'

semver_valid() {
	local v=$1 id
	[[ $v =~ $SEMVER_RE ]] || return 1
	if [[ -n ${BASH_REMATCH[5]} ]]; then
		local IFS=.
		for id in ${BASH_REMATCH[5]}; do
			# Numeric identifiers: no leading zeros, bounded length.
			if [[ $id =~ ^[0-9]+$ ]]; then
				[[ $id =~ ^(0|[1-9][0-9]{0,14})$ ]] || return 1
			fi
		done
	fi
	return 0
}

# Prints -1, 0 or 1 for a < b, a == b, a > b. Both must be valid.
semver_cmp() {
	local a=$1 b=$2 i
	[[ $a =~ $SEMVER_RE ]] || return 1
	local -a ca=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
	local pa=${BASH_REMATCH[5]}
	[[ $b =~ $SEMVER_RE ]] || return 1
	local -a cb=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
	local pb=${BASH_REMATCH[5]}
	for i in 0 1 2; do
		if ((10#${ca[i]} < 10#${cb[i]})); then echo -1; return 0; fi
		if ((10#${ca[i]} > 10#${cb[i]})); then echo 1; return 0; fi
	done
	# Equal core: a version without a prerelease is newer than one with.
	if [[ -z $pa && -z $pb ]]; then echo 0; return 0; fi
	if [[ -z $pa ]]; then echo 1; return 0; fi
	if [[ -z $pb ]]; then echo -1; return 0; fi
	local -a ia ib
	IFS=. read -r -a ia <<<"$pa"
	IFS=. read -r -a ib <<<"$pb"
	local n=${#ia[@]}
	((${#ib[@]} < n)) && n=${#ib[@]}
	for ((i = 0; i < n; i++)); do
		local x=${ia[i]} y=${ib[i]}
		local xn=0 yn=0
		[[ $x =~ ^[0-9]+$ ]] && xn=1
		[[ $y =~ ^[0-9]+$ ]] && yn=1
		if ((xn && yn)); then
			if ((10#$x < 10#$y)); then echo -1; return 0; fi
			if ((10#$x > 10#$y)); then echo 1; return 0; fi
		elif ((xn)); then
			echo -1; return 0 # numeric identifiers sort before text ones
		elif ((yn)); then
			echo 1; return 0
		else
			if [[ $x < $y ]]; then echo -1; return 0; fi
			if [[ $x > $y ]]; then echo 1; return 0; fi
		fi
	done
	if ((${#ia[@]} < ${#ib[@]})); then echo -1; return 0; fi
	if ((${#ia[@]} > ${#ib[@]})); then echo 1; return 0; fi
	echo 0
}

# ---------------------------------------------------------------------------

# Writes $2 to $1 only when the content changed, atomically.
write_if_changed() {
	local dest=$1 content=$2 tmp
	if [[ -f $dest ]] && [[ $(cat "$dest") == "$content" ]]; then
		return 0
	fi
	tmp=$(mktemp "$dest.XXXXXX")
	printf '%s\n' "$content" >"$tmp"
	chmod 0644 "$tmp"
	mv -f "$tmp" "$dest"
}

gpg_key_b64() {
	base64 -w0 "$GPG_PUBKEY_FILE"
}

write_web_files() {
	local key channel
	key=$(gpg_key_b64)
	write_if_changed "$ROOT/luna.flatpakrepo" "[Flatpak Repo]
Title=$REPO_TITLE
Comment=Luna Desktop for Linux
Homepage=$HOMEPAGE
Url=$REPO_URL
DefaultBranch=stable
GPGKey=$key"
	for channel in $CHANNELS; do
		write_if_changed "$ROOT/luna-desktop-$channel.flatpakref" "[Flatpak Ref]
Title=Luna Desktop ($channel)
Name=$APP_ID
Branch=$channel
Url=$REPO_URL
IsRuntime=false
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
GPGKey=$key"
	done
}

init_repo() {
	if [[ ! -f $REPO/config ]]; then
		log "creating repo at $REPO"
		mkdir -p "$REPO"
		ostree init --mode=archive --repo="$REPO"
		# Clients use delta indexes when the repo advertises them.
		ostree config set --repo="$REPO" core.indexed-deltas true
	fi
}

update_repo_metadata() {
	local -a args=(
		--gpg-sign="$KEYID" --gpg-homedir="$GNUPGHOME"
		--title="$REPO_TITLE" --comment="Luna Desktop for Linux"
		--homepage="$HOMEPAGE" --default-branch=stable
		--gpg-import="$GPG_PUBKEY_FILE"
		--prune --prune-depth="$PRUNE_DEPTH"
	)
	[[ $STATIC_DELTAS == 1 ]] && args+=(--generate-static-deltas)
	flatpak build-update-repo "${args[@]}" "$REPO"
}

# Downloads the first working URL for the part into $2, enforcing size and
# sha256. Arguments: <feed json> <out file>.
download_part() {
	local feed=$1 out=$2 size sha url got
	size=$(jq -r '.size' <<<"$PART")
	sha=$(jq -r '.sha256' <<<"$PART")
	while IFS= read -r url; do
		[[ -n $url ]] || continue
		log "downloading $url"
		rm -f "$out"
		if ! curl -fsSL --proto '=https,http' --proto-redir '=https,http' \
			--retry 2 --connect-timeout 20 --max-time 1800 \
			--max-filesize "$size" -o "$out" "$url"; then
			log "download failed, trying next url"
			continue
		fi
		got=$(stat -c %s "$out")
		if [[ $got != "$size" ]]; then
			log "size mismatch from $url (feed says $size, got $got), trying next url"
			continue
		fi
		if [[ $(sha256sum "$out" | cut -d' ' -f1) != "$sha" ]]; then
			log "sha256 mismatch from $url, trying next url"
			continue
		fi
		return 0
	done < <(jq -r '.urls[]' <<<"$PART")
	rm -f "$out"
	return 1
}

# Imports the bundle (already verified) into the real repo.
import_bundle() {
	local channel=$1 bundle=$2 ref refs chk
	ref="app/$APP_ID/$ARCH/$channel"
	chk=$STAGING/check
	rm -rf "$chk"
	ostree init --mode=archive --repo="$chk"
	if ! flatpak build-import-bundle --no-update-summary --no-summary-index "$chk" "$bundle"; then
		err "$channel: the bundle could not be read"
		rm -rf "$chk"
		return 1
	fi
	refs=$(ostree refs --repo="$chk")
	rm -rf "$chk"
	if [[ $refs != "$ref" ]]; then
		err "$channel: bundle is built for '${refs//$'\n'/ }', expected '$ref'. Refusing to import."
		return 1
	fi
	flatpak build-import-bundle --gpg-sign="$KEYID" --gpg-homedir="$GNUPGHOME" \
		--no-update-summary --no-summary-index "$REPO" "$bundle"
}

process_channel() {
	local channel=$1 dir feed sig code url
	dir=$STAGING/$channel
	rm -rf "$dir"
	mkdir -p "$dir"
	feed=$dir/feed.json
	sig=$dir/feed.json.minisig
	url=$FEED_BASE/$UNIT/$channel.json

	code=$(curl -sS --proto '=https,http' --retry 2 --connect-timeout 20 --max-time 60 \
		-o "$feed" -w '%{http_code}' "$url") || { err "$channel: could not reach $url"; return 1; }
	if [[ $code == 404 ]]; then
		log "$channel: no feed published yet"
		return 0
	fi
	if [[ $code != 200 ]]; then
		err "$channel: $url answered HTTP $code"
		return 1
	fi
	code=$(curl -sS --proto '=https,http' --retry 2 --connect-timeout 20 --max-time 60 \
		-o "$sig" -w '%{http_code}' "$url.minisig") || { err "$channel: could not reach $url.minisig"; return 1; }
	if [[ $code != 200 ]]; then
		err "$channel: signature $url.minisig answered HTTP $code"
		return 1
	fi
	# Signature first, over the exact bytes; only then parse.
	if ! minisign -Vm "$feed" -x "$sig" -p "$KEY_FILE" >/dev/null 2>&1; then
		err "$channel: feed signature is NOT valid. Ignoring this feed."
		return 1
	fi

	local format funit fchan version published
	format=$(jq -r '.format // empty' "$feed") || { err "$channel: feed is not valid JSON"; return 1; }
	if [[ $format != 1 ]]; then
		log "$channel: feed format '$format' is not understood by this watcher, skipping"
		return 0
	fi
	funit=$(jq -r '.unit // empty' "$feed")
	fchan=$(jq -r '.channel // empty' "$feed")
	if [[ $funit != "$UNIT" ]]; then err "$channel: feed is for unit '$funit', not $UNIT"; return 1; fi
	if [[ $fchan != "$channel" ]]; then err "$channel: feed is for channel '$fchan'"; return 1; fi
	version=$(jq -r '.version // empty' "$feed")
	published=$(jq -r '.published // empty' "$feed")
	if ! semver_valid "$version"; then err "$channel: feed version '$version' is not valid semver"; return 1; fi
	if [[ ! $published =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
		err "$channel: feed 'published' is not a UTC timestamp: '$published'"
		return 1
	fi

	local seen_pub="" seen_ver=""
	[[ -f $STATE_DIR/$channel.published ]] && seen_pub=$(<"$STATE_DIR/$channel.published")
	[[ -f $STATE_DIR/$channel.version ]] && seen_ver=$(<"$STATE_DIR/$channel.version")
	if [[ -n $seen_pub && $published < $seen_pub ]]; then
		err "$channel: feed was published $published, older than the newest seen ($seen_pub). Possible replay, ignoring."
		return 1
	fi
	if [[ -n $seen_ver ]]; then
		local c
		c=$(semver_cmp "$version" "$seen_ver")
		if [[ $c != 1 ]]; then
			log "$channel: $version is not newer than imported $seen_ver, nothing to do"
			return 0
		fi
	fi

	PART=$(jq -c '[.parts[]? | select(.name == "flatpak"
		and (.os == "linux" or .os == "any")
		and (.arch == "amd64" or .arch == "any"))][0] // empty' "$feed")
	if [[ -z $PART ]]; then err "$channel: feed has no linux/amd64 flatpak part"; return 1; fi
	if ! jq -e '(.size | type == "number" and . > 0 and floor == .)
		and (.sha256 | type == "string" and test("^[0-9a-f]{64}$"))
		and (.urls | type == "array" and length > 0)' <<<"$PART" >/dev/null; then
		err "$channel: flatpak part is malformed"
		return 1
	fi

	log "$channel: importing $version (published $published)"
	local bundle=$dir/bundle.flatpak
	if ! download_part "$feed" "$bundle"; then
		err "$channel: no download URL gave a file matching the feed's size and sha256"
		return 1
	fi
	init_repo
	import_bundle "$channel" "$bundle" || return 1
	update_repo_metadata || { err "$channel: could not update the repo metadata"; return 1; }

	# The feed's bundle was only our input. The file people install is rebuilt
	# from our signed repo so it carries the repo URL and GPG key (the client
	# remote then verifies signatures). Write to a temp name, then rename.
	mkdir -p "$ROOT/bundles"
	local out=$ROOT/bundles/luna-desktop-$channel.flatpak tmp
	tmp=$ROOT/bundles/.luna-desktop-$channel.flatpak.new
	rm -f "$tmp"
	flatpak build-bundle "$REPO" "$tmp" "$APP_ID" "$channel" \
		--repo-url="${REPO_URL%/}" --gpg-keys="$GPG_PUBKEY_FILE" \
		--runtime-repo="$RUNTIME_REPO" || { rm -f "$tmp"; err "$channel: could not build the user bundle"; return 1; }
	chmod 0644 "$tmp"
	mv -f "$tmp" "$out"
	write_web_files

	# State last: a crash before this point just means a harmless re-import.
	printf '%s\n' "$published" >"$STATE_DIR/$channel.published"
	printf '%s\n' "$version" >"$STATE_DIR/$channel.version"
	rm -rf "$dir"
	log "$channel: now serving $version"
}

main() {
	local tool
	for tool in flatpak ostree minisign jq curl flock sha256sum base64; do
		command -v "$tool" >/dev/null || { err "$tool is not installed"; exit 1; }
	done
	[[ -f $KEY_FILE ]] || { err "minisign key $KEY_FILE not found"; exit 1; }
	[[ -f $GPG_PUBKEY_FILE ]] || { err "GPG public key $GPG_PUBKEY_FILE not found"; exit 1; }

	mkdir -p "$STATE_DIR" "$ROOT/bundles" "$STAGING"
	exec 9>"$STATE_DIR/lock"
	if ! flock -n 9; then
		log "another run is in progress, exiting"
		exit 0
	fi
	# Stop the gpg-agent that signing may have started.
	trap 'rm -rf "$STAGING"/*; gpgconf --kill gpg-agent >/dev/null 2>&1 || true' EXIT

	init_repo
	write_web_files

	local channel failed=0
	for channel in $CHANNELS; do
		if ! process_channel "$channel"; then failed=1; fi
	done
	if [[ $failed == 1 ]]; then
		err "finished with errors"
		exit 1
	fi
	log "done"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	main "$@"
fi
