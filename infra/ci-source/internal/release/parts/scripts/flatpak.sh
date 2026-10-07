# Luna Desktop Flatpak bundles (flatpak-builder image, rootless).
# Needs: BRANCHES="branch:file branch:file ...". /src is read-only; the user
# flatpak installation (runtimes) and flatpak-builder state are volumes.
# The bundles carry no repository address and no signing keys: the repo server adds those.
set -euo pipefail
APP=org.libreloom.LunaDesktop
ARCH=x86_64
M=/src/luna/desktop/packaging/flatpak/$APP.yml
STATE=/root/.local/share/flatpak-builder
# flatpak-builder refuses a build dir on another filesystem than its state dir.
W=$STATE/work
rm -rf "$W"
mkdir -p "$W"
cd "$W"
trap 'cd /; rm -rf "$W"' EXIT
rm -rf build-dir repo
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
for spec in $BRANCHES; do
	branch=${spec%%:*}
	file=${spec#*:}
	echo "==> flatpak-builder (branch $branch)"
	flatpak-builder --user --force-clean --disable-rofiles-fuse \
		--install-deps-from=flathub --state-dir="$STATE" \
		--default-branch="$branch" --repo=repo build-dir "$M"
	flatpak build-bundle repo "/out/$file" "$APP" "$branch" \
		--runtime-repo=https://flathub.org/repo/flathub.flatpakrepo
	# The bundle must carry exactly this branch.
	grep -aq "app/$APP/$ARCH/$branch" "/out/$file" || { echo "$file has no ref for branch $branch" >&2; exit 1; }
	ls -l "/out/$file"
done
