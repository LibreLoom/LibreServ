# Remount root read-only in the boot runlevel, before lunad or other writers start.
cat > "$ROOTFS/usr/local/sbin/luna-root-ro" <<'NORW'
#!/bin/sh
mount -o remount,ro,noatime / 2>/dev/null || mount -o remount,noatime / 2>/dev/null || true
NORW
chmod +x "$ROOTFS/usr/local/sbin/luna-root-ro"

cat > "$ROOTFS/etc/init.d/luna-root-ro" <<'INIT'
#!/sbin/openrc-run
description="Remount Luna OS root read-only"
command="/usr/local/sbin/luna-root-ro"
depend() {
    need localmount
    before luna-input luna-network luna avahi-daemon
}
INIT
chmod +x "$ROOTFS/etc/init.d/luna-root-ro"

# Mark tryboot success after lunad is up (best-effort; must never block boot).
cat > "$ROOTFS/usr/local/sbin/luna-boot-ok" <<'BOOTOK'
#!/bin/sh
# Clear GRUB tryboot failure state after a successful boot into this slot.
if ! command -v grub-editenv >/dev/null 2>&1; then
    exit 0
fi
for _env in /boot/efi/grub/grubenv /efi/grub/grubenv; do
    [ -f "$_env" ] || continue
    grub-editenv "$_env" set luna_boot_ok=1 2>/dev/null || true
    grub-editenv "$_env" set luna_tries=3 2>/dev/null || true
done
# ESP lives on its own FAT partition; prefer the stable by-label path over findfs.
for _esp in /dev/disk/by-label/LUNAESP; do
    [ -e "$_esp" ] || continue
    _m="$(mktemp -d /tmp/luna-esp.XXXXXX 2>/dev/null)" || continue
    if timeout 2 mount -o rw "$_esp" "$_m" 2>/dev/null; then
        grub-editenv "$_m/grub/grubenv" set luna_boot_ok=1 2>/dev/null || true
        grub-editenv "$_m/grub/grubenv" set luna_tries=3 2>/dev/null || true
        umount "$_m" 2>/dev/null || true
    fi
    rmdir "$_m" 2>/dev/null || true
    break
done
BOOTOK
chmod +x "$ROOTFS/usr/local/sbin/luna-boot-ok"

cat > "$ROOTFS/etc/init.d/luna-boot-ok" <<'INIT'
#!/sbin/openrc-run
description="Mark Luna GRUB tryboot successful"
command="/usr/local/sbin/luna-boot-ok"
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
  Luna is starting. Open it from a phone or computer.
============================================================

ISSUE

# Console accounts (HDMI/USB keyboard only; no SSH).
# `root` keeps an empty password for local tty1 login.
# `luna` stays locked (!). Rootfs is remounted read-only later.
podman run --rm --privileged -v "$ROOTFS:/rootfs:z" "$ALPINE_IMAGE" sh -euc '
    if grep -q "^root:" /rootfs/etc/passwd; then
        sed -i -E "s|^root:([^:]*):([^:]*):([^:]*):([^:]*):([^:]*):[^:]*$|root:\1:\2:\3:\4:\5:/bin/ash|" /rootfs/etc/passwd
    fi
    if ! grep -q "^luna:" /rootfs/etc/passwd; then
        echo "luna:x:1000:1000:Luna:/home/luna:/sbin/nologin" >> /rootfs/etc/passwd
        echo "luna:x:1000:" >> /rootfs/etc/group
        mkdir -p /rootfs/home/luna
        chown 1000:1000 /rootfs/home/luna
    else
        sed -i -E "s|^luna:([^:]*):([^:]*):([^:]*):([^:]*):([^:]*):[^:]*$|luna:\1:\2:\3:\4:\5:/sbin/nologin|" /rootfs/etc/passwd
    fi
    # Empty hash for root (blank password login); lock luna.
    if grep -q "^root:" /rootfs/etc/shadow; then
        sed -i -E "s|^root:[^:]*:|root::|" /rootfs/etc/shadow
    else
