# Luna Android APK (android image). /src is read-only; gradle caches and the
# build dirs are volumes. A keystore (LUNA_ANDROID_KEYSTORE=/keys/...) makes a
# signed release build; without one the APK is debug-signed. Passwords arrive
# in the environment, never on a command line.
set -eu
cd /src/luna/mobile
# Persist the debug signing key, so debug APKs keep installing over each other.
export ANDROID_USER_HOME=/root/.gradle/android
mkdir -p "$ANDROID_USER_HOME"
if [ -n "${LUNA_ANDROID_KEYSTORE:-}" ]; then
	task=assembleRelease
	out=app/build/outputs/apk/release/app-release.apk
else
	echo "no keystore given: building a debug-signed APK"
	task=assembleDebug
	out=app/build/outputs/apk/debug/app-debug.apk
fi
rm -f "$out"
./gradlew "$task" --no-daemon --console=plain --warning-mode=summary -Dorg.gradle.jvmargs=-Xmx2g
test -f "$out"
if [ "$task" = assembleRelease ]; then
	apksigner=$(ls "$ANDROID_HOME"/build-tools/*/apksigner | sort -V | tail -1)
	certs=$("$apksigner" verify --print-certs "$out")
	echo "release APK signature verified"
	if [ -n "${EXPECT_CERT_SHA256:-}" ]; then
		got=$(printf '%s\n' "$certs" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr 'A-F' 'a-f')
		if [ "$got" != "$EXPECT_CERT_SHA256" ]; then
			echo "APK is signed by certificate $got, expected $EXPECT_CERT_SHA256" >&2
			exit 1
		fi
		echo "signing certificate matches"
	fi
fi
cp "$out" /out/luna-android.apk
