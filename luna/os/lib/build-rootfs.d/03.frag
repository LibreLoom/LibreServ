# Remount root read-only in the boot runlevel, before lunad or other writers start.
cat > "$ROOTFS/usr/local/sbin/luna-root-ro" <<'NORW'
#!/bin/sh
mount -o remount,ro,noatime / 2>/dev/null || mount -o remount,noatime / 2>/dev/null || true
NORW
chmod +x "$ROOTFS/usr/local/sbin/luna-root-ro"

cat > "$ROOTFS/etc/init.d/luna-root-ro" <<'INIT'
#!/sbin/openrc-run
description="Remount Luna OS root read-only"
start() {
    ebegin "Remounting the Luna OS root read-only"
    /usr/local/sbin/luna-root-ro
    eend $?
}
depend() {
    need localmount
    # bootmisc cleans /run and /tmp; it must finish before / goes read-only.
    after bootmisc
    before luna-input luna-network luna avahi-daemon
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna-root-ro"

# Mark tryboot success after lunad is up (best-effort; must never block boot).
cat > "$ROOTFS/usr/local/sbin/luna-boot-ok" <<'BOOTOK'
#!/bin/sh
# Clear GRUB tryboot failure state after a successful boot into this slot, then
# tell lunad: /run/luna/boot-ok holds this boot's id, written only after GRUB's
# luna_boot_ok=1 was saved. lunad records a new OS image as installed only once
# it sees that file, so it never gets ahead of GRUB. /run is empty after reboot.
if ! command -v grub-editenv >/dev/null 2>&1; then
    exit 0
fi
_saved=0
for _env in /boot/efi/grub/grubenv /efi/grub/grubenv; do
    [ -f "$_env" ] || continue
    if grub-editenv "$_env" set luna_boot_ok=1 2>/dev/null; then
        _saved=1
    fi
    grub-editenv "$_env" set luna_tries=3 2>/dev/null || true
done
# ESP lives on its own FAT partition; prefer the stable by-label path over findfs.
for _esp in /dev/disk/by-label/LUNAESP; do
    [ -e "$_esp" ] || continue
    _m="$(mktemp -d /tmp/luna-esp.XXXXXX 2>/dev/null)" || continue
    if timeout 2 mount -o rw "$_esp" "$_m" 2>/dev/null; then
        if grub-editenv "$_m/grub/grubenv" set luna_boot_ok=1 2>/dev/null; then
            _saved=1
        fi
        grub-editenv "$_m/grub/grubenv" set luna_tries=3 2>/dev/null || true
        umount "$_m" 2>/dev/null || true
    fi
    rmdir "$_m" 2>/dev/null || true
    break
done
if [ "$_saved" = 1 ] && [ -r /proc/sys/kernel/random/boot_id ]; then
    mkdir -p /run/luna 2>/dev/null || true
    _tmp=/run/luna/boot-ok.tmp
    if cat /proc/sys/kernel/random/boot_id > "$_tmp" 2>/dev/null; then
        mv "$_tmp" /run/luna/boot-ok 2>/dev/null || true
    fi
fi
exit 0
BOOTOK
chmod +x "$ROOTFS/usr/local/sbin/luna-boot-ok"

cat > "$ROOTFS/etc/init.d/luna-boot-ok" <<'INIT'
#!/sbin/openrc-run
description="Mark Luna GRUB tryboot successful"
start() {
    ebegin "Marking this boot successful"
    /usr/local/sbin/luna-boot-ok
    eend $?
}
depend() {
    need luna
    keyword -timeout -noparallel
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna-boot-ok"

# Install the daemon binary.
install -m 0755 "$BIN" "$ROOTFS/usr/local/bin/lunad"
CONSOLE_BIN="${LUNA_CONSOLE_BIN:-}"
if [ -z "$CONSOLE_BIN" ]; then
    CONSOLE_BIN="$(dirname "$BIN")/luna-console"
fi
if [ ! -x "$CONSOLE_BIN" ]; then
    echo "missing luna-console binary next to lunad ($CONSOLE_BIN)" >&2
    echo "build it first: cargo build --release -p lunad --bin luna-console (musl) or set LUNA_CONSOLE_BIN" >&2
    exit 1
fi
install -m 0755 "$CONSOLE_BIN" "$ROOTFS/usr/local/bin/luna-console"
mkdir -p "$ROOTFS/var/lib/luna"



# Seed console issue file (lunad overwrites with live IP / device token).
cat > "$ROOTFS/var/lib/luna/issue" <<'ISSUE'

============================================================
  Luna is starting. Open it from a browser.
============================================================

ISSUE

# Console accounts (HDMI/USB keyboard only; no SSH).
# `root` keeps an empty password for local tty1 login.
# `luna` stays locked (!). Rootfs is remounted read-only later.
if grep -q "^root:" "$ROOTFS"/etc/passwd; then
    sed -i -E "s|^root:([^:]*):([^:]*):([^:]*):([^:]*):([^:]*):[^:]*$|root:\1:\2:\3:\4:\5:/bin/ash|" "$ROOTFS"/etc/passwd
fi
if ! grep -q "^luna:" "$ROOTFS"/etc/passwd; then
    echo "luna:x:1000:1000:Luna:/home/luna:/sbin/nologin" >> "$ROOTFS"/etc/passwd
    echo "luna:x:1000:" >> "$ROOTFS"/etc/group
    mkdir -p "$ROOTFS"/home/luna
    chown 1000:1000 "$ROOTFS"/home/luna
else
    sed -i -E "s|^luna:([^:]*):([^:]*):([^:]*):([^:]*):([^:]*):[^:]*$|luna:\1:\2:\3:\4:\5:/sbin/nologin|" "$ROOTFS"/etc/passwd
fi
# Empty hash for root (blank password login); lock luna.
if grep -q "^root:" "$ROOTFS"/etc/shadow; then
    sed -i -E "s|^root:[^:]*:|root::|" "$ROOTFS"/etc/shadow
else
