#!/usr/bin/env bash
# One-time (and safe to re-run) setup of the Luna Desktop Flatpak repo server.
# Run as root on the server, from the /opt/LibreServ checkout:
#   sudo /opt/LibreServ/infra/flatpak-repo/setup.sh
# Does not create keys.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
USER_NAME=luna-flatpak
ROOT=/srv/luna-flatpak
HOME_DIR=/var/lib/luna-flatpak
FPR=7081D2758F2D56690DA2ACFAEBBC51F23119763B

[[ $EUID == 0 ]] || { echo "Run as root." >&2; exit 1; }
id "$USER_NAME" >/dev/null 2>&1 || { echo "System user $USER_NAME does not exist." >&2; exit 1; }
[[ -d $HOME_DIR/gnupg ]] || { echo "$HOME_DIR/gnupg not found (GPG key missing)." >&2; exit 1; }
if ! runuser -u "$USER_NAME" -- env GNUPGHOME="$HOME_DIR/gnupg" gpg --list-secret-keys "$FPR" >/dev/null 2>&1; then
	echo "GPG secret key $FPR not found in $HOME_DIR/gnupg." >&2
	exit 1
fi
for tool in flatpak ostree minisign jq curl flock; do
	command -v "$tool" >/dev/null || { echo "$tool is not installed." >&2; exit 1; }
done
flatpak build-import-bundle --help | grep -q -- '--no-update-summary' ||
	echo "warning: this flatpak lacks build-import-bundle --no-update-summary" >&2
flatpak build-update-repo --help | grep -q -- '--prune-depth' ||
	echo "warning: this flatpak lacks build-update-repo --prune-depth" >&2

install -d -o "$USER_NAME" -g "$USER_NAME" -m 0755 "$ROOT" "$ROOT/bundles"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0755 "$HOME_DIR/state"
chown "$USER_NAME:$USER_NAME" "$ROOT" "$ROOT/bundles" "$HOME_DIR/state"
chmod 0700 "$HOME_DIR/gnupg"

# The service runs the script from the checkout as luna-flatpak: it must be
# able to read it.
if ! runuser -u "$USER_NAME" -- test -x "$HERE/watch.sh"; then
	echo "$USER_NAME cannot run $HERE/watch.sh. Check permissions on /opt/LibreServ." >&2
	exit 1
fi

for f in luna-flatpak-watch.service luna-flatpak-watch.timer; do
	ln -sfn "$HERE/$f" "/etc/systemd/system/$f"
done
systemctl daemon-reload
systemctl enable --now luna-flatpak-watch.timer

echo
echo "Done. Next steps:"
echo "  1. Add to /etc/caddy/Caddyfile (after the global block):"
echo "       import $HERE/Caddyfile.conf"
echo "     then: caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy"
echo "  2. Add flatpak.luna.libreloom.org as a public hostname on the cloudflared tunnel"
echo "     (service http://localhost:80)."
echo "  3. First import now:  systemctl start luna-flatpak-watch.service; journalctl -u luna-flatpak-watch -n 50"
