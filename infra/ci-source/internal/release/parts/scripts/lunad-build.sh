# lunad + luna-console as static-pie musl binaries (rust-musl image).
# /src is read-only; the web bundle is mounted at crates/lunad/web/dist and
# target/ is a volume. Needs: PATCH_VERSION. The podman smoke test is a
# separate job (it runs the result in plain Alpine).
#
# The version is not compiled in: LUNA_VERSION_PATCH makes build.rs leave
# lunad's version slot empty (and stop depending on luna/VERSION), so a new
# version recompiles and relinks nothing. The slot is filled in the installed
# copy, never in target/ (the cached build stays version-free).
set -eu
cd /src/luna
unset RUSTFLAGS
export LUNA_VERSION_PATCH=1
T=x86_64-unknown-linux-musl
. ./os/lib/musl-link.sh
luna_musl_export "$T"
grep -q 'build the web app first' crates/lunad/web/dist/index.html && { echo "web bundle is the build.rs stub" >&2; exit 1; }
cargo build --release --locked -p lunad --bin lunad --bin luna-console --target "$T"
for b in lunad luna-console; do
	luna_musl_assert_static_pie "target/$T/release/$b"
done
install -m 0755 "target/$T/release/lunad" /out/lunad-linux-amd64-musl
install -m 0755 "target/$T/release/luna-console" /extra/luna-console
python3 - /out/lunad-linux-amd64-musl "$PATCH_VERSION" <<'PY'
import sys
path, version = sys.argv[1], sys.argv[2].encode()
mark = b"LUNA-VERSION-V1:"
if not 0 < len(version) <= 64 or b"\0" in version:
    sys.exit("version does not fit lunad's 64-byte slot: %r" % version)
data = bytearray(open(path, "rb").read())
if data.count(mark) != 1:
    sys.exit("lunad has %d version slots, expected 1" % data.count(mark))
at = data.index(mark) + len(mark)
if any(data[at:at + 64]):
    sys.exit("lunad's version slot is not empty: the build was not a patch build")
data[at:at + len(version)] = version
open(path, "wb").write(data)
PY
