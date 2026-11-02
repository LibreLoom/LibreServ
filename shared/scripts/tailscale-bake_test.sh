#!/bin/sh
# Exercise the pinned archives and an isolated, unenrolled userspace daemon.
set -eu
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
. "$REPO/shared/scripts/tailscale-bake.sh"
ts_test_dir="$(mktemp -d /tmp/tailscale-package-test.XXXXXX)"
ts_test_pid=""
ts_test_container=""
cleanup() {
    if [ -s "$ts_test_dir/cid" ]; then
        ts_cid="$(cat "$ts_test_dir/cid")"
        echo 'Tailscale package test container final state:' >&2
        if [ "$ts_test_container" = docker ]; then
            timeout 5 docker --host "$ts_container_host" inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} pids={{.HostConfig.PidsLimit}} memory={{.HostConfig.Memory}} runtime={{.HostConfig.Runtime}}' "$ts_cid" >&2 2>&1 || true
        else
            timeout 5 podman inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} pids={{.HostConfig.PidsLimit}} memory={{.HostConfig.Memory}} runtime={{.HostConfig.Runtime}}' "$ts_cid" >&2 2>&1 || true
        fi
        # Inspect only this test's container, before removing it. The native
        # Podman view can expose OCI resource settings hidden by Docker's API.
        # Print resource limits only, never the full configuration or env.
        case "$ts_container_host" in
            unix://*/podman/podman.sock|'')
                ts_static="$(timeout 5 podman inspect --format '{{.StaticDir}}' "$ts_cid" 2>/dev/null || true)"
                if [ -n "$ts_static" ] && [ -f "$ts_static/config.json" ]; then
                    python3 - "$ts_static/config.json" <<'PY' >&2 || true
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    cfg = json.load(f)
linux = cfg.get("linux", {})
resources = linux.get("resources", {})
print("owned container OCI resources:", json.dumps({k: resources.get(k) for k in ("pids", "memory", "cpu")}, sort_keys=True))
print("owned container OCI cgroup namespace:", any(n.get("type") == "cgroup" for n in linux.get("namespaces", [])))
PY
                else
                    echo 'Owned container OCI config unavailable after exit.' >&2
                fi
                ;;
        esac
        run_test_container stop --time 3 "$ts_cid" >/dev/null 2>&1 || true
        run_test_container rm "$ts_cid" >/dev/null 2>&1 || true
    fi
    if [ -n "$ts_test_pid" ]; then
        kill "$ts_test_pid" 2>/dev/null || true
        wait "$ts_test_pid" 2>/dev/null || true
    fi
    if [ -f "$ts_test_dir/node/log" ]; then
        echo 'Tailscale package container log (last 80 lines):' >&2
        tail -n 80 "$ts_test_dir/node/log" >&2 || true
    fi
    rm -rf "$ts_test_dir"
}
trap cleanup EXIT HUP INT TERM

for ts_test_arch in amd64 arm64; do
    libreloom_install_tailscale "$ts_test_dir/$ts_test_arch" "$ts_test_arch"
    test -x "$ts_test_dir/$ts_test_arch/tailscale"
    test -x "$ts_test_dir/$ts_test_arch/tailscaled"
done
case "$(uname -m)" in
    x86_64) ts_native=amd64 ;;
    aarch64|arm64) ts_native=arm64 ;;
    *) echo "unsupported test host" >&2; exit 1 ;;
esac
echo 'Tailscale package check: host version and CLI help' >&2
echo "host process limit: $(ulimit -u 2>/dev/null || echo unavailable)" >&2
for ts_limit in /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max; do
    if [ -r "$ts_limit" ]; then IFS= read -r ts_value < "$ts_limit" || true; echo "host cgroup $ts_limit: $ts_value" >&2; fi
done
"$ts_test_dir/$ts_native/tailscale" version | head -1 | grep -Fx "$TAILSCALE_BAKE_VERSION"
"$ts_test_dir/$ts_native/tailscale" serve --help >/dev/null 2>&1
"$ts_test_dir/$ts_native/tailscale" funnel --help >/dev/null 2>&1

# Real local API shapes, without login, enrollment or a public listener.
mkdir -m 700 "$ts_test_dir/node"
mkdir -p "$ts_test_dir/versions/0.0.1" "$ts_test_dir/versions/0.0.2" "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
ln "$ts_test_dir/$ts_native/tailscaled" "$ts_test_dir/versions/0.0.1/tailscaled"
# Keep the real, unenrolled daemon off all networks. Its only API is the
# private Unix socket in this temporary directory. Verify the network namespace
# before starting the daemon; fail closed if the container cannot provide it.
. "$REPO/luna/os/lib/alpine-image.sh"
ts_container_host="${DOCKER_HOST:-}"
if [ -z "$ts_container_host" ]; then
    for socket in "${XDG_RUNTIME_DIR:-/nonexistent}/podman/podman.sock" /run/podman/podman.sock /var/run/docker.sock; do
        if [ -S "$socket" ]; then ts_container_host="unix://$socket"; break; fi
    done
fi
if [ -n "$ts_container_host" ] && command -v docker >/dev/null 2>&1; then
    ts_test_container=docker
    # Rootless runtimes map container root to the invoking host account.
    ts_security="$(docker --host "$ts_container_host" info --format '{{json .SecurityOptions}}')"
    case "$ts_security" in
        *rootless*) ts_container_user="" ;;
        *) ts_container_user="$(id -u):$(id -g)" ;;
    esac
elif command -v podman >/dev/null 2>&1; then
    ts_test_container=podman
    ts_container_user=""
else
    echo "An isolated container runtime is required for the Tailscale daemon check" >&2
    exit 1
fi
run_test_container() {
    if [ "$ts_test_container" = docker ]; then
        docker --host "$ts_container_host" "$@"
    else
        podman "$@"
    fi
}
case "$ts_container_host" in unix://*) ts_endpoint="$ts_container_host" ;; '') ts_endpoint='local Podman' ;; *) ts_endpoint='remote endpoint (redacted)' ;; esac
echo "Tailscale package runtime: client=$ts_test_container endpoint=$ts_endpoint" >&2
run_test_container info --format 'server={{.ServerVersion}} runtime={{.DefaultRuntime}} security={{json .SecurityOptions}}' >&2 || true
# Docker needs the host UID for the bind-mounted socket. Rootless Podman's
# container root already maps to the invoking host user.
set --
if [ -n "$ts_container_user" ]; then set -- --user "$ts_container_user"; fi
# Podman 4.9.3's Docker API can emit OCI pids.limit=0 for an omitted limit.
# runc 1.5.2 / opencontainers/cgroups 0.1.0 maps that explicit zero to one
# task, preventing the isolation checks from forking. Keep this disposable
# container bounded while allowing its shell and userspace daemon to run.
# Evidence and versioned source references: tailscale-verification.md.
run_test_container run --network=none --read-only --cap-drop=all --pids-limit=64 \
    --security-opt label=disable --security-opt no-new-privileges --cidfile "$ts_test_dir/cid" "$@" \
    -v "$ts_test_dir:$ts_test_dir:rw" "$ALPINE_IMAGE" sh -ec '
        package_dir=$1
        echo "container limits before isolation check and daemon start:" >&2
        echo "process limits:" >&2
        ulimit -a >&2 || true
        echo "container process cgroup and kernel limits:" >&2
        for file in /proc/self/cgroup /proc/self/limits; do
            if [ -r "$file" ]; then echo "$file:" >&2; while IFS= read -r line; do echo "$line" >&2; done < "$file"; fi
        done
        echo "cgroup mount entries:" >&2
        while IFS= read -r line; do case "$line" in *" - cgroup"*) echo "$line" >&2 ;; esac; done < /proc/self/mountinfo
        echo "container-visible cgroup mount root (may differ from effective process cgroup):" >&2
        for file in /sys/fs/cgroup/pids.current /sys/fs/cgroup/pids.max /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events; do
            if [ -r "$file" ]; then echo "$file:" >&2; while IFS= read -r line; do echo "$line" >&2; done < "$file"; fi
        done
        set -- /proc/[0-9]*; echo "visible process count: $#" >&2
        set -- "$package_dir"
        test "$(ls /sys/class/net)" = lo
        test "$(wc -l </proc/net/route)" -eq 1
        if nc -z -w 1 1.1.1.1 443; then echo "Network isolation failed" >&2; exit 1; fi
        export TS_NO_LOGS_NO_SUPPORT=true
        exec "$1/versions/0.0.1/tailscaled" --state="$1/node/state" --socket="$1/node/socket" --tun=userspace-networking --port=0
    ' sh "$ts_test_dir" >"$ts_test_dir/node/log" 2>&1 &
ts_test_pid=$!
ts_ready=false
for ts_attempt in 1 2 3 4 5; do
    if timeout 3 "$ts_test_dir/$ts_native/tailscale" --socket="$ts_test_dir/node/socket" status --json >"$ts_test_dir/node/status.json" 2>/dev/null; then
        ts_ready=true
        break
    fi
    sleep 1
done
if [ "$ts_ready" != true ]; then cat "$ts_test_dir/node/log" >&2; exit 1; fi
ts_container_pid="$(run_test_container inspect --format '{{.State.Pid}}' "$(cat "$ts_test_dir/cid")" 2>/dev/null || true)"
case "$ts_container_pid" in
    ''|*[!0-9]*|0) echo 'Container PID unavailable for task-count diagnostics.' >&2 ;;
    *)
        ts_cgroup="$(awk -F: '$1 == "0" {print $3}' "/proc/$ts_container_pid/cgroup" 2>/dev/null || true)"
        case "$ts_cgroup" in
            /*) for ts_metric in pids.current pids.peak pids.max; do
                if [ -r "/sys/fs/cgroup$ts_cgroup/$ts_metric" ]; then
                    IFS= read -r ts_value < "/sys/fs/cgroup$ts_cgroup/$ts_metric" || true
                    echo "owned container $ts_metric: $ts_value" >&2
                fi
            done ;;
        esac ;;
esac
echo 'Tailscale package check: unenrolled local API' >&2
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["BackendState"] == "NeedsLogin"' "$ts_test_dir/node/status.json"
timeout 3 "$ts_test_dir/$ts_native/tailscale" --socket="$ts_test_dir/node/socket" serve status --json >"$ts_test_dir/node/serve.json"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1])) in (None, {})' "$ts_test_dir/node/serve.json"
# This is why product teardown must also work offline, after stopping tailscaled.
if timeout 3 "$ts_test_dir/$ts_native/tailscale" --socket="$ts_test_dir/node/socket" serve reset >"$ts_test_dir/node/reset.log" 2>&1; then
    echo "Expected the pinned daemon to reject a reset before login" >&2
    exit 1
fi
grep -F 'netMap is nil' "$ts_test_dir/node/reset.log"
# Upgrades reclaim unused versions, but keep the running executable intact.
bash -c '. "$1"; TAILSCALE_INSTALL_DIR="$2"; prune_tailscale_versions' \
    check "$REPO/sol/install.sh" "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
test -d "$ts_test_dir/versions/0.0.1"
test ! -d "$ts_test_dir/versions/0.0.2"
test -d "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
run_test_container stop --time 3 "$(cat "$ts_test_dir/cid")" >/dev/null
wait "$ts_test_pid" || true
ts_test_pid=""
echo 'Tailscale package test stopped container state:' >&2
run_test_container inspect --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} pids={{.HostConfig.PidsLimit}} memory={{.HostConfig.Memory}} runtime={{.HostConfig.Runtime}}' "$(cat "$ts_test_dir/cid")" >&2 || true
run_test_container rm "$(cat "$ts_test_dir/cid")" >/dev/null
rm -f "$ts_test_dir/cid"
bash -c '. "$1"; TAILSCALE_INSTALL_DIR="$2"; prune_tailscale_versions' \
    check "$REPO/sol/install.sh" "$ts_test_dir/versions/$TAILSCALE_BAKE_VERSION"
test ! -d "$ts_test_dir/versions/0.0.1"

# The public installer must remain standalone and pin the same release/hashes.
bash -c '. "$1"; test "$TAILSCALE_VERSION" = "$2" && test "$TAILSCALE_SHA256_AMD64" = "$3" && test "$TAILSCALE_SHA256_ARM64" = "$4"' \
    check "$REPO/sol/install.sh" "$TAILSCALE_BAKE_VERSION" "$TAILSCALE_BAKE_SHA_AMD64" "$TAILSCALE_BAKE_SHA_ARM64"
test "$(sed -n 's/^const TailscaleVersion = "\([^"]*\)"/\1/p' "$REPO/sol/server/backend/internal/network/tailscale.go")" = "$TAILSCALE_BAKE_VERSION"

# Optional native packaging failure must not abort install or upgrade.
bash -c 'set -e; . "$1"; install_tailscale() { return 1; }; install_optional_tailscale; echo continued' \
    check "$REPO/sol/install.sh" | grep -Fx continued

# A fresh Sol install must not require tools used only by optional packaging.
bash -c 'set -e; . "$1"; command() {
    if [ "$1" = -v ]; then
        case "$2" in tar|timeout) return 1 ;; curl|openssl|sha256sum) return 0 ;; esac
    fi
    builtin command "$@"
}; check_dependencies; install_optional_tailscale; echo continued-without-optional-tools' \
    check "$REPO/sol/install.sh" | grep -Fx continued-without-optional-tools

mkdir -p "$ts_test_dir/fakebin"
cat > "$ts_test_dir/fakebin/curl" <<'MOCK'
#!/bin/sh
while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then printf 'corrupt archive' > "$2"; exit 0; fi
    shift
done
exit 1
MOCK
chmod +x "$ts_test_dir/fakebin/curl"
if PATH="$ts_test_dir/fakebin:$PATH" libreloom_install_tailscale "$ts_test_dir/rejected" amd64; then
    echo "corrupt archive was accepted" >&2
    exit 1
fi
test ! -e "$ts_test_dir/rejected/tailscale"
sh "$REPO/luna/os/rootfs_test.sh"
sh "$REPO/shared/scripts/tailscale-rootfs_test.sh"
echo "Pinned Tailscale archives, integrity rejection, and Luna rootfs checks passed"
