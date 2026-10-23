#!/bin/sh
# Mount contracts for both OS build paths, plus the real in-container helper
# and input hash. Never build an OS image or touch a shared rootfs/cache volume.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="$(mktemp -d /tmp/tailscale-rootfs-test.XXXXXX)"
trap 'rm -rf "$T"' EXIT HUP INT TERM
. "$REPO/luna/os/lib/alpine-image.sh"

mkdir -p "$T/bin" "$T/repo/luna/os" "$T/repo/shared/scripts"
cp -R "$REPO/luna/os/build" "$REPO/luna/os/lib" "$T/repo/luna/os/"
cp "$REPO/shared/scripts/tailscale-bake.sh" "$T/repo/shared/scripts/"

# Execute the actual dev wrapper, recording its Podman argv instead of starting
# its costly rootfs build. A second, real container below uses those mounts.
cat > "$T/bin/podman" <<'MOCK'
#!/usr/bin/env python3
import json, os, sys
if sys.argv[1] == "run":
    json.dump(sys.argv[2:], open(os.environ["TS_ROOTFS_ARGS"], "w"))
MOCK
chmod +x "$T/bin/podman"
printf '#!/bin/sh\nexit 0\n' > "$T/lunad"
chmod +x "$T/lunad"
PATH="$T/bin:$PATH" TS_ROOTFS_ARGS="$T/args.json" LUNAD_BIN="$T/lunad" LUNA_CONSOLE_BIN="$T/lunad" \
    sh "$REPO/luna/os/build-rootfs.sh"
python3 - "$T/args.json" "$REPO" <<'PY'
import json, sys
args = json.load(open(sys.argv[1]))
for value in [sys.argv[2] + "/luna/os:/luna/os:ro", sys.argv[2] + "/luna/../shared/scripts:/shared/scripts:ro"]:
    assert any(args[i] == "-v" and args[i+1] == value for i in range(len(args)-1)), value
PY

# Match ./ci's runtime socket preference. On hosts using its Docker fallback,
# local rootless Podman may not have a usable OCI/cgroup runtime at all.
TS_CONTAINER_HOST="${DOCKER_HOST:-}"
if [ -z "$TS_CONTAINER_HOST" ]; then
    for socket in "${XDG_RUNTIME_DIR:-/nonexistent}/podman/podman.sock" /run/podman/podman.sock /var/run/docker.sock; do
        if [ -S "$socket" ]; then TS_CONTAINER_HOST="unix://$socket"; break; fi
    done
fi
run_container() {
    if [ -n "$TS_CONTAINER_HOST" ] && command -v docker >/dev/null 2>&1; then
        docker --host "$TS_CONTAINER_HOST" "$@"
    else
        podman "$@"
    fi
}
hash_in_container() {
    run_container run --rm --security-opt label=disable --network=none --read-only --memory=256m \
        -v "$T/repo/luna/os:/luna/os:ro" \
        -v "$T/repo/shared/scripts:/shared/scripts:ro" \
        "$ALPINE_IMAGE" sh -ec '. /shared/scripts/tailscale-bake.sh; test -n "$TAILSCALE_BAKE_VERSION"; sh /luna/os/build/input-hash.sh'
}
before="$(hash_in_container)"
test "$before" = "$(sh "$T/repo/luna/os/build/input-hash.sh")"
printf '\n# Input change must invalidate the cached OS image.\n' >> "$T/repo/shared/scripts/tailscale-bake.sh"
after="$(hash_in_container)"
test "$before" != "$after"
test "$after" = "$(sh "$T/repo/luna/os/build/input-hash.sh")"
echo "OS container helper mounts and content hashing passed"
