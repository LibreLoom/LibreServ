# Runs the musl lunad in plain Alpine: right version, starts, no web stub.
# Needs: EXPECT_VERSION. /w is the part dir, /x holds luna-console.
set -eu
bin=/w/lunad-linux-amd64-musl
got=$("$bin" --version)
if [ "$got" != "$EXPECT_VERSION" ]; then
	echo "lunad reports version '$got', expected '$EXPECT_VERSION'" >&2
	exit 1
fi
"$bin" --help >/dev/null
if grep -q 'build the web app first' "$bin"; then
	echo "lunad embeds the build.rs web stub, not the web UI" >&2
	exit 1
fi
# luna-console wants a tty: a mislinked binary dies at once (139 SIGSEGV,
# 132 SIGILL); a good one fails on /dev/tty1 or is killed by the timeout.
rc=0
timeout 1 /x/luna-console >/dev/null 2>&1 || rc=$?
case $rc in
139 | 132)
	echo "luna-console crashed (exit $rc): not a static-pie musl binary" >&2
	exit 1
	;;
esac
echo "lunad $got ok"
