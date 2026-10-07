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
# changed source recompiles only the crates that changed. The build sandbox
# sees the volume at $CACHE_IN. The version is not compiled in
# (LUNA_DESKTOP_VERSION_PATCH): it is written into the installed copy of the
# binary, so a new version recompiles and relinks nothing.
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
	-e "s|CARGO_HOME: .*|CARGO_HOME: $CACHE_IN/home\n        CARGO_TARGET_DIR: $CACHE_IN/target\n        LUNA_DESKTOP_VERSION_PATCH: \"1\"|" \
	-e "s|      build-args:|      build-args:\n        - --bind-mount=$CACHE_IN=$CACHE|" \
	-e "s|luna/desktop/target/release/luna-desktop|$CACHE_IN/target/release/luna-desktop|" \
	-e "s|^\( *\)- install -Dm755 .*|&\n\1- python3 luna/desktop/packaging/patch-version.py /app/bin/luna-desktop \"\$(cat luna/desktop/VERSION)\"|" \
	"$M" >manifest.yml
for want in "path: $D\$" "path: /src/luna/crates/luna-feed" "path: /src/keys/" "CARGO_TARGET_DIR" "bind-mount" "LUNA_DESKTOP_VERSION_PATCH" "patch-version.py /app/bin/luna-desktop" "install -Dm755 $CACHE_IN"; do
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
	# The app must have been compiled for this build's version. The Linux binary
	# does not keep the version string (only the Windows update check reads
	# it), so ask cargo what the build script last baked in: the newest
	# build-script output of luna-desktop, in the volume.
	want=$(tr -d '\r\n' < /src/luna/desktop/VERSION)
	out=$(ls -td "$CACHE"/target/release/build/luna-desktop-*/output 2>/dev/null | head -1)
	[ -n "$out" ] && grep -qxF "cargo:rustc-env=LUNA_DESKTOP_APP_VERSION=$want" "$out" \
		|| { echo "luna-desktop was not compiled for version $want (cargo last baked in: $(grep -h LUNA_DESKTOP_APP_VERSION "$out" 2>/dev/null || echo nothing))" >&2; exit 1; }
	flatpak build-bundle repo "/out/$file" "$APP" "$branch" \
		--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
	# The bundle must carry exactly this branch.
	grep -aq "app/$APP/$ARCH/$branch" "/out/$file" || { echo "$file has no ref for branch $branch" >&2; exit 1; }
	ls -l "/out/$file"
done
