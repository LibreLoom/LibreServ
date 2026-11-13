# Luna web UI (node image). /src is read-only; node_modules are volumes and
# the bundle goes to /web-out. Reinstalls only when a lock file changed.
set -eu
cd /src
# Skip the whole build when nothing it is made from changed. Key: every file of
# luna/web and shared/ui (except node_modules and dist), the node and npm
# versions (so a new node image rebuilds), and the bundle must still be there.
# The stamp lives in the node_modules volume, next to what it describes.
stamp=/src/luna/web/node_modules/.libreserv-web-stamp
key=$( (find luna/web shared/ui \( -name node_modules -o -name dist \) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum; node -v; npm -v) | sha256sum | cut -d' ' -f1)
if [ "$(cat "$stamp" 2>/dev/null || true)" = "$key" ] && [ -f /web-out/index.html ]; then
	echo "==> web bundle unchanged ($key), skipping"
	exit 0
fi
# Reinstall every time: npm ci is deterministic and minutes-cheap next to the
# build, and it is what repairs a tree an interrupted or racing run gutted —
# a volume stamped before its tree was wrecked would otherwise skip the one
# step that could fix it.
for d in shared/ui luna/web; do
	echo "==> npm ci ($d)"
	(cd "$d" && npm ci --no-audit --no-fund)
done
echo "==> vite build"
cd luna/web
rm -rf /tmp/web-dist
npm run build -- --outDir /tmp/web-dist --emptyOutDir
test -f /tmp/web-dist/index.html
# Copy only files whose bytes changed. lunad embeds this dir and cargo goes by
# mtime, so a byte-identical rebuild must not look new (it would re-link lunad).
new=/tmp/web-dist
(cd /web-out && find . -type f) | while IFS= read -r f; do
	[ -f "$new/$f" ] || rm -f "/web-out/$f"
done
(cd "$new" && find . -type f) | while IFS= read -r f; do
	if ! cmp -s "$new/$f" "/web-out/$f"; then
		mkdir -p "$(dirname "/web-out/$f")"
		cp "$new/$f" "/web-out/$f"
	fi
done
find /web-out -mindepth 1 -type d -empty -delete
echo "$key" > "$stamp"
