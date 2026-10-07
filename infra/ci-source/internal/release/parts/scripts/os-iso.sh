# Rapidinstall ISO, then xz: the release file is the compressed ISO. Runs in
# the luna-iso image. /luna/os (ro), /payload (ro), /out, /cache are mounted.
set -eu
iso=/out/luna-rapidinstall-x86_64.iso
tmp=/out/.luna-rapidinstall-x86_64.iso.xz.tmp
trap 'rm -f "$iso" "$tmp"' EXIT
sh /luna/os/build/iso.sh
echo "==> xz"
# -T and the memory cap are explicit: xz sizes its defaults from the host's
# RAM, not this container's limit. -0: the ISO is almost all compressed data
# already (xz -6 saves 0.4% more and takes twice as long).
xz -0 -T"$(nproc)" --memlimit-compress=2GiB -c "$iso" >"$tmp"
xz -t "$tmp"
rm -f "$iso"
mv -f "$tmp" /out/luna-rapidinstall-x86_64.iso.xz
printf 'compressed %s bytes\n' "$(wc -c </out/luna-rapidinstall-x86_64.iso.xz | tr -d ' ')"
