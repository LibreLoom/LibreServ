# Luna Desktop Flatpak bundles (flatpak-builder image, rootless).
# Needs: BRANCHES="branch:file branch:file ...". /src is read-only; the user
# flatpak installation (runtimes) and flatpak-builder state are volumes.
# The bundles carry no repository address and no signing keys: the repo server adds those.
set -euo pipefail
APP=org.libreloom.LunaDesktop
ARCH=x86_64
M=/src/luna/desktop/packaging/flatpak/$APP.yml
STATE=/root/.local/share/flatpak-builder
# Cargo's home and target dir live in a volume, outside the module cache, so a
# changed version (or any source change) recompiles only the crates that
# changed. The build sandbox sees the volume at $CACHE_IN. The version file
# keeps its export mtime (so lunad does not rebuild on every run), which cargo
# cannot see change: the build touches it when the version differs from the
# one last compiled.
CACHE=/root/.cache/luna-cargo
CACHE_IN=/run/luna-cargo
mkdir -p "$CACHE/home" "$CACHE/target"
# flatpak-builder refuses a build dir on another filesystem than its state dir.
W=$STATE/work
rm -rf "$W"
mkdir -p "$W"
cd "$W"
trap 'cd /; rm -rf "$W"' EXIT

# A private copy of the manifest: cargo state moves into the volume. Its
# relative source paths become absolute (the copy lives elsewhere).
D=/src/luna/desktop
sed -e "s|path: ../../../../keys|path: /src/keys|" \
	-e "s|path: ../../../crates|path: /src/luna/crates|" \
	-e "s|path: ../\.\.\$|path: $D|" \
	-e "s|CARGO_HOME: .*|CARGO_HOME: $CACHE_IN/home\n        CARGO_TARGET_DIR: $CACHE_IN/target|" \
	-e "s|      build-args:|      build-args:\n        - --bind-mount=$CACHE_IN=$CACHE|" \
	-e "s|^\( *\)- cargo build .*|&\n\1- cp luna/desktop/VERSION $CACHE_IN/version|" \
	-e "s|^\( *\)- cargo build |\1- cmp -s luna/desktop/VERSION $CACHE_IN/version \|\| touch luna/desktop/VERSION\n&|" \
	-e "s|luna/desktop/target/release/luna-desktop|$CACHE_IN/target/release/luna-desktop|" \
	"$M" >manifest.yml
for want in "path: $D\$" "path: /src/luna/crates/luna-feed" "path: /src/keys/" "CARGO_TARGET_DIR" "bind-mount" "cp luna/desktop/VERSION" "touch luna/desktop/VERSION" "install -Dm755 $CACHE_IN"; do
	grep -q -- "$want" manifest.yml || { echo "manifest rewrite failed: no '$want'" >&2; exit 1; }
done
M=$PWD/manifest.yml

flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
for spec in $BRANCHES; do
	branch=${spec%%:*}
	file=${spec#*:}
	echo "==> flatpak-builder (branch $branch)"
	# The first branch compiles; later ones hit the module cache and only
	# export again under their own branch (the appstream data names the ref).
	rm -rf build-dir repo
	flatpak-builder --user --force-clean --disable-rofiles-fuse \
		--install-deps-from=flathub --state-dir="$STATE" \
		--default-branch="$branch" --repo=repo build-dir "$M"
	# The compiled app must carry this build's version (cargo's cache cannot see
	# VERSION change; the manifest touches it, and this proves the rebuild ran).
	want=$(tr -d '\r\n' < /src/luna/desktop/VERSION)
	grep -aqF -- "$want" build-dir/files/bin/luna-desktop || { cat "$CACHE/version" >&2 || true; strings -n 5 build-dir/files/bin/luna-desktop | grep -c . >&2 || true; grep -ao "0\.[0-9]*\.[0-9]*[-0-9a-z.]*" build-dir/files/bin/luna-desktop | sort -u | head -20 >&2; echo "the built luna-desktop does not contain version $want" >&2; exit 1; }
	flatpak build-bundle repo "/out/$file" "$APP" "$branch" \
		--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
	# The bundle must carry exactly this branch.
	grep -aq "app/$APP/$ARCH/$branch" "/out/$file" || { echo "$file has no ref for branch $branch" >&2; exit 1; }
	ls -l "/out/$file"
done
