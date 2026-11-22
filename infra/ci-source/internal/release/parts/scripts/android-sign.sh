# Sign the unsigned release APK (android image, --network=none). Only the
# part's output dir (/out) and the keystore (/keys/release.keystore, read-only)
# are mounted: no source tree, no gradle and no gradle caches. The store
# password and the key password arrive on standard input, one line each, and
# apksigner reads them from there (never argv, env or a file).
set -eu
bt=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
in=/out/unsigned.apk
test -f "$in"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Align before signing (APK Signature Scheme v2+ covers the aligned bytes);
# -p page-aligns uncompressed native libraries.
"$bt/zipalign" -f -p 4 "$in" "$work/aligned.apk"
"$bt/apksigner" sign --ks /keys/release.keystore --ks-key-alias "$KEY_ALIAS" \
	--ks-pass stdin --key-pass stdin --out "$work/signed.apk" "$work/aligned.apk"
"$bt/zipalign" -c -p 4 "$work/signed.apk"
certs=$("$bt/apksigner" verify --print-certs "$work/signed.apk")
echo "release APK signature verified"
if [ -n "${EXPECT_CERT_SHA256:-}" ]; then
	got=$(printf '%s\n' "$certs" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr 'A-F' 'a-f')
	if [ "$got" != "$EXPECT_CERT_SHA256" ]; then
		echo "APK is signed by certificate $got, expected $EXPECT_CERT_SHA256" >&2
		exit 1
	fi
	echo "signing certificate matches"
fi
cp "$work/signed.apk" /out/luna-android.apk
rm -f "$in"
