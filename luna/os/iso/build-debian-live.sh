#!/bin/bash
# Build the Luna rapidinstall hybrid ISO with live-build on the host.
# live-build/debootstrap need mknod; run this script with sudo.
set -euo pipefail

ARCH="${ARCH:-x86_64}"
OUT="${OUT:-/out}"
WORK="${WORK:-/work}"
LOG="${WORK}/build.log"

export DEBIAN_FRONTEND=noninteractive

die() {
	echo "ERROR: $*" >&2
	exit 1
}

if [ "$(id -u)" -ne 0 ]; then
	die "run via sudo (live-build needs root for debootstrap/chroot)"
fi

if ! command -v lb >/dev/null 2>&1; then
	die "live-build missing (apt install live-build debootstrap debian-archive-keyring xorriso)"
fi

# Host tools live-build invokes directly (not via chroot package lists).
_missing=""
for _pkg in xorriso syslinux-utils apt-utils isolinux; do
	dpkg -s "$_pkg" >/dev/null 2>&1 || _missing="$_missing $_pkg"
done
if [ -n "$_missing" ]; then
	echo "==> installing host packages:${_missing}" | tee -a "${LOG:-/dev/stderr}"
	apt-get update -qq || die "apt-get update failed"
	apt-get install -y --no-install-recommends $_missing >>"${LOG:-/dev/stderr}" 2>&1 \
		|| die "could not install host packages:${_missing}"
fi

[ -d "$WORK" ] || die "build workspace missing: $WORK"
[ -d "$OUT" ] || die "output directory missing: $OUT"
[ -f "$WORK/config/includes.binary/luna/rapidinstall.sh" ] || \
	die "staged installer missing — run os/iso/stage-debian-live.sh first"

# live-build 3.x isolinux templates use broken symlinks on bookworm; ship our own.
_setup_bootloaders() {
	local _bl="$WORK/config/bootloaders/isolinux"
	local _src="/usr/share/live/build/bootloaders/isolinux"
	local _tmpdir
	mkdir -p "$_bl"
	cp "$_src"/*.cfg "$_bl/"
	cp "$_src"/*.in "$_bl/" 2>/dev/null || true
	cp /usr/lib/ISOLINUX/isolinux.bin "$_bl/"
	cp /usr/lib/syslinux/modules/bios/vesamenu.c32 "$_bl/"
	_tmpdir="$(mktemp -d)"
	( cd "$_tmpdir" && find . -depth -print | cpio -o --quiet ) >"$_bl/bootlogo"
	rm -rf "$_tmpdir"
}

_setup_bootloaders

cd "$WORK"
chmod +x auto/config config/hooks/*.hook.chroot config/hooks/live/*.hook.chroot 2>/dev/null || true
chmod +x config/includes.chroot/usr/lib/luna-installer/start.sh 2>/dev/null || true

: >"$LOG"

echo "==> lb clean" | tee -a "$LOG"
if ! lb clean --purge >>"$LOG" 2>&1; then
	echo "warn: lb clean --purge failed (continuing)" >>"$LOG"
fi

echo "==> lb config" | tee -a "$LOG"
if ! lb config >>"$LOG" 2>&1; then
	echo "==> lb config failed; last 30 log lines:" >&2
	tail -30 "$LOG" >&2
	die "lb config failed (see $LOG)"
fi

echo "==> lb build" | tee -a "$LOG"
# Detach from controlling tty so job-control SIGSTOP cannot freeze apt in chroot.
_lb_ok=0
if setsid lb build >>"$LOG" 2>&1; then
	_lb_ok=1
else
	echo "==> lb build returned error; checking for recoverable hybrid ISO" | tee -a "$LOG"
	for _candidate in binary.hybrid.iso chroot/binary.hybrid.iso; do
		if [ -f "$_candidate" ] && command -v isohybrid >/dev/null 2>&1; then
			if isohybrid ${ISOHYBRID_OPTIONS:-} "$_candidate" >>"$LOG" 2>&1; then
				[ "$_candidate" != "binary.hybrid.iso" ] && mv "$_candidate" binary.hybrid.iso
				_lb_ok=1
				echo "==> recovered with host isohybrid on binary.hybrid.iso" | tee -a "$LOG"
				break
			fi
		fi
	done
fi
if [ "$_lb_ok" -ne 1 ]; then
	echo "==> lb build failed; last 40 log lines:" >&2
	tail -40 "$LOG" >&2
	exit 1
fi

_iso=""
for candidate in "live-image-${ARCH}.hybrid.iso" "live-image-amd64.hybrid.iso" "binary.hybrid.iso"; do
	if [ -f "$candidate" ]; then
		_iso="$candidate"
		break
	fi
done
if [ -z "$_iso" ]; then
	_iso="$(find . -maxdepth 1 -name '*.hybrid.iso' -print -quit || true)"
fi
[ -n "$_iso" ] && [ -f "$_iso" ] || die "live-build produced no *.hybrid.iso (see $LOG)"

_out="$OUT/luna-rapidinstall-${ARCH}.iso"
cp "$_iso" "$_out" || die "could not copy ISO to $_out"

if [ -n "${SUDO_USER:-}" ]; then
	chown "$SUDO_USER:$SUDO_USER" "$_out" "$LOG" 2>/dev/null || true
fi

printf 'built %s\n' "$_out"
