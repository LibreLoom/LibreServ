# lunad + luna-console as static-pie musl binaries (rust-musl image).
# /src is read-only; the web bundle is mounted at crates/lunad/web/dist and
# target/ is a volume. Needs: EXPECT_VERSION. The podman smoke test is a
# separate job (it runs the result in plain Alpine).
set -eu
cd /src/luna
unset RUSTFLAGS
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
