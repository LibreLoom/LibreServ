#!/bin/sh
# Bring up the first wired NIC with DHCP on the rapidinstall live ISO.
# Custom init= skips live-config, so we do this by hand.
set -eu

[ -d /sys/class/net ] || exit 0

if ! command -v ip >/dev/null 2>&1; then
	exit 0
fi

for _sys in /sys/class/net/*; do
	[ -e "$_sys" ] || continue
	_iface="$(basename "$_sys")"
	case "$_iface" in
	lo) continue ;;
	esac
	# Prefer classic wired names; fall back to the first non-loopback iface.
	case "$_iface" in
	eth*|en*|eno*|ens*|enp*) ;;
	*) continue ;;
	esac
	ip link set "$_iface" up 2>/dev/null || continue
	if command -v dhclient >/dev/null 2>&1; then
		dhclient -1 -q "$_iface" 2>/dev/null || true
	elif command -v udhcpc >/dev/null 2>&1; then
		udhcpc -i "$_iface" -q -n 2>/dev/null || true
	fi
	exit 0
done
