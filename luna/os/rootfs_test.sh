#!/bin/sh
# Static checks for Luna OS rootfs wiring (no podman build required).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ASSEMBLER="$ROOT/os/build/rootfs.sh"
FRAGS="$ROOT/os/lib/build-rootfs.d"
CF_BAKE="$ROOT/os/lib/cloudflared-bake.sh"
# Assemble frags into a temp script so static asserts scan the real body.
BUILD="$(mktemp)"
trap 'rm -f "$BUILD"' EXIT
# shellcheck disable=SC2012
cat $(ls "$FRAGS"/*.frag | sort) > "$BUILD"

assert_file_has() {
	file="$1"
	needle="$2"
	msg="$3"
	grep -q "$needle" "$file" || {
		echo "FAIL: $msg (missing '$needle' in $file)" >&2
		exit 1
	}
}

assert_file_lacks() {
	file="$1"
	needle="$2"
	msg="$3"
	if grep -Eq "$needle" "$file"; then
		echo "FAIL: $msg (found '$needle' in $file)" >&2
		exit 1
	fi
}

assert_file_has "$BUILD" 'luna-network-up' "rootfs must ship wired bring-up script"
assert_file_has "$BUILD" 'etc/init.d/luna-network' "rootfs must ship luna-network OpenRC service"
assert_file_has "$BUILD" '/etc/network/interfaces' "rootfs must ship a minimal interfaces file"
# Ethernet-only: rootfs must not ship wpa_supplicant / setup-AP leftovers.
if grep -E 'wpa_supplicant|dnsmasq' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: Luna OS is Ethernet-only; do not package wpa_supplicant or dnsmasq" >&2
	exit 1
fi
assert_file_has "$BUILD" 'for svc in luna-root-ro hwclock modules sysctl hostname bootmisc syslog loopback luna-input luna-network;' \
	"boot runlevel must remount root read-only before network bring-up"
assert_file_has "$BUILD" 'loopback' "boot runlevel must enable loopback service"
# lunad must be supervised (crash/update restart) and must have a log file.
assert_file_has "$BUILD" 'supervisor="supervise-daemon"' "lunad must run under supervise-daemon"
assert_file_has "$BUILD" 'output_log="/var/log/luna.log"' "lunad stdout must go to a log file"
# One-shot boot scripts must define start(): with command= OpenRC watches for a
# daemon that already exited, lists the service as "crashed", and starts it again
# for every service that depends on it.
assert_file_lacks "$BUILD" 'command="/usr/local/[a-z]*/luna-\(network-up\|input-up\|root-ro\|boot-ok\)"' \
	"one-shot boot scripts must use start(), not command="
assert_file_has "$BUILD" 'critical_mounts="/var/lib/luna"' \
	"localmount must treat LUNA_DATA as critical"
assert_file_has "$BUILD" 'for svc in devfs dmesg mdev hwdrivers fsck root localmount;' \
	"sysinit must mount fstab before boot services start"
assert_file_has "$BUILD" 'mountpoint -q /var/lib/luna' \
	"lunad must refuse to start when LUNA_DATA is not mounted"
assert_file_lacks "$BUILD" 'runlevels/default/local' \
	"rootfs must not use OpenRC local.d for boot hooks"
assert_file_has "$BUILD" 'etc/init.d/luna-root-ro' \
	"rootfs must remount root via a dedicated OpenRC service"
assert_file_has "$BUILD" 'etc/init.d/luna-boot-ok' \
	"rootfs must mark tryboot success via a dedicated OpenRC service"
assert_file_has "$BUILD" 'timeout 2 mount' \
	"tryboot marker must not block boot on a slow ESP mount"
assert_file_has "$BUILD" '/run/luna/boot-ok' \
	"boot-ok must tell lunad the boot is confirmed (it settles OS updates on it)"
assert_file_has "$BUILD" '"$_saved" = 1' \
	"boot-ok marker must only be written after GRUB's luna_boot_ok was saved"
assert_file_has "$BUILD" 'ip link set lo up' "luna-network-up must ensure lo interface is up"
assert_file_has "$BUILD" 'for svc in devfs dmesg mdev hwdrivers fsck root localmount;' \
	"sysinit must enable Alpine hwdrivers coldplug and mount fstab before boot"
assert_file_has "$BUILD" 'modules-load.d/luna-input.conf' "rootfs must ship keyboard module list"
assert_file_has "$BUILD" 'luna-input-up' "rootfs must ship keyboard / HID bring-up script"
assert_file_has "$BUILD" 'usbhid' "rootfs must load usbhid for USB keyboards"
assert_file_has "$BUILD" 'hid-generic' "rootfs must load hid-generic"
assert_file_has "$BUILD" 'evdev' "rootfs must load evdev for /dev/input/event*"
assert_file_has "$BUILD" 'atkbd' "rootfs must load atkbd for PS/2 keyboards"
assert_file_has "$BUILD" ' alpine-base openrc linux-lts kmod ' \
	"rootfs must install kmod so gzipped .ko.gz modules load"
assert_file_has "$BUILD" 'linux-firmware-none' \
	"rootfs must use linux-firmware-none instead of the full firmware meta package"
assert_file_has "$BUILD" 'virtio_net' \
	"rootfs network bring-up must load virtio_net for QEMU / virt guests"
assert_file_has "$BUILD" 'rc_parallel="YES"' \
	"OpenRC must start services in parallel for faster boot"
assert_file_has "$BUILD" 'udhcpc -i "$iface" -q -n -t 3' \
	"boot DHCP must use a short retry budget so OpenRC is not blocked"
assert_file_has "$BUILD" 'after luna-network' \
	"lunad must not wait on avahi before binding HTTP"
assert_file_has "$BUILD" 'makestep 1.0 3' \
	"chrony must step the clock quickly after DHCP for TLS"
assert_file_has "$BUILD" 'tmpfs /tmp' \
	"rootfs must mount /tmp on tmpfs (read-only root slot)"
assert_file_has "$BUILD" 'tmpfs /var/log' \
	"syslog must land on tmpfs so messages do not wear the eMMC"
assert_file_has "$BUILD" 'LABEL=LUNA_DATA /var/lib/luna' \
	"rootfs must mount the data partition at /var/lib/luna"
assert_file_has "$BUILD" 'luna-root-ro' \
	"rootfs must remount root read-only + noatime"
assert_file_has "$BUILD" 'luna-run' \
	"rootfs must prefer /var/lib/luna/bin/lunad for daemon OTA"
assert_file_has "$BUILD" 'util-linux' \
	"rootfs must include util-linux (provides fstrim)"
assert_file_has "$ASSEMBLER" 'build-rootfs.d' \
	"build/rootfs.sh must assemble lib/build-rootfs.d frags"
assert_file_has "$CF_BAKE" 'CLOUDFLARED_VERSION' \
	"rootfs must ship pinned cloudflared-bake helper"
assert_file_has "$CF_BAKE" 'keeping baked cloudflared' \
	"rootfs must skip pinned refresh when a good baked cloudflared already exists"
assert_file_has "$BUILD" 'luna_cloudflared_download' \
	"rootfs must ship cloudflared so Luna Connect tunnels can start"
assert_file_lacks "$BUILD" '/latest/download' \
	"rootfs must never fetch unpinned cloudflared /latest/"
assert_file_lacks "$CF_BAKE" '/latest/download' \
	"cloudflared-bake must never fetch unpinned /latest/"
assert_file_has "$CF_BAKE" 'lunad can also install on demand' \
	"cloudflared-bake must mention on-demand install"
assert_file_has "$BUILD" 'PATH=/usr/local/sbin:/usr/local/bin' \
	"lunad OpenRC service must include /usr/local/bin in PATH for cloudflared"
assert_file_has "$BUILD" 'tty1::respawn:/usr/local/bin/luna-console' \
	"rootfs must run luna-console on tty1 instead of stock getty"
assert_file_has "$BUILD" 'install -m 0755 "$CONSOLE_BIN" "$ROOTFS/usr/local/bin/luna-console"' \
	"rootfs build must install luna-console next to lunad"
assert_file_lacks "$BUILD" 'tty1::respawn:/sbin/getty' \
	"rootfs must not respawn BusyBox getty on tty1"
assert_file_lacks "$BUILD" 'luna-pwreset' \
	"rootfs must not ship luna-pwreset (recovery is USB flash drive)"
assert_file_lacks "$BUILD" 'pwreset:x:' \
	"rootfs must not bake a pwreset Linux account"
assert_file_has "$BUILD" 'luna:x:1000' \
	"rootfs must bake the luna Linux account"
assert_file_has "$BUILD" '/sbin/nologin' \
	"luna console account must use nologin"
assert_file_has "$BUILD" 'root::' \
	"root may keep an empty password hash for local console login"
assert_file_has "$BUILD" '/bin/ash' \
	"root console account must use /bin/ash"
assert_file_has "$BUILD" 'luna:!:' \
	"luna must be locked in the baked shadow (not empty password)"
assert_file_lacks "$BUILD" 'pwreset::' \
	"rootfs must not keep a pwreset shadow entry"
assert_file_lacks "$BUILD" 'for u in root luna pwreset' \
	"build must not empty passwords for root/luna/pwreset in one loop"
assert_file_lacks "$BUILD" 'openssh|dropbear' \
	"rootfs must not package SSH (console accounts are local only)"

# Rootless build: no podman, sudo, or privileged container inside the rootfs
# frags (they run inside a container), and no tarball output.
assert_file_lacks "$BUILD" '^[^#]*(podman|sudo|--privileged)' \
	"rootfs frags run inside the build container and must not call podman or sudo"
assert_file_lacks "$BUILD" 'luna-rootfs-.*tar' \
	"the rootfs tarball is gone: the slot image is the only OS payload"
assert_file_lacks "$ROOT/os/build/image.sh" '^[^#]*(podman|sudo|--privileged)' \
	"image.sh runs inside the build container and must not call podman or sudo"
assert_file_has "$ROOT/os/build/image.sh" 'mkfs.ext4 .* -d ' \
	"image.sh must write the filesystem with mkfs.ext4 -d (no loop device, no mount)"
assert_file_has "$ROOT/os/build/image.sh" 'xz -3' \
	"image.sh must compress the slot image with xz"

FLASH="$ROOT/os/lib/flash-disk.sh"
assert_file_has "$FLASH" 'rootflags=ro,noatime' \
	"installed kernel cmdline must mount OS slots read-only with noatime"
assert_file_has "$FLASH" 'LUNA_A' \
	"flash must create OS slot A"
assert_file_has "$FLASH" 'LUNA_B' \
	"flash must create OS slot B"
assert_file_has "$FLASH" 'LUNA_DATA' \
	"flash must create the data partition"
assert_file_has "$FLASH" 'luna_boot_ok' \
	"flash GRUB must implement tryboot rollback"

# Only flag an apk install of the meta package, not comments mentioning it.
if grep -E 'apk add' "$BUILD" | grep -qE '(^|[[:space:]])linux-firmware([[:space:]]|$)'; then
	echo "FAIL: do not install the linux-firmware meta package (hundreds of MB of unused blobs)" >&2
	exit 1
fi

if grep 'for svc in .*networking;' "$BUILD" >/dev/null 2>&1; then
	echo "FAIL: stock Alpine networking must not stay in boot runlevel" >&2
	exit 1
fi

if ! grep -q 'hwdrivers' "$BUILD"; then
	echo "FAIL: hwdrivers must be enabled so cold-plugged keyboards bind at boot" >&2
	exit 1
fi

# cloudflared must be checked against its pinned SHA-256, on download and on
# every cache hit; a bad cache entry is deleted.
(
	T="$(mktemp -d)"
	trap 'rm -rf "$T"' EXIT
	mkdir "$T/bin" "$T/cache"
	{ printf '\177ELF'; head -c 3000 /dev/zero; } > "$T/good"
	{ printf '\177ELF'; head -c 3000 /dev/zero | tr '\0' 'x'; } > "$T/evil"
	cat > "$T/bin/curl" <<STUB
#!/bin/sh
echo hit >> "$T/curl-calls"
while [ \$# -gt 0 ]; do [ "\$1" = -o ] && out="\$2"; shift; done
cp "$T/\$(cat "$T/serve")" "\$out"
STUB
	chmod +x "$T/bin/curl"
	export PATH="$T/bin:$PATH" ARCH=x86_64 LUNA_CACHE_DIR="$T/cache"
	CLOUDFLARED_SHA256_AMD64="$(sha256sum "$T/good" | cut -d' ' -f1)"
	export CLOUDFLARED_SHA256_AMD64
	# shellcheck source=lib/cloudflared-bake.sh
	. "$CF_BAKE"
	cached="$T/cache/cloudflared-${CLOUDFLARED_VERSION}-amd64"

	echo evil > "$T/serve"
	if luna_cloudflared_download "$T/out" 2>/dev/null; then
		echo "FAIL: cloudflared download with a wrong SHA-256 must fail" >&2; exit 1
	fi
	{ [ ! -e "$T/out" ] && [ ! -e "$cached" ]; } || { echo "FAIL: a mismatching download must not be kept or cached" >&2; exit 1; }

	echo good > "$T/serve"
	luna_cloudflared_download "$T/out" 2>/dev/null || { echo "FAIL: matching cloudflared download must succeed" >&2; exit 1; }
	[ -s "$cached" ] || { echo "FAIL: verified download must be cached" >&2; exit 1; }

	: > "$T/curl-calls"
	luna_cloudflared_download "$T/out2" 2>/dev/null || { echo "FAIL: good cache hit must succeed" >&2; exit 1; }
	[ ! -s "$T/curl-calls" ] || { echo "FAIL: a good cache hit must not download" >&2; exit 1; }

	cp "$T/evil" "$cached"
	luna_cloudflared_download "$T/out3" 2>/dev/null || { echo "FAIL: a bad cache entry must fall back to a download" >&2; exit 1; }
	cmp -s "$T/out3" "$T/good" || { echo "FAIL: output after a bad cache must be the verified binary" >&2; exit 1; }
	cmp -s "$cached" "$T/good" || { echo "FAIL: a bad cache entry must be replaced" >&2; exit 1; }
)

# DNS on a read-only root: udhcpc writes /run/resolv.conf (tmpfs), /etc/resolv.conf
# is a symlink to it, and luna-network-up seeds a fallback when DHCP gave no servers.
assert_file_has "$BUILD" "RESOLV_CONF=/run/resolv.conf" \
	"udhcpc must write resolv.conf to tmpfs; the root is read-only"
assert_file_has "$BUILD" 'ln -s /run/resolv.conf "$ROOTFS/etc/resolv.conf"' \
	"/etc/resolv.conf must point at the writable /run/resolv.conf"
assert_file_has "$BUILD" 'nameserver 1.1.1.1' \
	"luna-network-up must seed a fallback DNS server"

(
	T="$(mktemp -d)"
	trap 'rm -rf "$T"' EXIT INT
	# luna-network-up as shipped, with every command it calls stubbed out.
	sed -n "/luna-network-up\" <<'INIT'\$/,/^INIT\$/p" "$FRAGS/02.frag" | sed '1d;$d' >"$T/up"
	[ -s "$T/up" ] || { echo "FAIL: cannot find luna-network-up in 02.frag" >&2; exit 1; }
	mkdir "$T/bin"
	for c in modprobe ip udhcpc; do printf '#!/bin/sh\nexit 0\n' >"$T/bin/$c"; chmod +x "$T/bin/$c"; done
	run_up() { PATH="$T/bin:$PATH" LUNA_RESOLV_CONF="$T/resolv.conf" sh "$T/up"; }

	rm -f "$T/resolv.conf"
	run_up
	grep -qx 'nameserver 1.1.1.1' "$T/resolv.conf" && grep -qx 'nameserver 9.9.9.9' "$T/resolv.conf" || {
		echo "FAIL: a missing resolv.conf must be seeded with the fallback servers" >&2; exit 1; }

	: >"$T/resolv.conf"
	run_up
	grep -qx 'nameserver 1.1.1.1' "$T/resolv.conf" || {
		echo "FAIL: an empty resolv.conf must be seeded with the fallback servers" >&2; exit 1; }

	printf 'search lan\nnameserver 192.168.1.1\n' >"$T/resolv.conf"
	run_up
	[ "$(cat "$T/resolv.conf")" = "$(printf 'search lan\nnameserver 192.168.1.1')" ] || {
		echo "FAIL: DNS servers from DHCP must not be overwritten by the fallback" >&2; exit 1; }
)

echo "rootfs_test ok"
